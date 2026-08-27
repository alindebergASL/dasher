#!/usr/bin/env bash
#
# Dump the database and put it somewhere the instance cannot lose.
#
# WHY OFF THE BOX IS THE WHOLE POINT. A dump written to a Docker volume beside
# the database is not a backup of the failure that actually happens, which is
# losing the volume. `source_snapshots` holds uploaded files under an
# immutability trigger and nothing can recreate them, so that volume is the only
# copy of evidence that live dashboards are still citing.
#
# WHY IT LOOPS RATHER THAN USING CRON. One process, one log stream, and
# `docker compose logs backup` shows the last run. A cron daemon inside a
# container needs its own logging, its own PID 1 story, and a reason.
set -euo pipefail

# No apostrophe in this message: inside ${VAR:?word} bash parses a quote even
# within double quotes, and the script fails to parse rather than to run.
: "${DASHER_BACKUP_DSN:?set it to the schema owner connection string}"
: "${DASHER_BACKUP_S3_URI:?set DASHER_BACKUP_S3_URI, e.g. s3://bucket/dasher}"

# Split the password out of the DSN so it can travel in the environment rather
# than in argv. Bash parameter expansion only — no parser, because the shape
# accepted here is the one deploy/.env documents:
#   postgresql://user:password@host:port/database
# A DSN with no password is passed through untouched, which is what an instance
# using a trust or IAM connection would supply.
_rest="${DASHER_BACKUP_DSN#*://}"
if [ "${_rest}" = "${DASHER_BACKUP_DSN}" ] || [ "${_rest#*@}" = "${_rest}" ]; then
  # No scheme separator, or no `@` at all — so there is no userinfo and nothing
  # to split. Checking for the `@` FIRST is the whole correction: testing only
  # for a `:` matched the port in `postgresql://host:5432/db`, took the password
  # branch, set PGPASSWORD to "5432/db", and rebuilt the URI from a `${DSN#*@}`
  # that expanded to the entire DSN. A passwordless DSN is exactly the shape an
  # instance-role or trust connection supplies, so it silently broke the case
  # the comment promised was untouched.
  DASHER_BACKUP_PASSWORD=""
  DASHER_BACKUP_URI="${DASHER_BACKUP_DSN}"
else
  _userinfo="${_rest%%@*}"
  if [ "${_userinfo#*:}" = "${_userinfo}" ]; then
    DASHER_BACKUP_PASSWORD=""
    DASHER_BACKUP_URI="${DASHER_BACKUP_DSN}"
  else
    # `#*:` and `%%:*` rather than a split on every colon: a password may
    # contain one, and only the FIRST colon separates user from password.
    #
    # The password is percent-decoded, because libpq decodes it out of a URI
    # and does not out of PGPASSWORD — so a password written `p%40ss` in the
    # DSN is `p@ss` to the server, and passing the raw form in the environment
    # would authenticate with the wrong string.
    # `sed` FIRST, then one `printf %b`. The earlier form ran `printf %b` on
    # the raw password before the substitution, so a password containing a
    # backslash was backslash-decoded — `a\tb` became a tab, `a\\b` became one
    # backslash — and authentication then failed with a password nobody could
    # see was wrong. Percent-decoding is the only transformation wanted here,
    # because libpq decodes percent-escapes out of a URI and does not out of
    # PGPASSWORD.
    DASHER_BACKUP_PASSWORD="$(
      printf '%s' "${_userinfo#*:}" \
        | sed 's/\\/\\\\/g; s/%\([0-9A-Fa-f][0-9A-Fa-f]\)/\\x\1/g'
    )"
    DASHER_BACKUP_PASSWORD="$(printf '%b' "${DASHER_BACKUP_PASSWORD}")"
    DASHER_BACKUP_URI="${DASHER_BACKUP_DSN%%://*}://${_userinfo%%:*}@${_rest#*@}"
  fi
fi
unset _rest _userinfo
INTERVAL_SECONDS="${DASHER_BACKUP_INTERVAL_SECONDS:-86400}"

log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Every step checked explicitly, rather than relying on `set -e`.
#
# `set -e` is DISABLED inside a function invoked as part of a condition or an
# `||` list — `if ! run_once`, `run_once || rc=$?`, both. So a function that
# leans on errexit silently runs to completion after a failure when called that
# way, which for this one means uploading a truncated dump under an ordinary
# timestamped name, deleting the local copy, and logging "done". Verified by
# running both shapes: each printed the step after the failing command.
#
# Explicit `|| return 1` on every step is the only form that behaves the same
# however this function is called.
run_once() {
  stamp="$(date -u +%Y%m%dT%H%M%SZ)" || return 1
  target="/tmp/dasher-${stamp}.dump"
  # Removed however this returns, so a failed run leaves no partial dump behind.
  trap 'rm -f "${target}"' RETURN

  # Custom format, so a restore can be selective and parallel. Plain SQL would
  # also work and would be larger and slower to restore, which matters at the
  # moment somebody is deciding whether to wait.
  # The password goes in the environment, not in argv.
  #
  # `pg_dump "postgresql://user:pw@host/db"` puts the whole URI — password
  # included — into the process's argv, which is world-readable through `ps` and
  # `docker top` for the duration of every dump. This container holds the
  # credential that bypasses row-level security, so that is the one credential
  # most worth not publishing to every local account on the instance. libpq
  # reads PGPASSWORD from the environment, which `/proc/<pid>/environ` does not
  # expose to other users.
  log "dumping"
  PGPASSWORD="${DASHER_BACKUP_PASSWORD}" \
    pg_dump --format=custom --no-owner --file="${target}" "${DASHER_BACKUP_URI}" \
    || { log "pg_dump failed"; return 1; }

  # Verified before it is uploaded, so a truncated dump is caught here rather
  # than discovered during a restore. `pg_restore --list` parses the archive's
  # table of contents and fails on a corrupt one.
  log "verifying archive"
  pg_restore --list "${target}" >/dev/null \
    || { log "archive did not parse; NOT uploading"; return 1; }

  size="$(stat -c %s "${target}")" || return 1
  log "uploading ${size} bytes to ${DASHER_BACKUP_S3_URI}/${stamp}.dump"
  aws s3 cp "${target}" "${DASHER_BACKUP_S3_URI}/${stamp}.dump" \
    || { log "upload failed"; return 1; }

  log "done"
}

if [ "${1:-}" = "--once" ]; then
  rc=0
  run_once || rc=$?
  exit "${rc}"
fi

while true; do
  # A failed backup must not stop the next one: a transient S3 error at 3am
  # should cost one backup, not every backup after it. The failure is logged
  # loudly and the loop continues.
  #
  # `|| rc=$?` does NOT keep errexit live inside `run_once` — nothing does,
  # from any call site. That is why every step in `run_once` carries its own
  # `|| return 1`, and the reason this comment says so rather than the
  # comfortable opposite: an earlier version claimed `|| rc=$?` restored
  # errexit, which would have told the next person adding a step that they
  # could leave the guard off. They cannot.
  #
  # What this construct IS for: capturing the exit status without `set -e`
  # ending the script, so one failed backup costs one backup rather than every
  # backup after it.
  rc=0
  run_once || rc=$?
  if [ "${rc}" -ne 0 ]; then
    log "FAILED (exit ${rc}) — see the error above. Next attempt in ${INTERVAL_SECONDS}s."
  fi
  sleep "${INTERVAL_SECONDS}"
done
