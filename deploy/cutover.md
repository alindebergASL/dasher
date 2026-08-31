# Cutting over a host that is already serving

`README.md` deploys onto an empty instance. This file is for the case that
actually exists: a host where something is already answering on 80 and 443, and
where the deploy has to be reversible right up to the last step.

It was written for `luckbutton.com`, whose live state at the time was: nginx
holding 80 and 443 behind HTTP Basic Auth, a certificate valid into October, an
old `next start` on `127.0.0.1:3000`, a checkout detached at an old revision,
and no Docker installed.

## What actually collides

Only the proxy. `web` is `expose`d, not published, so the container's 3000 never
touches the host's — the old server can keep running through the entire build.
Caddy is the single conflict: it binds 80 and 443, and while nginx holds them it
will fail to start and retry.

That gives the whole plan its shape. Everything except the last two steps can be
done with the old site still serving, and the irreversible moment is one
`systemctl stop`.

## Before you start

Keep the old configuration as rollback material, not as something you can
reconstruct afterwards:

```sh
sudo cp -a /etc/nginx "/root/nginx-backup-$(date +%Y%m%d-%H%M)"
systemctl is-enabled nginx; systemctl is-active nginx
# Whatever unit runs the old Next server — note its name, do not disable it yet.
systemctl list-units --type=service | grep -i -E 'dasher|next|node'
```

## 1. Docker, and the revision you intend to run

```sh
# docker-compose-v2 exists in Ubuntu 22.04 and later. If this apt-get cannot
# find it, the host is older than assumed — stop and check `lsb_release -a`
# before improvising a compose install.
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2
sudo usermod -aG docker "$USER" && newgrp docker
# `newgrp` opens a NEW shell: fine pasted interactively, but it only affects
# this session (a second SSH login still lacks the group until re-login), and
# any variables exported before it are gone — so run it BEFORE step 2's
# `set -a`, or log out and back in instead.

cd ~/dasher
git fetch origin
git checkout <THE MERGE SHA>       # detached is fine; it is what you want here
git rev-parse --short HEAD          # goes in DASHER_DEPLOYMENT_REVISION
```

## 2. Fill in the contract

`cp deploy/.env.example deploy/.env` and complete it, following `README.md` —
including its quoting rule and its "MUST STAY UNSET" section.

Set `DASHER_PUBLIC_ORIGIN=https://luckbutton.com`. Not the port you are about to
test on: the value is what signed-in readers are redirected to, and a host-local
origin baked in here is how a deployment ends up sending people to an address
that does not resolve.

```sh
set -a && . deploy/.env && set +a
```

## 3. Database and schema, while the old site still serves

```sh
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --wait postgres
```

Then create the two roles and apply the schema exactly as `README.md` describes
— including `--build` on the migrator, which is not optional on a host that has
built this image before.

> **Memory.** This instance has 2 GB and 2 GB of swap. The image build is the
> heaviest thing that will happen here and it is close to the line; a build
> killed without explanation is the symptom. Confirm swap is actually on
> (`swapon --show`) before building, and do not run the build concurrently with
> anything else.

## 4. Bring up the application, but NOT the proxy

Naming the services is the whole point — a bare `up -d` starts `proxy`, which is
the one thing that cannot coexist with nginx.

```sh
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build \
  postgres web backup
docker compose -f deploy/compose.yml --env-file deploy/.env ps
```

Verify it answers, from the host, without any proxy in front:

```sh
WEB=$(docker compose -f deploy/compose.yml --env-file deploy/.env \
  ps -q web | xargs docker inspect \
  -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
curl -sS -o /dev/null -w '%{http_code}\n' "http://$WEB:3000/"   # 200
```

## 5. Rehearse through the OLD proxy, TLS and all

This step is the reason the cutover is safe, and it is worth doing rather than
skipping to step 6. Point nginx's upstream at the container and reload — but
edit the RIGHT file, and put the backup in the right place:

