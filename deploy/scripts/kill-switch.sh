#!/usr/bin/env bash
# Kill switches (docs/ops/RUNBOOK.md, "Kill switch"). Two layers, flipped together:
#
#   edge    Caddy checks flag files in $ZEROFEE_HOME/flags on every request: it acts at once, with
#           no reload, and keeps working even if the server process is broken.
#   server  the admin kill switch (POST /api/admin/halt, needs ADMIN_TOKEN): persists across
#           restarts, lands in the audit log, is pushed to every client so the UI disables trading,
#           and also stops what the server would submit on its own (armed orders).
#
#   kill-switch.sh halt [reason]        stop trading: edge 503 on /api/tx + server halt
#   kill-switch.sh resume               lift both
#   kill-switch.sh maintenance on [reason] | off
#                                       the whole site answers 503 and evicts cached assets
#                                       (front-end compromise, DNS incident, risky maintenance)
#   kill-switch.sh status
#
# Neither layer can stop a browser that sends straight to Helius Sender's browser endpoint (the
# fallback lane).
set -euo pipefail
# shellcheck source=deploy/scripts/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

flags="$ZEROFEE_HOME/flags"
[[ -d "$flags" ]] || die "$flags is missing (cloud-init creates it; mkdir -m 0755 it otherwise)"

public_code() { # public_code METHOD PATH: HTTP status through the public edge
  local domain
  domain="$(env_get APP_DOMAIN)"
  if [[ -z "$domain" ]]; then
    echo "?"
    return
  fi
  curl -s -o /dev/null -m 10 -w '%{http_code}' -X "$1" "https://$domain$2" || echo "unreachable"
}

# server_switch ACTION [reason]: the admin halt or resume; reports, never fails the edge action.
server_switch() {
  local action="$1" out rc=0
  if [[ "$action" == halt ]]; then
    out="$(admin_api POST /api/admin/halt "$(json_reason "${2:-}")" 2>&1)" || rc=$?
  else
    out="$(admin_api POST /api/admin/resume 2>&1)" || rc=$?
  fi
  case "$rc" in
    0) log "server: $action ok ($out)" ;;
    2) warn "ADMIN_TOKEN is empty: edge layer only. Set it to use the server's persistent kill switch too" ;;
    *) warn "server $action failed (${out:-no answer}); the edge layer is still in effect" ;;
  esac
}

status() {
  local f m admin
  for f in HALT_TX MAINTENANCE; do
    if [[ -e "$flags/$f" ]]; then echo "edge $f: ON since $(date -u -r "$flags/$f" +%FT%TZ)"; else echo "edge $f: off"; fi
  done
  if admin="$(admin_api GET /api/admin/status 2>/dev/null)"; then
    if command -v jq >/dev/null 2>&1; then admin="$(jq -c '.halt' <<<"$admin")"; fi
    echo "server halt: $admin"
  else
    echo "server halt: unknown (ADMIN_TOKEN empty or server unreachable)"
  fi
  # GET /api/tx: 503 when halted at the edge or in the server, 405 when open (nothing is submitted).
  echo "public edge: /api/tx -> $(public_code GET /api/tx) (503 = halted, 405 = open), / -> $(public_code GET /) (503 = maintenance)"
  if m="$(metrics 2>/dev/null)"; then
    echo "metrics: halted tx=$(metric 'zerofee_halted{scope="tx"}' <<<"$m") site=$(metric 'zerofee_halted{scope="site"}' <<<"$m") dry_run=$(metric zerofee_dry_run <<<"$m")"
  else
    echo "metrics: /metrics unreachable"
  fi
}

cmd="${1:-status}"
reason="${*:2}"
case "$cmd" in
  halt)
    touch "$flags/HALT_TX"
    ops_log "kill-switch: halt ${reason:+($reason)}"
    log "edge: trading halted"
    server_switch halt "$reason"
    ;;
  resume)
    rm -f "$flags/HALT_TX"
    ops_log "kill-switch: resume"
    log "edge: trading resumed"
    server_switch resume
    ;;
  maintenance)
    case "${2:-}" in
      on)
        touch "$flags/MAINTENANCE"
        ops_log "kill-switch: maintenance on ${*:3}"
        log "maintenance mode on"
        ;;
      off)
        rm -f "$flags/MAINTENANCE"
        ops_log "kill-switch: maintenance off"
        log "maintenance mode off"
        ;;
      *) die "usage: kill-switch.sh maintenance on [reason] | off" ;;
    esac
    ;;
  status) ;;
  *) die "usage: kill-switch.sh halt [reason] | resume | maintenance on|off | status" ;;
esac
status
