#!/usr/bin/env bash
# boat.dev backend tests: boxery-host + host/backends/boat.sh against a fake boat API (no account, no
# network). A stub curl serves the REST API from directories; a stub ssh records what the backend runs in
# sandboxes as `user` (checking the pinned host key) and accepts the boxery-host → guest sshd hops
# (agent@127.0.0.1 through the tunnel). systemctl, launchctl and nc are stubbed as in host-exe-backend.sh.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
H=$ROOT/host/boxery-host
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export BOXERY_CONF=$tmp/conf BOXERY_BACKEND=boat BOXERY_BOAT_DIR=$tmp/boat BOXERY_BOAT_PREFIX=bxtest- BOXERY_BOAT_SUPERVISOR=systemd
export BOXERY_BOAT_POLL=0 BOXERY_BOAT_RETRIES=1 BOXERY_REMOTE_BUILD_TIMEOUT=5 BOXERY_PROXY_PORT=9999 BOXERY_SSH_WAIT_TRIES=2
export BOAT_API_KEY=boat_testkey123 FAKE_BOAT_KEY=boat_testkey123 HOME=$tmp/home CALLS=$tmp/calls.log UNITS=$tmp/units BOAT_STATE=$tmp/cloud
mkdir -p "$tmp/bin" "$BOXERY_CONF" "$HOME" "$UNITS" "$BOAT_STATE/sb" "$BOAT_STATE/saved"
touch "$CALLS"
echo "ssh-ed25519 AAAAtestmgmt mgmt@host" >"$BOXERY_CONF/mgmt_ed25519.pub"; touch "$BOXERY_CONF/mgmt_ed25519"

stub() { printf '#!/usr/bin/env bash\n%s\n' "$2" >"$tmp/bin/$1"; chmod +x "$tmp/bin/$1"; }
# The fake boat API. Sandboxes are $BOAT_STATE/sb/ID/{state,type,labels,data,ip,hostkey,create.json};
# saved snapshots $BOAT_STATE/saved/NAME/{status,source,data}. Starting/stopping/saving states settle
# on the next GET.
cat >"$tmp/bin/curl" <<'STUB'
#!/usr/bin/env bash
S=$BOAT_STATE; m=GET; url=""; body=""; auth=""; hdrs=()
while [ $# -gt 0 ]; do
	case $1 in
	-X) m=$2; shift 2 ;;
	-H) hdrs+=("$2"); shift 2 ;;
	-K) auth=$(sed -n 's/^header = "\(.*\)"$/\1/p' "$2"); shift 2 ;;
	--data-binary) body=$(cat); shift 2 ;;
	-w | --max-time) shift 2 ;;
	-*) shift ;;
	*) url=$1; shift ;;
	esac
done
path=${url#*/api/v1}; q=""; case $path in *\?*) q=${path#*\?}; path=${path%%\?*} ;; esac
echo "curl $m $path${q:+?$q} $body" >>"$CALLS"
hdr() { local h; for h in "${hdrs[@]}"; do case $h in "$1: "*) echo "${h#*: }"; return ;; esac; done; }
reply() { printf '%s\n%s' "$2" "$1"; exit 0; }
err() { reply "$1" "$(jq -nc --arg c "$2" --argjson s "$1" '{ok: false, type: "error", status: $s, code: $c, message: $c, error: {code: $c, message: $c, status: $s}}')"; }
[ "$auth" = "Authorization: Bearer $FAKE_BOAT_KEY" ] || err 401 unauthorized
[ -z "${FAIL_API:-}" ] || err 500 http_500
sbjson() { local d=$S/sb/$1; jq -nc --arg i "$1" --arg n "$(cat "$d/name")" --arg s "$(cat "$d/state")" --arg t "$(cat "$d/type")" --argjson l "$(cat "$d/labels")" --arg ip "$(cat "$d/ip" 2>/dev/null)" \
	'{id: $i, name: $n, state: $s, type: $t, labels: $l, ip: (if $ip == "" then null else $ip end), createdAt: "2026-11-01T12:00:00Z"}'; }
