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
