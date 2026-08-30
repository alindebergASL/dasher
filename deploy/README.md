# Deploying Dasher to one instance

Everything here is executed on the instance. Nobody working in this repository
can reach that host interactively, so this file is written to be followed
exactly rather than adapted while reading it.

## What this deploys

One EC2 instance running four containers: PostgreSQL 16, the Next.js
application, Caddy — the only thing bound to a host port — and a backup service
that dumps to S3 on a timer. A fifth, `migrate`, sits behind the `tools` profile
and runs only when invoked.

The backup container is the one worth noticing in an audit of what holds
credentials on the box: it carries the schema-owner DSN and the AWS
credentials, because a dump has to read every row. The
application is reachable on the compose network and nowhere else, so a security
group mistake cannot expose it over plain HTTP.

That last point is not tidiness. The session cookie carries the `__Host-`
prefix and the `secure` attribute, which browsers exempt only for
`http://localhost`. **A deployment reached by IP address over HTTP cannot hold a
session at all.** The hostname and the certificate are a precondition for
sign-in, not a finishing touch.

## The instance

- **t3.small or t4g.small**, 2 GB of memory. `pnpm build` will be killed on a
  1 GB instance. If you would rather build elsewhere and ship the image, a
  smaller instance is fine to _run_ on.
- **20 GB of disk.** The image carries the built workspace and is around a
  gigabyte; the default 8 GB volume is tight once Docker keeps a previous
  image for rollback.
- **Security group**: inbound 80 and 443 from anywhere, 22 from your address
  only. Nothing else. Port 80 must be open or Caddy cannot complete the
  certificate challenge.
- **A DNS A record** for `DASHER_PUBLIC_HOSTNAME` pointing at the instance's
  address, in place _before_ the first `up`, for the same reason.

## First deploy

```sh
# 1. Docker, if the AMI does not carry it.
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2
sudo usermod -aG docker "$USER" && newgrp docker

# 2. The repository, at the commit you intend to run.
git clone https://github.com/alindebergASL/dasher.git && cd dasher

# 3. The contract. Fill in every blank; read the "MUST STAY UNSET" section.
cp deploy/.env.example deploy/.env && "${EDITOR:-nano}" deploy/.env

# 4. Load it into THIS SHELL as well. `--env-file` populates interpolation
#    inside the compose file; it does not export anything to your shell, and
#    several commands below reference these variables directly.
#
#    NOTE that this is the SHELL parsing the file, not compose. The two differ:
#    the shell performs expansion and word splitting, treats an unquoted `#` as
#    starting a comment, and will execute a `$(...)`. Compose does none of that.
#    So keep every value in deploy/.env single-quoted — 'p@ss word#1' — and the
#    two parsers agree. An unquoted password containing a space or a `#` will
#    silently mean something different here than it does to compose.
set -a && . deploy/.env && set +a

# 5. The database, on its own, so the roles exist before the migrator runs.
#
#    `--wait` is not optional here. `up -d` returns when the CONTAINER has
#    started, which is several seconds before PostgreSQL accepts connections;
#    the `exec psql` in the next step then fails with "No such file or
#    directory ... Is the server running locally", which reads like a broken
#    image rather than a race you lost by a few seconds. Measured on a clean
#    volume: six seconds from started to ready.
#
#    `migrate` and `web` already wait, via `depends_on: service_healthy` — it
#    is only this hand-run step, outside compose's dependency graph, that has
#    to ask.
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --wait postgres
```

### Create the two roles

The migrator grants `dasher_app` to a login role but does not invent one, and it
refuses to run as anything other than the DATABASE owner — `assertDatabaseOwner`
compares `CURRENT_USER` against `pg_database.datdba`. It does not check schema
ownership, which it could not: at this point the `dasher` schema does not exist,
because the migration that creates it has not run. Both roles are created
once, by hand, as the superuser. Use passwords that match what you put in
`deploy/.env`.

```sh
docker compose -f deploy/compose.yml --env-file deploy/.env exec postgres \
  psql -U "$DASHER_PG_SUPERUSER" -d dasher -v ON_ERROR_STOP=1 <<'SQL'
