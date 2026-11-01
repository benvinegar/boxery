#!/bin/bash
# boxery layer 1/3, plumbing: what every boxery VM needs, desktop or headless. Small, and boxery's own.
# Runs as root, idempotent. Applied by boxery-provision (image/layers/provision.sh): in the desktop base
# build, or at first boot of a headless VM on the stock image (Ubuntu cloud image, exeuntu).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# shellcheck source=/dev/null
. /usr/local/lib/boxery/layers/lib.sh

# The agent user. cloud-init creates it on libvirt/cloud-hypervisor (user-data `users:`), Lima creates it
# from its template; exeuntu has neither.
id agent >/dev/null 2>&1 || useradd -m -s /bin/bash -c "boxery agent" -G sudo,adm agent
echo "agent ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/90-boxery-agent; chmod 440 /etc/sudoers.d/90-boxery-agent

# socat: the guest end of the LLM proxy. qemu-guest-agent: libvirt freezes filesystems for snapshots.
pkgs socat tmux git curl ca-certificates qemu-guest-agent

mkdir -p /etc/boxery /etc/cloud/cloud.cfg.d /etc/systemd/system /etc/ssh/sshd_config.d /etc/sysctl.d /etc/profile.d
# Make `agent` the cloud-init default user, so per-VM ssh_authorized_keys land there (also for VMs made
# from this disk: snapshots and forks).
cat >/etc/cloud/cloud.cfg.d/99-boxery.cfg <<'EOF'
system_info:
  default_user:
    name: agent
    gecos: boxery agent
    groups: [sudo, adm]
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    lock_passwd: true
EOF

# Guest end of the LLM proxy: 127.0.0.1:8088 in the guest -> the host proxy (path depends on the backend).
# Credentials stay on the host; the guest only ever holds its per-VM proxy token.
cat >/etc/systemd/system/boxery-llm.service <<'EOF'
[Unit]
Description=boxery: forward 127.0.0.1:8088 to host LLM proxy over vsock
After=network.target
[Service]
# Upstream is backend-specific (libvirt: VSOCK-CONNECT:2:8088, lima: TCP:host.lima.internal:PORT);
# written per VM by boxery-host into /etc/boxery/proxy-upstream. Default: vsock. ($$: systemd's literal $)
ExecStart=/bin/sh -c 'exec /usr/bin/socat TCP-LISTEN:8088,bind=127.0.0.1,reuseaddr,fork "$$(cat /etc/boxery/proxy-upstream 2>/dev/null || echo VSOCK-CONNECT:2:8088)"'
Restart=always
RestartSec=1
[Install]
WantedBy=multi-user.target
EOF

# Many parallel tool calls share one multiplexed ssh connection from the laptop.
cat >/etc/ssh/sshd_config.d/60-boxery.conf <<'EOF'
MaxSessions 64
MaxStartups 64:30:128
EOF

# Reduce accidental persistence of secrets (see ARCHITECTURE.md, Secrets).
echo 'kernel.core_pattern=|/bin/false' >/etc/sysctl.d/60-boxery.conf
sysctl -q -p /etc/sysctl.d/60-boxery.conf 2>/dev/null || true   # not allowed in some containers/VMs; applies at next boot
systemctl disable --now apport.service 2>/dev/null || true

# GUI apps launched by agents show up on the shared desktop, if the VM has one.
cat >/etc/profile.d/boxery.sh <<'EOF'
[ -e /etc/boxery/headless ] || export DISPLAY=${DISPLAY:-:1}
EOF

cat >/etc/skel/.tmux.conf <<'EOF'
set -g extended-keys on
set -g mouse on
set -g history-limit 50000
set -g update-environment "DISPLAY SSH_AUTH_SOCK"
if-shell '[ ! -e /etc/boxery/headless ]' 'set-environment -g DISPLAY :1'
EOF
install -o agent -g agent -m 644 /etc/skel/.tmux.conf /home/agent/.tmux.conf

systemctl daemon-reload
systemctl enable boxery-llm.service >/dev/null 2>&1
systemctl enable qemu-guest-agent >/dev/null 2>&1 || true   # static unit on some releases
systemctl reload ssh.service 2>/dev/null || true
