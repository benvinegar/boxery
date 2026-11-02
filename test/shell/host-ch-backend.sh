#!/usr/bin/env bash
# cloud-hypervisor backend tests: boxery-host + host/backends/cloud-hypervisor.sh with stubbed
# cloud-hypervisor, ch-remote, qemu-img, cloud-localds, ip, nft, sysctl and systemctl (no VMs, no root).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
H=$ROOT/host/boxery-host
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export BOXERY_CONF=$tmp/conf BOXERY_BACKEND=cloud-hypervisor BOXERY_CH_DIR=$tmp/ch BOXERY_CH_SUDO="" BOXERY_PROXY_PORT=9999
export BOXERY_CH_FIRMWARE=$tmp/fw/hypervisor-fw HOME=$tmp/home CALLS=$tmp/calls.log UNITS=$tmp/units
mkdir -p "$tmp/bin" "$BOXERY_CONF" "$BOXERY_CH_DIR" "$HOME" "$UNITS" "$tmp/fw"
touch "$BOXERY_CH_FIRMWARE" "$CALLS"
echo "ssh-ed25519 AAAAtest mgmt" >"$BOXERY_CONF/mgmt_ed25519.pub"; touch "$BOXERY_CONF/mgmt_ed25519"

stub() { printf '#!/usr/bin/env bash\n%s\n' "$2" >"$tmp/bin/$1"; chmod +x "$tmp/bin/$1"; }
stub ssh 'exit 0'
stub ssh-keygen 'exit 0'
stub cloud-hypervisor 'echo "cloud-hypervisor $*" >>"$CALLS"'
stub ch-remote 'echo "ch-remote $*" >>"$CALLS"
[[ $3 == info ]] && echo '"'"'{"state":"'"'"'"${CH_STATE:-Running}"'"'"'"}'"'"'
exit 0'
stub qemu-img 'echo "qemu-img $*" >>"$CALLS"; [[ $1 == create ]] && touch "${@: -2:1}"; [[ $1 == info ]] && echo "{\"virtual-size\": 10737418240, \"actual-size\": 999}"; exit 0'
stub cloud-localds 'echo "cloud-localds $*" >>"$CALLS"; cp "$2" "$3.network-config"; cp "$4" "$3.user-data"; touch "$3"'
stub ip 'echo "ip $*" >>"$CALLS"; [[ "$1 $2" == "link show" ]] && exit 1; exit 0'
stub sysctl 'echo "sysctl $*" >>"$CALLS"'
stub nft 'echo "nft $*" >>"$CALLS"; [[ "$1 $2" == "-f -" ]] && cat >'"$tmp"'/nft.rules; exit 0'
stub systemctl 'echo "systemctl $*" >>"$CALLS"; u=${3:-}
case $2 in show-environment) [[ -z ${FAIL_SYSTEMD:-} ]] ;; start) [[ -z ${FAIL_START:-} ]] || exit 1; [[ -z ${SLOW_START:-} ]] || sleep 60; touch "$UNITS/$u" ;; stop) rm -f "$UNITS/$u" ;; is-active) [[ -f "$UNITS/${4:-}" ]] ;; esac'
# GNU cp flags the backend uses; BSD cp (macOS) lacks them
stub cp '[[ -z ${FAIL_CP:-} ]] || exit 1; a=(); for x in "$@"; do case $x in --reflink=*|--sparse=*) ;; *) a+=("$x") ;; esac; done; exec /bin/cp "${a[@]}"'
stub flock 'exit 0'   # util-linux; not on macOS
export PATH="$tmp/bin:$PATH"
touch "$BOXERY_CH_DIR/base.qcow2"

pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }
expect() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
expect_fail() { local d=$1; shift; if "$@" >/dev/null 2>&1; then bad "$d (should fail)"; else ok "$d"; fi; }
called() { grep -qF -- "$1" "$CALLS"; }
V=$BOXERY_CH_DIR/vms

[[ $("$H" backend) == cloud-hypervisor ]] && ok "backend selection" || bad "backend selection"

