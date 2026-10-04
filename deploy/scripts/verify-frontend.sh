#!/usr/bin/env bash
# Compares what a site actually serves with a release's SHA256SUMS (front-end integrity, RUNBOOK).
# deploy.sh runs it after every deploy. Also run it from a machine you control: a compromised
# server can't vouch for itself. Each release publishes its manifest at https://<domain>/SHA256SUMS,
# and the copy you trust is the one built from the tagged commit.
#
#   verify-frontend.sh https://app.example.com /opt/zerofee/web/releases/<sha>/SHA256SUMS
set -euo pipefail

base="${1:?usage: verify-frontend.sh <https://domain> <SHA256SUMS>}"
base="${base%/}"
sums="${2:?usage: verify-frontend.sh <https://domain> <SHA256SUMS>}"
[[ -r "$sums" ]] || {
  echo "cannot read $sums" >&2
  exit 2
}

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }
fetch() { curl -fsS --compressed -m 20 "$1" | sha || echo "fetch-failed"; }

n=0
bad=0
while read -r hash path; do
  path="${path#\*}"
  path="${path#./}"
  [[ -n "$hash" && -n "$path" ]] || continue
  n=$((n + 1))
  if [[ "$(fetch "$base/$path")" != "$hash" ]]; then
    echo "MISMATCH /$path"
    bad=$((bad + 1))
  fi
  if [[ "$path" == index.html && "$(fetch "$base/")" != "$hash" ]]; then
    echo "MISMATCH / (the page browsers load)"
    bad=$((bad + 1))
  fi
done <"$sums"

((n > 0)) || {
  echo "no entries in $sums" >&2
  exit 2
}
if ((bad > 0)); then
  echo "$bad mismatch(es) across $n files: the live site differs from $sums"
  exit 1
fi
echo "all $n files served by $base match $sums"
