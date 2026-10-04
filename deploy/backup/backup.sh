#!/usr/bin/env bash
# Nightly backup (zerofee-backup.timer, 03:30 UTC).
#
#   1. Postgres: pg_dump (custom format) streamed out of the container straight into age.
#   2. SQLite: a consistent online snapshot made inside the server container (sqlite-snapshot.ts),
#      streamed out through zstd into age.
#   3. SHA256SUMS + meta, upload with rclone to BACKUP_REMOTE/<timestamp>/, verify the upload.
#   4. Prune the remote: the BACKUP_KEEP_DAILY newest sets plus the first set of each of the last
#      BACKUP_KEEP_MONTHLY months. Locally only the last two sets stay (for a fast restore).
#
# Everything is encrypted to BACKUP_AGE_RECIPIENT. The private key is NOT on this server, so a
# compromised host can't read old backups. Plaintext never touches the host disk. Reports to
# HC_BACKUP_URL (healthchecks.io: start, success or fail).
#
#   deploy/backup/backup.sh             full run
#   deploy/backup/backup.sh --local     no upload, no report (deploy.sh's pre-deploy copy)
#   deploy/backup/backup.sh --pg-only   Postgres only
set -euo pipefail
# shellcheck source=deploy/scripts/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib.sh"

upload=true
with_sqlite=true
for arg in "$@"; do
  case "$arg" in
    --local) upload=false ;;
    --pg-only) with_sqlite=false ;;
    *) die "unknown option $arg" ;;
  esac
done

require_cmd docker age zstd sha256sum curl
recipient="$(env_get BACKUP_AGE_RECIPIENT)"
[[ "$recipient" == age1* ]] || die "BACKUP_AGE_RECIPIENT must be an age public key (age1...)"
remote="$(env_get BACKUP_REMOTE)"
mode="$(env_get BACKUP_SQLITE_MODE slim)"
trades_hours="$(env_get BACKUP_TRADES_HOURS 6)"
keep_daily="$(env_get BACKUP_KEEP_DAILY 14)"
keep_monthly="$(env_get BACKUP_KEEP_MONTHLY 6)"
# keep_daily >= 1 guarantees the set uploaded below is never pruned in the same run.
[[ "$keep_daily" =~ ^[0-9]+$ ]] && ((keep_daily >= 1)) || die "BACKUP_KEEP_DAILY must be a whole number >= 1"
[[ "$keep_monthly" =~ ^[0-9]+$ ]] || die "BACKUP_KEEP_MONTHLY must be a whole number"
[[ "$mode" == slim || "$mode" == full ]] || die "BACKUP_SQLITE_MODE must be slim or full"
ts="$(date -u +%Y%m%dT%H%M%SZ)"
hc=""
name="$ts-local"
if $upload; then
  require_cmd rclone
  [[ -n "$remote" ]] || die "BACKUP_REMOTE is empty"
  hc="$(env_get HC_BACKUP_URL)"
  name="$ts"
fi
work="$ZEROFEE_HOME/backups/$name"
umask 077
mkdir -p "$work"

finished=false
on_exit() {
  local rc=$?
  $finished && return 0
  warn "backup $name failed (exit $rc)"
  hc_ping "$hc" /fail "backup $name failed (exit $rc); journalctl -u zerofee-backup on $(hostname)"
}
trap on_exit EXIT

hc_ping "$hc" /start
log "backup $name -> $work"

# The SQLite snapshot needs free space next to the live database (slim mode: a fraction of it).
avail_gb="$(df -P -BG /var/lib/docker | awk 'NR == 2 { gsub("G", "", $4); print $4 }')"
((avail_gb >= 5)) || die "only ${avail_gb} GB free under /var/lib/docker; refusing to snapshot"

log "postgres: pg_dump | age"
dc exec -T postgres pg_dump -U zerofee -d zerofee --format=custom --no-owner |
  age -r "$recipient" -o "$work/postgres.dump.age"

if $with_sqlite; then
  snap="/backups/market-$ts.db"
  log "sqlite: $mode snapshot (trades newer than ${trades_hours} h)"
  dc exec -T server bun /app/deploy/backup/sqlite-snapshot.ts \
    --db /data/market.db --out "$snap" --mode "$mode" --trades-hours "$trades_hours" >"$work/sqlite-summary.json"
  dc exec -T server cat "$snap" | zstd -q -T0 -10 | age -r "$recipient" -o "$work/market.db.zst.age"
  dc exec -T server rm -f "$snap"
fi

git_sha="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
printf '{"name":"%s","host":"%s","git":"%s","sqlite_mode":"%s","recipient":"%s"}\n' \
  "$name" "$(hostname)" "$git_sha" "$($with_sqlite && echo "$mode" || echo none)" "$recipient" >"$work/meta.json"
(cd "$work" && sha256sum -- *.age >SHA256SUMS)
sizes="$(cd "$work" && du -ch -- *.age | tr '\n' ' ')"
log "encrypted: $sizes"

if $upload; then
  log "upload -> $remote/$name"
  rclone copy "$work" "$remote/$name"
  rclone check --one-way "$work" "$remote/$name"

  # Remote retention.
  backup_sets "$remote" | backup_prune_list "$keep_daily" "$keep_monthly" | while read -r old; do
    log "prune $remote/$old"
    rclone purge "$remote/$old"
  done
fi

# Local retention: the two newest sets of each kind (nightly, pre-deploy).
for pattern in '[0-9]*Z' '[0-9]*Z-local'; do
  find "$ZEROFEE_HOME/backups" -mindepth 1 -maxdepth 1 -type d -name "$pattern" | sort |
    awk '{ d[NR] = $0 } END { for (i = 1; i <= NR - 2; i++) print d[i] }' |
    while read -r old; do rm -rf -- "$old"; done
done

finished=true
log "backup $name done"
hc_ping "$hc" "" "backup $name: $sizes"
