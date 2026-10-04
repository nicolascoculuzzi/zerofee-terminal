#!/usr/bin/env bash
# Restores production from a backup set (docs/ops/RUNBOOK.md, "Restore from backup"). It replaces
# data, so it insists on --yes. Before replacing anything it:
#   - halts trading at the edge (HALT_TX) and leaves it halted for you to check and resume
#   - keeps an encrypted dump of the current Postgres database next to the restore
#   - renames the current SQLite files to *.pre-restore-<timestamp> instead of deleting them
#
#   deploy/backup/restore.sh --identity /dev/shm/zerofee-backup.key [--from <set>|latest] [--only postgres|sqlite] --yes
set -euo pipefail
# shellcheck source=deploy/scripts/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib.sh"

identity=""
from="latest"
only=""
yes=false
while (($#)); do
  case "$1" in
    --identity) identity="${2:-}" && shift 2 ;;
    --from) from="${2:-}" && shift 2 ;;
    --only) only="${2:-}" && shift 2 ;;
    --yes) yes=true && shift ;;
    *) die "unknown option $1" ;;
  esac
done
[[ -n "$identity" && -r "$identity" ]] || die "--identity <age key file> is required and must be readable"
[[ -z "$only" || "$only" == postgres || "$only" == sqlite ]] || die "--only takes postgres or sqlite"
$yes || die "this replaces production data; re-run with --yes"
require_cmd docker rclone age zstd
remote="$(env_get BACKUP_REMOTE)"
recipient="$(env_get BACKUP_AGE_RECIPIENT)"
[[ "$recipient" == age1* ]] || die "BACKUP_AGE_RECIPIENT must be set (the pre-restore copy is encrypted to it)"
[[ "$from" != latest ]] || from="$(backup_sets "$remote" | tail -n 1)"
[[ -n "$from" ]] || die "no backup sets under $remote"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
work="$ZEROFEE_HOME/backups/restore-$ts"
umask 077
mkdir -p "$work"
cleanup() {
  rm -rf -- "$work/enc" "$work/postgres.dump" "$work/sqlite"
  if [[ -e "$ZEROFEE_HOME/flags/HALT_TX" ]]; then
    warn "trading is HALTED. Check the restore (deploy/scripts/smoke.sh), then: deploy/scripts/kill-switch.sh resume"
  fi
}
trap cleanup EXIT

ops_log "restore start: $remote/$from (only=${only:-all})"
log "restore from $remote/$from"
fetch_backup "$remote" "$from" "$identity" "$work"
log "checksums ok, decrypted"

[[ -e "$ZEROFEE_HOME/flags/HALT_TX" ]] || "$DEPLOY_DIR/scripts/kill-switch.sh" halt "restore from $from"

if [[ "$only" != sqlite ]]; then
  log "postgres: encrypted copy of the current database -> $work/pre-restore-postgres.dump.age"
  dc exec -T postgres pg_dump -U zerofee -d zerofee --format=custom --no-owner |
    age -r "$recipient" -o "$work/pre-restore-postgres.dump.age"
  dc stop server
  log "postgres: replacing database zerofee"
  dc exec -T postgres psql -U zerofee -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS zerofee WITH (FORCE)" -c "CREATE DATABASE zerofee OWNER zerofee"
  dc exec -T postgres pg_restore -U zerofee -d zerofee --no-owner --exit-on-error <"$work/postgres.dump"
fi

if [[ "$only" != postgres ]]; then
  if [[ -f "$work/sqlite/market.db" ]]; then
    dc stop server
    log "sqlite: swapping market.db (current files kept as *.pre-restore-$ts in the server-data volume)"
    # Readable by the server's uid 10001: public market data only.
    chmod 755 "$work/sqlite"
    chmod 644 "$work/sqlite/market.db"
    dc run --rm --no-deps -T --entrypoint sh -v "$work/sqlite:/restore:ro" server -c "
      set -e
      for f in /data/market.db /data/market.db-wal /data/market.db-shm; do
        if [ -e \"\$f\" ]; then mv \"\$f\" \"\$f.pre-restore-$ts\"; fi
      done
      cp /restore/market.db /data/market.db"
  else
    warn "set $from has no SQLite snapshot; market data left as it is"
  fi
fi

log "starting the server"
dc up -d server
wait_healthy server 300
ops_log "restore done: $remote/$from"
log "restore of $from done. Next: deploy/scripts/smoke.sh, then deploy/scripts/kill-switch.sh resume"
