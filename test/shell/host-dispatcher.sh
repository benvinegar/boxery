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
"$H" ls | grep -Eq '^a1 *running *127.0.0.1:22[0-9]* .* - +[a-z]+$' && ok "ls (LEASE column '-' for pets)" || bad "ls: $("$H" ls)"
"$H" ls --json | jq -e 'length == 1 and .[0] == {name: "a1", state: "running", ssh_addr: .[0].ssh_addr, disk_size: 10, disk_used: 0.5, tunnel: null, lease: null, shape: "custom", cpus: 2, mem: 2048, desktop: true, guest: .[0].guest} and (.[0].guest.status | IN("current", "outdated", "unknown")) and (.[0].ssh_addr | test("^127\\.0\\.0\\.1:22[0-9]+$"))' >/dev/null && ok "ls --json" || bad "ls --json: $("$H" ls --json)"
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
# --- concurrent creates of one name: the loser must not remove the winner's VM
for i in 1 2 3 4; do "$H" new same >/dev/null 2>&1 & done; wait
[[ -d $BOXERY_FAKE_DIR/same ]] && jq -e '.same | length == 48' "$BOXERY_CONF/tokens.json" >/dev/null && ok "racing creates of one name keep the winner's VM + token" || bad "winner lost"
[[ ! -d $BOXERY_CONF/.new-same.lock ]] && ok "name lock released" || bad "stale name lock"
"$H" rm same >/dev/null 2>&1
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

echo; # --- resize (#8)
"$H" new rz --cpus 2 --mem 2048 --disk 10 >/dev/null 2>&1
sz() { cat "$BOXERY_FAKE_DIR/rz/size"; }
restarts() { [[ -f $BOXERY_FAKE_DIR/rz/restarts ]] && wc -l <"$BOXERY_FAKE_DIR/rz/restarts" | tr -d ' ' || echo 0; }
out=$("$H" resize rz --cpus 4 --mem 4096 2>&1) && [[ $(sz) == "4 4096 10" ]] && ok "resize changes CPUs and memory, keeps disk" || bad "resize: $(sz) $out"
[[ $out == *"2 vCPU, 2048 MiB, 10 GiB → 4 vCPU, 4096 MiB, 10 GiB"* ]] && ok "resize reports before → after" || bad "resize output: $out"
[[ $(cat "$BOXERY_FAKE_DIR/rz/state") == running && $(restarts) == 1 ]] && ok "a running VM is restarted and left running" || bad "state $(cat "$BOXERY_FAKE_DIR/rz/state"), restarts $(restarts)"
"$H" resize rz --disk 20 >/dev/null 2>&1 && [[ $(sz) == "4 4096 20" ]] && ok "resize grows the disk" || bad "disk grow: $(sz)"
expect_fail "resize refuses to shrink the disk" "$H" resize rz --disk 5
[[ $(sz) == "4 4096 20" ]] && ok "...and leaves the VM as it was" || bad "after shrink attempt: $(sz)"
"$H" resize rz --cpus 2 --mem 1024 >/dev/null 2>&1 && [[ $(sz) == "2 1024 20" ]] && ok "CPUs and memory can go down" || bad "shrink cpu/mem: $(sz)"
r=$(restarts); out=$("$H" resize rz --cpus 2 --disk 20 2>&1) && [[ $(restarts) == "$r" && $out == *"already has"* ]] && ok "a no-op resize does not restart the VM" || bad "no-op: restarts $(restarts), $out"
"$H" stop rz >/dev/null 2>&1; r=$(restarts)
"$H" resize rz --mem 2048 >/dev/null 2>&1 && [[ $(cat "$BOXERY_FAKE_DIR/rz/state") == "shut off" && $(restarts) == "$r" && $(sz) == "2 2048 20" ]] \
	&& ok "a stopped VM is resized and stays stopped" || bad "stopped resize: $(cat "$BOXERY_FAKE_DIR/rz/state") $(sz)"
"$H" start rz >/dev/null 2>&1
if BOXERY_FAKE_FAIL_RESIZE=1 "$H" resize rz --cpus 8 >/dev/null 2>&1; then bad "failed resize reported success"; else ok "a failed resize exits non-zero"; fi
[[ $(sz) == "2 2048 20" && $(cat "$BOXERY_FAKE_DIR/rz/state") == running ]] && ok "...and leaves the VM running at its old size" || bad "after failure: $(sz) $(cat "$BOXERY_FAKE_DIR/rz/state")"
"$H" resize rz --cpus 3 >/dev/null 2>&1 && [[ $(sz) == "3 2048 20" ]] && "$H" resize rz --cpus 2 >/dev/null 2>&1 \
	&& ok "...and releases the VM's operation lock (the next resize runs)" || bad "resize after a failure: $(sz)"