-- CREATEROLE is required, not decorative: `migrate` calls
-- `bootstrapManagedRoles` before applying anything, and that runs
-- `CREATE ROLE dasher_app`. A plain database owner gets
-- "permission denied to create role" and the migrate step below aborts.
CREATE ROLE dasher_owner LOGIN CREATEROLE PASSWORD 'REPLACE_ME';
CREATE ROLE dasher_web_app LOGIN PASSWORD 'REPLACE_ME';
-- The migrator refuses to run as anything but the owner of the DATABASE, which
-- is what this line establishes. It creates the `dasher` schema itself on the
-- first migration.
ALTER DATABASE dasher OWNER TO dasher_owner;
SQL
```

`dasher_web_app` is granted nothing here. The migrator grants it `dasher_app`,
which is a deliberately narrow role: it cannot write `organizations`, `users`,
or `memberships`. If a later step fails with `permission denied for table
organizations`, that is the schema working — do not fix it with a grant.

### Apply the schema, then start

```sh
# Idempotent. Reports what it discovered, what was already applied, and what it
# applied, so running it on every deploy is the intended use.
#
# `--build` on the RUN, not just on the `up` below. `migrate` builds its own
# image and sits behind `profiles: ["tools"]`, so it is not among the services
# `up --build` starts and `up --build` therefore never rebuilds it. Without
# this flag `run` reuses whatever image is already on the host — which on a
# second deploy is the PREVIOUS revision's, so a migration added since then is
# silently not applied and the new web image starts against an old schema.
docker compose -f deploy/compose.yml --env-file deploy/.env \
  --profile tools run --build --rm migrate

docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
```

Caddy obtains the certificate on first request. Watch it happen:

```sh
docker compose -f deploy/compose.yml --env-file deploy/.env logs -f proxy
```

> **Deploying onto a host that is already serving something?** This file
> assumes an empty instance. A host where nginx or another proxy already holds
> 80 and 443 needs the reversible sequence in [`cutover.md`](./cutover.md)
> instead — Caddy cannot bind while the old proxy is running, and the order that
> keeps a rollback available is not the order below.

## Subsequent deploys

```sh
git pull
# `--build` here for the reason given above: without it this runs the previous
# revision's migrator, which is exactly the deploy where it matters.
docker compose -f deploy/compose.yml --env-file deploy/.env \
  --profile tools run --build --rm migrate
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
```

Set `DASHER_DEPLOYMENT_REVISION` to the deployed commit SHA each time. It is
written onto every dashboard version and every audit event, and it is the only
thing that will let you trace a stored row back to the code that wrote it.

### Create the first organization

Sign-in is invitation-only: a link is only ever sent to an address that already
has an active membership, and there is deliberately no path in the product that
creates one. So the first organization is created here, as the schema owner:

```sh
# No `-e DASHER_MIGRATE_DSN=...`: the `migrate` service already resolves it
# from deploy/.env, and passing it again overrides it with whatever the shell
# has — which was empty, so provisioning printed "DASHER_MIGRATE_DSN is not
# set" and created nothing.
docker compose -f deploy/compose.yml --env-file deploy/.env \
  --profile tools run --rm migrate \
  pnpm --filter @dasher/control-plane provision \
    --organization "Your org" --email you@example.com --role admin
```

Re-running it with the same address and a different organization adds that
person to the second one rather than creating a second account for the same
inbox. A sign-in link goes to their oldest membership.

## Verifying it actually works

The development bootstrap **must not** be enabled here — it mints a session for
anyone who can reach the URL. Sign-in is the real path:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://YOUR_HOSTNAME/                 # 200
curl -sS -o /dev/null -w '%{http_code}\n' https://YOUR_HOSTNAME/dev/bootstrap    # 404
```

The second is the one that matters, and 404 is the answer you want.

