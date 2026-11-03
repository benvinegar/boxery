#!/usr/bin/env bash
# GitHub Actions runners (docs/github-runners.md), offline: `boxery-host runners` config/token/status/start/stop
# against the fake backend (systemctl/launchctl stubbed), the controller's passthrough, and the guest side:
# image/layers/github-runner.sh's pins and its boxery-runner helper, run here with stand-ins for sudo,
# systemd-run and the runner itself. The manager's policy and a full run: test/runners.test.mjs.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
H=$ROOT/host/boxery-host A=$ROOT/controller/boxery LAYER=$ROOT/image/layers/github-runner.sh
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export HOME=$tmp/home BOXERY_CONF=$tmp/conf BOXERY_HOME=$tmp/ctl BOXERY_BACKEND=fake BOXERY_FAKE_DIR=$tmp/vms CALLS=$tmp/calls
mkdir -p "$tmp/bin" "$HOME/.ssh" "$BOXERY_CONF" "$BOXERY_FAKE_DIR"; : >"$CALLS"
echo "ssh-ed25519 AAAAtest mgmt" >"$BOXERY_CONF/mgmt_ed25519.pub"; touch "$BOXERY_CONF/mgmt_ed25519"
echo "ssh-ed25519 AAAAme me@laptop" >"$HOME/.ssh/id_ed25519.pub"; touch "$HOME/.ssh/id_ed25519"
for c in systemctl launchctl ssh; do printf '#!/bin/sh\necho "%s $*" >>"$CALLS"\ncase "$*" in *is-active*|*print*) exit 3 ;; esac\n' "$c" >"$tmp/bin/$c"; chmod +x "$tmp/bin/$c"; done
export PATH="$tmp/bin:$PATH"
pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }
mode() { if stat -f %Lp "$1" >/dev/null 2>&1; then stat -f %Lp "$1"; else stat -c %a "$1"; fi; }
TOKEN=ghp_FAKEfakeFAKEfakeFAKEfakeFAKEfake1234

