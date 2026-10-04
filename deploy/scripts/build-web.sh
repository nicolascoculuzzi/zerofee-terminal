#!/usr/bin/env bash
# Builds the web app (apps/web, Vite) for one commit and installs it as
# $ZEROFEE_HOME/web/releases/<short-sha>, ready for deploy.sh to switch the `current` symlink.
#
#   - Built from `git archive <commit>` (exactly the committed tree) in a throwaway container from the
#     same digest-pinned Bun image as the server, with the frozen lockfile. Same inputs, same bytes,
#     so the hashes can be reproduced anywhere.
#   - Writes SHA256SUMS for the release. It is also served at /SHA256SUMS: the published hashes.
#   - Refuses an index.html with inline scripts (the CSP would block them); warns without SRI.
#   - Carries over the previous release's own assets, so tabs still running the old build can
#     lazy-load their chunks after the switch.
# Exits 0 without doing anything until apps/web exists in the commit.
#
#   deploy/scripts/build-web.sh <commit>
set -euo pipefail
# shellcheck source=deploy/scripts/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

sha="$(git -C "$REPO_DIR" rev-parse --verify "${1:?usage: build-web.sh <commit>}^{commit}")"
short="${sha:0:12}"
if ! git -C "$REPO_DIR" cat-file -e "$sha:apps/web/package.json" 2>/dev/null; then
  log "no apps/web in $short: skipping the web build"
  exit 0
fi
dest="$ZEROFEE_HOME/web/releases/$short"
if [[ -d "$dest" ]]; then
  log "web release $short already built"
  exit 0
fi

tmp="$(mktemp -d "$ZEROFEE_HOME/web/.build-$short.XXXXXX")"
trap 'rm -rf -- "$tmp"' EXIT
git -C "$REPO_DIR" archive "$sha" | tar -x -C "$tmp"

log "building web $short"
docker run --rm --platform linux/amd64 --user "$(id -u):$(id -g)" -e HOME=/tmp -e CI=true \
  -v "$tmp:/src" -w /src "$(bun_image)" \
  sh -c 'bun install --frozen-lockfile && bun run --cwd apps/web build'

dist="$tmp/apps/web/dist"
[[ -f "$dist/index.html" ]] || die "the build produced no apps/web/dist/index.html"
if grep -Eiq '<script([[:space:]][^>]*)?>[^<]*[^[:space:]<]' "$dist/index.html"; then
  die "dist/index.html has an inline <script>; the CSP forbids inline scripts"
fi
grep -q 'integrity=' "$dist/index.html" || warn "dist/index.html has no Subresource Integrity attributes (SPEC: strict CSP and SRI)"

(cd "$dist" && find . -type f -print0 | sort -z | xargs -0 sha256sum) >"$tmp/SHA256SUMS"
mv "$tmp/SHA256SUMS" "$dist/SHA256SUMS"

prev="$(readlink "$ZEROFEE_HOME/web/current" 2>/dev/null || true)"
if [[ -n "$prev" && -f "$ZEROFEE_HOME/web/$prev/SHA256SUMS" ]]; then
  while read -r _ p; do
    p="${p#./}"
    if [[ "$p" == assets/* && ! -e "$dist/$p" ]]; then cp -p "$ZEROFEE_HOME/web/$prev/$p" "$dist/$p"; fi
  done <"$ZEROFEE_HOME/web/$prev/SHA256SUMS"
fi

# Caddy reads the files as "other": world-readable, nothing executable.
find "$dist" -type d -exec chmod 0755 {} +
find "$dist" -type f -exec chmod 0644 {} +
mv "$dist" "$dest"
log "web release ready: $dest ($(wc -l <"$dest/SHA256SUMS") files)"