# --- new
out=$("$H" new v1 --cpus 2 --mem 2048 --disk 10 2>/dev/null) && [[ $out == "v1 10.77.1.2:22" ]] && ok "new prints NAME 10.77.1.2:22" || bad "new: $out"
called "qemu-img create -q -f qcow2 -F qcow2 -b $BOXERY_CH_DIR/base.qcow2 $V/v1/disk.qcow2 10G" && ok "overlay backed by the base image" || bad "qemu-img create"
nc=$V/v1/seed.iso.network-config
grep -q '10.77.1.2/24' "$nc" && grep -q 'via: 10.77.1.1' "$nc" && grep -q '52:54:00:77:00:01' "$nc" && grep -q '1.1.1.1, 9.9.9.9' "$nc" && ok "seed network-config: static IP, gateway, MAC, DNS" || bad "network-config: $(cat "$nc")"
grep -A1 proxy-upstream "$V/v1/seed.iso.user-data" | grep -q 'VSOCK-CONNECT:2:9999' && ok "guest proxy upstream is vsock CID 2" || bad "proxy upstream"
L=$V/v1/launch.sh
bash -n "$L" && ok "launch.sh parses" || bad "launch.sh syntax"
(cd "$V/v1" && bash ./launch.sh)   # stub VMM: logs its arguments
for a in "--cpus boot=2" "--memory size=2048M" "--net tap=bxch1,mac=52:54:00:77:00:01" "--vsock cid=3,socket=$V/v1/vsock.sock" "--disk path=$V/v1/disk.qcow2,image_type=qcow2,backing_files=on path=$V/v1/seed.iso,readonly=on,image_type=raw" "--firmware $BOXERY_CH_FIRMWARE" "--api-socket path=$V/v1/api.sock"; do
	called "$a" && ok "launch.sh passes $a" || bad "launch.sh lacks $a: $(cat "$CALLS")"
done
grep -q "ExecStart=$L" "$HOME/.config/systemd/user/boxery-ch-v1.service" && ok "systemd unit runs launch.sh" || bad unit
[[ $(readlink "$V/v1/vsock.sock_9999") == "$BOXERY_CH_DIR/proxy.sock" ]] && ok "vsock port 9999 → shared proxy socket" || bad "vsock symlink"
called "ip tuntap add dev bxch1 mode tap user $(id -un)" && called "ip addr replace 10.77.1.1/24 dev bxch1" && called "ip link set bxch1 up" && ok "TAP created, addressed, up" || bad "tap setup"
called "sysctl -qw net.ipv4.ip_forward=1" && [[ -f $tmp/nft.rules ]] && ok "forwarding + nftables rules loaded" || bad "firewall"
[[ $(head -2 "$tmp/nft.rules" | tr '\n' ' ') == "table inet boxery_ch delete table inet boxery_ch " ]] && ok "rules replace the table in one transaction" || bad "nft preamble: $(head -2 "$tmp/nft.rules")"

# --- isolation rules
R=$tmp/nft.rules
grep -q 'iifname "bxch\*" counter drop' "$R" && ok "guest → host dropped" || bad "input drop"
grep -q 'iifname "bxch\*" fib saddr . iif oif missing counter drop' "$R" && ok "spoofed source addresses dropped" || bad "anti-spoof"
grep -q 'oifname "bxch\*" counter drop' "$R" && ok "new connections into guests (incl. guest → guest) dropped" || bad "guest→guest"
grep -q 'ip daddr @blocked4 counter drop' "$R" && grep -q '100.64.0.0/10' "$R" && grep -q '192.168.0.0/16' "$R" && ok "private + CGNAT/Tailscale ranges blocked" || bad "blocked ranges"
grep -q 'ip saddr 10.77.0.0/16 oifname != "bxch\*" masquerade' "$R" && ok "internet NAT" || bad masquerade

