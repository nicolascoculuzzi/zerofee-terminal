# shellcheck shell=bash
# Shared helpers for the zerofee ops scripts. Source it; don't run it.

ZEROFEE_HOME="${ZEROFEE_HOME:-/opt/zerofee}"
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"
COMPOSE_DIR="$DEPLOY_DIR/docker"
ENV_FILE="${ENV_FILE:-$COMPOSE_DIR/.env.production}"
SERVER_URL="${SERVER_URL:-http://127.0.0.1:8787}"
export ZEROFEE_HOME DEPLOY_DIR REPO_DIR COMPOSE_DIR ENV_FILE SERVER_URL

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
warn() { log "WARN $*" >&2; }
die() {
  log "ERROR $*" >&2
  exit 1
}

# env_get KEY [default]: one value from .env.production, without running the file as shell code.
env_get() {
  local key="$1" def="${2-}" line val
  [[ -r "$ENV_FILE" ]] || die "cannot read $ENV_FILE (copy .env.production.example and fill it in)"
  line="$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" | tail -n 1 || true)"
  val="${line#*=}"
  val="${val%$'\r'}"
  if [[ ${#val} -ge 2 && ${val:0:1} == '"' && ${val: -1} == '"' ]]; then
    val="${val:1:${#val}-2}"
  elif [[ ${#val} -ge 2 && ${val:0:1} == "'" && ${val: -1} == "'" ]]; then
    val="${val:1:${#val}-2}"
  fi
  if [[ -z "$line" || -z "$val" ]]; then printf '%s' "$def"; else printf '%s' "$val"; fi
}

# docker compose for the production stack (project "zerofee").
dc() {
  docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_DIR/docker-compose.yml" --env-file "$ENV_FILE" "$@"
}

# hc_ping URL [suffix] [message]: healthchecks.io ping (suffix "", /start or /fail). Never fails the caller.
hc_ping() {
  local url="${1:-}" suffix="${2:-}" msg="${3:-}"
  [[ -n "$url" ]] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "${msg:0:10000}" "${url}${suffix}" || warn "healthchecks.io ping failed"
}

# metrics: the server's Prometheus text, through the host-published port, with the bearer token.
metrics() {
  local token
  token="$(env_get METRICS_TOKEN)"
  [[ -n "$token" ]] || die "METRICS_TOKEN is empty in $ENV_FILE"
  curl -fsS -m 5 -H "Authorization: Bearer $token" "$SERVER_URL/metrics"
}

# metric NAME_WITH_LABELS: one sample's value from `metrics` output on stdin (empty if absent).
metric() {
  awk -v k="$1" '$1 == k { print $2; exit }'
}

require_cmd() {
  local c
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || die "missing command: $c"; done
}

# wait_healthy SERVICE [TIMEOUT_S]: until the service's container reports healthy (or has no healthcheck).
wait_healthy() {
  local svc="$1" timeout="${2:-180}" id status waited=0
  id="$(dc ps -q "$svc")"
  [[ -n "$id" ]] || die "$svc is not running"
  while :; do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")"
    [[ "$status" == healthy || "$status" == none ]] && return 0
    ((waited >= timeout)) && die "$svc is not healthy after ${timeout}s (status: $status); see: deploy/scripts/dc logs --tail 100 $svc"
    sleep 2
    waited=$((waited + 2))
  done
}

# ops_log MESSAGE: an audit line (who did what, when) in $ZEROFEE_HOME/ops.log.
ops_log() {
  printf '%s %s %s\n' "$(date -u +%FT%TZ)" "${SUDO_USER:-${USER:-unknown}}" "$*" >>"$ZEROFEE_HOME/ops.log" 2>/dev/null ||
    warn "could not write $ZEROFEE_HOME/ops.log"
}

# --- releases ----------------------------------------------------------------------------------------
# Server images are tagged zerofee-server:<12-char sha>; zerofee-server:current is what compose runs.
# Web releases live in $ZEROFEE_HOME/web/releases/<sha>; the `current` symlink is what Caddy serves.
# $ZEROFEE_HOME/deploys.log has one line per deploy or rollback: time user action ref sha.

DEPLOYS_LOG="$ZEROFEE_HOME/deploys.log"

# running_release: the 12-char sha of the image tagged :current (from its OCI revision label).
running_release() {
  local rev
  rev="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' zerofee-server:current 2>/dev/null || true)"
  printf '%s' "${rev:0:12}"
}

# activate_release SHA12: point :current and the web symlink (when that release exists) at SHA12,
# converge the stack, wait for the server's healthcheck and reload Caddy.
activate_release() {
  local short="$1" web="$ZEROFEE_HOME/web"
  docker image inspect "zerofee-server:$short" >/dev/null 2>&1 ||
    die "image zerofee-server:$short not found (docker image ls zerofee-server)"
  docker tag "zerofee-server:$short" zerofee-server:current
  dc up -d --remove-orphans
  wait_healthy server 300
  if [[ -d "$web/releases/$short" ]]; then
    ln -sfn "releases/$short" "$web/current.next"
    mv -Tf "$web/current.next" "$web/current"
    log "web: current -> releases/$short"
  fi
  reload_caddy || warn "this release's Caddyfile is NOT active; fix it, then: deploy/scripts/dc exec caddy caddy reload --config /etc/caddy/Caddyfile --address unix//run/caddy/admin.sock"
}

# reload_caddy: apply the Caddyfile without dropping connections. On failure (an invalid Caddyfile)
# Caddy keeps running its previous config.
reload_caddy() {
  local tries=0 out
  until out="$(dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile --address unix//run/caddy/admin.sock 2>&1)"; do
    tries=$((tries + 1))
    if ((tries >= 10)); then
      warn "caddy reload failed; Caddy keeps its previous config: $out"
      return 1
    fi
    sleep 2 # a freshly started Caddy needs a moment before its admin socket answers
  done
}

record_deploy() { # record_deploy ACTION REF SHA12
  printf '%s %s %s %s %s\n' "$(date -u +%FT%TZ)" "${SUDO_USER:-${USER:-unknown}}" "$1" "$2" "$3" >>"$DEPLOYS_LOG"
  ops_log "$1 done: $2 ($3)"
}

# prune_releases: keep the images and web releases of the last 5 distinct deploys (and :current).
prune_releases() {
  local keep tag d
  [[ -s "$DEPLOYS_LOG" ]] || return 0
  keep="$(awk '{ print $5 }' "$DEPLOYS_LOG" | tac | awk '!seen[$0]++ { if (n++ < 5) print }')"
  keep+=$'\n'"$(running_release)"
  while read -r tag; do
    [[ -z "$tag" || "$tag" == current ]] && continue
    grep -qxF "$tag" <<<"$keep" || docker image rm "zerofee-server:$tag" >/dev/null 2>&1 || true
  done < <(docker image ls zerofee-server --format '{{.Tag}}')
  for d in "$ZEROFEE_HOME"/web/releases/*/; do
    [[ -d "$d" ]] || continue
    grep -qxF "$(basename "$d")" <<<"$keep" || rm -rf -- "$d"
  done
  docker image prune -f >/dev/null
  docker builder prune -f --filter until=720h >/dev/null
}

# --- backups -----------------------------------------------------------------------------------------

BACKUP_NAME_RE='^[0-9]{8}T[0-9]{6}Z$'

# backup_sets REMOTE: backup set names on the remote, oldest first.
backup_sets() {
  rclone lsf --dirs-only "$1" | sed 's:/$::' | grep -E "$BACKUP_NAME_RE" | sort || true
}

# backup_prune_list KEEP_DAILY KEEP_MONTHLY: reads set names on stdin (any order) and prints the ones
# to delete: all but the KEEP_DAILY newest and the first set of each of the KEEP_MONTHLY newest months.
backup_prune_list() {
  sort | awk -v daily="$1" -v monthly="$2" '
    { name[NR] = $0 }
    END {
      for (i = NR; i >= 1 && i > NR - daily; i--) keep[name[i]] = 1
      for (i = 1; i <= NR; i++) {
        m = substr(name[i], 1, 6)
        if (!(m in first)) { first[m] = name[i]; month[++months] = m }
      }
      for (j = months; j >= 1 && j > months - monthly; j--) keep[first[month[j]]] = 1
      for (i = 1; i <= NR; i++) if (!(name[i] in keep)) print name[i]
    }'
}

sha256_check() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum --check --quiet "$@"; else shasum -a 256 --check --quiet "$@"; fi
}

# fetch_backup REMOTE NAME IDENTITY DIR: downloads one backup set, checks SHA256SUMS and decrypts it:
#   DIR/postgres.dump (pg_dump custom format) and, when the set has one, DIR/sqlite/market.db
fetch_backup() {
  local remote="$1" name="$2" identity="$3" dir="$4"
  mkdir -p "$dir/enc"
  rclone copy "$remote/$name" "$dir/enc"
  [[ -f "$dir/enc/SHA256SUMS" ]] || die "$remote/$name has no SHA256SUMS"
  (cd "$dir/enc" && sha256_check SHA256SUMS) || die "checksum mismatch in $remote/$name"
  age -d -i "$identity" -o "$dir/postgres.dump" "$dir/enc/postgres.dump.age"
  if [[ -f "$dir/enc/market.db.zst.age" ]]; then
    mkdir -p "$dir/sqlite"
    age -d -i "$identity" "$dir/enc/market.db.zst.age" | zstd -d -q -f -o "$dir/sqlite/market.db"
  fi
}

# The pinned Bun image from the server Dockerfile (for one-off verification containers).
bun_image() {
  sed -n 's/^ARG BUN_IMAGE=//p' "$DEPLOY_DIR/docker/server.Dockerfile" | head -n 1
}
