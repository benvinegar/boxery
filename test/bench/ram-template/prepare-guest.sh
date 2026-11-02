#!/usr/bin/env bash
# Run as root ONLY in a throwaway benchmark builder guest, never on the host.
set -euo pipefail
[[ $(id -u) == 0 && -f /usr/local/sbin/ram-template-agent.py ]] || exit 1
chmod 755 /usr/local/sbin/ram-template-agent.py
touch /etc/cloud/cloud-init.disabled
systemctl mask systemd-networkd-wait-online.service
cat >/etc/systemd/system/ram-template-agent.service <<'UNIT'
[Unit]
Description=LOCAL EXPERIMENT root vsock assignment agent
After=basic.target
[Service]
ExecStartPre=/sbin/modprobe vmw_vsock_virtio_transport
ExecStart=/usr/bin/python3 /usr/local/sbin/ram-template-agent.py
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
cat >/etc/systemd/system/ram-template-chrome.service <<'UNIT'
[Unit]
Description=LOCAL EXPERIMENT blank Chromium browser
After=systemd-user-sessions.service
[Service]
User=agent
Environment=DISPLAY=:1
ExecStartPre=/bin/bash -c 'for i in {1..200}; do test -S /tmp/.X11-unix/X1 && exit 0; sleep 0.05; done; exit 1'
# A cold boot from a disk paired with a RAM snapshot must not retain Chrome's old host/PID lock.
ExecStartPre=/usr/bin/rm -f /home/agent/.cache/ram-template-chrome/SingletonLock /home/agent/.cache/ram-template-chrome/SingletonSocket /home/agent/.cache/ram-template-chrome/SingletonCookie
ExecStart=/usr/bin/google-chrome --no-first-run --no-default-browser-check --disable-gpu --disable-dev-shm-usage --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=/home/agent/.cache/ram-template-chrome about:blank
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable ram-template-agent ram-template-chrome
# No real credentials, grants, SSH access or cloud-init user-data in the template.
rm -f /home/agent/.boxery/token /home/agent/.pi/agent/models.json /home/agent/.config/opencode/opencode.json
rm -f /home/agent/.ssh/authorized_keys /etc/ssh/ssh_host_*
rm -rf /var/lib/cloud /var/log/cloud-init.log /var/log/cloud-init-output.log
systemctl mask ssh.service ssh.socket
systemctl disable apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
sync
