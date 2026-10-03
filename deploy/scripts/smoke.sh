#!/usr/bin/env bash
# Smoke tests: deploy.sh runs them after every deploy, and they are safe to run any time. They fail on:
#   - GET /api/health through Caddy (TLS, DNS, proxy, server)
#   - missing security headers, or a CSP weaker than script-src 'self' / frame-ancestors 'none'
#   - /metrics reachable from the internet, or unreachable on the host
#   - a front-end that differs from its release's SHA256SUMS
# Feed freshness is only a warning: a stalled feed is usually the provider, not the release.
set -euo pipefail
# shellcheck source=deploy/scripts/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

domain="$(env_get APP_DOMAIN)"
[[ -n "$domain" ]] || die "APP_DOMAIN is empty in $ENV_FILE"
base="https://$domain"
fails=0
pass() { log "ok   $*"; }
fail() {
  log "FAIL $*"
  fails=$((fails + 1))
}

if body="$(curl -fsS -m 15 "$base/api/health")" && grep -q '"version"' <<<"$body"; then
  pass "GET $base/api/health (TLS, proxy, server)"
else
  fail "GET $base/api/health"
fi

# Headers of the app shell (also present on a 404 before the first web release).
headers="$(curl -sS -m 15 -o /dev/null -D - "$base/" | tr -d '\r' || true)"
for h in strict-transport-security content-security-policy x-content-type-options x-frame-options referrer-policy \
  permissions-policy cross-origin-opener-policy cross-origin-resource-policy; do
  if grep -qi "^$h:" <<<"$headers"; then pass "header $h"; else fail "missing header $h"; fi
done
csp="$(grep -i '^content-security-policy:' <<<"$headers" || true)"
if grep -qi "frame-ancestors 'none'" <<<"$csp"; then pass "CSP frame-ancestors 'none'"; else fail "CSP lacks frame-ancestors 'none'"; fi
if grep -qi "script-src 'self'" <<<"$csp" && ! grep -qiE "'unsafe-(inline|eval)'" <<<"$csp"; then
  pass "CSP script-src 'self' without unsafe-inline/unsafe-eval"
else
  fail "CSP script-src is weaker than 'self'"
fi
if grep -qi '^server:' <<<"$headers"; then fail "Server header present"; else pass "no Server header"; fi

code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$base/metrics" || true)"
if [[ "$code" == 404 ]]; then pass "/metrics closed at the edge"; else fail "$base/metrics answered $code"; fi

m=""
if m="$(metrics)"; then pass "/metrics on $SERVER_URL"; else fail "/metrics on $SERVER_URL"; fi
if [[ "$(metric zerofee_dry_run <<<"$m")" == 1 ]]; then log "note DRY_RUN=true: POST /api/tx simulates only"; fi
if [[ "$(metric 'zerofee_halted{scope="tx"}' <<<"$m")" == 1 ]]; then log "note trading is HALTED (deploy/scripts/kill-switch.sh status)"; fi

rel="$(readlink "$ZEROFEE_HOME/web/current" 2>/dev/null || true)"
if [[ -n "$rel" && -f "$ZEROFEE_HOME/web/$rel/SHA256SUMS" ]]; then
  if "$DEPLOY_DIR/scripts/verify-frontend.sh" "$base" "$ZEROFEE_HOME/web/$rel/SHA256SUMS" >/dev/null; then
    pass "front-end matches $rel/SHA256SUMS"
  else
    fail "front-end differs from $rel/SHA256SUMS (deploy/scripts/verify-frontend.sh for details)"
  fi
else
  log "skip front-end hash check (no web release yet)"
fi

stalled=""
for _ in $(seq 1 30); do
  stalled="$(metrics 2>/dev/null | metric zerofee_feed_stalled || true)"
  [[ "$stalled" == 0 ]] && break
  sleep 2
done
if [[ "$stalled" == 0 ]]; then
  pass "feed flowing"
else
  warn "feed still stalled after 60 s (provider, keys, INGEST_SOURCE?): not failing on it"
fi

((fails == 0)) || die "$fails smoke check(s) failed"
log "smoke tests passed"