# --- slots
"$H" new v2 >/dev/null 2>&1; [[ $(cat "$V/v2/slot") == 2 ]] && ok "second VM gets slot 2" || bad "slot v2"
[[ $(grep -c '^nft -f -' "$CALLS") == 2 ]] && ok "rules reloaded on every VM start" || bad "nft loads: $(grep -c '^nft -f -' "$CALLS")"
"$H" ls --json | jq -e 'map(select(.name == "v1"))[0] | .state == "running" and .ssh_addr == "10.77.1.2:22" and .disk_size == 10 and .disk_used == 0' >/dev/null && ok "ls --json: running, guest IP:22, disk size (qcow2 virtual size) and use (its blocks; empty here)" || bad "ls: $("$H" ls --json)"
called "qemu-img info -U --output=json $V/v1/disk.qcow2" && ok "ls reads the size without the running VMM's lock" || bad "qemu-img info: $(grep 'qemu-img info' "$CALLS")"
[[ $("$H" ip v1) == 10.77.1.2 ]] && ok "ip" || bad ip

# --- stop / start
"$H" stop v1 >/dev/null 2>&1 && called "ch-remote --api-socket $V/v1/api.sock power-button" && ok "stop presses the power button" || bad stop
systemctl --user stop boxery-ch-v1.service   # the guest powered off
"$H" ls --json | jq -e 'map(select(.name == "v1"))[0] | .state == "shut off" and .ssh_addr == null' >/dev/null && ok "stopped VM: shut off, no addr" || bad "ls stopped"
expect_fail "ip of stopped VM fails" "$H" ip v1

# --- images: snapshots (disk only)
I=$BOXERY_CH_DIR/images
echo stopped-disk >"$V/v1/disk.qcow2"
: >"$CALLS"
expect "snapshot of a stopped VM" "$H" snap v1 cold
[[ $(cat "$I/v1@cold.qcow2") == stopped-disk ]] && ! called "ch-remote" && ok "stopped VM: plain copy of the overlay, no pause" || bad "cold capture: $(cat "$CALLS")"
expect "start" "$H" start v1
echo running-disk >"$V/v1/disk.qcow2"
: >"$CALLS"
expect "snapshot of a running VM" "$H" snap v1 s1
grep -o 'ch-remote .*' "$CALLS" | awk '{print $4}' | tr '\n' ' ' | grep -q '^pause resume $' && ok "running VM: pause → copy → resume" || bad "capture sequence: $(cat "$CALLS")"
[[ $(cat "$I/v1@s1.qcow2") == running-disk && ! -e $I/v1@s1.qcow2.part ]] && ok "image is a copy of the overlay" || bad "s1 image"
expect_fail "duplicate snapshot name rejected" "$H" snap v1 s1
imgs=$("$H" images); grep -q '^v1@s1 ' <<<"$imgs" && grep -q '^v1@cold ' <<<"$imgs" && ok "images lists both" || bad "images: $("$H" images)"
: >"$CALLS"
FAIL_CP=1 expect_fail "failed capture fails" "$H" snap v1 s2
called "ch-remote --api-socket $V/v1/api.sock resume" && ok "failed capture still resumes the VM" || bad "no resume after failure"
[[ ! -e $I/v1@s2.qcow2 && ! -e $I/v1@s2.qcow2.part ]] && ok "failed capture leaves nothing behind" || bad "s2 debris"

# --- revert = reimage: same VM identity, image's disk, running
echo changed >"$V/v1/disk.qcow2"
: >"$CALLS"
expect "revert" "$H" revert v1 s1
[[ $(cat "$V/v1/disk.qcow2") == running-disk ]] && ok "disk replaced by the image" || bad "disk not restored"
called "systemctl --user stop boxery-ch-v1.service" && called "systemctl --user start boxery-ch-v1.service" && ok "revert restarts the VM" || bad "revert sequence: $(cat "$CALLS")"
[[ $(cat "$V/v1/slot") == 1 ]] && ok "revert keeps the VM's slot (IP, MAC, TAP)" || bad "slot changed"
expect_fail "revert to unknown snapshot fails" "$H" revert v1 nope