# Lima's limactl start leaves a hostagent daemon behind; the supervisor must not wait for it (fd 3)
t0=$(date +%s); BOXERY_FAKE_DAEMON=20 "$H" resize rz --cpus 3 >/dev/null 2>&1; t1=$(date +%s)
"$H" stop rz >/dev/null 2>&1; BOXERY_FAKE_DAEMON=20 "$H" start rz >/dev/null 2>&1; t2=$(date +%s)
((t1 - t0 < 10 && t2 - t1 < 10)) && [[ $(sz) == "3 2048 20" ]] && ok "resize and start do not wait for a daemon they leave behind" \
	|| bad "operations waited for a daemon: resize $((t1 - t0))s, start $((t2 - t1))s"
"$H" resize rz --cpus 2 >/dev/null 2>&1
for args in "rz" "rz --cpus" "rz --cpus 0" "rz --cpus x" "rz --mem 256" "rz --disk -1" "rz --bogus 1" "rz extra --cpus 2" "--cpus 2" "nosuchvm --cpus 2" "Bad --cpus 2"; do
	read -r -a argv <<<"$args"; expect_fail "resize rejects: $args" "$H" resize "${argv[@]}"
done
[[ $(sz) == "2 2048 20" ]] && ok "rejected invocations left the size alone" || bad "size changed: $(sz)"
"$H" rm rz >/dev/null 2>&1 || true

echo; # --- headless VMs: the stock image + plumbing/devtools layers at first boot, no build-base
mv "$BOXERY_FAKE_DIR/.base" "$tmp/base.off"
expect_fail "a desktop VM still needs the base" "$H" new nob
out=$("$H" new hl --headless 2>&1) && [[ $(cat "$BOXERY_FAKE_DIR/hl/from") == stock ]] && ok "new --headless needs no base: boots the stock image" || bad "new --headless: $out"
[[ $out == *"plumbing devtools installed"* && $out == *"hl ready (headless"* && $out != *noVNC* ]] && ok "new --headless waits for the layers, not for noVNC" || bad "headless new output: $out"
ud=$tmp/hl-user-data; cp "$BOXERY_FAKE_DIR/hl/user-data" "$ud"
grep -q '^users:$' "$ud" && grep -q '^  - name: agent$' "$ud" && grep -A9 '^users:' "$ud" | grep -q 'AAAAlaptop' && ok "headless seed creates agent with the VM's keys (stock image's default user isn't agent)" || bad "headless users: $(grep -A10 '^users:' "$ud")"
for f in /usr/local/sbin/boxery-provision /usr/local/lib/boxery/layers/plumbing.sh /usr/local/lib/boxery/layers/devtools.sh /usr/local/lib/boxery/layers/desktop.sh /usr/local/lib/boxery/layers/lib.sh; do
	b64=$(awk -v p="  - path: $f" '$0 == p {f=1} f&&/content:/{print $2; exit}' "$ud")
	n=$(basename "$f" .sh); [[ $n == boxery-provision ]] && n=provision
	[[ -n $b64 && $(echo "$b64" | base64 -d) == "$(cat "$ROOT/image/layers/$n.sh")" ]] && ok "headless seed carries $f" || bad "seed lacks $f"
