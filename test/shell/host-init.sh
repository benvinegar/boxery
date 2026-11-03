#!/usr/bin/env bash
# boxery-host init, add-key and build-base against the fake backend: state directory and permissions,
# host.env, the proxy/reaper service files, and the service manager calls (systemctl/launchctl stubbed).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
H=$ROOT/host/boxery-host
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export HOME=$tmp/home BOXERY_CONF=$tmp/conf BOXERY_BACKEND=fake BOXERY_FAKE_DIR=$tmp/vms BOXERY_PROXY_PORT=9999 CALLS=$tmp/calls
export BOXERY_STUB_SERVICES=1   # HOME is a temp dir: init refuses it unless the service managers are stubs (below)
mkdir -p "$tmp/bin" "$HOME"; : >"$CALLS"
for c in systemctl ssh-keygen; do
	printf '#!/bin/sh\necho "%s $*" >>"$CALLS"\n' "$c" >"$tmp/bin/$c"; chmod +x "$tmp/bin/$c"
done
# systemctl is-active: inactive (3), unless RUNNERS_ACTIVE=1 (the runner manager runs)
printf '#!/bin/sh\necho "systemctl $*" >>"$CALLS"\ncase "$*" in *is-active*) [ "${RUNNERS_ACTIVE:-}" = 1 ] || exit 3 ;; esac\n' >"$tmp/bin/systemctl"
# launchctl stub: after a bootout the job stays visible to print for LAUNCHD_LINGER calls, and the first
# LAUNCHD_BOOTSTRAP_FAILS bootstraps fail the way launchd does while it is still removing the job.
cat >"$tmp/bin/launchctl" <<'STUB'
#!/bin/sh
echo "launchctl $*" >>"$CALLS"
st=$CALLS.launchd
case $1 in
bootout) echo "${LAUNCHD_LINGER:-0}" >"$st.linger" ;;
print) n=$(cat "$st.linger" 2>/dev/null || echo 0); [ "$n" -gt 0 ] || exit 113; echo $((n - 1)) >"$st.linger" ;;
bootstrap) n=$(cat "$st.fails" 2>/dev/null || echo "${LAUNCHD_BOOTSTRAP_FAILS:-0}"); echo $((n > 0 ? n - 1 : 0)) >"$st.fails"
	[ "$n" -eq 0 ] || { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; } ;;
esac
STUB
chmod +x "$tmp/bin/launchctl"
# ssh-keygen stub: write the key pair it was asked for
printf '#!/bin/sh\necho "ssh-keygen $*" >>"$CALLS"; while [ $# -gt 1 ]; do shift; done; echo "ssh-ed25519 AAAAhost boxery-host" >"$1.pub"; : >"$1"\n' >"$tmp/bin/ssh-keygen"
export PATH="$tmp/bin:$PATH"
pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }
mode() { if stat -f %Lp "$1" >/dev/null 2>&1; then stat -f %Lp "$1"; else stat -c %a "$1"; fi; }

echo "== init"
# Without BOXERY_STUB_SERVICES a temp HOME is refused before anything is written or loaded: the real
# launchctl would put this HOME's dev.boxery-proxy in place of the account's own (it did, from a test).
err=$(env -u BOXERY_STUB_SERVICES "$H" init 2>&1) && bad "init ran with HOME not the account's home" || { [[ $err == *"HOME=$HOME is not this account's home"* && ! -s $CALLS && ! -e $BOXERY_CONF ]] && ok "init refuses a HOME that isn't the account's: no service manager call, nothing written" || bad "error: $err; calls: $(cat "$CALLS")"; }
out=$(BOXERY_NO_SERVICES=1 BOXERY_NET=isolated "$H" init 2>&1) && ok "init succeeds" || bad "init: $out"
[[ $out == *"init done. Next: boxery-host build-base"* ]] && ok "init says what's next" || bad "output: $out"
[[ $(mode "$BOXERY_CONF") == 700 ]] && ok "state directory is 0700" || bad "conf mode $(mode "$BOXERY_CONF")"
for f in tokens.json authorized_keys proxy.env runners.env; do [[ $(mode "$BOXERY_CONF/$f") == 600 ]] && ok "$f is 0600" || bad "$f mode $(mode "$BOXERY_CONF/$f")"; done
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
	grep -q "systemctl --user enable --now boxery-proxy.service boxery-fake-bridge.service" "$CALLS" && ok "proxy unit and the default profile's bridge enabled" || bad "calls: $(cat "$CALLS")"
	[[ ! -e $HOME/.config/systemd/user/boxery-reaper.timer ]] && ok "BOXERY_NO_SERVICES: no reaper" || bad "reaper installed"
