#!/bin/bash
# boxery-provision [LAYER...]: apply boxery's image layers (/usr/local/lib/boxery/layers/LAYER.sh) in order.
# Default: the layers listed in /etc/boxery/provision (written by boxery-host's per-VM cloud-config).
#   plumbing   every VM: agent user, boxery-llm (LLM proxy bridge), sshd/sysctl/cloud-init/tmux config
#   devtools   git, build tools, node 24, pi, opencode, ripgrep (keeps what the image already has)
#   desktop    XFCE, VNC/noVNC, browsers, playwright-core (the desktop base build only)
# Records what's installed in /etc/boxery/layers; /etc/boxery/headless marks a VM without the desktop.
set -euo pipefail
D=/usr/local/lib/boxery/layers
want=" ${*:-$(cat /etc/boxery/provision 2>/dev/null || true)} "
for l in $want; do case $l in plumbing | devtools | desktop) ;; *) echo "boxery-provision: unknown layer '$l'" >&2; exit 2 ;; esac; done
[ "$want" != "  " ] || { echo "boxery-provision: no layers given (and no /etc/boxery/provision)" >&2; exit 2; }
mkdir -p /etc/boxery
rm -f /var/log/boxery-provision.ok
for l in plumbing devtools desktop; do
	case $want in *" $l "*) ;; *) continue ;; esac
	echo "==> boxery layer: $l"
	t=$SECONDS
	bash "$D/$l.sh"
	grep -qx "$l" /etc/boxery/layers 2>/dev/null || echo "$l" >>/etc/boxery/layers
	echo "==> boxery layer $l done in $((SECONDS - t))s"
done
if grep -qx desktop /etc/boxery/layers; then rm -f /etc/boxery/headless; else echo "no desktop (boxery new --headless)" >/etc/boxery/headless; fi
touch /var/log/boxery-provision.ok
