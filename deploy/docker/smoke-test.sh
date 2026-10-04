#!/usr/bin/env bash
# Boots a built server image the way production runs it (read-only root filesystem, every capability
# dropped, no-new-privileges, uid 10001) against dead upstreams, then checks the healthcheck,
# /api/health, /metrics access control and the SQLite snapshot script. CI runs it after the build;
# it works locally too:
#
#   docker build --platform linux/amd64 -f deploy/docker/server.Dockerfile -t zerofee-server:ci .
#   deploy/docker/smoke-test.sh zerofee-server:ci
set -euo pipefail

image="${1:-zerofee-server:ci}"
name="zerofee-smoke-$$"
port="${SMOKE_PORT:-18787}"
token="smoke-$(date +%s)-not-a-real-secret"

fail() {
  echo "smoke test FAILED: $*" >&2
  docker logs --tail 50 "$name" >&2 || true
  exit 1
}

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm -f "$name-data" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker volume create "$name-data" >/dev/null
docker run -d --name "$name" \
  --platform linux/amd64 \
  --read-only --tmpfs /tmp:size=64m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$name-data:/data" \
  -p "127.0.0.1:$port:8787" \
  -e RPC_URL=http://127.0.0.1:9 \
  -e BINANCE_WS_URLS=ws://127.0.0.1:9 \
  -e METRICS_TOKEN="$token" \
  -e LOG_LEVEL=warn \
  "$image" >/dev/null

status=starting
for _ in $(seq 1 60); do
  [[ "$(docker inspect -f '{{.State.Running}}' "$name")" == true ]] || fail "container exited"
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name")"
  [[ "$status" == healthy ]] && break
  sleep 2
done
[[ "$status" == healthy ]] || fail "healthcheck status is '$status' after 120 s"
echo "ok   healthcheck: healthy"

[[ "$(docker exec "$name" id -u)" == 10001 ]] || fail "not running as uid 10001"
echo "ok   runs as uid 10001"

if docker exec "$name" sh -c 'touch /app/should-fail' 2>/dev/null; then fail "root filesystem is writable"; fi
echo "ok   root filesystem is read-only"

health="$(curl -fsS "http://127.0.0.1:$port/api/health")" || fail "/api/health unreachable"
grep -q '"dryRun":true' <<<"$health" || fail "/api/health does not report dryRun=true"
echo "ok   /api/health answers (dryRun=true)"

code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/metrics")"
[[ "$code" == 404 ]] || fail "/metrics without the token returned $code, expected 404"
metrics="$(curl -fsS -H "Authorization: Bearer $token" "http://127.0.0.1:$port/metrics")" || fail "/metrics with the token failed"
grep -q '^zerofee_build_info{' <<<"$metrics" || fail "/metrics lacks zerofee_build_info"
grep -q '^zerofee_feed_stalled ' <<<"$metrics" || fail "/metrics lacks zerofee_feed_stalled"
echo "ok   /metrics: 404 without the token, Prometheus text with it"

snapshot="$(docker exec "$name" bun /app/deploy/backup/sqlite-snapshot.ts --db /data/market.db --out /tmp/snapshot.db --mode slim)" ||
  fail "sqlite snapshot failed"
grep -q '"integrity":"ok"' <<<"$snapshot" || fail "sqlite snapshot integrity check: $snapshot"
echo "ok   sqlite snapshot inside the image"

echo "smoke test passed: $image"
