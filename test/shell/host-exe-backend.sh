#!/usr/bin/env bash
# exe.dev backend tests: boxery-host + host/backends/exe.sh against a fake exe.dev (no account, no network).
# A stub ssh routes `ssh exe.dev CMD` to a fake lobby that keeps VMs as directories, records what the
# backend runs in VMs through the edge (`ssh NAME.exe.xyz`), and accepts the boxery-host → guest sshd
# hops (agent@127.0.0.1 through the tunnel). systemctl and nc are stubbed as in host-ch-backend.sh.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
H=$ROOT/host/boxery-host
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export BOXERY_CONF=$tmp/conf BOXERY_BACKEND=exe BOXERY_EXE_DIR=$tmp/exe BOXERY_EXE_PREFIX=bxtest- BOXERY_EXE_SUPERVISOR=systemd
export BOXERY_EXE_POLL=0 BOXERY_PROXY_PORT=9999 BOXERY_SSH_WAIT_TRIES=2 HOME=$tmp/home CALLS=$tmp/calls.log UNITS=$tmp/units EXE_STATE=$tmp/cloud
mkdir -p "$tmp/bin" "$BOXERY_CONF" "$HOME" "$UNITS" "$EXE_STATE"
touch "$CALLS"
echo "ssh-ed25519 AAAAtestmgmt mgmt@host" >"$BOXERY_CONF/mgmt_ed25519.pub"; touch "$BOXERY_CONF/mgmt_ed25519"