settle() { local d=$S/sb/$1; case $(cat "$d/state") in provisioning) echo ready >"$d/state" ;; archiving) echo archived >"$d/state"; rm -f "$d/ip" ;; esac; }
newmachine() { local d=$S/sb/$1 g; g=$(($(cat "$S/gen" 2>/dev/null || echo 0) + 1)); echo $g >"$S/gen"; echo "203.0.113.$g" >"$d/ip"; echo "ssh-ed25519 AAAAhostkey$g" >"$d/hostkey"; }
savedjson() { jq -nc --arg n "$1" --arg s "$(cat "$S/saved/$1/status")" --arg src "$(cat "$S/saved/$1/source")" '{name: $n, status: $s, sourceSandboxId: $src, createdAt: "2026-11-01T12:00:00Z", sizeBytes: 1000}'; }
case $m:$path in
GET:/me) reply 200 '{"ok":true,"type":"user","user":{"email":"t@example.com"}}' ;;
GET:/sandboxes)
	[ -z "${FAIL_LS:-}" ] || err 500 http_500
	want=$(printf '%s' "$q" | tr '&' '\n' | sed -n 's/^namePrefix=//p'); cur=$(printf '%s' "$q" | tr '&' '\n' | sed -n 's/^cursor=//p')
	ids=$(ls "$S/sb"); n=0 out=() next=""
	for i in $ids; do
		case $(cat "$S/sb/$i/name") in "$want"*) ;; *) [ -n "${IGNORE_NAME_FILTER:-}" ] || continue ;; esac
		n=$((n + 1)); [ -z "$cur" ] || [ $n -gt "$cur" ] || continue
		if [ ${#out[@]} -ge "${PAGE:-100}" ]; then next=$((n - 1)); break; fi
		out+=("$(sbjson "$i")")
	done
	reply 200 "$(printf '%s\n' ${out[@]+"${out[@]}"} | jq -sc --arg nx "$next" '{ok: true, sandboxes: ., pageInfo: {nextCursor: (if $nx == "" then null else $nx end), hasMore: ($nx != "")}}')" ;;
POST:/sandboxes)
	[ -z "${FAIL_CREATE:-}" ] || err 500 http_500
	[ -n "$(hdr Idempotency-Key)" ] || err 400 idempotency_key_missing_in_test
	from=$(jq -r '.from // ""' <<<"$body")
	if [ -n "$from" ]; then [ "$(cat "$S/saved/$from/status" 2>/dev/null)" = ready ] || err 404 snapshot_not_found; fi
	c=$(($(cat "$S/ids" 2>/dev/null || echo 0) + 1)); echo $c >"$S/ids"; id=bx_t$c; d=$S/sb/$id
	# boat drops the labels of a sandbox created from a saved snapshot
	mkdir "$d"; echo provisioning >"$d/state"; jq -r .type <<<"$body" >"$d/type"; jq -r .name <<<"$body" >"$d/name"; jq -c 'if .from then {} else .labels // {} end' <<<"$body" >"$d/labels"; echo "$body" >"$d/create.json"; echo "$body" >>"$S/creates.log"
	if [ -n "$from" ]; then cp "$S/saved/$from/data" "$d/data"; else echo stock >"$d/data"; fi
	newmachine "$id"
	[ -z "${SLOW_CREATE:-}" ] || sleep 60
	reply 202 "{\"ok\":true,\"type\":\"sandbox.created\",\"sandbox\":$(sbjson "$id")}" ;;
GET:/sandboxes/*/* | POST:/sandboxes/*/* | DELETE:/sandboxes/*)
	rest=${path#/sandboxes/}; id=${rest%%/*}; act=${rest#"$id"}; act=${act#/}; d=$S/sb/$id
	[ -d "$d" ] || err 404 not_found
	case $m:$act in
	POST:sshkey)
		case $(cat "$d/state") in ready | idle | running) ;; *) err 400 machine_not_running ;; esac
		jq -r .key <<<"$body" >>"$d/authorized"
		ip=$(cat "$d/ip"); [ -z "${EVIL_IP:-}" ] || ip=$EVIL_IP
		reply 200 "$(jq -nc --arg ip "$ip" --arg k "$(cat "$d/hostkey")" '{ok: true, type: "ssh_key.configured", success: true, machineIp: $ip, sshUser: "user", sshEndpoint: null, hostKey: $k}')" ;;
	POST:stop) echo archiving >"$d/state"; reply 202 '{"ok":true,"type":"sandbox.stopping","status":"archiving"}' ;;
	POST:resume)
		t=$(jq -r '.type // ""' <<<"$body")
		[ "$(cat "$d/state")" = archived ] || { [ -z "$t" ] || err 409 sandbox_running_stop_first; reply 202 '{"ok":true}'; }
		[ -z "${FAIL_RESUME_TYPE:-}" ] || [ -z "$t" ] || err 403 machine_class_plan_required
		[ -z "$t" ] || echo "$t" >"$d/type"
		echo provisioning >"$d/state"; newmachine "$id"; echo "$body" >>"$d/resumes"; reply 202 '{"ok":true,"type":"sandbox.resuming"}' ;;
	DELETE:) [ "$(hdr X-Ascii-Confirm-Delete)" = "$id" ] || err 409 confirm_delete_mismatch; rm -rf "$d"; reply 202 '{"ok":true,"type":"sandbox.deleting","operation":{"id":"bdop_1"}}' ;;
	*) err 404 no_route ;;
	esac ;;
GET:/sandboxes/*) id=${path#/sandboxes/}; [ -d "$S/sb/$id" ] || err 404 not_found; j=$(sbjson "$id"); settle "$id"; reply 200 "{\"ok\":true,\"sandbox\":$j}" ;;
POST:/saved-snapshots)
	n=$(jq -r .name <<<"$body"); src=$(jq -r .sandboxId <<<"$body")
	[[ $n =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || err 400 invalid_name
	[ -d "$S/sb/$src" ] || err 404 not_found
	mkdir -p "$S/saved/$n"; echo saving >"$S/saved/$n/status"; echo "$src" >"$S/saved/$n/source"; cp "$S/sb/$src/data" "$S/saved/$n/data"
	reply 202 "{\"ok\":true,\"status\":\"saving\",\"snapshot\":$(savedjson "$n")}" ;;
GET:/saved-snapshots)
	out=(); for n in $(ls "$S/saved"); do out+=("$(savedjson "$n")"); done
	reply 200 "$(printf '%s\n' ${out[@]+"${out[@]}"} | jq -sc '{ok: true, snapshots: ., allowance: {included: 10}}')" ;;
GET:/saved-snapshots/*)
	n=${path#/saved-snapshots/}; [ -d "$S/saved/$n" ] || err 404 snapshot_not_found
	j=$(savedjson "$n"); [ "$(cat "$S/saved/$n/status")" != saving ] || { [ -n "${FAIL_SAVE:-}" ] && echo failed || echo ready; } >"$S/saved/$n/status"
	reply 200 "{\"ok\":true,\"snapshot\":$j}" ;;
DELETE:/saved-snapshots/*) n=${path#/saved-snapshots/}; [ -d "$S/saved/$n" ] || err 404 snapshot_not_found; rm -rf "${S:?}/saved/$n"; reply 200 '{"ok":true}' ;;
*) err 404 no_route ;;
esac
STUB
chmod +x "$tmp/bin/curl"
# ssh: user@203.0.113.N → the sandbox with that address (the host key must be pinned under its id);
# anything else (agent@127.0.0.1 -p PORT through a tunnel) succeeds.
cat >"$tmp/bin/ssh" <<'STUB'
#!/usr/bin/env bash
echo "ssh $*" >>"$CALLS"
alias="" kh="" N=""
while [ $# -gt 0 ]; do case $1 in
	-o) case $2 in HostKeyAlias=*) alias=${2#*=} ;; UserKnownHostsFile=*) kh=${2#*=} ;; esac; shift 2 ;;
	-p|-i|-L|-R|-F|-W|-l) shift 2 ;; -N) N=1; shift ;; -*) shift ;; *) break ;; esac; done
dest=$1; shift
case $dest in user@203.0.113.*) ;; *) exit 0 ;; esac
for d in "$BOAT_STATE"/sb/*/; do [ "$(cat "$d/ip" 2>/dev/null)" = "${dest#user@}" ] && break; d=""; done
[ -n "$d" ] || exit 255
id=$(basename "$d")
case $(cat "$d/state") in ready | idle | running) ;; *) exit 255 ;; esac
[ "$alias" = "$id" ] && grep -qxF "$id $(cat "$d/hostkey")" "$kh" || { echo "Host key verification failed." >&2; exit 255; }
[ -z "$N" ] || exit 0   # the tunnel
echo "$*" >>"$d/edge.log"
case "$*" in
"sudo bash -s")
	n=$(ls "$d" | grep -c '^script\.' || true); cat >"$d/script.$((n + 1))"
	# A build: keep its script, and change the builder's host key (as boat would on a new machine).
	if grep -q BOXERY_POST "$d/script.$((n + 1))"; then cp "$d/script.$((n + 1))" "$BOAT_STATE/build-script"; echo "ssh-ed25519 AAAArotated$RANDOM" >"$d/hostkey"; fi ;;
