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
_credentials="${DASHER_BACKUP_DSN#*://}"
_credentials="${_credentials%%@*}"
if [ "${_credentials}" != "${DASHER_BACKUP_DSN}" ] && [ "${_credentials#*:}" != "${_credentials}" ]; then
  DASHER_BACKUP_PASSWORD="${_credentials#*:}"
  DASHER_BACKUP_URI="${DASHER_BACKUP_DSN%%://*}://${_credentials%%:*}@${DASHER_BACKUP_DSN#*@}"
else
  DASHER_BACKUP_PASSWORD=""
  DASHER_BACKUP_URI="${DASHER_BACKUP_DSN}"
fi
unset _credentials
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
  # NOT `if ! run_once`. Invoking a function in a condition disables `set -e`
  # FOR THE WHOLE FUNCTION, so a failing `pg_dump` or a failing
  # `pg_restore --list` would not stop the sequence: the upload would run
  # anyway, a truncated dump would reach S3 under an ordinary timestamped
  # name, the local copy would be deleted, and the log would read "done".
  # Silent failure in the direction of "everything is fine" is the one thing a
  # backup must never do. `|| rc=$?` keeps errexit live inside the function.
  rc=0
  run_once || rc=$?
  if [ "${rc}" -ne 0 ]; then
    log "FAILED (exit ${rc}) — see the error above. Next attempt in ${INTERVAL_SECONDS}s."
  fi
  sleep "${INTERVAL_SECONDS}"
done
