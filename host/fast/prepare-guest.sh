#!/usr/bin/env bash
# ONLY a fresh disposable builder. build.py checks its hostname before invoking this over SSH.
set -euo pipefail
[[ $(id -u) == 0 && -f /usr/local/sbin/boxery-fast-agent.py ]] || exit 1
systemd-detect-virt --vm >/dev/null
chmod 755 /usr/local/sbin/boxery-fast-agent.py
mkdir -p /etc/boxery /etc/systemd/system /etc/ssh/sshd_config.d
touch /etc/cloud/cloud-init.disabled
printf '1\n' >/etc/boxery/fast-template
chmod 444 /etc/boxery/fast-template
cat >/etc/systemd/system/boxery-template.target <<'UNIT'
[Unit]
Description=Boxery clean template assignment barrier
DefaultDependencies=no
Requires=sysinit.target boxery-fast-agent.service
After=sysinit.target boxery-fast-agent.service
AllowIsolate=yes
UNIT
cat >/etc/systemd/system/boxery-fast-agent.service <<'UNIT'
[Unit]
Description=Boxery restore-time identity assignment
DefaultDependencies=no
After=sysinit.target
Before=multi-user.target
Conflicts=shutdown.target
[Service]
Type=simple
ExecStartPre=/sbin/modprobe vmw_vsock_virtio_transport
ExecStart=/usr/bin/python3 /usr/local/sbin/boxery-fast-agent.py
StandardOutput=null
StandardError=console
UNIT
# Fresh modern host keys without duplicated template key material or slow RSA generation.
printf 'HostKey /etc/ssh/ssh_host_ed25519_key\n' >/etc/ssh/sshd_config.d/60-boxery-fast.conf
systemctl disable ssh.socket 2>/dev/null || true
systemctl enable ssh.service
systemctl mask systemd-networkd-wait-online.service
systemctl set-default boxery-template.target
systemctl daemon-reload
rm -f /home/agent/.boxery/token /home/agent/.pi/agent/models.json /home/agent/.config/opencode/opencode.json
rm -f /home/agent/.ssh/authorized_keys /etc/ssh/ssh_host_* /etc/boxery/identity.json
rm -rf /var/lib/cloud /var/log/cloud-init.log /var/log/cloud-init-output.log
rm -rf /run/user/1000/boxery
# No user manager, SSH, D-Bus or application starts in the template boot. They start only once
# the agent has assigned fresh identity/entropy and acknowledged the host.
sync
