#!/usr/bin/env bash
# agentvm-host dispatcher tests against the fake backend (no VMs, no network).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
H=$ROOT/host/agentvm-host
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export AGENTVM_CONF=$tmp/conf AGENTVM_BACKEND=fake AGENTVM_FAKE_DIR=$tmp/vms AGENTVM_PROXY_PORT=9999
mkdir -p "$tmp/bin" "$AGENTVM_CONF"
# ssh stub: every "VM" answers immediately
printf '#!/bin/sh\nexit 0\n' >"$tmp/bin/ssh"; chmod +x "$tmp/bin/ssh"
printf '#!/bin/sh\nexit 0\n' >"$tmp/bin/ssh-keygen"; chmod +x "$tmp/bin/ssh-keygen"
mkdir -p "$AGENTVM_CONF"; echo "ssh-ed25519 AAAAtest mgmt" >"$AGENTVM_CONF/mgmt_ed25519.pub"; touch "$AGENTVM_CONF/mgmt_ed25519"
export PATH="$tmp/bin:$PATH"
pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }
expect() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
expect_fail() { local d=$1; shift; if "$@" >/dev/null 2>&1; then bad "$d (should fail)"; else ok "$d"; fi; }

[[ $("$H" backend) == fake ]] && ok "backend selection via env" || bad "backend selection"
expect_fail "new before build-base fails" "$H" new a1
expect "build-base" "$H" build-base
echo "ssh-ed25519 AAAAlaptop me@laptop" | "$H" add-key >/dev/null 2>&1 && ok "add-key" || bad add-key
expect_fail "add-key rejects non-keys" bash -c "echo hello | '$H' add-key"
out=$("$H" new a1 --cpus 2 --mem 2048 --disk 10 2>/dev/null) && [[ $out == "a1 127.0.0.1:2222" ]] && ok "new prints NAME ADDR" || bad "new: $out"
[[ $(cat "$AGENTVM_FAKE_DIR/a1/size") == "2 2048 10" ]] && ok "new passes sizes to backend" || bad "sizes"
ud=$AGENTVM_FAKE_DIR/a1/user-data
grep -q '^#cloud-config' "$ud" && grep -q '^hostname: a1$' "$ud" && ok "seed is cloud-config with hostname" || bad "seed header"
grep -q 'AAAAlaptop' "$ud" && grep -q 'AAAAtest' "$ud" && ok "seed authorizes mgmt + registered keys" || bad "seed keys"
grep -A1 'proxy-upstream' "$ud" | grep -q 'TCP:fake-gateway:9999' && ok "seed carries backend proxy upstream" || bad "proxy upstream"
jq -e '.a1 | length == 48' "$AGENTVM_CONF/tokens.json" >/dev/null && ok "per-VM proxy token stored" || bad "token"
b64=$(awk '/path: \/home\/agent\/.pi\/agent\/models.json/{f=1} f&&/content:/{print $2; exit}' "$ud")
echo "$b64" | base64 -d | jq -e '.providers["openai-codex"].baseUrl == "http://127.0.0.1:8088/chatgpt/backend-api"' >/dev/null && ok "pi models.json points at the guest-side proxy" || bad "models.json"
expect_fail "duplicate name rejected" "$H" new a1
for n in A1 1a 'a;b' '../x' "$(printf 'a%.0s' {1..32})"; do expect_fail "invalid name '$n' rejected" "$H" new "$n"; done
"$H" ls | grep -q '^a1 *running *127.0.0.1:2222' && ok "ls" || bad "ls: $("$H" ls)"
[[ $("$H" ip a1) == 127.0.0.1 ]] && ok "ip" || bad ip
expect "stop" "$H" stop a1
expect_fail "ip of stopped VM fails" "$H" ip a1
expect "start" "$H" start a1
expect "snap" "$H" snap a1 s1
"$H" snaps a1 | grep -qx s1 && ok "snaps" || bad snaps
expect "revert" "$H" revert a1 s1
expect_fail "revert to unknown snapshot fails" "$H" revert a1 nope
expect_fail "connect rejects non-ssh ports" "$H" connect a1 80
expect "rm" "$H" rm a1
jq -e 'has("a1") | not' "$AGENTVM_CONF/tokens.json" >/dev/null && ok "rm revokes the proxy token" || bad "token not revoked"
expect_fail "rm of unknown VM fails" "$H" rm a1
AGENTVM_BACKEND=nope expect_fail "unknown backend rejected" "$H" ls

echo; echo "passed: $pass  failed: $fail"; ((fail == 0))
