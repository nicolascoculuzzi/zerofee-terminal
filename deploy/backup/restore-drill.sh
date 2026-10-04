#!/usr/bin/env bash
# Restore drill: run it monthly (docs/ops/RUNBOOK.md). It proves the newest backup really restores,
# without touching production:
#   1. download the set, check SHA256SUMS, decrypt it with the offline age key
#   2. restore Postgres into a throwaway container with no network; count tables and rows
#   3. integrity-check the SQLite snapshot; report row counts and how fresh it is
#   4. report the backup's age and ping HC_DRILL_URL. Give that healthchecks.io check a 35-day
#      period, so a skipped drill raises an alert.
# Runs on the server or on any machine with docker, rclone (with the same remote), age and zstd.
#
#   deploy/backup/restore-drill.sh --identity /dev/shm/zerofee-backup.key [--from <set>] [--remote <rclone:path>]
#
# Keep the key on a tmpfs (/dev/shm) for the drill and delete it afterwards. It never belongs on
# this server's disk.
set -euo pipefail
# shellcheck source=deploy/scripts/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib.sh"

identity=""
from=""
remote=""
while (($#)); do
  case "$1" in
    --identity) identity="${2:-}" && shift 2 ;;
    --from) from="${2:-}" && shift 2 ;;
    --remote) remote="${2:-}" && shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
[[ -n "$identity" && -r "$identity" ]] || die "--identity <age key file> is required and must be readable"
require_cmd docker rclone age zstd
have_env=false
[[ -r "$ENV_FILE" ]] && have_env=true
if [[ -z "$remote" ]] && $have_env; then remote="$(env_get BACKUP_REMOTE)"; fi
[[ -n "$remote" ]] || die "no remote: pass --remote or set BACKUP_REMOTE in $ENV_FILE"
hc=""
$have_env && hc="$(env_get HC_DRILL_URL)"
[[ -n "$from" ]] || from="$(backup_sets "$remote" | tail -n 1)"
[[ -n "$from" ]] || die "no backup sets under $remote"

# Decrypted data stays in memory where possible: the Postgres dump maps users to wallets.
tmp_base="${TMPDIR:-/tmp}"
[[ -z "${TMPDIR:-}" && -d /dev/shm ]] && tmp_base=/dev/shm
work="$(mktemp -d "$tmp_base/zerofee-drill.XXXXXX")"
chmod 700 "$work"
pg="zerofee-drill-pg-$$"
finished=false
cleanup() {
  local rc=$?
  docker rm -f "$pg" >/dev/null 2>&1 || true
  rm -rf -- "$work"
  $finished || hc_ping "$hc" /fail "restore drill of $from failed (exit $rc)"
}
trap cleanup EXIT

log "drill: $remote/$from"
fetch_backup "$remote" "$from" "$identity" "$work"
log "checksums ok, decrypted"

# Postgres: same major as production, no network. Ready once it listens on TCP (the entrypoint's
# temporary init server only uses the Unix socket).
docker run -d --name "$pg" --network none -e POSTGRES_USER=zerofee -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=zerofee \
  postgres:18-trixie >/dev/null
for _ in $(seq 1 90); do
  docker exec "$pg" pg_isready -h 127.0.0.1 -U zerofee -d zerofee -q && break
  sleep 1
done
docker exec "$pg" pg_isready -h 127.0.0.1 -U zerofee -d zerofee -q || die "the drill's Postgres did not start"
docker exec -i "$pg" pg_restore -U zerofee -d zerofee --no-owner --exit-on-error <"$work/postgres.dump"
docker exec "$pg" psql -U zerofee -d zerofee -qc "ANALYZE"
pg_tables="$(docker exec "$pg" psql -U zerofee -d zerofee -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')")"
pg_rows="$(docker exec "$pg" psql -U zerofee -d zerofee -tAc \
  "SELECT coalesce(sum(greatest(c.reltuples, 0)), 0)::bigint FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')")"
log "postgres: restored $pg_tables tables, about $pg_rows rows"

sqlite_report="none in this set"
if [[ -f "$work/sqlite/market.db" ]]; then
  sqlite_report="$(docker run --rm --network none \
    -v "$work/sqlite:/drill:ro" \
    -v "$DEPLOY_DIR/backup/sqlite-snapshot.ts:/tools/sqlite-snapshot.ts:ro" \
    "$(bun_image)" bun /tools/sqlite-snapshot.ts --verify /drill/market.db)"
  log "sqlite: $sqlite_report"
fi

age_note=""
if date --version >/dev/null 2>&1; then
  made="$(date -u -d "${from:0:4}-${from:4:2}-${from:6:2} ${from:9:2}:${from:11:2}:${from:13:2}" +%s)"
  age_h=$((($(date -u +%s) - made) / 3600))
  age_note=" (${age_h} h old)"
  ((age_h <= 36)) || warn "the newest backup is ${age_h} h old: is the nightly job failing? (journalctl -u zerofee-backup)"
fi

finished=true
report="restore drill OK: $from$age_note; postgres $pg_tables tables, ~$pg_rows rows; sqlite $sqlite_report"
log "$report"
hc_ping "$hc" "" "$report"
