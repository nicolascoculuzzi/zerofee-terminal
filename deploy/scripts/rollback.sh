#!/usr/bin/env bash
# Rolls back to an earlier deploy: by default the most recent one that differs from what runs now,
# or the given 12-char sha. Its image must still exist (deploy.sh keeps the last 5 deploys:
# `docker image ls zerofee-server`). The commit is checked out too, so the compose file and the
# Caddyfile match the image. No rebuild, so it takes seconds.
#
#   deploy/scripts/rollback.sh [<sha12>]
set -euo pipefail
# shellcheck source=deploy/scripts/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

cd "$REPO_DIR"
current="$(running_release)"
target="${1:-}"
if [[ -z "$target" ]]; then
  [[ -s "$DEPLOYS_LOG" ]] || die "no deploy history in $DEPLOYS_LOG; pass a sha"
  target="$(awk -v cur="$current" '$5 != cur { t = $5 } END { print t }' "$DEPLOYS_LOG")"
fi
[[ -n "$target" ]] || die "no earlier deploy to roll back to"
target="${target:0:12}"
[[ "$target" != "$current" ]] || die "$target is already running"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "the checkout has local changes (git status)"

log "rolling back: ${current:-unknown} -> $target"
ops_log "rollback start: ${current:-unknown} -> $target"
git checkout -q --detach "$target" || die "commit $target is not in this clone (git fetch?)"
activate_release "$target"
if ! "$DEPLOY_DIR/scripts/smoke.sh"; then
  warn "smoke tests fail on $target as well: the cause may not be the release (provider outage, DNS, disk, keys)"
fi
record_deploy rollback "-" "$target"
log "rolled back to $target"