stub() { printf '#!/usr/bin/env bash\n%s\n' "$2" >"$tmp/bin/$1"; chmod +x "$tmp/bin/$1"; }
# ssh: exe.dev → fake lobby; *.exe.xyz → fake edge (runs nothing; records commands and scripts);
# anything else (agent@127.0.0.1 -p PORT through a tunnel) succeeds.
cat >"$tmp/bin/ssh" <<'STUB'
#!/usr/bin/env bash
echo "ssh $*" >>"$CALLS"
user=""
while [ $# -gt 0 ]; do case $1 in -o|-p|-i|-L|-R|-F|-W) shift 2 ;; -l) user=$2; shift 2 ;; -*) shift ;; *) break ;; esac; done
host=$1; shift
case $host in
exe.dev) exec fake-exe "$@" ;;
vm.exe.xyz) vm=${user#vm+} ;;
*.exe.xyz) vm=${host%.exe.xyz} ;;
*) exit 0 ;;
esac
d=$EXE_STATE/$vm
[ -d "$d" ] && [ "$(cat "$d/status")" = running ] || exit 255
[ $# -gt 0 ] || exit 0   # the tunnel (-N)
echo "$*" >>"$d/edge.log"
case "$*" in
"sudo bash -s") n=$(ls "$d" | grep -c '^script\.' || true); cat >"$d/script.$((n + 1))" ;;
*boxery-exe.ok*) echo "${BUILD_RESULT:-ok}" ;;
esac
exit 0
STUB
chmod +x "$tmp/bin/ssh"
# The fake exe.dev lobby: VMs are $EXE_STATE/NAME/{status,comment,data,args}.
cat >"$tmp/bin/fake-exe" <<'STUB'
#!/usr/bin/env bash
S=$EXE_STATE; cmd=$1; shift
pos=(); flags=()
for a in "$@"; do case $a in --json) ;; --*) flags+=("$a") ;; *) pos+=("$a") ;; esac; done
echo "exe.dev $cmd ${pos[*]} ${flags[*]}" >>"$CALLS"
flag() { local f; for f in "${flags[@]}"; do case $f in --$1=*) echo "${f#*=}"; return ;; esac; done; }
err() { printf '{"error":"%s"}\n' "$*"; exit 1; }
vm() { [ -d "$S/$1" ] || err "VM $1 not found"; }
case $cmd in
whoami) [ -z "${UNREGISTERED:-}" ] || { echo "Please complete registration by running: ssh exe.dev"; exit 1; }; echo '{"email":"t@example.com"}' ;;
ls)
	[ -z "${FAIL_LS:-}" ] || exit 255
	for d in "$S"/*/; do
		[ -d "$d" ] || continue; n=$(basename "$d")
		if [ -n "${SSH_USER_MODE:-}" ]; then u="vm+$n" h=vm.exe.xyz; else u="" h=$n.exe.xyz; fi
		jq -n --arg n "$n" --arg s "$(cat "$d/status")" --arg c "$(cat "$d/comment" 2>/dev/null)" --arg u "$u" --arg h "$h" \
			'{vm_name: $n, status: $s, comment: $c, created_at: "2026-10-31T12:00:00Z", ssh_host: $h, ssh_dest: (if $u != "" then "\($u)@\($h)" else $h end)} + (if $u != "" then {ssh_user: $u} else {} end)'
	done | jq -s '{vms: .}' ;;
new)
	n=$(flag name); [ ! -d "$S/$n" ] || err "VM $n already exists"
	mkdir "$S/$n"; echo running >"$S/$n/status"; echo base >"$S/$n/data"; echo "${flags[*]}" >"$S/$n/args"
	echo "{\"vm_name\":\"$n\"}" ;;
cp)
	[ -z "${FAIL_CP:-}" ] || err "injected cp failure"
	[ -z "${SLOW_CP:-}" ] || sleep 60
	vm "${pos[0]}"; [ ! -d "$S/${pos[1]}" ] || err "VM ${pos[1]} already exists"
	mkdir "$S/${pos[1]}"; cp "$S/${pos[0]}/data" "$S/${pos[1]}/data"; echo running >"$S/${pos[1]}/status"; echo "${flags[*]}" >"$S/${pos[1]}/args"
	echo "{\"vm_name\":\"${pos[1]}\",\"copied_from\":\"${pos[0]}\"}" ;;
rm) for n in "${pos[@]}"; do vm "$n"; rm -rf "${S:?}/$n"; done; echo '{}' ;;
rename) vm "${pos[0]}"; [ ! -d "$S/${pos[1]}" ] || err "VM ${pos[1]} already exists"; mv "$S/${pos[0]}" "$S/${pos[1]}"; echo '{}' ;;
comment) vm "${pos[0]}"; t=${pos[1]#\'}; echo "${t%\'}" >"$S/${pos[0]}/comment"; echo '{}' ;;
pause) vm "${pos[0]}"; echo paused >"$S/${pos[0]}/status"; echo '{}' ;;
resume | restart) vm "${pos[0]}"; echo running >"$S/${pos[0]}/status"; echo '{}' ;;
*) err "unknown command $cmd" ;;
esac
STUB
chmod +x "$tmp/bin/fake-exe"
stub systemctl 'echo "systemctl $*" >>"$CALLS"
case $2 in
enable) touch "$UNITS/enabled.$3" ;;
disable) rm -f "$UNITS/enabled.$4" "$UNITS/$4" ;;
start | restart) [[ -z ${FAIL_TUNNEL:-} ]] || exit 1; touch "$UNITS/$3" ;;
stop) rm -f "$UNITS/$3" ;;
is-active) [[ -f "$UNITS/$4" ]] ;;
esac'
stub nc 'echo "nc $*" >>"$CALLS"'
export PATH="$tmp/bin:$PATH"
S=$EXE_STATE E=$BOXERY_EXE_DIR/vms

pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }
expect() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
expect_fail() { local d=$1; shift; if "$@" >/dev/null 2>&1; then bad "$d (should fail)"; else ok "$d"; fi; }
called() { grep -F -- "$1" "$CALLS" >/dev/null; }   # not grep -q: early exit + pipefail = false negatives
st() { cat "$S/$1/status" 2>/dev/null; }
img() { printf 'bxtest-i-%s' "$(printf '%s' "$1" | { shasum 2>/dev/null || sha1sum; } | cut -c1-16)"; }
lsj() { "$H" ls --json; }
mkdir "$S/my-blog"; echo running >"$S/my-blog/status"; echo blog >"$S/my-blog/data"   # the account's other VM

[[ $("$H" backend) == exe ]] && ok "backend selection" || bad "backend selection"

# --- build-base
BUILD_RESULT=failed expect_fail "a failed build fails" "$H" build-base
[[ -d $S/bxtest-build && ! -d $S/bxtest-base ]] && ok "failed build keeps the builder VM for debugging, no base" || bad "after failed build: $(ls "$S")"
: >"$CALLS"
expect "build-base" "$H" build-base
called "exe.dev rm bxtest-build" && ok "a previous builder VM is removed first" || bad "stale builder"
called "exe.dev new  --name=bxtest-build --no-email --cpu=2 --memory=4GB --disk=20GB" && ok "builder: exeuntu VM within the plan" || bad "new: $(grep 'exe.dev new' "$CALLS")"
called "exe.dev rename bxtest-build bxtest-base" && [[ $(st bxtest-base) == paused ]] && ok "builder renamed to the base and paused" || bad "base: $(st bxtest-base)"
B=$S/bxtest-base/script.1
bash -n "$B" && ok "build script parses" || bad "build script syntax"
grep -F 'useradd -m -s /bin/bash -c "boxery agent" -G sudo,adm agent' "$B" >/dev/null && grep -F '/etc/sudoers.d/90-boxery-agent' "$B" >/dev/null && ok "build creates the agent user (no cloud-init on exeuntu)" || bad "agent user"
grep -F '/usr/local/sbin/boxery-build.sh' "$B" >/dev/null && grep -F 'setsid nohup' "$B" >/dev/null && ok "shared build script, detached from the ssh session" || bad "build run"
sed -n "/<<'BOXERY_POST'/,/^BOXERY_POST\$/p" "$B" | sed '1d;$d' >"$tmp/post.sh"
bash -n "$tmp/post.sh" && grep -x 'ListenAddress 127.0.0.1' "$tmp/post.sh" >/dev/null && grep -x 'AllowUsers agent' "$tmp/post.sh" >/dev/null && ok "post-build: sshd on loopback, agent only" || bad "post: $(cat "$tmp/post.sh")"
grep -F 'systemctl unmask ssh.service ssh.socket' "$tmp/post.sh" >/dev/null && grep -F 'ssh-keygen -A' "$tmp/post.sh" >/dev/null && ok "post-build: unmasks sshd and makes host keys" || bad "sshd unmask"
grep -F 'ExecStart=/bin/systemctl start user@$(id -u agent).service' "$tmp/post.sh" >/dev/null && ok "post-build: starts the agent's user manager at boot (exeuntu has no logind)" || bad "user session"

# --- new
: >"$CALLS"
out=$("$H" new v1 --cpus 4 --mem 8192 --disk 10 2>"$tmp/err") && [[ $out == "v1 127.0.0.1:22401" ]] && ok "new prints NAME 127.0.0.1:PORT" || bad "new: $out $(cat "$tmp/err")"
called "exe.dev cp bxtest-base bxtest-v-v1 --copy-tags=false --cpu=2 --memory=4GB" && ! called "--disk=" && ok "copied from the base, capped to the plan, disk never shrunk" || bad "cp: $(grep 'exe.dev cp' "$CALLS")"
grep -F "capping to 2 vCPU" "$tmp/err" >/dev/null && ok "capping is logged" || bad "no capping log"
I=$S/bxtest-v-v1/script.1
bash -n "$I" && ok "identity script parses" || bad "identity syntax"
grep -x 'ssh-ed25519 AAAAtestmgmt mgmt@host' "$I" >/dev/null && grep -F 'cat >/home/agent/.ssh/authorized_keys <<' "$I" >/dev/null && ok "authorized_keys replaced with the host's keys" || bad "keys"
up=$(grep -F '/etc/boxery/proxy-upstream' "$I" | grep -o 'echo [A-Za-z0-9+/=]*' | head -1 | cut -c6- | base64 -d 2>/dev/null || true)
[[ $up == "TCP:127.0.0.1:18088" ]] && ok "guest proxy upstream is the tunnel's -R end" || bad "upstream: $up"
grep -F 'systemd-machine-id-setup' "$I" >/dev/null && grep -F 'ssh-keygen -A' "$I" >/dev/null && grep -F 'hostname v1' "$I" >/dev/null && ok "fresh machine-id, host keys, hostname" || bad "identity"
grep -F 'boxery-novnc' "$I" >/dev/null && grep -F 'git init -q' "$I" >/dev/null && ok "runcmd steps: desktop services, ~/project" || bad "runcmd"
U=$HOME/.config/systemd/user/boxery-exe-bxtest-v-v1.service
grep -F "ExecStart=$E/v1/tunnel.sh" "$U" >/dev/null && grep -F 'Restart=always' "$U" >/dev/null && ok "tunnel runs as a restarting user unit" || bad "unit: $(cat "$U")"
[[ -f $UNITS/enabled.boxery-exe-bxtest-v-v1.service && -f $UNITS/boxery-exe-bxtest-v-v1.service ]] && ok "tunnel enabled (survives host reboots) and running" || bad "unit state"
bash -n "$E/v1/tunnel.sh" && ok "tunnel.sh parses" || bad "tunnel.sh syntax"
: >"$CALLS"; bash "$E/v1/tunnel.sh"
for a in "-N" "ExitOnForwardFailure=yes" "-L 127.0.0.1:22401:127.0.0.1:22" "-R 127.0.0.1:18088:127.0.0.1:9999" "bxtest-v-v1.exe.xyz" "StrictHostKeyChecking=accept-new" "ControlPath=none"; do
	called "$a" && ok "tunnel passes $a" || bad "tunnel lacks $a: $(cat "$CALLS")"
done

: >"$CALLS"
"$H" new v2 --disk 60 >/dev/null 2>&1
called "exe.dev cp bxtest-base bxtest-v-v2 --copy-tags=false --cpu=2 --memory=4GB --disk=60GB" && [[ $(cat "$E/v2/slot") == 2 ]] && ok "bigger disk is passed; second VM gets slot 2" || bad "v2: $(grep 'exe.dev cp' "$CALLS")"
j=$(lsj)
jq -e 'map(select(.name == "v1"))[0] | .state == "running" and .addr == "127.0.0.1:22401" and .disk == "20GiB"' <<<"$j" >/dev/null && ok "ls --json: running, tunnel address, disk" || bad "ls: $j"
jq -e 'map(.name) | sort == ["v1", "v2"]' <<<"$j" >/dev/null && ok "ls lists boxery VMs only (not the base, images or the account's other VMs)" || bad "ls names: $j"
[[ $("$H" ip v1) == 127.0.0.1 ]] && ok "ip" || bad ip

# --- stop / start
: >"$CALLS"
expect "stop" "$H" stop v1
called "exe.dev pause bxtest-v-v1" && grep -F 'sudo rm -rf /run/user/*/boxery' "$S/bxtest-v-v1/edge.log" >/dev/null && ok "stop drops pushed grants, then pauses" || bad "stop: $(cat "$CALLS")"
[[ ! -f $UNITS/boxery-exe-bxtest-v-v1.service ]] && ok "stop stops the tunnel" || bad "tunnel still up"
lsj | jq -e 'map(select(.name == "v1"))[0] | .state == "paused" and .addr == null' >/dev/null && ok "paused VM: no addr" || bad "ls stopped: $(lsj)"
expect_fail "ip of a stopped VM fails" "$H" ip v1
: >"$CALLS"
expect "start" "$H" start v1
called "exe.dev resume bxtest-v-v1" && [[ -f $UNITS/boxery-exe-bxtest-v-v1.service ]] && ok "start resumes and brings the tunnel back" || bad "start: $(cat "$CALLS")"