echo "== runners config / token / status"
out=$("$H" runners status 2>&1) && [[ $out == *"not configured"* && $out == *"token      not set"* ]] && ok "status before any setup" || bad "status: $out"
out=$("$H" runners config --vms ci-1 2>&1) && bad "config without a repo accepted" || { [[ $out == *"--repo OWNER/REPO or --org ORG"* ]] && ok "config needs a repo or an org" || bad "config: $out"; }
out=$("$H" runners config --repo o/r 2>&1) && bad "config without VMs accepted" || { [[ $out == *"--vms NAME"* ]] && ok "config needs the runner VMs" || bad "config: $out"; }
out=$("$H" runners config --repo o/r --vms ci-1 --count 2 2>&1) && bad "count > VMs accepted" || ok "count can't exceed the VMs"
out=$("$H" runners config --repo o/r --vms ci-1 --api http://example.com 2>&1) && bad "plain http API accepted" || ok "the API must be https (or loopback)"
[[ ! -e $BOXERY_CONF/runners.json ]] && ok "...and a refused config saves nothing" || bad "runners.json written"
out=$("$H" runners config --repo o/r --vms ci-1,ci-2 --labels gpu,big 2>/dev/null) && jq -e '.repo == "o/r" and .count == 2 and .group == 1 and .ttl == 1800 and (.prefix | startswith("boxery-")) and .labels == ["gpu","big"]' <<<"$out" >/dev/null \
	&& [[ $(mode "$BOXERY_CONF/runners.json") == 600 ]] && ok "config saved (0600) with defaults: count = VMs, group 1, a host prefix" || bad "config: $out"
out=$("$H" runners config --org acme 2>/dev/null) && jq -e '.org == "acme" and (has("repo") | not) and .vms == ["ci-1","ci-2"]' <<<"$out" >/dev/null && ok "config changes only what it's given (--org replaces --repo)" || bad "config merge: $out"
"$H" runners config --repo o/r >/dev/null 2>&1
out=$(printf 'not a token\n' | "$H" runners token 2>&1) && bad "a bad token accepted" || { [[ $out != *"not a token"* ]] && ok "a bad token is refused without echoing it" || bad "token: $out"; }
out=$(printf '%s\n' "$TOKEN" | "$H" runners token 2>&1) && grep -qx "GITHUB_TOKEN=$TOKEN" "$BOXERY_CONF/runners.env" && [[ $(mode "$BOXERY_CONF/runners.env") == 600 && $out != *"$TOKEN"* ]] \
	&& ok "token stored 0600, from stdin, not echoed" || bad "token: $out"
out=$("$H" runners status 2>&1) && [[ $out == *"repo o/r, 2 runner(s) on ci-1 ci-2"* && $out == *"self-hosted linux "*" boxery gpu big"* && $out == *"token      set ("* && $out != *"$TOKEN"* ]] \
	&& ok "status: scope, VMs, labels, token set (never its value)" || bad "status: $out"
out=$("$H" runners status --json) && jq -e '.configured and .token and .vms_leased == [] and .service.unit == "boxery-runners"' <<<"$out" >/dev/null && [[ $out != *"$TOKEN"* ]] && ok "status --json" || bad "status --json: $out"
chmod 644 "$BOXERY_CONF/runners.env"
out=$("$H" runners status 2>&1); [[ $out == *"readable by other users"* ]] && ok "a token file others can read is refused" || bad "status: $out"
out=$("$H" runners start 2>&1) && bad "start with a readable token file" || ok "...and the manager won't start with it"
chmod 600 "$BOXERY_CONF/runners.env"
out=$("$H" runners bogus 2>&1) && bad "unknown subcommand accepted" || { [[ $out == *"usage: runners status"* ]] && ok "unknown subcommand: usage" || bad "usage: $out"; }

echo "== runners start / stop"
: >"$CALLS"
out=$("$H" runners start 2>&1) || bad "start: $out"
if [[ $(uname) == Darwin ]]; then
	p=$HOME/Library/LaunchAgents/dev.boxery-runners.plist
	grep -q "<string>$ROOT/host/boxery-host</string><string>runners</string><string>run</string>" "$p" && grep -q "launchctl bootstrap gui/$(id -u) $p" "$CALLS" && ok "start: launch agent written and loaded" || bad "start: $(cat "$CALLS")"
	"$H" runners stop >/dev/null 2>&1 && [[ ! -e $p ]] && grep -q "launchctl bootout gui/$(id -u)/dev.boxery-runners" "$CALLS" && ok "stop: unloaded and removed" || bad "stop: $(cat "$CALLS")"
else
	u=$HOME/.config/systemd/user/boxery-runners.service
	grep -q "^ExecStart=$ROOT/host/boxery-host runners run$" "$u" && grep -q 'systemctl --user enable --now boxery-runners.service' "$CALLS" && ok "start: unit written and enabled" || bad "start: $(cat "$CALLS")"
	"$H" runners stop >/dev/null 2>&1 && grep -q 'systemctl --user disable --now boxery-runners.service' "$CALLS" && ok "stop: disabled" || bad "stop: $(cat "$CALLS")"
fi

echo "== controller passthrough"
"$A" setup local --host-bin "$H" >/dev/null 2>&1 || bad "setup local"
out=$("$A" runners status 2>&1) && [[ $out == *"repo o/r"* ]] && ok "boxery runners status reaches the host" || bad "controller: $out"
out=$(printf '%s\n' "$TOKEN" | "$A" runners token 2>&1) && grep -qx "GITHUB_TOKEN=$TOKEN" "$BOXERY_CONF/runners.env" && ok "boxery runners token passes stdin through" || bad "controller token: $out"
"$A" help | grep -q 'runners status|start|stop|config|token' && ok "controller usage lists runners" || bad "controller usage"
out=$("$A" new hr --layers 'bad;x' 2>&1) && bad "a bad --layers value passed on" || { [[ $out == *"invalid layer list"* ]] && ok "controller checks --layers before calling the host" || bad "controller --layers: $out"; }

echo "== guest layer: image/layers/github-runner.sh"
v=$(sed -n 's/^VERSION=//p' "$LAYER")
[[ $v =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && ok "the runner version is pinned ($v)" || bad "VERSION: $v"
[[ $(grep -cE '^(amd64|arm64)\) ARCH=(x64|arm64) SHA256=[0-9a-f]{64} ;;$' "$LAYER") == 2 ]] && ok "a SHA-256 is pinned for x64 and arm64" || bad "hashes"
c=$(grep -n 'sha256sum -c' "$LAYER" | cut -d: -f1); t=$(grep -n 'tar -xzf' "$LAYER" | cut -d: -f1)
[[ -n $c && -n $t && $c -lt $t ]] && ok "the tarball is checked before it is unpacked" || bad "checksum order: $c $t"
grep -q 'releases/download/v$VERSION/$TGZ' "$LAYER" && grep -q 'bin/installdependencies.sh' "$LAYER" && grep -q 'chown -R agent:agent "$D"' "$LAYER" && ok "official release, its dependency script, owned by agent" || bad "layer steps"
! grep -qi 'token\|GITHUB_' "$LAYER" && ok "the layer handles no GitHub credential" || bad "credential in the layer"
grep -q '^for l in plumbing devtools desktop github-runner; do$' "$ROOT/image/layers/provision.sh" && ok "boxery-provision knows the layer" || bad "provision.sh"

echo "== guest helper: boxery-runner"
g=$tmp/guest; mkdir -p "$g/opt" "$g/gbin"
# The helper from the layer, pointed at this directory instead of /opt/actions-runner, /run/boxery-runner, /usr/local/sbin.
awk '/^cat >\/usr\/local\/sbin\/boxery-runner <<.EOF.$/{f=1; next} /^EOF$/{f=0} f' "$LAYER" \
	| sed -e "s#^D=/opt/actions-runner S=/run/boxery-runner U=boxery-runner#D=$g/opt S=$g/run U=boxery-runner#" -e "s#/usr/local/sbin/boxery-runner __run#$g/boxery-runner __run#" >"$g/boxery-runner"
chmod +x "$g/boxery-runner"
bash -n "$g/boxery-runner" && grep -q "^D=$g/opt " "$g/boxery-runner" && ok "the helper extracts and parses" || bad "helper: $(head -5 "$g/boxery-runner")"
# sudo: run the command (install's -o/-g need root: dropped); systemd-run: start the command in the
# background and record its pid; systemctl is-active: is it alive?
cat >"$g/gbin/sudo" <<EOF
#!/usr/bin/env bash
case \$1 in
install) shift; a=(); while [ \$# -gt 0 ]; do case \$1 in -o|-g) shift 2 ;; *) a+=("\$1"); shift ;; esac; done; exec install "\${a[@]}" ;;
systemd-run) shift; while [ \$# -gt 0 ]; do case \$1 in --*|-p) [ "\$1" = -p ] && shift; shift ;; *) break ;; esac; done
	"\$@" >/dev/null 2>&1 & echo \$! >"$g/unit.pid" ;;
systemctl) echo "systemctl \$*" >>"$g/calls" ;;
*) exec "\$@" ;;
esac
EOF
cat >"$g/gbin/systemctl" <<EOF
#!/bin/sh
[ -f "$g/unit.pid" ] && kill -0 "\$(cat "$g/unit.pid")" 2>/dev/null
EOF
# The runner: records its arguments, runs until told to finish, exits 3.
printf '#!/bin/sh\necho "$@" >"%s/args"\nwhile [ ! -e "%s/finish" ]; do sleep 0.05; done\nexit 3\n' "$g" "$g" >"$g/opt/run.sh"
chmod +x "$g/gbin/sudo" "$g/gbin/systemctl" "$g/opt/run.sh"
R() { PATH="$g/gbin:$PATH" "$g/boxery-runner" "$@"; }
st() { local rc=0; R status || rc=$?; echo "$rc"; }
wait_for() { for _ in $(seq 100); do [ -e "$1" ] && return 0; sleep 0.05; done; return 1; }
[[ $(st) == 2 ]] && ok "status before a start: 2 (none)" || bad "status: $(st)"
rc=0; R start </dev/null 2>/dev/null || rc=$?; [[ $rc == 2 && ! -e $g/run/started ]] && ok "start without a config on stdin is refused" || bad "empty start: $rc"
printf 'JIT-CONFIG' | R start && wait_for "$g/args" && [[ $(cat "$g/args") == "--jitconfig JIT-CONFIG" ]] && ok "start runs the runner with the JIT config from stdin" || bad "start: $(cat "$g/args" 2>&1)"
[[ $(mode "$g/run") == 700 && ! -e $g/run/jitconfig ]] && ok "the config is read and deleted; its directory is private" || bad "jitconfig left: $(ls -la "$g/run")"
[[ $(st) == 0 ]] && ok "status while it runs: 0" || bad "status running: $(st)"
rc=0; printf 'X' | R start 2>/dev/null || rc=$?; [[ $rc == 4 ]] && ok "a second start is refused (single-use VM)" || bad "second start: $rc"
touch "$g/finish"; wait_for "$g/run/exit"
[[ $(st) == 1 && $(cat "$g/run/exit") == 3 ]] && ok "status after it exits: 1, its exit code recorded" || bad "after exit: $(st) $(cat "$g/run/exit" 2>&1)"
rm -f "$g/opt/run.sh"; rm -rf "$g/run"
rc=0; printf 'X' | R start 2>/dev/null || rc=$?; [[ $rc == 3 ]] && ok "start without the runner installed: 3" || bad "no runner: $rc"
R stop && grep -q 'systemctl stop boxery-runner' "$g/calls" && ok "stop stops the unit" || bad "stop"

echo "passed: $pass  failed: $fail"; ((fail == 0))