# --- new --from / fork: a new identity on a copy of the image
: >"$CALLS"
out=$("$H" new f1 --from v1@s1 2>/dev/null) && [[ $out == "f1 10.77.3.2:22" ]] && ok "new --from gets its own slot" || bad "new --from: $out"
[[ $(cat "$V/f1/disk.qcow2") == running-disk ]] && ! called "qemu-img create" && ok "new --from copies the image's disk" || bad "f1 disk"
grep -q '52:54:00:77:00:03' "$V/f1/seed.iso.network-config" && grep -q '^hostname: f1$' "$V/f1/seed.iso.user-data" && ok "new --from: own MAC, IP and seed" || bad "f1 identity"
rm "$I/v1@s1.qcow2"; [[ $(cat "$V/f1/disk.qcow2") == running-disk ]] && ok "VM from an image survives the image's removal" || bad "f1 depends on image"
out=$("$H" fork v1 g1 g2 2>/dev/null) && [[ $(echo "$out" | wc -l | tr -d ' ') == 2 ]] && ok "fork into two VMs" || bad "fork: $out"
left=$(find "$I" -name '*@fork-*'); [[ -z $left ]] && ok "fork removes its temporary image" || bad "fork image left: $left"
"$H" rm f1 >/dev/null 2>&1; "$H" rm g1 >/dev/null 2>&1; "$H" rm g2 >/dev/null 2>&1

# --- rm
: >"$CALLS"
expect "rm" "$H" rm v1
[[ ! -d $V/v1 && ! -f $HOME/.config/systemd/user/boxery-ch-v1.service ]] && ok "rm removes the VM dir and unit" || bad "rm leftovers"
called "ip link del bxch1" && ok "rm deletes the TAP" || bad "tap not deleted"
[[ ! -e $I/v1@cold.qcow2 ]] && ok "rm deletes the VM's images" || bad "images left: $(ls "$I")"
jq -e 'has("v1") | not' "$BOXERY_CONF/tokens.json" >/dev/null && ok "rm revokes the proxy token" || bad token
"$H" new v3 >/dev/null 2>&1; [[ $(cat "$V/v3/slot") == 1 ]] && ok "freed slot 1 is reused" || bad "slot reuse: $(cat "$V/v3/slot")"

# --- headless: an overlay on stock.qcow2 (the plain cloud image), the layers in the seed
arch=amd64; [[ $(uname -m) != aarch64 && $(uname -m) != arm64 ]] || arch=arm64
mkdir -p "$HOME/.cache/boxery"; ci=$HOME/.cache/boxery/noble-$arch.img
echo cloud-image >"$ci"
mv "$BOXERY_CH_DIR/base.qcow2" "$tmp/base.off"
: >"$CALLS"
out=$("$H" new hl --headless 2>&1) && ok "new --headless without a base" || bad "new --headless: $out"
[[ $(cat "$BOXERY_CH_DIR/stock.qcow2" 2>/dev/null) == cloud-image ]] && ok "stock.qcow2 is a copy of the cloud image" || bad "stock.qcow2"
called "qemu-img create -q -f qcow2 -F qcow2 -b $BOXERY_CH_DIR/stock.qcow2 $V/hl/disk.qcow2" && ok "headless overlay backed by stock.qcow2" || bad "qemu-img: $(grep qemu-img "$CALLS")"
grep -q 'path: /usr/local/sbin/boxery-provision' "$V/hl/seed.iso.user-data" && grep -q '^users:' "$V/hl/seed.iso.user-data" && ok "seed carries the layers and creates agent" || bad "headless seed"
echo hl-disk >"$V/hl/disk.qcow2"
"$H" snap hl s1 >/dev/null 2>&1 && [[ $(cat "$BOXERY_CH_DIR/images/hl@s1.qcow2") == hl-disk ]] && ok "snapshot of a headless VM" || bad "headless snap"
"$H" new hl2 --from hl@s1 >/dev/null 2>&1 && [[ $(cat "$V/hl2/disk.qcow2") == hl-disk ]] && ! grep -q boxery-provision "$V/hl2/seed.iso.user-data" && ok "new --from a headless image: copy, no reprovisioning" || bad "headless new --from"
"$H" rm hl >/dev/null 2>&1; "$H" rm hl2 >/dev/null 2>&1
mv "$tmp/base.off" "$BOXERY_CH_DIR/base.qcow2"

