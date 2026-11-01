#!/usr/bin/env bash
# boxery-host init, add-key and build-base against the fake backend: state directory and permissions,
# host.env, the proxy/reaper service files, and the service manager calls (systemctl/launchctl stubbed).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
H=$ROOT/host/boxery-host
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export HOME=$tmp/home BOXERY_CONF=$tmp/conf BOXERY_BACKEND=fake BOXERY_FAKE_DIR=$tmp/vms BOXERY_PROXY_PORT=9999 CALLS=$tmp/calls
mkdir -p "$tmp/bin" "$HOME"; : >"$CALLS"
for c in systemctl launchctl ssh-keygen; do
	printf '#!/bin/sh\necho "%s $*" >>"$CALLS"\n' "$c" >"$tmp/bin/$c"; chmod +x "$tmp/bin/$c"
done
# ssh-keygen stub: write the key pair it was asked for
printf '#!/bin/sh\necho "ssh-keygen $*" >>"$CALLS"; while [ $# -gt 1 ]; do shift; done; echo "ssh-ed25519 AAAAhost boxery-host" >"$1.pub"; : >"$1"\n' >"$tmp/bin/ssh-keygen"
export PATH="$tmp/bin:$PATH"
pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }
mode() { if stat -f %Lp "$1" >/dev/null 2>&1; then stat -f %Lp "$1"; else stat -c %a "$1"; fi; }

echo "== init"
out=$(BOXERY_NO_SERVICES=1 BOXERY_NET=isolated "$H" init 2>&1) && ok "init succeeds" || bad "init: $out"
[[ $out == *"init done. Next: boxery-host build-base"* ]] && ok "init says what's next" || bad "output: $out"
[[ $(mode "$BOXERY_CONF") == 700 ]] && ok "state directory is 0700" || bad "conf mode $(mode "$BOXERY_CONF")"
for f in tokens.json authorized_keys proxy.env; do [[ $(mode "$BOXERY_CONF/$f") == 600 ]] && ok "$f is 0600" || bad "$f mode $(mode "$BOXERY_CONF/$f")"; done
[[ $(cat "$BOXERY_CONF/tokens.json") == "{}" ]] && ok "empty token table" || bad "tokens: $(cat "$BOXERY_CONF/tokens.json")"
grep -q AAAAhost "$BOXERY_CONF/mgmt_ed25519.pub" && ok "host management key created" || bad "no host key"
e=$BOXERY_CONF/host.env
grep -qx BOXERY_BACKEND=fake "$e" && grep -qx BOXERY_PROXY_PORT=9999 "$e" && grep -qx BOXERY_PROXY_UNIT=boxery-proxy "$e" && ok "host.env: backend, proxy port and unit" || bad "host.env: $(cat "$e")"
grep -q '^BOXERY_NODE=/' "$e" && ok "host.env records the node to run" || bad "BOXERY_NODE: $(cat "$e")"
grep -qx BOXERY_NET=isolated "$e" && ok "host.env keeps backend settings given at init (BOXERY_NET)" || bad "BOXERY_NET: $(cat "$e")"
[[ ! -e $HOME/.local/bin/boxery-host ]] && ok "no symlinks with an explicit BOXERY_CONF" || bad "symlinked"
if [[ $(uname) == Darwin ]]; then
	p=$HOME/Library/LaunchAgents/dev.boxery-proxy.plist
	grep -q "<string>$ROOT/proxy/boxery-proxy.mjs</string>" "$p" && grep -q '<key>BOXERY_PROXY_PORT</key><string>9999</string>' "$p" && ok "proxy launch agent" || bad "plist: $(cat "$p" 2>&1)"
	grep -q "launchctl bootstrap gui/$(id -u) $p" "$CALLS" && ok "proxy agent loaded" || bad "calls: $(cat "$CALLS")"
	[[ ! -e $HOME/Library/LaunchAgents/dev.boxery-reaper.plist ]] && ok "BOXERY_NO_SERVICES: no reaper" || bad "reaper installed"
else
	u=$HOME/.config/systemd/user/boxery-proxy.service
	grep -q "ExecStart=.* $ROOT/proxy/boxery-proxy.mjs" "$u" && grep -q 'Environment=BOXERY_PROXY_PORT=9999' "$u" && ok "proxy unit" || bad "unit: $(cat "$u" 2>&1)"
	grep -q "systemctl --user enable --now boxery-proxy.service" "$CALLS" && ok "proxy unit enabled" || bad "calls: $(cat "$CALLS")"
	[[ ! -e $HOME/.config/systemd/user/boxery-reaper.timer ]] && ok "BOXERY_NO_SERVICES: no reaper" || bad "reaper installed"
fi
echo "# my key" >"$BOXERY_CONF/proxy.env"
BOXERY_NO_SERVICES=1 "$H" init >/dev/null 2>&1 && [[ $(cat "$BOXERY_CONF/proxy.env") == "# my key" ]] && ok "re-running init keeps proxy.env" || bad "proxy.env overwritten"
: >"$CALLS"
"$H" init >/dev/null 2>&1 || bad "init with services"
if [[ $(uname) == Darwin ]]; then grep -q 'dev.boxery-reaper.plist' "$CALLS" && ok "reaper agent loaded" || bad "reaper: $(cat "$CALLS")"
else grep -q 'enable --now boxery-reaper.timer' "$CALLS" && ok "reaper timer enabled" || bad "reaper: $(cat "$CALLS")"; fi
err=$("$H" init --backend nope 2>&1) && bad "init --backend nope succeeded" || { [[ $err == *"unknown backend 'nope'"* ]] && ok "init --backend rejects an unknown backend" || bad "error: $err"; }

echo "== add-key"
echo "ssh-ed25519 AAAAlaptop me@laptop" | "$H" add-key >/dev/null 2>&1 && grep -qx "ssh-ed25519 AAAAlaptop me@laptop" "$BOXERY_CONF/authorized_keys" && ok "add-key appends" || bad "add-key"
out=$(echo "ssh-ed25519 AAAAlaptop me@laptop" | "$H" add-key 2>&1) && [[ $(grep -c AAAAlaptop "$BOXERY_CONF/authorized_keys") == 1 && $out == *"(1 total)"* ]] && ok "add-key is idempotent" || bad "duplicate: $out"
if echo hello | "$H" add-key >/dev/null 2>&1; then bad "add-key accepted a non-key"; else ok "add-key rejects non-keys"; fi

echo "== build-base"
"$H" build-base >/dev/null 2>&1 && [[ -f $BOXERY_FAKE_DIR/.base ]] && ok "build-base runs the backend's build" || bad "build-base"

echo; echo "passed: $pass  failed: $fail"; ((fail == 0))
