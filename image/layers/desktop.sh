#!/bin/bash
# boxery layer 3/3, desktop: XFCE on :1, TigerVNC + noVNC (localhost only, with a password), Firefox, Chrome
# (Chromium on arm64) and playwright-core for vm_browser, xdotool + ImageMagick for computer use. The heavy
# layer (~2 min to build), and the only reason a backend needs a built base: headless VMs skip it. Needs the
# dev-tools layer (node). Runs as root, idempotent.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# shellcheck source=/dev/null
. /usr/local/lib/boxery/layers/lib.sh

pkgs xfce4 xfce4-terminal xfce4-panel xfce4-session xfwm4 xfdesktop4 thunar \
	dbus-x11 x11-xserver-utils x11-utils xdotool imagemagick \
	tigervnc-standalone-server tigervnc-tools novnc websockify python3-numpy \
	fonts-dejavu-core adwaita-icon-theme-full apparmor

# Firefox as a real deb (not snap)
if ! dpkg-query -W -f='${Status}' firefox 2>/dev/null | grep -q 'install ok installed' || [ ! -f /etc/apt/sources.list.d/mozilla.list ]; then
	install -d -m 0755 /etc/apt/keyrings
	curl -fsSL https://packages.mozilla.org/apt/repo-signing-key.gpg -o /etc/apt/keyrings/packages.mozilla.org.asc
	echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main" >/etc/apt/sources.list.d/mozilla.list
	printf 'Package: *\nPin: origin packages.mozilla.org\nPin-Priority: 1000\n' >/etc/apt/preferences.d/mozilla
	apt-get update -qq && apt-get install -y -q firefox
fi

# Browser for CDP/Playwright control. amd64: Google Chrome deb. arm64 (Apple Silicon/Lima): Google ships no
# Linux arm64 Chrome and Ubuntu's chromium is a snap, so use Playwright's Chromium build, exposed as
# `google-chrome` (below, after playwright-core).
if [ "$(dpkg --print-architecture)" = amd64 ] && ! command -v google-chrome >/dev/null; then
	curl -fsSLo /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
	apt-get install -y -q /tmp/chrome.deb && rm -f /tmp/chrome.deb
fi

# Playwright client used by the laptop extension's vm_browser tool (talks CDP to the desktop Chrome)
[ -f /opt/boxery/node_modules/playwright-core/index.mjs ] || npm install --prefix /opt/boxery playwright-core
ls /opt/boxery/node_modules/playwright-core/index.mjs
# Ubuntu restricts user namespaces by executable path. Chrome's deb has a distro profile, but Playwright's
# ARM64 Chromium needs its own so the browser can keep its sandbox enabled.
cat >/etc/apparmor.d/boxery-chromium <<'EOF'
abi <abi/4.0>,
include <tunables/global>
profile boxery-chromium /opt/boxery/browsers/chromium-*/chrome-linux*/chrome flags=(unconfined) {
  userns,
}
EOF
if ! command -v google-chrome >/dev/null; then
	PLAYWRIGHT_BROWSERS_PATH=/opt/boxery/browsers node /opt/boxery/node_modules/playwright-core/cli.js install --with-deps chromium
	CH=$(ls -d /opt/boxery/browsers/chromium-*/chrome-linux*/chrome | head -1)
	printf '#!/bin/sh\nexec %s "$@"\n' "$CH" >/usr/local/bin/google-chrome && chmod +x /usr/local/bin/google-chrome
	apparmor_parser -r /etc/apparmor.d/boxery-chromium
fi
google-chrome --version

mkdir -p /usr/share/novnc
echo '<meta http-equiv="refresh" content="0; url=vnc.html?autoconnect=1&resize=remote&reconnect=1">' >/usr/share/novnc/index.html

# The VNC password. TigerVNC's VncAuth uses 8 characters at most: 8 random letters and digits, kept on the
# agent user's tmpfs (/run/user/UID: gone at shutdown, never on the disk). boxery-vnc.service makes one
# before every start, so the desktop is never open, even if nobody runs `boxery desktop`; `boxery desktop`
# sets a fresh one for each session (--new) and hands it to noVNC in the URL fragment. Xtigervnc reads the
# file at each login: a new password applies to the next connection, and connections already open stay.
cat >/usr/local/bin/boxery-vnc-password <<'EOF'
#!/bin/sh
# boxery-vnc-password [--new]: make the desktop's VNC password if there is none; --new replaces it and prints it.
set -eu
d=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/boxery-vnc
umask 077
mkdir -p "$d" && chmod 700 "$d"
[ "${1:-}" = --new ] || [ ! -s "$d/passwd" ] || exit 0
p=$(LC_ALL=C tr -dc A-Za-z0-9 </dev/urandom | head -c 8)
[ ${#p} = 8 ] || { echo "boxery-vnc-password: could not generate a password" >&2; exit 1; }
printf '%s\n' "$p" | vncpasswd -f >"$d/passwd.new"
mv -f "$d/passwd.new" "$d/passwd"
[ "${1:-}" != --new ] || echo "$p"
EOF
chmod 755 /usr/local/bin/boxery-vnc-password

# Desktop services for the agent user (systemd user units, started at boot through lingering).
U=/etc/skel/.config/systemd/user
mkdir -p "$U"
cat >"$U/boxery-vnc.service" <<'EOF'
[Unit]
Description=boxery: TigerVNC X server :1 (localhost only, password required)
[Service]
ExecStartPre=/usr/local/bin/boxery-vnc-password
ExecStart=/usr/bin/Xtigervnc :1 -localhost=1 -rfbport 5901 -SecurityTypes VncAuth -PasswordFile %t/boxery-vnc/passwd -geometry 1600x1000 -depth 24 -AlwaysShared -desktop boxery
Restart=always
RestartSec=2
[Install]
WantedBy=default.target
EOF
cat >"$U/boxery-desktop.service" <<'EOF'
[Unit]
Description=boxery: XFCE session on :1
After=boxery-vnc.service
Requires=boxery-vnc.service
[Service]
Environment=DISPLAY=:1
ExecStartPre=/bin/sh -c 'for i in $(seq 100); do [ -S /tmp/.X11-unix/X1 ] && exit 0; sleep 0.2; done; exit 1'
ExecStart=/usr/bin/dbus-launch --exit-with-session /usr/bin/startxfce4
Restart=always
RestartSec=2
[Install]
WantedBy=default.target
EOF
cat >"$U/boxery-novnc.service" <<'EOF'
[Unit]
Description=boxery: noVNC on 127.0.0.1:6080
After=boxery-vnc.service
[Service]
ExecStart=/usr/bin/websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5901
Restart=always
RestartSec=2
[Install]
WantedBy=default.target
EOF
cp -rT /etc/skel/.config /home/agent/.config
mkdir -p /home/agent/.config/systemd/user/default.target.wants
for s in boxery-vnc boxery-desktop boxery-novnc; do
	ln -sf "/home/agent/.config/systemd/user/$s.service" "/home/agent/.config/systemd/user/default.target.wants/$s.service"
done
chown -R agent:agent /home/agent/.config
mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/agent