# --- images: snapshots
echo v1-work >"$S/bxtest-v-v1/data"
: >"$CALLS"
expect "snapshot of a running VM" "$H" snap v1 s1
IS1=$(img v1@s1)
grep -x sync "$S/bxtest-v-v1/edge.log" >/dev/null && called "exe.dev cp bxtest-v-v1 $IS1 --copy-tags=false" && ok "guest sync, then cp to the image VM" || bad "capture: $(cat "$CALLS")"
[[ $(cat "$S/$IS1/comment") == "boxery-image:v1@s1:20" && $(st "$IS1") == paused && $(cat "$S/$IS1/data") == v1-work ]] && ok "image: labelled with its name and disk, paused, a copy of the disk" || bad "image: $(cat "$S/$IS1/comment") $(st "$IS1")"
[[ $(st bxtest-v-v1) == running ]] && ok "source keeps running" || bad "source state"
expect_fail "duplicate snapshot name rejected" "$H" snap v1 s1
"$H" images | grep -E '^v1@s1 +2026-10-31T12:00:00 +20GiB' >/dev/null && ok "images: name, created, size" || bad "images: $("$H" images)"
[[ $("$H" images | grep -c '@') == 1 ]] && ok "images: the base isn't an image" || bad "images: $("$H" images)"
: >"$CALLS"
FAIL_CP=1 expect_fail "failed capture fails" "$H" snap v1 s2
[[ ! -d $S/$(img v1@s2) && $(st bxtest-v-v1) == running ]] && ok "failed capture leaves nothing behind and the source alone" || bad "s2 debris"

