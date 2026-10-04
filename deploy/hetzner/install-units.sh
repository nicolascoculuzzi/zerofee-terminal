#!/usr/bin/env bash
# Installs and starts the host timers (nightly backup, per-minute health ping) from deploy/systemd.
# Run once after cloning the repo to /opt/zerofee/app, and again whenever deploy/systemd changes:
#   sudo /opt/zerofee/app/deploy/hetzner/install-units.sh
set -euo pipefail

[[ $EUID -eq 0 ]] || {
  echo "run with sudo" >&2
  exit 1
}
src="$(cd "$(dirname "${BASH_SOURCE[0]}")/../systemd" && pwd)"
[[ "$src" == /opt/zerofee/app/deploy/systemd ]] || echo "note: the units expect the repo at /opt/zerofee/app (found $src)" >&2

install -m 0644 "$src"/zerofee-*.service "$src"/zerofee-*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now zerofee-backup.timer zerofee-health.timer
systemctl list-timers 'zerofee-*' --no-pager
