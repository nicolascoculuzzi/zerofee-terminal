#!/usr/bin/env bash
# Deploys one git ref (a tag, ideally signed, or a commit) to this host. docs/ops/RUNBOOK.md, "Deploy".
#
#   1. preflight: clean checkout, complete .env.production, Docker reachable, disk space
#   2. fetch and check out the ref, detached (signed tags required when REQUIRE_SIGNED_TAGS=true)
#   3. encrypted local copy of Postgres (backup.sh --local --pg-only), when backups are configured
#   4. build zerofee-server:<sha>, plus the web release when apps/web exists (build-web.sh)
#   5. activate: retag :current, converge the stack, wait for the healthcheck, switch the web
#      symlink, reload Caddy
#   6. smoke tests (smoke.sh). If they fail, roll back to the previous deploy automatically.
#   7. record it in $ZEROFEE_HOME/deploys.log; prune old images and releases (keeps 5)
#
#   deploy/scripts/deploy.sh v0.3.0 [--skip-backup] [--no-rollback]
set -euo pipefail
# shellcheck source=deploy/scripts/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ref="${1:-}"
[[ -n "$ref" && "$ref" != --* ]] || die "usage: deploy.sh <git-ref> [--skip-backup] [--no-rollback]"
shift
skip_backup=false
auto_rollback=true
for arg in "$@"; do
  case "$arg" in
    --skip-backup) skip_backup=true ;;
    --no-rollback) auto_rollback=false ;;
    *) die "unknown option $arg" ;;
  esac
done

require_cmd git docker curl
cd "$REPO_DIR"

# 1. Preflight.
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "the checkout has local changes (git status); commit or discard them"
for key in APP_DOMAIN ACME_EMAIL POSTGRES_PASSWORD METRICS_TOKEN; do
  [[ -n "$(env_get "$key")" ]] || die "$key is empty in $ENV_FILE"
done
if [[ "$(env_get INGEST_SOURCE rpc)" == yellowstone ]]; then
  for key in YELLOWSTONE_ENDPOINT YELLOWSTONE_X_TOKEN; do
    [[ -n "$(env_get "$key")" ]] || die "INGEST_SOURCE=yellowstone needs $key"
  done
fi
[[ "$(stat -c %a "$ENV_FILE")" == 600 ]] || warn "$ENV_FILE should be chmod 600"
docker info >/dev/null 2>&1 || die "Docker is not reachable (is ${USER:-this user} in the docker group?)"
avail_gb="$(df -P -BG /var/lib/docker | awk 'NR == 2 { gsub("G", "", $4); print $4 }')"
((avail_gb >= 10)) || die "only ${avail_gb} GB free under /var/lib/docker"

# 2. Check out.
git fetch --tags --prune origin
sha="$(git rev-parse --verify --quiet "$ref^{commit}")" || die "unknown ref $ref (for a branch, use origin/<branch>)"
if [[ "$(env_get REQUIRE_SIGNED_TAGS false)" == true ]]; then
  git verify-tag "$ref" >/dev/null 2>&1 || die "$ref is not a tag signed by a key in your keyring"
fi
short="${sha:0:12}"
prev="$(running_release)"
git checkout -q --detach "$sha"
log "deploying $ref ($short); running now: ${prev:-nothing}"
ops_log "deploy start: $ref ($short)"

# 3. Safety copy of user state.
if ! $skip_backup; then
  if [[ -z "$(env_get BACKUP_AGE_RECIPIENT)" ]]; then
    warn "BACKUP_AGE_RECIPIENT is empty: no pre-deploy backup (set up backups before go-live)"
  elif [[ -n "$(dc ps -q postgres 2>/dev/null)" ]]; then
    "$DEPLOY_DIR/backup/backup.sh" --local --pg-only
  fi
fi

# 4. Build.
log "building zerofee-server:$short"
SERVER_TAG="$short" GIT_SHA="$sha" dc build server
"$DEPLOY_DIR/scripts/build-web.sh" "$sha"

# 5. Activate.
activate_release "$short"

# 6. Smoke tests, automatic rollback.
if ! "$DEPLOY_DIR/scripts/smoke.sh"; then
  ops_log "deploy failed smoke tests: $ref ($short)"
  if $auto_rollback && [[ -n "$prev" && "$prev" != "$short" ]]; then
    warn "smoke tests failed; rolling back to $prev"
    "$DEPLOY_DIR/scripts/rollback.sh" "$prev"
  fi
  die "deploy of $ref ($short) failed its smoke tests"
fi

# 7. Record and prune.
record_deploy deploy "$ref" "$short"
prune_releases
log "deployed $ref ($short)"
