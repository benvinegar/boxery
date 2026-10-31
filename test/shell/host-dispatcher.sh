#!/usr/bin/env bash
# boxery-host dispatcher tests against the fake backend (no VMs, no network).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
H=$ROOT/host/boxery-host
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export BOXERY_CONF=$tmp/conf BOXERY_BACKEND=fake BOXERY_FAKE_DIR=$tmp/vms BOXERY_PROXY_PORT=9999
mkdir -p "$tmp/bin" "$BOXERY_CONF"
# ssh stub: every "VM" answers immediately
printf '#!/bin/sh\nexit 0\n' >"$tmp/bin/ssh"; chmod +x "$tmp/bin/ssh"
printf '#!/bin/sh\nexit 0\n' >"$tmp/bin/ssh-keygen"; chmod +x "$tmp/bin/ssh-keygen"
mkdir -p "$BOXERY_CONF"; echo "ssh-ed25519 AAAAtest mgmt" >"$BOXERY_CONF/mgmt_ed25519.pub"; touch "$BOXERY_CONF/mgmt_ed25519"
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
out=$("$H" new a1 --cpus 2 --mem 2048 --disk 10 2>/dev/null) && [[ $out =~ ^a1\ 127\.0\.0\.1:22[0-9]{3}$ ]] && ok "new prints NAME ADDR" || bad "new: $out"
[[ $(cat "$BOXERY_FAKE_DIR/a1/size") == "2 2048 10" ]] && ok "new passes sizes to backend" || bad "sizes"
ud=$BOXERY_FAKE_DIR/a1/user-data
grep -q '^#cloud-config' "$ud" && grep -q '^hostname: a1$' "$ud" && ok "seed is cloud-config with hostname" || bad "seed header"
grep -q 'AAAAlaptop' "$ud" && grep -q 'AAAAtest' "$ud" && ok "seed authorizes mgmt + registered keys" || bad "seed keys"
grep -A1 'proxy-upstream' "$ud" | grep -q 'TCP:fake-gateway:9999' && ok "seed carries backend proxy upstream" || bad "proxy upstream"
jq -e '.a1 | length == 48' "$BOXERY_CONF/tokens.json" >/dev/null && ok "per-VM proxy token stored" || bad "token"
b64=$(awk '/path: \/home\/agent\/.pi\/agent\/models.json/{f=1} f&&/content:/{print $2; exit}' "$ud")
echo "$b64" | base64 -d | jq -e '.providers["openai-codex"].baseUrl == "http://127.0.0.1:8088/chatgpt/backend-api"' >/dev/null && ok "pi models.json points at the guest-side proxy" || bad "models.json"
expect_fail "duplicate name rejected" "$H" new a1
for n in A1 1a 'a;b' '../x' "$(printf 'a%.0s' {1..32})"; do expect_fail "invalid name '$n' rejected" "$H" new "$n"; done
"$H" ls | grep -q '^a1 *running *127.0.0.1:22[0-9]* .* -$' && ok "ls (LEASE column '-' for pets)" || bad "ls: $("$H" ls)"
"$H" ls --json | jq -e 'length == 1 and .[0] == {name: "a1", state: "running", addr: .[0].addr, disk: "1GiB", lease: null} and (.[0].addr | test("^127\\.0\\.0\\.1:22[0-9]+$"))' >/dev/null && ok "ls --json" || bad "ls --json: $("$H" ls --json)"
[[ $("$H" ip a1) == 127.0.0.1 ]] && ok "ip" || bad ip
expect "stop" "$H" stop a1
expect_fail "ip of stopped VM fails" "$H" ip a1
expect "start" "$H" start a1
expect "snap" "$H" snap a1 s1
"$H" snaps a1 | cut -f1 | grep -qx s1 && ok "snaps" || bad snaps
[[ $("$H" snaps a1 --json | jq -c 'map(.name)') == '["s1"]' ]] && ok "snaps --json" || bad "snaps --json: $("$H" snaps a1 --json)"
expect_fail "snaps --json of unknown VM fails" "$H" snaps nope --json
expect "revert" "$H" revert a1 s1
expect_fail "revert to unknown snapshot fails" "$H" revert a1 nope
expect_fail "connect rejects non-ssh ports" "$H" connect a1 80
expect "rm" "$H" rm a1
[[ $("$H" ls --json) == '[]' ]] && ok "ls --json with no VMs → []" || bad "ls --json empty: $("$H" ls --json)"
jq -e 'has("a1") | not' "$BOXERY_CONF/tokens.json" >/dev/null && ok "rm revokes the proxy token" || bad "token not revoked"
expect_fail "rm of unknown VM fails" "$H" rm a1
BOXERY_BACKEND=nope expect_fail "unknown backend rejected" "$H" ls
"$H" new a2 >/dev/null 2>&1
for sn in 'x;id' '$(id)' '-rf' '../x'; do expect_fail "invalid snapshot name '$sn' rejected" "$H" snap a2 "$sn"; done
expect_fail "non-numeric --mem rejected" "$H" new a3 --mem '1;id'
grep -q 'content: [A-Za-z0-9+/=]*$' "$BOXERY_FAKE_DIR/a2/user-data" && ! grep -q 'content: $' "$BOXERY_FAKE_DIR/a2/user-data" && ok "seed base64 payloads are non-empty (portable base64)" || bad "empty seed payload"

