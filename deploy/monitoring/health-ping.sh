#!/usr/bin/env bash
# Every minute (zerofee-health.timer). Checks, from this host:
#   - the feed: zerofee_feed_stalled 0 (an event within METRICS_FEED_STALL_SEC, default 30 s)
#   - the blockhash browsers sign with: zerofee_blockhash_stale 0
#   - every container running, and the server's healthcheck healthy
#   - the root disk below 85 %
# It then pings HC_HEALTH_URL on healthchecks.io: a plain ping when all is well, /fail with the
# reasons otherwise. If the host dies, the pings stop and healthchecks.io alerts on its own; that is
# why this check lives outside the box. Uptime Kuma, with its 20 s checks, is the faster local layer.
#
# healthchecks.io settings for this check: period 1 minute, grace 2 minutes.
set -euo pipefail
# shellcheck source=deploy/scripts/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib.sh"

hc="$(env_get HC_HEALTH_URL)"
problems=()
notes=()

if m="$(metrics 2>/dev/null)"; then
  if [[ "$(metric zerofee_feed_stalled <<<"$m")" != 0 ]]; then
    problems+=("feed stalled: no event for $(metric zerofee_feed_silence_seconds <<<"$m") s")
  fi
  if [[ "$(metric zerofee_blockhash_stale <<<"$m")" != 0 ]]; then
    problems+=("blockhash stale: $(metric zerofee_blockhash_age_seconds <<<"$m") s old")
  fi
  if [[ "$(metric 'zerofee_halted{scope="tx"}' <<<"$m")" == 1 ]]; then notes+=("trading halted (HALT_TX)"); fi
  if [[ "$(metric 'zerofee_halted{scope="site"}' <<<"$m")" == 1 ]]; then notes+=("maintenance mode on"); fi
  if [[ "$(metric zerofee_dry_run <<<"$m")" == 1 ]]; then notes+=("DRY_RUN=true"); fi
else
  problems+=("server /metrics unreachable on $SERVER_URL")
fi

for svc in server postgres caddy uptime-kuma; do
  state="$(dc ps --format '{{.State}}' "$svc" 2>/dev/null | head -n 1 || true)"
  [[ "$state" == running ]] || problems+=("container $svc is ${state:-missing}")
done
health="$(dc ps --format '{{.Health}}' server 2>/dev/null | head -n 1 || true)"
[[ -z "$health" || "$health" == healthy ]] || problems+=("server healthcheck: $health")

disk="$(df -P / | awk 'NR == 2 { gsub("%", "", $5); print $5 }')"
((disk < 85)) || problems+=("root disk ${disk}% full")
if [[ -e /var/run/reboot-required ]]; then notes+=("reboot required since $(date -u -r /var/run/reboot-required +%F)"); fi

summary="disk ${disk}%"
if ((${#notes[@]})); then summary+="; $(printf '%s; ' "${notes[@]}")"; fi
if ((${#problems[@]})); then
  msg="$(printf '%s\n' "${problems[@]}")"
  log "UNHEALTHY: ${msg//$'\n'/; } ($summary)"
  hc_ping "$hc" /fail "$msg
$summary"
  exit 1
fi
hc_ping "$hc" "" "ok; $summary"