# --- revert = reimage: same exe.dev name and slot, the image's disk
echo changed >"$S/bxtest-v-v1/data"
: >"$CALLS"
expect "revert" "$H" revert v1 s1
called "exe.dev cp $IS1 bxtest-s-v1" && called "exe.dev rm bxtest-v-v1" && called "exe.dev rename bxtest-s-v1 bxtest-v-v1" && ok "revert: copy to staging, remove, rename" || bad "revert: $(cat "$CALLS")"
[[ $(cat "$S/bxtest-v-v1/data") == v1-work && $(cat "$E/v1/slot") == 1 && -f $UNITS/boxery-exe-bxtest-v-v1.service ]] && ok "disk restored, slot kept, tunnel up" || bad "after revert"
expect_fail "revert to an unknown snapshot fails" "$H" revert v1 nope

# --- new --from / fork
: >"$CALLS"
out=$("$H" new f1 --from v1@s1 2>/dev/null) && [[ $out == "f1 127.0.0.1:22403" ]] && ok "new --from gets its own slot" || bad "new --from: $out"
called "exe.dev cp $IS1 bxtest-v-f1" && [[ $(cat "$S/bxtest-v-f1/data") == v1-work ]] && ok "new --from copies the image VM" || bad "f1: $(grep 'exe.dev cp' "$CALLS")"
grep -F 'hostname f1' "$S/bxtest-v-f1/script.1" >/dev/null && grep -F '/home/agent/.ssh/authorized_keys' "$S/bxtest-v-f1/script.1" >/dev/null && ok "new --from: own identity, keys replaced" || bad "f1 identity"
out=$("$H" fork v1 g1 g2 2>/dev/null) && [[ $(echo "$out" | wc -l | tr -d ' ') == 2 ]] && ok "fork into two VMs" || bad "fork: $out"
imgs=("$S"/bxtest-i-*); [[ ${#imgs[@]} == 1 ]] && ok "fork removes its temporary image" || bad "images left: $(ls "$S")"
for n in v2 f1 g1 g2; do "$H" rm "$n" >/dev/null 2>&1; done

# --- rm
: >"$CALLS"
expect "rm" "$H" rm v1
[[ ! -d $S/bxtest-v-v1 && ! -d $S/$IS1 && ! -d $E/v1 && ! -f $HOME/.config/systemd/user/boxery-exe-bxtest-v-v1.service ]] && ok "rm removes the VM, its images, tunnel and state" || bad "rm leftovers: $(ls "$S" "$E")"
jq -e 'has("v1") | not' "$BOXERY_CONF/tokens.json" >/dev/null && ok "rm revokes the proxy token" || bad token
[[ -d $S/my-blog && -d $S/bxtest-base ]] && ok "rm leaves the base and the account's other VMs" || bad "collateral: $(ls "$S")"
"$H" new v3 >/dev/null 2>&1; [[ $(cat "$E/v3/slot") == 1 ]] && ok "freed slot 1 is reused" || bad "slot reuse"

# --- a failed create cleans up
FAIL_CP=1 expect_fail "new fails when exe.dev cp fails" "$H" new bad1
[[ ! -d $E/bad1 && ! -d $S/bxtest-v-bad1 ]] && jq -e 'has("bad1") | not' "$BOXERY_CONF/tokens.json" >/dev/null && ok "failed new removes its state and token" || bad "bad1 leftovers"
FAIL_TUNNEL=1 expect_fail "new fails when the tunnel can't start" "$H" new bad2
[[ ! -d $E/bad2 && ! -d $S/bxtest-v-bad2 && ! -f $UNITS/enabled.boxery-exe-bxtest-v-bad2.service ]] && ok "… and removes the exe.dev VM and tunnel it made" || bad "bad2 leftovers: $(ls "$S")"

# --- concurrency: parallel creates get distinct slots
for i in 1 2 3 4; do "$H" new "p$i" >/dev/null 2>&1 & done; wait
[[ $(cat "$E"/p*/slot | sort -u | wc -l | tr -d ' ') == 4 ]] && ok "4 parallel creates → 4 distinct slots" || bad "slots: $(cat "$E"/p*/slot | tr '\n' ' ')"

# --- inventory: an unreachable exe.dev is an error, not an empty account
FAIL_LS=1 expect_fail "ls fails when exe.dev is unreachable" "$H" ls --json
FAIL_LS=1 expect_fail "images fails when exe.dev is unreachable" "$H" images

# --- crash recovery hooks (sourced; README "Crash recovery contract"), idempotent
rec() { ( die() { echo "$*" >&2; exit 1; }; log() { :; }; need() { :; }; PROXY_PORT=9999; ROOT=$ROOT
	# shellcheck source=/dev/null
	. "$ROOT/host/backends/exe.sh"; "$@" ); }
mkdir -p "$E/half" "$S/bxtest-v-half" "$S/bxtest-s-half"; echo 77 >"$E/half/slot"; echo running >"$S/bxtest-v-half/status"; echo running >"$S/bxtest-s-half/status"
touch "$HOME/.config/systemd/user/boxery-exe-bxtest-v-half.service" "$UNITS/boxery-exe-bxtest-v-half.service"
rec backend_cleanup_new half && [[ ! -d $E/half && ! -d $S/bxtest-v-half && ! -d $S/bxtest-s-half && ! -f $UNITS/boxery-exe-bxtest-v-half.service && ! -f $HOME/.config/systemd/user/boxery-exe-bxtest-v-half.service ]] && ok "cleanup_new removes a half-created VM: exe.dev VM, staging copy, tunnel, state" || bad "cleanup_new"
rec backend_cleanup_new half && ok "cleanup_new is idempotent" || bad "cleanup_new second run"
mkdir "$BOXERY_EXE_DIR/.slot.lock" && rec backend_cleanup_new nothing && [[ ! -d $BOXERY_EXE_DIR/.slot.lock ]] && ok "cleanup_new clears a dead holder's slot lock" || bad "slot lock"
FAIL_LS=1 rec backend_cleanup_new p1 2>/dev/null && bad "cleanup_new succeeded without exe.dev" || ok "cleanup_new fails (keeps the journal) when exe.dev is unreachable"
mkdir -p "$S/$(img x@y)"; echo running >"$S/$(img x@y)/status"   # a cp killed before its comment
rec backend_cleanup_image x@y && [[ ! -d $S/$(img x@y) ]] && rec backend_cleanup_image x@y && ok "cleanup_image removes an unlabelled image, idempotently" || bad "cleanup_image"
mkdir -p "$S/$(img p1@z)"; echo running >"$S/$(img p1@z)/status"
rec backend_recover_capture p1 p1@z running && [[ ! -d $S/$(img p1@z) && $(st bxtest-v-p1) == running ]] && ok "recover_capture drops the image, never the source" || bad "recover_capture"
# reimage retried after the old VM was removed, before the rename
mkdir -p "$S/$(img p2@c)"; echo paused >"$S/$(img p2@c)/status"; echo "boxery-image:p2@c:20" >"$S/$(img p2@c)/comment"
mv "$S/bxtest-v-p2" "$S/bxtest-s-p2"
: >"$CALLS"
rec backend_reimage p2 p2@c && [[ -d $S/bxtest-v-p2 && ! -d $S/bxtest-s-p2 ]] && ! called "exe.dev cp" && ok "reimage resumes an interrupted swap (rename only)" || bad "reimage recovery: $(cat "$CALLS")"

# --- a create killed mid-way is recovered through backend_cleanup_new (docs/lifecycle.md)
SLOW_CP=1 "$H" new crash >/dev/null 2>&1 & cli=$!
for _ in $(seq 200); do pgrep -f 'sleep 60' >/dev/null && break; sleep 0.05; done
[[ -f $E/crash/slot ]] && ok "create got as far as exe.dev cp" || bad "crash: no state"
kill -9 "$cli" 2>/dev/null; wait "$cli" 2>/dev/null || true
"$H" reconcile >/dev/null 2>&1
[[ ! -d $E/crash ]] && jq -e 'has("crash") | not' "$BOXERY_CONF/tokens.json" >/dev/null && ok "reconcile recovers an interrupted create: state and token gone" || bad "crash recovery: $(ls "$E")"
pgrep -f 'sleep 60' >/dev/null && { bad "abandoned worker still running"; pkill -f 'sleep 60'; } || ok "abandoned worker group stopped"

# --- helpers (sourced)
die() { echo "$*" >&2; exit 1; }; log() { :; }; need() { :; }   # helpers that die run in ( subshells )
PROXY_PORT=9999
# shellcheck source=/dev/null
. "$ROOT/host/backends/exe.sh"
[[ $(exe_img demo@s1) =~ ^bxtest-i-[0-9a-f]{16}$ && $(exe_img demo@s1) == "$(exe_img demo@s1)" && $(exe_img demo@s1) != "$(exe_img demo@s2)" ]] && ok "image VM names: stable 16-hex hash" || bad "exe_img: $(exe_img demo@s1)"
[[ $(exe_sizes 1 1500) == "--cpu=1 --memory=2GB" ]] && ok "memory rounds up to whole GB" || bad "sizes: $(exe_sizes 1 1500)"
[[ $(BOXERY_EXE_MAX_CPUS=8 BOXERY_EXE_MAX_MEM=16384; . "$ROOT/host/backends/exe.sh"; exe_sizes 4 8192) == "--cpu=4 --memory=8GB" ]] && ok "plan caps are configurable" || bad "caps"
(unset BOXERY_EXE_PREFIX; BOXERY_EXE_DIR=$tmp/fresh; . "$ROOT/host/backends/exe.sh"; [[ -z $EXE_PREFIX ]] && ! backend_has_base && [[ -z $(backend_list) ]]) && ok "no prefix yet: no base, nothing listed, no API call" || bad "unprefixed"
p1=$(unset BOXERY_EXE_PREFIX; BOXERY_EXE_DIR=$tmp/fresh; . "$ROOT/host/backends/exe.sh"; backend_init; echo "$EXE_PREFIX")
p2=$(unset BOXERY_EXE_PREFIX; BOXERY_EXE_DIR=$tmp/fresh; . "$ROOT/host/backends/exe.sh"; echo "$EXE_PREFIX")
[[ $p1 =~ ^bx[0-9a-f]{6}-$ && $p1 == "$p2" ]] && ok "init generates a prefix once and keeps it" || bad "prefix: $p1 / $p2"
e=$( (UNREGISTERED=1 backend_check) 2>&1 ) && bad "unregistered key accepted" || { [[ $e == *"ssh exe.dev"* ]] && ok "unregistered key: says how to register" || bad "check: $e"; }
[[ $(SSH_USER_MODE=1 exe_dest bxtest-base) == "-l vm+bxtest-base vm.exe.xyz" ]] && ok "ssh_user routing (vm+NAME@vm.exe.xyz) is honoured" || bad "dest: $(SSH_USER_MODE=1 exe_dest bxtest-base)"
: >"$CALLS"
(BOXERY_EXE_EGRESS=integrations BOXERY_EXE_POOL=build; . "$ROOT/host/backends/exe.sh"; mkdir -p "$tmp/ud"; printf '#cloud-config\nssh_authorized_keys:\n  - "k"\n' >"$tmp/ud/u"; backend_new eg 2 2048 20 "$tmp/ud/u") >/dev/null 2>&1
called "exe.dev cp bxtest-base bxtest-v-eg --copy-tags=false --cpu=2 --memory=2GB --pool=build --egress=integrations" && ok "BOXERY_EXE_POOL and BOXERY_EXE_EGRESS reach cp" || bad "pool/egress: $(grep 'exe.dev cp' "$CALLS")"
# launchd (macOS hosts)
stub launchctl 'echo "launchctl $*" >>"$CALLS"; case $1 in print) [[ -f $UNITS/launchd ]] ;; bootstrap) touch "$UNITS/launchd" ;; bootout) rm -f "$UNITS/launchd" ;; esac'
: >"$CALLS"
(BOXERY_EXE_SUPERVISOR=launchd; . "$ROOT/host/backends/exe.sh"; exe_tunnel_write v3 "$(exe_ls)"; exe_tunnel_start v3; exe_tunnel_active v3) && ok "launchd: tunnel starts" || bad "launchd start: $(cat "$CALLS")"
PL=$HOME/Library/LaunchAgents/dev.boxery-exe-bxtest-v-v3.plist
grep -F "<string>dev.boxery-exe-bxtest-v-v3</string>" "$PL" >/dev/null && grep -F "<string>$E/v3/tunnel.sh</string>" "$PL" >/dev/null && grep -F '<key>KeepAlive</key><true/>' "$PL" >/dev/null && ok "launchd: agent runs tunnel.sh, kept alive" || bad "plist: $(cat "$PL" 2>/dev/null)"
called "launchctl bootstrap gui/$(id -u) $PL" && ok "launchd: bootstrapped in the user's GUI domain" || bad "bootstrap"
(BOXERY_EXE_SUPERVISOR=launchd; . "$ROOT/host/backends/exe.sh"; exe_tunnel_stop v3; ! exe_tunnel_active v3) && [[ ! -f $PL ]] && ok "launchd: stop boots it out and removes it from LaunchAgents" || bad "launchd stop"

echo "passed: $pass  failed: $fail"; ((fail == 0))