# --- concurrency: parallel creates must not lose tokens (P1 #3)
for i in 1 2 3 4 5 6 7 8; do "$H" new "p$i" >/dev/null 2>&1 & done; wait
[[ $(jq '[keys[] | select(startswith("p"))] | length' "$BOXERY_CONF/tokens.json") == 8 ]] && ok "8 parallel creates → 8 tokens" || bad "lost tokens: $(jq -c 'keys' "$BOXERY_CONF/tokens.json")"
for i in 1 2 3 4 5 6 7 8; do "$H" rm "p$i" >/dev/null 2>&1 & done; wait
[[ $(jq '[keys[] | select(startswith("p"))] | length' "$BOXERY_CONF/tokens.json") == 0 ]] && ok "8 parallel removes → tokens revoked" || bad "stale tokens: $(jq -c 'keys' "$BOXERY_CONF/tokens.json")"
# --- failed creation rolls back its token and half-created VM
BOXERY_FAKE_FAIL_NEW=1 expect_fail "backend failure during new fails" "$H" new f1
jq -e 'has("f1") | not' "$BOXERY_CONF/tokens.json" >/dev/null && ok "failed new revokes its token" || bad "token left behind by failed new"
[[ ! -d $BOXERY_FAKE_DIR/f1 ]] && ok "failed new removes the half-created VM" || bad "half-created VM left"

echo; # --- edge-set validation
"$H" new edg >/dev/null 2>&1
echo '{"api.example.com":{"headers":{"Authorization":"Bearer x"},"readonly":true}}' | "$H" edge-set edg >/dev/null 2>&1 && [[ -f $BOXERY_CONF/edge/edg.json ]] && ok "edge-set writes routes" || bad "edge-set"
for bad in '{"127.0.0.1":{}}' '{"localhost":{}}' '{"x.com:8080":{}}' '{"X.COM":{}}' '{"a.com":{"headers":{"Host":"evil"}}}' '{"a.com":{"headers":{"Bad Name":"v"}}}' '{"a.com":{"headers":{"A":"v\r\nInjected: 1"}}}' '{"a.com":{"readonly":"yes"}}' 'not json' '[]'; do
	if echo "$bad" | "$H" edge-set edg >/dev/null 2>&1; then bad "edge-set accepted: $bad"; else ok "edge-set rejects $(printf %s "$bad" | cut -c1-40)"; fi
done
[[ $(jq -r '.hosts | keys[0]' "$BOXERY_CONF/edge/edg.json") == api.example.com ]] && ok "rejected input left routes intact" || bad "routes clobbered"
if echo '{}' | "$H" edge-set nosuchvm >/dev/null 2>&1; then bad "edge-set on missing VM"; else ok "edge-set needs an existing VM"; fi
echo '{}' | "$H" edge-set edg >/dev/null 2>&1 && [[ ! -f $BOXERY_CONF/edge/edg.json ]] && ok "edge-set {} clears" || bad "clear"
echo '{"a.example.com":{"headers":{}}}' | "$H" edge-set edg >/dev/null 2>&1; "$H" rm edg >/dev/null 2>&1
[[ ! -f $BOXERY_CONF/edge/edg.json ]] && ok "rm deletes edge routes" || bad "rm left routes"

echo "passed: $pass  failed: $fail"; ((fail == 0))