done
grep -A1 'path: /etc/boxery/provision$' "$ud" | grep -q 'content: plumbing devtools$' && ok "headless seed asks for plumbing + devtools only" || bad "provision list"
awk '/^runcmd:/{f=1;next} f&&/^  - /{print; exit}' "$ud" | grep -q 'boxery-provision' && ok "provisioning is the first runcmd step (before boxery-llm restarts)" || bad "runcmd order"
"$H" ls --json | jq -e 'map(select(.name == "hl"))[0].desktop == false' >/dev/null && ok "ls --json: desktop false" || bad "ls --json: $("$H" ls --json)"
"$H" ls | grep -Eq '^hl .* headless +- +[a-z]+$' && ok "ls shows the KIND" || bad "ls: $("$H" ls)"
! grep -q '^users:' "$BOXERY_FAKE_DIR/a2/user-data" && ! grep -q 'boxery-provision' "$BOXERY_FAKE_DIR/a2/user-data" && ok "desktop seeds are unchanged (no users:, no layers)" || bad "desktop seed changed"
"$H" snap hl s1 >/dev/null 2>&1
out=$("$H" new hl2 --from hl@s1 2>&1) && [[ $(cat "$BOXERY_FAKE_DIR/hl2/from") == hl@s1 ]] && ! grep -q boxery-provision "$BOXERY_FAKE_DIR/hl2/user-data" && ok "new --from a headless image: no base, no reprovisioning" || bad "from headless image: $out"
"$H" ls --json | jq -e 'map(select(.name == "hl2"))[0].desktop == false' >/dev/null && ok "...and stays headless" || bad "hl2 kind"
"$H" new hl3 --from hl@s1 --headless >/dev/null 2>&1 && ok "--headless with a headless image is fine" || bad "hl3"
out=$("$H" fork hl hf 2>&1) && "$H" ls --json | jq -e 'map(select(.name == "hf"))[0].desktop == false' >/dev/null && ok "a fork of a headless VM is headless" || bad "fork: $out"
mv "$tmp/base.off" "$BOXERY_FAKE_DIR/.base"
"$H" snap a2 d1 >/dev/null 2>&1
out=$("$H" new dx --from a2@d1 --headless 2>&1) && bad "--headless with a desktop image accepted" || { [[ $out == *"has a desktop"* && ! -d $BOXERY_FAKE_DIR/dx ]] && ok "--headless with a desktop image is refused" || bad "refusal: $out"; }
"$H" fork a2 df >/dev/null 2>&1 && "$H" ls --json | jq -e 'map(select(.name == "df"))[0].desktop == true' >/dev/null && ok "a fork of a desktop VM is a desktop" || bad "desktop fork"
"$H" rm hl >/dev/null 2>&1 && [[ ! -e $BOXERY_CONF/vm-kind/hl ]] && ok "rm drops the kind record" || bad "kind record left"
BOXERY_FAKE_FAIL_NEW=1 "$H" new hlf --headless >/dev/null 2>&1 || true; [[ ! -e $BOXERY_CONF/vm-kind/hlf && ! -d $BOXERY_FAKE_DIR/hlf ]] && ok "a failed headless new leaves no record" || bad "hlf leftovers"
for n in hl2 hl3 hf df; do "$H" rm "$n" >/dev/null 2>&1; done
# The desktop build's cloud-config: the template with every layer at its marker
bu=$tmp/cache/base-user-data.yaml
out=$(BOXERY_CACHE=$tmp/cache "$H" build-base 2>&1) && [[ -f $bu ]] && ok "build-base writes the build cloud-config" || bad "build-base: $out"
! grep -q '@boxery-layers' "$bu" && [[ $(grep -c '^  - path: ' "$bu") == $(($(grep -c '^  - path: ' "$ROOT/image/base-user-data.yaml") + 5)) ]] && ok "...with the 5 layer files in place of the marker" || bad "layers not inserted: $(grep 'path:' "$bu")"
node "$ROOT/host/cloudconfig-sh.mjs" "$bu" >"$tmp/files.sh" && grep -q '/usr/local/sbin/boxery-provision' "$tmp/files.sh" && grep -q '/usr/local/sbin/boxery-build.sh' "$tmp/files.sh" && ok "cloudconfig-sh.mjs (Lima, exe) reads it" || bad "cloudconfig-sh on the build config"
# YAML check with whatever parser this machine has (PyYAML, or macOS's Ruby); skipped if none.
yaml_keys() { python3 -c 'import sys, yaml; print(" ".join(sorted(yaml.safe_load(open(sys.argv[1])))))' "$1" 2>/dev/null || ruby -ryaml -e 'puts YAML.load_file(ARGV[0]).keys.sort.join(" ")' "$1" 2>/dev/null; }
if python3 -c 'import yaml' 2>/dev/null || ruby -ryaml -e '' 2>/dev/null; then
	[[ $(yaml_keys "$bu") == "hostname package_update power_state runcmd users write_files" ]] && ok "the build cloud-config is valid YAML" || bad "build cloud-config YAML: $(yaml_keys "$bu")"
	[[ $(yaml_keys "$ud") == "bootcmd fqdn hostname runcmd ssh_authorized_keys ssh_pwauth users write_files" ]] && ok "the headless seed is valid YAML" || bad "headless seed YAML: $(yaml_keys "$ud")"
else ok "(no YAML parser: YAML checks skipped)"; fi

echo "passed: $pass  failed: $fail"; ((fail == 0))