fi
echo "# my key" >"$BOXERY_CONF/proxy.env"
BOXERY_NO_SERVICES=1 "$H" init >/dev/null 2>&1 && [[ $(cat "$BOXERY_CONF/proxy.env") == "# my key" ]] && ok "re-running init keeps proxy.env" || bad "proxy.env overwritten"
: >"$CALLS"
"$H" init >/dev/null 2>&1 || bad "init with services"
if [[ $(uname) == Darwin ]]; then grep -q 'dev.boxery-reaper.plist' "$CALLS" && ok "reaper agent loaded" || bad "reaper: $(cat "$CALLS")"
else grep -q 'enable --now boxery-reaper.timer' "$CALLS" && ok "reaper timer enabled" || bad "reaper: $(cat "$CALLS")"; fi
# The GitHub runner manager (docs/github-runners.md): installed, but on only after `runners start`; an
# init while it runs (an upgrade) restarts it on the new code.
grep -q '^#GITHUB_TOKEN=$' "$BOXERY_CONF/runners.env" && ok "runners.env: a template, no token" || bad "runners.env: $(cat "$BOXERY_CONF/runners.env")"
if [[ $(uname) == Darwin ]]; then
	rp=$HOME/Library/LaunchAgents/dev.boxery-runners.plist
	[[ ! -e $rp ]] && ! grep -q boxery-runners "$CALLS" && ok "runner manager not installed until started (launchd loads every agent at login)" || bad "runners: $(cat "$CALLS")"
	echo started >"$rp"; : >"$CALLS"
	"$H" init >/dev/null 2>&1 && grep -q "<string>runners</string><string>run</string>" "$rp" && grep -q "launchctl bootstrap gui/$(id -u) $rp" "$CALLS" \
		&& ok "init reloads a started runner manager" || bad "runners reload: $(cat "$CALLS")"
else
	ru=$HOME/.config/systemd/user/boxery-runners.service
	grep -q "^ExecStart=$ROOT/host/boxery-host runners run$" "$ru" && ! grep -q 'boxery-runners.service' <(grep -v is-active "$CALLS") \
		&& ok "runner manager unit installed, not enabled" || bad "runners unit: $(cat "$ru" 2>&1) calls: $(cat "$CALLS")"
	: >"$CALLS"
	RUNNERS_ACTIVE=1 "$H" init >/dev/null 2>&1 && grep -q 'systemctl --user restart --no-block boxery-runners.service' "$CALLS" && ok "init restarts a running runner manager" || bad "runners restart: $(cat "$CALLS")"
fi
if [[ $(uname) == Darwin ]]; then
	: >"$CALLS"; rm -f "$CALLS".launchd.*
	out=$(LAUNCHD_LINGER=3 LAUNCHD_BOOTSTRAP_FAILS=2 BOXERY_NO_SERVICES=1 "$H" init 2>&1) && ok "launchd: init outlasts a job still being removed" || bad "init: $out; calls: $(cat "$CALLS")"
	[[ $(grep -c '^launchctl print' "$CALLS") == 4 ]] && ok "...waits until print no longer finds the old job" || bad "calls: $(cat "$CALLS")"
	[[ $(grep -c '^launchctl bootstrap' "$CALLS") == 3 ]] && ok "...and retries the bootstrap until it takes" || bad "calls: $(cat "$CALLS")"
	: >"$CALLS"; rm -f "$CALLS".launchd.*
	out=$(LAUNCHD_BOOTSTRAP_FAILS=9 BOXERY_NO_SERVICES=1 "$H" init 2>&1) && bad "init succeeded though bootstrap kept failing" ||
		{ [[ $out == *"Input/output error"* && $(grep -c '^launchctl bootstrap' "$CALLS") == 5 ]] && ok "launchd: a bootstrap that keeps failing fails init after 5 tries, with launchctl's error" || bad "out: $out; calls: $(cat "$CALLS")"; }
	rm -f "$CALLS".launchd.*
fi
err=$("$H" init --backend nope 2>&1) && bad "init --backend nope succeeded" || { [[ $err == *"unknown backend 'nope'"* ]] && ok "init --backend rejects an unknown backend" || bad "error: $err"; }

echo "== add-key"
echo "ssh-ed25519 AAAAlaptop me@laptop" | "$H" add-key >/dev/null 2>&1 && grep -qx "ssh-ed25519 AAAAlaptop me@laptop" "$BOXERY_CONF/authorized_keys" && ok "add-key appends" || bad "add-key"
out=$(echo "ssh-ed25519 AAAAlaptop me@laptop" | "$H" add-key 2>&1) && [[ $(grep -c AAAAlaptop "$BOXERY_CONF/authorized_keys") == 1 && $out == *"(1 total)"* ]] && ok "add-key is idempotent" || bad "duplicate: $out"
if echo hello | "$H" add-key >/dev/null 2>&1; then bad "add-key accepted a non-key"; else ok "add-key rejects non-keys"; fi

echo "== build-base"
"$H" build-base >/dev/null 2>&1 && [[ -f $BOXERY_FAKE_DIR/.base ]] && ok "build-base runs the backend's build" || bad "build-base"

