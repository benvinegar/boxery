#!/usr/bin/env bash
# boxery-host version/upgrade against a throwaway git "origin" and a clone of it as the install, the fake
# backend, a stub systemctl and a real LLM proxy. HOME is a temp dir: service files, profiles and
# ~/.local/bin stay inside it. Covers: no-op when current, fast-forward + re-init of every profile using
# the install, refusing a dirty checkout, waiting for in-flight operations (and timing out cleanly), and
# rolling back when the new version fails its checks. Also: init's service PATH finds the backend's tools.
set -euo pipefail
node --disable-warning=ExperimentalWarning -e 'require("node:sqlite")' 2>/dev/null || { echo "SKIP: node:sqlite unavailable (need Node >= 22.13)"; exit 0; }
[[ $(uname) == Linux ]] || { echo "SKIP: systemd-unit layout (launchd parsing is covered by test/upgrade.test.mjs)"; exit 0; }
command -v git >/dev/null || { echo "SKIP: git unavailable"; exit 0; }
SRC=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d)
proxies=()
cleanup() { [ -n "${KEEP:-}" ] && { echo "kept $tmp"; return; }; for p in "${proxies[@]}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$tmp"; }
trap cleanup EXIT
export HOME=$tmp/home BOXERY_BACKEND=fake BOXERY_FAKE_DIR=$tmp/vms BOXERY_BOOT_ID=boot-1 BOXERY_SSH_WAIT_TRIES=1
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=$tmp/gitconfig GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset BOXERY_CONF BOXERY_PROXY_PORT BOXERY_PROXY_UNIT
# Even if a real systemctl were found, it must not reach this user's service manager.
export XDG_RUNTIME_DIR=$tmp/run DBUS_SESSION_BUS_ADDRESS=unix:path=$tmp/run/no-bus
mkdir -p "$tmp/run"
git config --global init.defaultBranch master
git config --global advice.detachedHead false
mkdir -p "$HOME" "$tmp/bin" "$tmp/tools" "$tmp/vms"
touch "$tmp/vms/.base"
# Stubs: systemctl logs its calls; ssh "VMs" are always ready; a backend tool that only lives off the login PATH.
printf '#!/bin/sh\necho "$*" >>"%s/systemctl.log"\n' "$tmp" >"$tmp/bin/systemctl"
printf '#!/bin/sh\nexit 0\n' >"$tmp/bin/ssh"
command -v nc >/dev/null || printf '#!/bin/sh\nexit 0\n' >"$tmp/bin/nc"
printf '#!/bin/sh\nexit 0\n' >"$tmp/tools/limactl"
chmod +x "$tmp"/bin/* "$tmp/tools/limactl"
export PATH="$tmp/bin:$tmp/tools:$PATH"
pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }

# origin: this source tree at v0.7.0; the install is a clone of it on master.
mkdir "$tmp/origin"
(cd "$SRC" && git ls-files -co --exclude-standard -z | xargs -0 -I{} cp --parents {} "$tmp/origin/") 2>/dev/null ||
	(cd "$SRC" && tar --exclude=.git -cf - . | tar -C "$tmp/origin" -xf -)
og() { git -C "$tmp/origin" "$@"; }
og init -q; og add -A; og commit -qm v1; og tag v0.7.0
git clone -q "$tmp/origin" "$tmp/install"
I=$tmp/install; H=$I/host/boxery-host
ig() { git -C "$I" "$@"; }

port=$((20000 + RANDOM % 20000))
p1=$HOME/.config/boxery p2=$HOME/.config/boxery-two
BOXERY_PROXY_PORT=$port "$H" init >/dev/null 2>&1 && ok "init: default profile" || bad "init default"
BOXERY_CONF=$p2 BOXERY_PROXY_PORT=$((port + 1)) BOXERY_PROXY_UNIT=boxery-proxy-two "$H" init >/dev/null 2>&1 && ok "init: second profile" || bad "init two"
units=$HOME/.config/systemd/user
grep -q "PATH=.*$tmp/tools" "$units/boxery-reaper.service" && ok "reaper PATH includes the backend tools' directory" || bad "reaper PATH: $(grep PATH "$units/boxery-reaper.service")"
[[ $(readlink "$HOME/.local/bin/boxery-host") == "$H" ]] && ok "init links ~/.local/bin/boxery-host" || bad "symlink"
# The proxies, as the services would run them (systemctl is a stub).
for c in "$p1:$port" "$p2:$((port + 1))"; do
	BOXERY_CONF=${c%:*} BOXERY_PROXY_PORT=${c##*:} node "$SRC/proxy/boxery-proxy.mjs" >/dev/null 2>&1 & proxies+=($!); disown $!
done
healthy() { node -e 'Promise.all(process.argv.slice(1).map((p) => fetch(`http://127.0.0.1:${p}/healthz`))).then((r) => process.exit(r.every((x) => x.ok) ? 0 : 1), () => process.exit(1))' "$@"; }
for _ in $(seq 50); do healthy "$port" "$((port + 1))" && break; sleep 0.1; done

v=$("$H" version --json)
[[ $(jq -r .install <<<"$v") == git && $(jq -r .describe <<<"$v") == v0.7.0 && $(jq -r .version <<<"$v") == 0.7.0 ]] && ok "version --json" || bad "version: $v"
"$H" version | grep -q '^0.7.0 .*git' && ok "version (text)" || bad "version text: $("$H" version)"

out=$("$H" upgrade 2>&1) && grep -q "up to date" <<<"$out" && ok "upgrade when current is a no-op" || bad "no-op: $out"
grep -q "profiles: $p1, $p2" <<<"$out" && ok "upgrade finds every profile whose services run this install" || bad "profiles: $out"

# A new release upstream.
echo "# v2" >>"$tmp/origin/README.md"; og commit -qam v2; og tag v0.7.1; v2=$(og rev-parse HEAD)
out=$("$H" upgrade --check 2>&1) && grep -q "v0.7.0 → v0.7.1" <<<"$out" && [[ $(ig rev-parse HEAD) != "$v2" ]] && ok "--check reports without changing anything" || bad "--check: $out"

echo dirty >>"$I/README.md"
out=$("$H" upgrade 2>&1) && bad "dirty checkout upgraded" || { grep -q "uncommitted changes" <<<"$out" && ok "refuses a checkout with uncommitted changes" || bad "dirty: $out"; }
ig checkout -q README.md

# An operation in flight: the upgrade waits for it, and gives up cleanly at --wait.
"$H" new busy >/dev/null 2>&1 & busy=$!
BOXERY_FAKE_PAUSE=new "$H" new held >/dev/null 2>&1 & held=$!
for _ in $(seq 100); do [[ -e $tmp/vms/.barriers/held.new ]] && break; sleep 0.05; done
wait "$busy" || true
rc=0; out=$("$H" upgrade --wait 1 2>&1) || rc=$?
[[ $rc == 75 ]] && grep -q "timed out" <<<"$out" && [[ $(ig rev-parse HEAD) != "$v2" ]] && ok "times out (exit 75) on an in-flight operation, nothing changed" || bad "timeout rc=$rc: $out"
"$H" upgrade --wait 30 >"$tmp/up.log" 2>&1 & up=$!
sleep 1
kill -0 "$up" 2>/dev/null && [[ $(ig rev-parse HEAD) != "$v2" ]] && ok "upgrade waits while the operation runs" || bad "did not wait: $(cat "$tmp/up.log")"
: >"$tmp/systemctl.log"
touch "$tmp/vms/.barriers/held.new.release"
wait "$held" || true
if wait "$up"; then ok "upgrade completes once the operation finishes"; else bad "upgrade failed: $(cat "$tmp/up.log")"; fi
[[ $(ig rev-parse HEAD) == "$v2" ]] && ok "fast-forwarded to origin/master" || bad "HEAD $(ig rev-parse HEAD)"
! grep -q "Failed\|bus" "$tmp/up.log" && grep -q "restart boxery-proxy.service" "$tmp/systemctl.log" && grep -q "restart boxery-proxy-two.service" "$tmp/systemctl.log" && ok "re-ran init for both profiles (services restarted)" || bad "systemctl: $(cat "$tmp/systemctl.log")"
grep -q "proxy healthy on :$port" "$tmp/up.log" && grep -q "$p2: .* VMs" "$tmp/up.log" && ok "checked each profile after init" || bad "checks: $(cat "$tmp/up.log")"
jq -e '.busy and .held' "$p1/tokens.json" >/dev/null && ok "in-flight operation finished normally" || bad "tokens: $(cat "$p1/tokens.json")"
[[ $(node --disable-warning=ExperimentalWarning -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);console.log(d.prepare("SELECT count(*) n FROM operations").get().n+d.prepare("SELECT count(*) n FROM operation_locks").get().n)' "$p1/leases.db") == 0 ]] && ok "upgrade lock released" || bad "locks left behind"

# A broken release: init succeeds but the new host can't list VMs → roll back to the previous commit.
sed -i 's/^async function ls(rt, \[arg\]) {$/async function ls(rt, [arg]) { fail("broken release");/' "$tmp/origin/host/cli.mjs"
grep -q 'broken release' "$tmp/origin/host/cli.mjs" || bad "test setup: could not break ls"
og commit -qam broken; og tag v0.7.2
rc=0; out=$("$H" upgrade 2>&1) || rc=$?
[[ $rc != 0 ]] && grep -q "rolled back" <<<"$out" && [[ $(ig rev-parse HEAD) == "$v2" ]] && ok "failed checks roll back to the previous commit" || bad "rollback rc=$rc HEAD=$(ig rev-parse HEAD): $out"
"$H" ls --json >/dev/null 2>&1 && ok "host works after the rollback" || bad "ls after rollback"
[[ $(ig symbolic-ref --short HEAD) == master ]] && ok "still on master after rollback" || bad "branch"

# A pinned ref (detached) and back.
out=$("$H" upgrade --ref v0.7.0 2>&1) && [[ $(ig rev-parse HEAD) == $(og rev-parse v0.7.0) ]] && ok "--ref checks out a tag" || bad "--ref: $out"

# Services of another install are left alone.
sed "s#$I#/elsewhere/boxery#g" "$units/boxery-proxy-two.service" >"$units/boxery-proxy-other.service"
out=$("$H" upgrade --check 2>&1); grep -q "not touching .*boxery-proxy-other.service" <<<"$out" && ok "reports services of other installs" || bad "others: $out"

echo "host-upgrade: $pass passed, $fail failed"
[[ $fail == 0 ]]