```sh
# The entry under sites-enabled is a SYMLINK into sites-available. `sed -i.bak`
# on the symlink does two wrong things at once: it replaces the symlink with a
# regular file, and it drops the `.bak` INSIDE the directory nginx globs — so
# nginx loads the site twice and `nginx -t` fails on a duplicate default
# server, dead-ending the cutover mid-morning. Reproduced, not theorized.
SITE=$(readlink -f /etc/nginx/sites-enabled/<site>)
sudo cp -a "$SITE" /root/nginx-site.rehearsal.bak
sudo sed -i "s#127\.0\.0\.1:3000#$WEB:3000#" "$SITE"
sudo nginx -t && sudo systemctl reload nginx
```

One check before trusting the rehearsal:

```sh
grep -n 'proxy_set_header[[:space:]]\+Host' "$SITE"
```

If that finds nothing, add `proxy_set_header Host $host;` to the location block
before rehearsing. nginx's default forwards the UPSTREAM address as the Host,
and Next.js rejects server actions whose `Origin` disagrees with the forwarded
Host — so page loads would look fine while sign-in and the CSV upload fail,
which is precisely the false confidence this step exists to prevent.

The new application is now being served over the EXISTING certificate, on the
real hostname, still behind Basic Auth. That means sign-in can be exercised for
real before anything irreversible happens — `__Host-` cookies need `Secure` and
a real hostname, and this arrangement provides both. Sign in, upload a CSV, load
a dashboard.

> **`$WEB` is not stable.** It is a bridge-network address that can change any
> time the container is recreated — another `up -d --build`, or an OOM-kill
> followed by `restart: unless-stopped`. If ANYTHING rebuilds or restarts the
> `web` container after this step, re-derive `$WEB` (step 4) and re-point
> nginx, or the live site quietly serves 502s while the rehearsal still looks
> green in your notes.

To undo the rehearsal: `sudo cp /root/nginx-site.rehearsal.bak "$SITE" && sudo
nginx -t && sudo systemctl reload nginx` — no downtime in either direction.

## 6. Cut over

```sh
sudo systemctl stop nginx
sudo systemctl stop <old next unit>
docker compose -f deploy/compose.yml --env-file deploy/.env up -d proxy
docker compose -f deploy/compose.yml --env-file deploy/.env logs -f proxy
```

Caddy now requests its own certificate. This is the step that cannot be
rehearsed off the instance: it needs public DNS and port 80 reachable. Watch for
a certificate obtained. If it loops on the challenge, the cause is DNS or the
security group, not the application.

Leave both old units _stopped but enabled_ until step 7 passes. Disabling them
is a step for tomorrow, not for tonight.

## 7. Verify, and know what failure looks like

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://luckbutton.com/                # 200
curl -sS -o /dev/null -w '%{http_code}\n' https://luckbutton.com/dev/bootstrap   # 404
curl -sSI https://luckbutton.com/ | grep -i 'content-security-policy\|x-frame'   # both present
curl -sS -o /dev/null -w '%{http_code}\n' http://luckbutton.com/                 # 308 to https
```

Run the header check against a 200, not against the first response after a
restart: the security headers ride the APPLICATION's responses, and a
Caddy-generated `502 Bad Gateway` during the few seconds a container is coming
up carries none of them (and a `Server: Caddy` banner besides). A missing
header on a 502 is a race you lost, not a configuration fault.

404 is the answer you want on `/dev/bootstrap`: the route exports GET and POST
and both check the switch first, so a switched-off deployment answers 404 on
either. A **405 means the bootstrap is live** — it mints a session for anyone
who can reach the URL. Take the deployment down until it is not.

Then sign in again through Caddy, and confirm the dashboard you created in step
5 is still there. It should be: the database was never part of the cutover.

## Rolling back

Before step 6, rollback is the rehearsal-undo above. After step 6 it is three
commands, not two — step 6 stopped BOTH old services, and restoring nginx's
config points it back at `127.0.0.1:3000`, where nothing answers until the old
server is started again. A rollback that forgets the third command serves 502s
and looks like a second failure:

```sh
docker compose -f deploy/compose.yml --env-file deploy/.env stop proxy
sudo cp /root/nginx-site.rehearsal.bak "$SITE" && sudo nginx -t   # if step 5 edited it
sudo systemctl start <old next unit> && sudo systemctl start nginx
```

Postgres, `web` and `backup` can keep running while you work out what happened —
none of them binds a port the old site wants.
