#!/usr/bin/env bash
# Edge kill switches (docs/ops/RUNBOOK.md, "Kill switch"). Caddy checks the flag files in
# $ZEROFEE_HOME/flags on every request, so a switch acts at once, with no reload or restart, and
# keeps working even if the server process is broken.
#
#   kill-switch.sh halt [reason]        POST /api/tx answers 503: no trade reaches our landing lanes
#   kill-switch.sh resume               lift the halt
#   kill-switch.sh maintenance on [reason] | off
#                                       the whole site answers 503 and evicts cached assets
#                                       (front-end compromise, DNS incident, risky maintenance)
#   kill-switch.sh status
#
# Scope: the edge halt stops trades that browsers submit through us. It does not stop transactions
# the server submits on its own (armed orders, Phase 5); those need the admin POST /api/halt once it
# exists. Today, DRY_RUN=true plus a server restart also stops all sending. Browsers that use
# Helius Sender's browser endpoint directly (the fallback lane) are not affected by either.
set -euo pipefail
# shellcheck source=deploy/scripts/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

flags="$ZEROFEE_HOME/flags"
[[ -d "$flags" ]] || die "$flags is missing (cloud-init creates it; mkdir -m 0755 it otherwise)"

public_code() { # public_code METHOD PATH: HTTP status through the public edge
  local domain
  domain="$(env_get APP_DOMAIN)"
  [[ -n "$domain" ]] || {
    echo "?"
    return
  }
  curl -s -o /dev/null -m 10 -w '%{http_code}' -X "$1" "https://$domain$2" || echo "unreachable"
}

status() {
  local f
  for f in HALT_TX MAINTENANCE; do
    if [[ -e "$flags/$f" ]]; then echo "$f: ON since $(date -u -r "$flags/$f" +%FT%TZ)"; else echo "$f: off"; fi
  done
  # GET /api/tx: the edge answers 503 when halted, the server 405 otherwise (nothing is submitted).
  echo "edge check: /api/tx -> $(public_code GET /api/tx) (503 = halted, 405 = open), / -> $(public_code GET /) (503 = maintenance)"
  if m="$(metrics 2>/dev/null)"; then
    echo "server sees: halted tx=$(metric 'zerofee_halted{scope="tx"}' <<<"$m") site=$(metric 'zerofee_halted{scope="site"}' <<<"$m") dry_run=$(metric zerofee_dry_run <<<"$m")"
  else
    echo "server /metrics unreachable"
  fi
}

cmd="${1:-status}"
reason="${*:2}"
case "$cmd" in
  halt)
    touch "$flags/HALT_TX"
    ops_log "kill-switch: HALT_TX on ${reason:+($reason)}"
    log "trading halted at the edge"
    ;;
  resume)
    rm -f "$flags/HALT_TX"
    ops_log "kill-switch: HALT_TX off"
    log "trading resumed"
    ;;
  maintenance)
    case "${2:-}" in
      on)
        touch "$flags/MAINTENANCE"
        ops_log "kill-switch: MAINTENANCE on ${*:3}"
        log "maintenance mode on"
        ;;
      off)
        rm -f "$flags/MAINTENANCE"
        ops_log "kill-switch: MAINTENANCE off"
        log "maintenance mode off"
        ;;
      *) die "usage: kill-switch.sh maintenance on [reason] | off" ;;
    esac
    ;;
  status) ;;
  *) die "usage: kill-switch.sh halt [reason] | resume | maintenance on|off | status" ;;
esac
status