# --- a failed create cleans up its TAP, directory and token
: >"$CALLS"
FAIL_START=1 expect_fail "new fails when the VMM unit can't start" "$H" new bad1
slot=$(grep -o 'ip tuntap add dev bxch[0-9]*' "$CALLS" | grep -o '[0-9]*$')
[[ -n $slot ]] && called "ip link del bxch$slot" && ok "failed new deletes its TAP" || bad "TAP left: $(cat "$CALLS")"
[[ ! -d $V/bad1 ]] && jq -e 'has("bad1") | not' "$BOXERY_CONF/tokens.json" >/dev/null && ok "failed new removes its dir and token" || bad "bad1 leftovers"
[[ ! -d $BOXERY_CONF/.new-bad1.lock ]] && ok "failed new releases its name lock" || bad "stale name lock"

# --- concurrency: parallel creates get distinct slots
for i in 1 2 3 4 5 6; do "$H" new "p$i" >/dev/null 2>&1 & done; wait
[[ $(cat "$V"/p*/slot | sort -u | wc -l | tr -d ' ') == 6 ]] && ok "6 parallel creates → 6 distinct slots" || bad "slots: $(cat "$V"/p*/slot | tr '\n' ' ')"

# --- inventory: an unreachable systemd user manager is an error, not an empty host
FAIL_SYSTEMD=1 expect_fail "ls fails when systemctl --user is unreachable" "$H" ls --json

# --- crash recovery hooks (sourced; README "Crash recovery contract"), idempotent
rec() { ( die() { echo "$*" >&2; exit 1; }; log() { :; }; need() { :; }; take_lock() { (set -C; : >"$1") 2>/dev/null; }; PROXY_PORT=9999
	# shellcheck source=/dev/null
	. "$ROOT/host/backends/cloud-hypervisor.sh"; "$@" ); }
mkdir -p "$V/half"; echo 77 >"$V/half/slot"; touch "$HOME/.config/systemd/user/boxery-ch-half.service" "$UNITS/boxery-ch-half.service"
: >"$CALLS"
rec backend_cleanup_new half && [[ ! -d $V/half && ! -f $HOME/.config/systemd/user/boxery-ch-half.service && ! -f $UNITS/boxery-ch-half.service ]] && called "ip link del bxch77" && ok "cleanup_new removes a half-created VM: unit, TAP, dir" || bad "cleanup_new: $(cat "$CALLS")"
rec backend_cleanup_new half && ok "cleanup_new is idempotent" || bad "cleanup_new second run"
mkdir -p "$V/early" && rec backend_cleanup_new early && [[ ! -d $V/early ]] && ok "cleanup_new before a slot was assigned" || bad "cleanup_new early"
mkdir "$BOXERY_CH_DIR/.slot.lock" && rec backend_cleanup_new nothing && [[ ! -d $BOXERY_CH_DIR/.slot.lock ]] && ok "cleanup_new clears a dead holder's slot lock" || bad "slot lock"
mkdir -p "$I"; touch "$I/x@y.qcow2" "$I/x@y.qcow2.part"
rec backend_cleanup_image x@y && [[ ! -e $I/x@y.qcow2 && ! -e $I/x@y.qcow2.part ]] && rec backend_cleanup_image x@y && ok "cleanup_image removes image + partial, idempotently" || bad "cleanup_image"
"$H" new rc1 >/dev/null 2>&1; touch "$I/rc1@z.qcow2.part"; : >"$CALLS"
CH_STATE=Paused rec backend_recover_capture rc1 rc1@z running && called "ch-remote --api-socket $V/rc1/api.sock resume" && [[ ! -e $I/rc1@z.qcow2.part ]] && ok "recover_capture resumes a VM left paused and drops the partial image" || bad "recover_capture: $(cat "$CALLS")"
: >"$CALLS"
rec backend_recover_capture rc1 rc1@z running && ! called "resume" && [[ -d $V/rc1 ]] && ok "recover_capture leaves a running VM alone (never removes the source)" || bad "recover_capture running"
"$H" rm rc1 >/dev/null 2>&1