echo "== --profile"
# A second profile beside the one above (found through its service files, on port 9999).
P=(env -u BOXERY_CONF -u BOXERY_PROXY_PORT "$H" --profile two)
pc=$HOME/.config/boxery-two
err=$("${P[@]}" ls 2>&1) && bad "--profile accepted a missing profile" || { [[ $err == *"no profile 'two'"*"--profile two init"* ]] && ok "--profile refuses a profile that was never created" || bad "error: $err"; }
err=$("$H" --profile ../x ls 2>&1) && bad "--profile accepted ../x" || { [[ $err == *"invalid profile name"* ]] && ok "--profile validates the name" || bad "error: $err"; }
err=$(BOXERY_CONF=$tmp/other "$H" --profile two init 2>&1) && bad "--profile with another BOXERY_CONF" || { [[ $err == *conflicts* ]] && ok "--profile refuses a different BOXERY_CONF" || bad "error: $err"; }
# The namespace check runs before the backend's own checks, so lima can be refused offline.
lp=$HOME/.config/boxery-lima1; mkdir -p "$lp"; printf 'BOXERY_BACKEND=lima\nBOXERY_PROXY_PORT=8100\nBOXERY_PROXY_UNIT=boxery-proxy-lima1\n' >"$lp/host.env"
err=$("${P[@]}" init --backend lima 2>&1) && bad "a second lima profile was created" || { [[ $err == *"$lp"*"already uses the lima backend"*BOXERY_LIMA_PREFIX* && ! -e $pc ]] && ok "same backend and settings as another profile: refused, nothing written" || bad "error: $err"; }
rm -rf "$lp"
err=$(env -u BOXERY_CONF BOXERY_PROXY_PORT=9999 BOXERY_FAKE_DIR="$tmp/vms-two" "$H" --profile two init --backend fake 2>&1) && bad "a taken proxy port was accepted" || { [[ $err == *"proxy port 9999 is already used"* ]] && ok "an explicit proxy port another profile uses: refused" || bad "error: $err"; }
: >"$CALLS"
out=$(BOXERY_FAKE_DIR=$tmp/vms-two "${P[@]}" init --backend fake 2>&1) && ok "--profile init creates the profile (same backend as the other one: fake has no namespace to check)" || bad "init: $out"
e=$pc/host.env
port=$(sed -n 's/^BOXERY_PROXY_PORT=//p' "$e")
[[ $port =~ ^80(89|9[0-9])$ ]] && ok "picks a free proxy port ($port)" || bad "port: $(cat "$e")"
grep -qx BOXERY_BACKEND=fake "$e" && grep -qx BOXERY_PROXY_UNIT=boxery-proxy-two "$e" && ok "host.env: backend and its own service name" || bad "host.env: $(cat "$e")"
[[ $out == *"Next: boxery-host --profile two build-base"* ]] && ok "says how to build its base" || bad "output: $out"
if [[ $(uname) == Darwin ]]; then
	grep -q "<key>BOXERY_CONF</key><string>$pc</string>" "$HOME/Library/LaunchAgents/dev.boxery-proxy-two.plist" && [[ -f $HOME/Library/LaunchAgents/dev.boxery-reaper-two.plist ]] && ok "its own proxy and reaper agents" || bad "agents: $(ls "$HOME/Library/LaunchAgents")"
else
	grep -q "Environment=BOXERY_CONF=$pc" "$HOME/.config/systemd/user/boxery-proxy-two.service" && [[ -f $HOME/.config/systemd/user/boxery-reaper-two.timer ]] && ok "its own proxy and reaper units" || bad "units: $(ls "$HOME/.config/systemd/user")"
fi
grep -q 'boxery-proxy\.service\|dev\.boxery-proxy\.plist\|boxery-fake-bridge\.service' "$CALLS" && bad "touched the other profile's proxy: $(cat "$CALLS")" || ok "leaves the other profile's services alone"
if [[ $(uname) != Darwin ]]; then
	grep -q "systemctl --user enable --now boxery-proxy-two.service boxery-fake-bridge-two.service" "$CALLS" && ok "enables the backend's bridge under the profile's own name (#117)" || bad "bridge: $(grep enable "$CALLS")"
fi
BOXERY_FAKE_DIR=$tmp/vms-two "${P[@]}" init >/dev/null 2>&1 && [[ $(sed -n 's/^BOXERY_PROXY_PORT=//p' "$e") == "$port" ]] && ok "re-running init keeps its port" || bad "re-init: $(cat "$e")"
out=$("${P[@]}" backend) && [[ $out == fake ]] && ok "--profile commands use that profile" || bad "backend: $out"
out=$(env -u BOXERY_CONF "$H" profiles --json) && [[ $out == *'"name":"two"'*'"backend":"fake"'* && $out == *"\"conf\":\"$BOXERY_CONF\""* ]] && ok "profiles lists both" || bad "profiles: $out"

echo; echo "passed: $pass  failed: $fail"; ((fail == 0))