`app/dev/bootstrap/route.ts` exports BOTH a GET and a POST, and each checks
`DASHER_DEV_BOOTSTRAP` before anything else. Switched off, both answer 404 — so
the route does not confirm it exists. Switched on, the GET answers 405 ("use
POST"). A **405 therefore means the bootstrap is live** on this deployment,
which mints a session for anyone who can reach the URL: take it down until it
is not.

Measured against a real build in both states rather than read off the source,
because an adversarial review asserted the opposite — that the route exports
only POST and a secured deployment answers 405 — and acting on that would have
inverted this check.

What the measurement establishes and what it does not: switched off, both verbs
answered 404, so a 404 here is consistent with the bootstrap being off. It is
not proof on its own — a route that did not exist at all would answer 404 too,
which is the point of answering 404. What a **405 does** prove is that the
handler ran and found the switch on.

Then sign in for real: open `/sign-in`, enter the address you provisioned, and
follow the link. If no mail transport is configured the page says sign-in is
unavailable rather than accepting the address and doing nothing — the one
sentence this product must not say falsely is "a link is on its way".

Two things to know when it does not arrive. The page says the same sentence for
an address it will not mail as for one it will, on purpose, so that submitting
an address is not a way to ask whether it has an account here — which means "no
email" is not by itself evidence of a fault. And the schema must be migrated
before any of this works: an unmigrated database answers with a 500, because
`dasher_api.begin_sign_in` does not exist yet. Run the migrate step above.

## Backups

The `backup` service dumps the database on a timer and puts the archive in S3.
It runs as part of `up -d`; nothing extra to start.

Off the instance is the whole point. The failure a backup exists for is losing
the volume, and `source_snapshots` holds uploaded files under an immutability
trigger — nothing can recreate them, so that volume is the only copy of
evidence that live dashboards are still citing.

Give the instance an IAM role rather than putting keys in `deploy/.env`. The
backup container reads every row, so a key there is a key to the whole
database.

The role needs three actions, not one. `s3:PutObject` on the prefix is what
writing a dump takes, and it used to be all this section named — but the
restore below downloads the archive using the SAME instance credentials, and
choosing which backup to restore means listing them. A role with only
`PutObject` produces a deployment that backs up perfectly and cannot restore,
which is the one failure mode a backup exists to prevent, discovered at the
worst possible moment.

- `s3:PutObject` on `arn:aws:s3:::BUCKET/PREFIX/*` — writing a dump.
- `s3:GetObject` on `arn:aws:s3:::BUCKET/PREFIX/*` — reading one back.
- `s3:ListBucket` on `arn:aws:s3:::BUCKET`, conditioned on the prefix — finding
  out which backups exist. This one is on the BUCKET, not on the objects; a
  policy that lists only object ARNs silently grants nothing.

Put a lifecycle rule on the bucket unless you intend to keep every daily dump
for ever.

Force a run without waiting for the timer:

```sh
docker compose -f deploy/compose.yml --env-file deploy/.env \
  run --rm backup --once
```

Each run dumps, then parses the archive with `pg_restore --list` BEFORE
uploading, so a truncated dump fails here rather than being discovered during a
restore. A failed run is logged and the loop continues: a transient S3 error
should cost one backup, not every backup after it.

### Restoring, and proving the restore is worth keeping

A backup nobody has restored is a claim, not a capability. Restore into a
throwaway database first — never over the live one:

```sh
# Everything runs INSIDE the compose network. The database port is deliberately
# only `expose`d, so `localhost:5432` from the host does not reach it, and the
# instance has no pnpm — the setup step installs Docker and nothing else.

# 1. Fetch the dump into the backup container, which already has aws and the
#    Postgres client tools.
docker compose -f deploy/compose.yml --env-file deploy/.env \
  run --rm --entrypoint sh \
  -e PGPASSWORD="$DASHER_PG_SUPERUSER_PASSWORD" backup -c \
  'aws s3 cp "$DASHER_BACKUP_S3_URI/20260827T000000Z.dump" /tmp/r.dump &&
   createdb -h postgres -U '"$DASHER_PG_SUPERUSER"' dasher_restore_check &&
   pg_restore -h postgres -U '"$DASHER_PG_SUPERUSER"' -d dasher_restore_check \
     --no-owner --role='"$DASHER_PG_SUPERUSER"' /tmp/r.dump'

# 2. Verify it, from the application image, which has the workspace installed.
#    Connect as the SUPERUSER: the restore ran --no-owner, so `dasher_owner` is
#    neither the object owner nor a member of dasher_app in the restored copy
#    and would be refused on every table.
#
#    The password rides in PGPASSWORD rather than in the URI. Spliced into a
#    DSN it has to be percent-encoded, and a password containing `@`, `/`, `?`
#    or `#` silently produces a different connection string — usually one that
#    parses, connects somewhere unintended, or fails with an error naming the
#    wrong host.
docker compose -f deploy/compose.yml --env-file deploy/.env \
  --profile tools run --rm \
  -e PGPASSWORD="$DASHER_PG_SUPERUSER_PASSWORD" \
  -e DASHER_RESTORE_CHECK_DSN="postgresql://$DASHER_PG_SUPERUSER@postgres:5432/dasher_restore_check" \
  migrate pnpm --filter @dasher/control-plane restore-check
```

`restore-check` does not ask whether the restore errored. It asks whether the
three claims this product makes about stored evidence still hold: every stored
file hashes to the digest beside it, every dashboard version can still find the
file it cites, and every claim edge still reaches an evidence record that still
belongs to a snapshot. It also refuses to call an EMPTY restore simply
verified — every invariant holds vacuously over no rows, which is the outcome
most likely to be mistaken for success.

Why that check exists at all: a restore is the one operation where the database
accepts whatever it is given. Foreign keys are not enforced on the paths a
partial recovery actually takes — `pg_restore --disable-triggers` turns off FK
triggers, a selective `-t` restore brings some tables and not others, and a
restore continued past errors leaves whatever it managed. All three produce a
database that opens cleanly, answers queries, and is missing the rows a
dashboard points at. A non-zero exit means do not promote this restore.
