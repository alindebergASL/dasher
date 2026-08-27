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
INTERVAL_SECONDS="${DASHER_BACKUP_INTERVAL_SECONDS:-86400}"

log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

run_once() {
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  target="/tmp/dasher-${stamp}.dump"

  # Custom format, so a restore can be selective and parallel. Plain SQL would
  # also work and would be larger and slower to restore, which matters at the
  # moment somebody is deciding whether to wait.
  log "dumping"
  pg_dump --format=custom --no-owner --file="${target}" "${DASHER_BACKUP_DSN}"

  # Verified before it is uploaded, so a truncated dump is caught here rather
  # than discovered during a restore. `pg_restore --list` parses the archive's
  # table of contents and fails on a corrupt one.
  log "verifying archive"
  pg_restore --list "${target}" >/dev/null

  size="$(stat -c %s "${target}")"
  log "uploading ${size} bytes to ${DASHER_BACKUP_S3_URI}/${stamp}.dump"
  aws s3 cp "${target}" "${DASHER_BACKUP_S3_URI}/${stamp}.dump"

  rm -f "${target}"
  log "done"
}

if [ "${1:-}" = "--once" ]; then
  run_once
  exit 0
fi

while true; do
  # A failed backup must not stop the next one: a transient S3 error at 3am
  # should cost one backup, not every backup after it. The failure is logged
  # loudly and the loop continues.
  if ! run_once; then
    log "FAILED — see the error above. The next attempt is in ${INTERVAL_SECONDS}s."
  fi
  sleep "${INTERVAL_SECONDS}"
done