# --- a create killed mid-way is recovered through backend_cleanup_new (docs/lifecycle.md)
: >"$CALLS"
SLOW_START=1 "$H" new crash >/dev/null 2>&1 & cli=$!
for _ in $(seq 200); do pgrep -f 'sleep 60' >/dev/null && break; sleep 0.05; done
crash_slot=$(cat "$V/crash/slot" 2>/dev/null) || true
kill -9 "$cli" 2>/dev/null; wait "$cli" 2>/dev/null || true   # 137
"$H" reconcile >/dev/null 2>&1
[[ -n $crash_slot && ! -d $V/crash ]] && called "ip link del bxch$crash_slot" && jq -e 'has("crash") | not' "$BOXERY_CONF/tokens.json" >/dev/null && ok "reconcile recovers an interrupted create: dir, TAP and token gone" || bad "crash recovery: slot=$crash_slot $(ls "$V")"
pgrep -f 'sleep 60' >/dev/null && { bad "abandoned worker still running"; pkill -f 'sleep 60'; } || ok "abandoned worker group stopped"

# --- helpers (sourced)
die() { echo "$*" >&2; exit 1; }; log() { :; }; need() { :; }; take_lock() { (set -C; : >"$1") 2>/dev/null; }   # helpers that die run in ( subshells )
# shellcheck source=/dev/null
. "$ROOT/host/backends/cloud-hypervisor.sh"
[[ $(ch_mac 300) == 52:54:00:77:01:2c ]] && ok "MAC encodes the slot" || bad "mac: $(ch_mac 300)"
(BOXERY_CH_SUDO="sudo -n"; . "$ROOT/host/backends/cloud-hypervisor.sh"; [[ ${CH_SUDO[*]} == "sudo -n" ]]) && ok "sudo is the default for network setup" || bad "sudo default"
(unset BOXERY_CH_SUDO; . "$ROOT/host/backends/cloud-hypervisor.sh"; [[ ${CH_SUDO[*]} == "sudo -n" ]]) && ok "sudo -n when BOXERY_CH_SUDO is unset" || bad "unset sudo"
[[ $CH_IMG == */noble-a*64.img ]] && ok "image cache path without CACHE set" || bad "CH_IMG: $CH_IMG"
stub cloud-hypervisor 'echo "cloud-hypervisor v53.0"'
e=$( (backend_check) 2>&1 ) && bad "v53 accepted" || { [[ $e == *"v54 or newer"* ]] && ok "cloud-hypervisor < v54 rejected" || bad "v53 error: $e"; }
stub cloud-hypervisor 'echo "cloud-hypervisor v54.0"'
e=$( (backend_check) 2>&1 ) || true; [[ $e != *"or newer"* ]] && ok "cloud-hypervisor v54 accepted" || bad "v54 error: $e"

# --- the proxy bridge: one unit per profile (#117). A second CH profile has its own BOXERY_CH_DIR.
U=$HOME/.config/systemd/user; mkdir -p "$U"
u1=$(BOXERY_PROXY_UNIT=boxery-proxy "$ROOT/host/backend.sh" backend_proxy_services)
u2=$(BOXERY_PROXY_UNIT=boxery-proxy-ch2 BOXERY_PROXY_PORT=9998 BOXERY_CH_DIR=$tmp/ch2 "$ROOT/host/backend.sh" backend_proxy_services)
[[ $u1 == boxery-ch-vsock.service && $u2 == boxery-ch-vsock-ch2.service ]] && ok "bridge units: boxery-ch-vsock (default), boxery-ch-vsock-ch2" || bad "units: $u1 $u2"
grep -q "UNIX-LISTEN:$BOXERY_CH_DIR/proxy.sock,.* TCP:127.0.0.1:9999$" "$U/$u1" && grep -q "UNIX-LISTEN:$tmp/ch2/proxy.sock,.* TCP:127.0.0.1:9998$" "$U/$u2" && grep -qx 'After=boxery-proxy-ch2.service' "$U/$u2" &&
	ok "each profile's socket goes to its own proxy" || bad "bridges: $(grep -h ExecStart "$U"/boxery-ch-vsock*.service)"

echo "passed: $pass  failed: $fail"; ((fail == 0))