*boxery-boat.ok*) echo "${BUILD_RESULT:-ok}" ;;
esac
exit 0
STUB
chmod +x "$tmp/bin/ssh"
stub systemctl 'echo "systemctl $*" >>"$CALLS"
case $2 in
enable) touch "$UNITS/enabled.$3" ;;
disable) rm -f "$UNITS/enabled.$4" "$UNITS/$4" ;;
start | restart) [[ -z ${FAIL_TUNNEL:-} ]] || exit 1; touch "$UNITS/$3" ;;
stop) rm -f "$UNITS/$3" ;;
is-active) [[ -f "$UNITS/$4" ]] ;;
esac'
stub nc 'echo "nc $*" >>"$CALLS"'
# init loads the proxy service on macOS too: never through the real launchctl, whose gui/UID domain is
# this account's (with HOME a temp dir, it replaced the real dev.boxery-proxy job).
stub launchctl 'echo "launchctl $*" >>"$CALLS"'
export PATH="$tmp/bin:$PATH" BOXERY_STUB_SERVICES=1
S=$BOAT_STATE E=$BOXERY_BOAT_DIR/vms

pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }
expect() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
expect_fail() { local d=$1; shift; if "$@" >/dev/null 2>&1; then bad "$d (should fail)"; else ok "$d"; fi; }
called() { grep -F -- "$1" "$CALLS" >/dev/null; }   # not grep -q: early exit + pipefail = false negatives
st() { cat "$S/sb/$1/state" 2>/dev/null; }
ID() { cat "$E/$1/id"; }   # NAME's current sandbox
ids_of() { local d; for d in "$S"/sb/*/; do [[ $(cat "$d/name") == "bxtest-vm-$1" ]] && basename "$d"; done | tr '\n' ' '; }
img() { printf 'bxtest-i-%s' "$(printf '%s' "$1" | { shasum 2>/dev/null || sha1sum; } | cut -c1-16)"; }
lsj() { "$H" ls --json; }
U() { echo "$HOME/.config/systemd/user/boxery-boat-bxtest-$1.service"; }
mkdir "$S/sb/bx_other"; echo "my dev box" >"$S/sb/bx_other/name"; echo ready >"$S/sb/bx_other/state"; echo default >"$S/sb/bx_other/type"; echo '{}' >"$S/sb/bx_other/labels"; echo 203.0.113.250 >"$S/sb/bx_other/ip"   # the account's own sandbox

[[ $("$H" backend) == boat ]] && ok "backend selection" || bad "backend selection"

# --- init
: >"$CALLS"
BOXERY_NO_SERVICES=1 "$H" init >/dev/null 2>&1 || true   # proxy services need a real systemd
[[ $(cat "$BOXERY_BOAT_DIR/api-key") == boat_testkey123 && $(ls -l "$BOXERY_BOAT_DIR/api-key" | cut -c1-10) == -rw------- ]] && ok "init saves the API key, 0600" || bad "api-key"
[[ -f $BOXERY_BOAT_DIR/id_ed25519 && -f $BOXERY_BOAT_DIR/id_ed25519.pub ]] && ok "init makes the host's admin ssh key" || bad "admin key"
grep -x 'BOXERY_BACKEND=boat' "$BOXERY_CONF/host.env" >/dev/null && grep -x 'BOXERY_BOAT_PREFIX=bxtest-' "$BOXERY_CONF/host.env" >/dev/null && grep -x "BOXERY_BOAT_DIR=$BOXERY_BOAT_DIR" "$BOXERY_CONF/host.env" >/dev/null && ok "init saves the backend's declared settings" || bad "host.env: $(cat "$BOXERY_CONF/host.env")"
! grep -F boat_testkey123 "$BOXERY_CONF/host.env" >/dev/null && ok "… but never the API key" || bad "key in host.env"
called "curl GET /me" && ! called "boat_testkey123" && ok "init checks the key (GET /me); the key never appears on a command line" || bad "key on argv: $(grep -c boat_testkey "$CALLS")"
unset BOAT_API_KEY   # from here on, the saved key

# --- build-base
BUILD_RESULT=failed expect_fail "a failed build fails" "$H" build-base
b=""; for x in "$S"/sb/bx_t*; do b=$(basename "$x"); done
[[ $(cat "$S/sb/$b/name") == bxtest-build && ! -d $S/saved/bxtest-base ]] && ok "failed build keeps the builder sandbox for debugging, no base" || bad "after failed build: $(ls "$S/sb" "$S/saved")"
: >"$CALLS"
expect "build-base" "$H" build-base
called "curl DELETE /sandboxes/$b" && ok "a previous builder sandbox is removed first" || bad "stale builder"
bb=$(grep -o 'curl POST /saved-snapshots {"sandboxId":"[^"]*","name":"bxtest-base"}' "$CALLS" | grep -o 'bx_t[0-9]*')
jq -se 'map(select(.name == "bxtest-build")) | last | .type == "default" and .ttlSeconds == null and .noEnv == true' "$S/creates.log" >/dev/null &&
	ok "builder: named PREFIXbuild, default type, no auto-stop, no account environment" || bad "builder create: $(cat "$S/creates.log")"
[[ $(cat "$S/saved/bxtest-base/status") == ready && -n $bb && ! -d $S/sb/$bb ]] && ok "builder saved as the base, then deleted" || bad "base: $(ls "$S/saved") $(ls "$S/sb")"
grep -F 'curl POST /sandboxes/'"$bb"'/sshkey {"key":"ssh-ed25519 ' "$CALLS" >/dev/null && ok "the host's admin key is authorized through the API" || bad "sshkey"
[[ $(grep -c "curl POST /sandboxes/$bb/sshkey" "$CALLS") -ge 2 ]] && ok "the build poller re-pins a builder whose host key changed" || bad "no re-pin: $(grep -c "sshkey" "$CALLS")"
die() { echo "$*" >&2; exit 1; }; log() { :; }; need() { :; }
eval "$(grep '^take_lock()' "$ROOT/host/backend.sh")"   # the real lock helper (host/backend.sh defines it for every backend)
PROXY_PORT=9999
cp "$S/build-script" "$tmp/build.sh"   # the last build's script, as the builder received it
bash -n "$tmp/build.sh" && ok "build script parses" || bad "build script syntax"
grep -F 'useradd -m -s /bin/bash -c "boxery agent" -G sudo,adm agent' "$tmp/build.sh" >/dev/null && grep -F 'setsid nohup' "$tmp/build.sh" >/dev/null && ok "build creates the agent user, runs detached" || bad "build"
sed -n "/<<'BOXERY_POST'/,/^BOXERY_POST\$/p" "$tmp/build.sh" | sed '1d;$d' >"$tmp/post.sh"
bash -n "$tmp/post.sh" && grep -x 'Match User agent Address \*,!127.0.0.1,!::1' "$tmp/post.sh" >/dev/null && grep -x '    DenyUsers agent' "$tmp/post.sh" >/dev/null && grep -x 'sshd -t' "$tmp/post.sh" >/dev/null &&
	ok "post-build: agent only from loopback (the tunnel), config checked" || bad "post: $(cat "$tmp/post.sh")"
grep -F 'cp -p /etc/ssh/ssh_host_* /root/.boxery-hostkeys/' "$tmp/build.sh" >/dev/null && grep -F 'cp -p /root/.boxery-hostkeys/ssh_host_* /etc/ssh/' "$tmp/post.sh" >/dev/null &&
	[[ $(grep -n -x 'ssh-keygen -A' "$tmp/post.sh" | cut -d: -f1) -lt $(grep -n -x 'sshd -t' "$tmp/post.sh" | cut -d: -f1) ]] && ok "post-build: the machine's host keys are put back (the shared build deletes them), the pin stays valid" || bad "host keys"
! grep -F 'ListenAddress' "$tmp/post.sh" >/dev/null && ok "post-build: boat's public sshd stays (its CLI and our tunnel need it)" || bad "sshd moved to loopback"
grep -F 'systemctl enable boxery-boat-boot.service' "$tmp/post.sh" >/dev/null && grep -F '/etc/boxery/hostname' "$tmp/post.sh" >/dev/null && grep -F 'boxery-agent-session.service' "$tmp/post.sh" >/dev/null && ok "post-build: hostname restored at every boot; agent session unit" || bad "boot units"
sed -n "/<<-'SH'/,/^SH\$/p" "$tmp/post.sh" | sed '1d;$d' | sh -n && ok "boot script parses (sh)" || bad "boot script"

# --- new
: >"$CALLS"
out=$("$H" new v1 2>"$tmp/err") && [[ $out == "v1 127.0.0.1:22601" ]] && ok "new prints NAME 127.0.0.1:PORT" || bad "new: $out $(cat "$tmp/err")"
C=$S/sb/$(ID v1)/create.json
jq -e '.from == "bxtest-base" and .name == "bxtest-vm-v1" and .type == "default" and .ttlSeconds == null and .noEnv == true' "$C" >/dev/null && ok "created from the base: named PREFIXvm-NAME, default type for the standard shape, no auto-stop, noEnv" || bad "create: $(cat "$C")"
I=$S/sb/$(ID v1)/script.1
bash -n "$I" && ok "identity script parses" || bad "identity syntax"
grep -x 'ssh-ed25519 AAAAtestmgmt mgmt@host' "$I" >/dev/null && grep -F 'cat >/home/agent/.ssh/authorized_keys <<' "$I" >/dev/null && ok "authorized_keys replaced with the host's keys" || bad "keys"
grep -F 'systemd-machine-id-setup' "$I" >/dev/null && grep -F 'echo v1 >/etc/boxery/hostname; /usr/local/sbin/boxery-boat-boot.sh' "$I" >/dev/null && ok "fresh machine-id, hostname through the boot script" || bad "identity"
! grep -F 'ssh-keygen -A' "$I" >/dev/null && ok "boat's own ssh host keys are kept (pinned through the API)" || bad "host keys regenerated"
up=$(grep -F '/etc/boxery/proxy-upstream' "$I" | grep -o 'echo [A-Za-z0-9+/=]*' | head -1 | cut -c6- | base64 -d 2>/dev/null || true)
[[ $up == "TCP:127.0.0.1:18088" ]] && ok "guest proxy upstream is the tunnel's -R end" || bad "upstream: $up"
[[ $(cat "$E/v1/known_hosts") == "$(ID v1) $(cat "$S/sb/$(ID v1)/hostkey")" ]] && ok "host key from the API pinned under the sandbox id" || bad "known_hosts: $(cat "$E/v1/known_hosts")"
! grep -F 'boxery_host_ed25519_key' "$I" >/dev/null && [[ $("$ROOT/host/backend.sh" backend_platform_host_key v1) == "$(cat "$S/sb/$(ID v1)/hostkey")" && $(cat "$BOXERY_CONF/host-keys/v1") == "v1.boxery $(cat "$S/sb/$(ID v1)/hostkey")" ]] &&
	ok "no seeded host key; backend_platform_host_key reports the API's key for boxery-host to pin (#70)" || bad "platform key: $("$ROOT/host/backend.sh" backend_platform_host_key v1 2>&1) / $(cat "$BOXERY_CONF/host-keys/v1" 2>&1)"
grep -F "ExecStart=$E/v1/tunnel.sh" "$(U v1)" >/dev/null && [[ -f $UNITS/enabled.boxery-boat-bxtest-v1.service && -f $UNITS/boxery-boat-bxtest-v1.service ]] && ok "tunnel: enabled, running user unit" || bad "unit"
bash -n "$E/v1/tunnel.sh" && ok "tunnel.sh parses" || bad "tunnel.sh syntax"
: >"$CALLS"; bash "$E/v1/tunnel.sh" && ok "tunnel connects with the pinned key" || bad "tunnel ssh refused"
for a in "-N" "ForwardAgent=no" "ExitOnForwardFailure=yes" "StrictHostKeyChecking=yes" "HostKeyAlias=$(ID v1)" "-L 127.0.0.1:22601:127.0.0.1:22" "-R 127.0.0.1:18088:127.0.0.1:9999" "user@$(cat "$S/sb/$(ID v1)/ip")"; do
	called "$a" && ok "tunnel passes $a" || bad "tunnel lacks $a: $(cat "$CALLS")"
done
: >"$CALLS"
"$H" new v2 --cpus 8 >/dev/null 2>"$tmp/err"
[[ $(jq -r .type "$S/sb/$(ID v2)/create.json") == large && $(cat "$E/v2/slot") == 2 ]] && grep -F "boat type large: 8 vCPU, 16384 MiB, 111 GiB" "$tmp/err" >/dev/null && ok "8 vCPU → large (logged); second VM gets slot 2" || bad "v2: $(cat "$tmp/err")"
j=$(lsj)
jq -e 'map(select(.name == "v1"))[0] | .state == "running" and .ssh_addr == "127.0.0.1:22601" and .disk_size == 51 and .disk_used == null' <<<"$j" >/dev/null && ok "ls --json: running, tunnel address, disk" || bad "ls: $j"
jq -e 'map(select(.name == "v1"))[0] | .tunnel == "up"' <<<"$j" >/dev/null && ok "ls --json: the tunnel's state" || bad "tunnel: $j"
e=$("$H" new hl --headless 2>&1) && bad "headless accepted" || { [[ $e == *"boat: headless is unavailable"* && $e == *"use build-base and a desktop VM on a paid plan, or another backend"* ]] && ok "new --headless is refused clearly" || bad "headless: $e"; }
jq -e 'map(.name) | sort == ["v1", "v2"]' <<<"$j" >/dev/null && ok "ls lists boxery VMs only (not the base, builders or the account's other sandboxes)" || bad "ls names: $j"
[[ $("$ROOT/host/backend.sh" backend_size v1 2>/dev/null) == "4 8192 51" ]] && ok "backend_size: the boat type's size" || bad "size: $("$ROOT/host/backend.sh" backend_size v1 2>&1)"
"$H" rm v2 >/dev/null 2>&1
BOXERY_BOAT_TTL=7200 "$H" new t1 >/dev/null 2>&1
jq -e '.ttlSeconds == 7200' "$S/sb/$(ID t1)/create.json" >/dev/null && ok "BOXERY_BOAT_TTL sets auto-stop (the free trial requires ≤ 7200 s)" || bad "ttl: $(cat "$S/sb/$(ID t1)/create.json")"
"$H" rm t1 >/dev/null 2>&1

# --- stop / start: a new machine each time
: >"$CALLS"
ip1=$(cat "$S/sb/$(ID v1)/ip")
expect "stop" "$H" stop v1
called "curl POST /sandboxes/$(ID v1)/stop" && [[ $(st "$(ID v1)") == archived ]] && grep -x sync "$S/sb/$(ID v1)/edge.log" >/dev/null && ok "stop syncs, stops and waits until boat has saved the disk" || bad "stop: $(cat "$CALLS")"
[[ ! -f $UNITS/boxery-boat-bxtest-v1.service ]] && ok "stop stops the tunnel" || bad "tunnel still up"
lsj | jq -e 'map(select(.name == "v1"))[0] | .state == "shut off" and .ssh_addr == null' >/dev/null && ok "stopped VM: shut off, no addr" || bad "ls stopped: $(lsj)"
: >"$CALLS"
expect "stop of a stopped VM" "$H" stop v1
! called "/stop" && ok "… is a no-op on boat" || bad "second stop: $(cat "$CALLS")"
: >"$CALLS"
expect "start" "$H" start v1
jq -e '.ttlSeconds == null and (has("type") | not)' <<<"$(tail -1 "$S/sb/$(ID v1)/resumes")" >/dev/null && ok "start resumes without auto-stop" || bad "resume: $(cat "$S/sb/$(ID v1)/resumes")"
echo provisioning >"$S/sb/$(ID v1)/state"; : >"$CALLS"
expect "start of a starting VM" "$H" start v1
! called "/resume" && [[ $(st "$(ID v1)") == ready ]] && ok "… waits for it instead of resuming again" || bad "start while starting: $(cat "$CALLS")"
ip2=$(cat "$S/sb/$(ID v1)/ip")
[[ $ip2 != "$ip1" ]] && grep -F "user@$ip2" "$E/v1/tunnel.sh" >/dev/null && [[ $(cat "$E/v1/known_hosts") == "$(ID v1) $(cat "$S/sb/$(ID v1)/hostkey")" && -f $UNITS/boxery-boat-bxtest-v1.service ]] && ok "start re-pins the new machine and rewrites the tunnel" || bad "after start: $(cat "$E/v1/tunnel.sh")"
[[ $(cat "$BOXERY_CONF/host-keys/v1") == "v1.boxery $(cat "$S/sb/$(ID v1)/hostkey")" ]] && ok "...and boxery-host's record for v1 follows the new machine's key" || bad "host-keys/v1 after start: $(cat "$BOXERY_CONF/host-keys/v1")"

# --- resize: stop + resume with a new type
: >"$CALLS"
expect "resize a running VM" "$H" resize v1 --cpus 8
called "curl POST /sandboxes/$(ID v1)/stop" && jq -e '.type == "large"' <<<"$(tail -1 "$S/sb/$(ID v1)/resumes")" >/dev/null && [[ $(st "$(ID v1)") == ready && -f $UNITS/boxery-boat-bxtest-v1.service ]] && ok "resize: stop, resume as large, running again with its tunnel" || bad "resize: $(cat "$CALLS")"
[[ $(cat "$E/v1/type") == large && $(cat "$E/v1/size") == "8 16384 111" ]] && ok "new type and size recorded" || bad "type: $(cat "$E/v1/type") $(cat "$E/v1/size")"
BOXERY_BOAT_MAX_TYPE=xlarge FAIL_RESUME_TYPE=1 expect_fail "a refused type fails" "$H" resize v1 --cpus 16 --mem 32768
[[ $(cat "$E/v1/type") == large && $(st "$(ID v1)") == ready && $(cat "$E/v1/size") == "8 16384 111" ]] && ok "… and leaves the VM running at its old type" || bad "after refused resize: $(cat "$E/v1/type") $(st "$(ID v1)")"
expect "stop again" "$H" stop v1
: >"$CALLS"
expect "resize a stopped VM" "$H" resize v1 --cpus 2 --mem 4096
! called "/resume" && [[ $(cat "$E/v1/type.pending") == small && $(st "$(ID v1)") == archived ]] && ok "stopped VM: type recorded, left stopped" || bad "resize stopped: $(cat "$CALLS")"
: >"$CALLS"
expect "start after a resize" "$H" start v1
jq -e '.type == "small"' <<<"$(tail -1 "$S/sb/$(ID v1)/resumes")" >/dev/null && [[ $(cat "$E/v1/type") == small && ! -f $E/v1/type.pending ]] && ok "start applies the recorded type" || bad "start resized: $(cat "$S/sb/$(ID v1)/resumes")"
expect "resize back to default" "$H" resize v1 --cpus 4 --mem 8192
[[ $(cat "$E/v1/type") == default ]] && ok "without --disk, a VM can move down to a smaller type" || bad "type: $(cat "$E/v1/type")"

# --- images: saved snapshots
echo v1-work >"$S/sb/$(ID v1)/data"
: >"$CALLS"
expect "snapshot of a running VM" "$H" snap v1 s1
IS1=$(img v1@s1)
called "curl POST /saved-snapshots {\"sandboxId\":\"$(ID v1)\",\"name\":\"$IS1\"}" && grep -x sync "$S/sb/$(ID v1)/edge.log" >/dev/null && ok "guest sync, then a saved snapshot named by hash" || bad "capture: $(cat "$CALLS")"
[[ $(cat "$S/saved/$IS1/status") == ready && $(cat "$S/saved/$IS1/data") == v1-work && $(st "$(ID v1)") == ready ]] && ok "image: a copy of the disk, ready; the source keeps running" || bad "image: $(cat "$S/saved/$IS1/status")"
expect_fail "duplicate snapshot name rejected" "$H" snap v1 s1
"$H" images | grep -E '^v1@s1 +2026-11-01T12:00:00 +51GiB' >/dev/null && ok "images: name, created, size" || bad "images: $("$H" images)"
[[ $("$H" images | grep -c '@') == 1 ]] && ok "images: the base isn't an image" || bad "images: $("$H" images)"
FAIL_SAVE=1 expect_fail "failed capture fails" "$H" snap v1 s2
[[ ! -d $S/saved/$(img v1@s2) && ! -f $BOXERY_BOAT_DIR/images/$(img v1@s2) && $(st "$(ID v1)") == ready ]] && ok "failed capture leaves nothing behind and the source alone" || bad "s2 debris"

# --- revert = reimage: a new sandbox from the image, same slot and tunnel port
echo changed >"$S/sb/$(ID v1)/data"
old=$(ID v1)
: >"$CALLS"
expect "revert" "$H" revert v1 s1
new=$(ID v1)
[[ $new != "$old" && ! -d $S/sb/$old ]] && jq -e --arg f "$IS1" '.from == $f and .type == "default"' "$S/sb/$new/create.json" >/dev/null && ok "revert: new sandbox from the image (same type), old one deleted" || bad "revert: $(cat "$CALLS")"
[[ $(cat "$S/sb/$new/data") == v1-work && $(ids_of v1) == "$new " && $(cat "$E/v1/slot") == 1 && -f $UNITS/boxery-boat-bxtest-v1.service ]] && grep -F "HostKeyAlias=$new" "$E/v1/tunnel.sh" >/dev/null && ok "disk restored, slot kept, tunnel follows the new sandbox" || bad "after revert: $(ids_of v1)"
expect_fail "revert to an unknown snapshot fails" "$H" revert v1 nope

# --- new --from / fork
out=$("$H" new f1 --from v1@s1 2>/dev/null) && [[ $out == "f1 127.0.0.1:22602" ]] && ok "new --from gets its own slot" || bad "new --from: $out"
[[ $(cat "$S/sb/$(ID f1)/data") == v1-work ]] && grep -F 'echo f1 >/etc/boxery/hostname' "$S/sb/$(ID f1)/script.1" >/dev/null && ok "new --from: the image's disk, its own identity" || bad "f1"
out=$("$H" fork v1 g1 g2 2>/dev/null) && [[ $(echo "$out" | wc -l | tr -d ' ') == 2 ]] && ok "fork into two VMs" || bad "fork: $out"
n_saved=("$S"/saved/bxtest-i-*); n_rec=("$BOXERY_BOAT_DIR"/images/*)
[[ ${#n_saved[@]} == 1 && ${#n_rec[@]} == 1 ]] && ok "fork removes its temporary image" || bad "images left: $(ls "$S/saved")"
for n in f1 g1 g2; do "$H" rm "$n" >/dev/null 2>&1; done

# --- rm
expect "rm" "$H" rm v1
[[ -z $(ids_of v1) && ! -d $S/saved/$IS1 && ! -d $E/v1 && ! -f $(U v1) ]] && ok "rm removes the sandbox, its images, tunnel and state" || bad "rm leftovers: $(ls "$S/sb" "$S/saved" "$E")"
[[ -d $S/sb/bx_other && -d $S/saved/bxtest-base ]] && ok "rm leaves the base and the account's other sandboxes" || bad "collateral"
"$H" new v3 >/dev/null 2>&1; [[ $(cat "$E/v3/slot") == 1 ]] && ok "freed slot 1 is reused" || bad "slot reuse"

# --- a failed create cleans up
FAIL_CREATE=1 expect_fail "new fails when boat refuses the create" "$H" new bad1
[[ ! -d $E/bad1 && -z $(ids_of bad1) ]] && jq -e 'has("bad1") | not' "$BOXERY_CONF/tokens.json" >/dev/null && ok "failed new removes its state and token" || bad "bad1 leftovers"
FAIL_TUNNEL=1 expect_fail "new fails when the tunnel can't start" "$H" new bad2
[[ ! -d $E/bad2 && -z $(ids_of bad2) && ! -f $UNITS/enabled.boxery-boat-bxtest-bad2.service ]] && ok "… and deletes the sandbox and tunnel it made" || bad "bad2 leftovers: $(ls "$S/sb")"

# --- inventory
FAIL_LS=1 expect_fail "ls fails when boat is unreachable" "$H" ls --json
FAIL_API=1 expect_fail "images fails when boat is unreachable" "$H" images
"$H" new v4 >/dev/null 2>&1; "$H" new v5 >/dev/null 2>&1
[[ $(PAGE=1 "$H" ls --json | jq -r 'map(.name) | sort | join(" ")') == "v3 v4 v5" ]] && ok "ls follows pagination" || bad "paged ls: $(PAGE=1 "$H" ls --json)"
[[ $(IGNORE_NAME_FILTER=1 "$H" ls --json | jq -r 'map(.name) | sort | join(" ")') == "v3 v4 v5" ]] && ok "only this host's names count, whatever the API filter returns" || bad "unfiltered: $(IGNORE_NAME_FILTER=1 "$H" ls --json)"

# --- crash recovery hooks (sourced; README "Crash recovery contract"), idempotent
rec() { ( die() { echo "$*" >&2; exit 1; }; log() { :; }; need() { :; }; PROXY_PORT=9999; ROOT=$ROOT
	# shellcheck source=/dev/null
	. "$ROOT/host/backends/boat.sh"; "$@" ); }
mk() { mkdir "$S/sb/$1"; echo ready >"$S/sb/$1/state"; echo default >"$S/sb/$1/type"; echo "bxtest-vm-$2" >"$S/sb/$1/name"; echo '{}' >"$S/sb/$1/labels"; }
mkdir -p "$E/half"; echo 77 >"$E/half/slot"; mk bx_half1 half; mk bx_half2 half
touch "$(U half)" "$UNITS/boxery-boat-bxtest-half.service"
rec backend_cleanup_new half && [[ ! -d $E/half && -z $(ids_of half) && ! -f $UNITS/boxery-boat-bxtest-half.service && ! -f $(U half) ]] && ok "cleanup_new removes a half-created VM: every sandbox, tunnel, state" || bad "cleanup_new: $(ids_of half)"
rec backend_cleanup_new half && ok "cleanup_new is idempotent" || bad "cleanup_new second run"
FAIL_LS=1 rec backend_cleanup_new v3 2>/dev/null && bad "cleanup_new succeeded without boat" || ok "cleanup_new fails (keeps the journal) when boat is unreachable"
mkdir -p "$S/saved/$(img x@y)"; echo saving >"$S/saved/$(img x@y)/status"; echo bx_t1 >"$S/saved/$(img x@y)/source"; touch "$BOXERY_BOAT_DIR/images/$(img x@y)"
rec backend_cleanup_image x@y && [[ ! -d $S/saved/$(img x@y) && ! -f $BOXERY_BOAT_DIR/images/$(img x@y) ]] && rec backend_cleanup_image x@y && ok "cleanup_image removes a half-saved image and its record, idempotently" || bad "cleanup_image"
mkdir -p "$S/saved/$(img v3@z)"; echo ready >"$S/saved/$(img v3@z)/status"; echo x >"$S/saved/$(img v3@z)/source"
rec backend_recover_capture v3 v3@z running && [[ ! -d $S/saved/$(img v3@z) && $(st "$(ID v3)") == ready ]] && ok "recover_capture drops the image, never the source" || bad "recover_capture"
# reimage retried after a run that created but died before switching: the stray sandbox goes too
"$H" snap v4 c >/dev/null 2>&1; mk bx_stray v4
lsj | jq -e '[.[] | select(.name == "v4")] | length == 1' >/dev/null && ok "ls shows a VM once, ignoring a stray sandbox" || bad "ls strays: $(lsj)"
rec backend_reimage v4 v4@c && [[ $(ids_of v4) == "$(ID v4) " && $(st "$(ID v4)") == ready ]] && ok "a retried reimage leaves exactly one sandbox, the new one" || bad "reimage retry: $(ids_of v4)"

# --- a create killed mid-way is recovered through backend_cleanup_new (docs/lifecycle.md)
SLOW_CREATE=1 "$H" new crash >/dev/null 2>&1 & cli=$!
for _ in $(seq 200); do pgrep -f 'sleep 60' >/dev/null && break; sleep 0.05; done
[[ -f $E/crash/slot ]] && ok "create got as far as POST /sandboxes" || bad "crash: no state"
kill -9 "$cli" 2>/dev/null; wait "$cli" 2>/dev/null || true
pkill -f 'sleep 60' 2>/dev/null || true
"$H" reconcile >/dev/null 2>&1
[[ ! -d $E/crash && -z $(ids_of crash) ]] && jq -e 'has("crash") | not' "$BOXERY_CONF/tokens.json" >/dev/null && ok "reconcile recovers an interrupted create: sandbox, state and token gone" || bad "crash recovery: $(ls "$E") $(ids_of crash)"

# --- helpers (sourced)
# shellcheck source=/dev/null
. "$ROOT/host/backends/boat.sh"
[[ $(boat_img demo@s1) =~ ^bxtest-i-[0-9a-f]{16}$ && $(boat_img demo@s1) != "$(boat_img demo@s2)" ]] && ok "image snapshot names: stable 16-hex hash, a valid saved snapshot name" || bad "boat_img: $(boat_img demo@s1)"
[[ $(boat_type_for 2 4096 20 2>/dev/null) == small && $(boat_type_for 4 8192 40 2>/dev/null) == default && $(boat_type_for 4 8192 80 2>/dev/null) == large && $(boat_type_for 3 1024 10 2>/dev/null) == default ]] && ok "types: the smallest that fits CPUs, memory and disk" || bad "types"
e=$(log() { echo "$*" >&2; }; boat_type_for 32 65536 10 2>&1 >/dev/null); [[ $(boat_type_for 32 65536 10 2>/dev/null) == large && $e == *BOXERY_BOAT_MAX_TYPE* ]] && ok "types: capped at BOXERY_BOAT_MAX_TYPE (large), and says so" || bad "cap: $e"
[[ $(BOXERY_BOAT_MAX_TYPE=xlarge; . "$ROOT/host/backends/boat.sh"; boat_type_for 16 32768 10 2>/dev/null) == xlarge ]] && ok "types: xlarge when allowed" || bad "xlarge"
mkdir -p "$tmp/evil"; echo bx_t1 >"$tmp/evil/id"
for ev in '-oProxyCommand=touch' '203.0.113.1 -oProxyCommand=x'; do
	(EVIL_IP=$ev; export EVIL_IP; boat_ssh_setup "$tmp/evil" "$(ID v3)") 2>/dev/null && bad "hostile machineIp accepted: $ev" || ok "hostile machineIp rejected: $ev"
done
(unset BOXERY_BOAT_PREFIX; BOXERY_BOAT_DIR=$tmp/fresh; . "$ROOT/host/backends/boat.sh"; [[ -z $BOAT_PREFIX ]] && ! backend_has_base && [[ -z $(backend_list) ]]) && ok "no prefix yet: no base, nothing listed" || bad "unprefixed"
p1=$(unset BOXERY_BOAT_PREFIX; BOXERY_BOAT_DIR=$tmp/fresh; . "$ROOT/host/backends/boat.sh"; backend_init; echo "$BOAT_PREFIX")
[[ $p1 =~ ^bx[0-9a-f]{6}-$ ]] && ok "init generates a prefix" || bad "prefix: $p1"
m=$( (BOXERY_BOAT_DIR=$tmp/nokey; unset BOAT_API_KEY; . "$ROOT/host/backends/boat.sh"; boat_api GET /me) 2>&1 || true)
[[ $m == *"no boat API key: set BOAT_API_KEY"* ]] && ok "no API key: says how to set it" || bad "no key message: $m"

echo "passed: $pass  failed: $fail"; ((fail == 0))
