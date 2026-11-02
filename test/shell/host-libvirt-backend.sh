#!/usr/bin/env bash
# libvirt backend: root volumes (desktop base vs stock image for headless VMs), against command doubles
# only (virsh, virt-install, cloud-localds are shell functions here). Never touches real libvirt.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT; T=$tmp   # T: backend functions have their own local tmp
export BOXERY_POOL=test BOXERY_POOL_DIR=$tmp/pool BOXERY_DOMAIN_PREFIX=boxery- CACHE=$tmp/cache
mkdir -p "$tmp/vols" "$CACHE"
pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }
die() { echo "$*" >&2; exit 1; }
log() { :; }
# shellcheck source=host/backends/libvirt.sh
. "$ROOT/host/backends/libvirt.sh"

# Volumes are files in $V: a volume's content is its backing volume's name (empty = none).
V=$tmp/vols LOG=$tmp/calls.log
: >"$LOG"
virsh() {
	printf 'virsh %s\n' "$*" >>"$LOG"
	local a
	case $1 in
	vol-info) [[ -f $V/$4 ]] ;;
	vol-dumpxml)
		[[ -f $V/$4 ]] || return 1
		printf "<volume type='file'>\n  <name>%s</name>\n  <target>\n    <path>%s/%s</path>\n  </target>\n" "$4" "$POOL_DIR" "$4"
		[[ ! -s $V/$4 ]] || printf "  <backingStore>\n    <path>%s/%s</path>\n    <format type='qcow2'/>\n  </backingStore>\n" "$POOL_DIR" "$(cat "$V/$4")"
		echo "</volume>" ;;
	vol-create-as) # POOL NAME BYTES [--format F] [--backing-vol B --backing-vol-format F]
		local b=""; for a in "${@:5}"; do [[ ${prev:-} != --backing-vol ]] || b=$a; prev=$a; done; prev=""
		echo "$b" >"$V/$3" ;;
	vol-delete) rm -f "$V/$4" ;;
	vol-list) printf ' Name Path\n------\n'; for a in "$V"/*; do [[ ! -f $a ]] || echo " $(basename "$a") $POOL_DIR/$(basename "$a")"; done ;;
	blockpull) echo "${5##*/}" >"$V/$2.qcow2" ;;   # DOM vda --base PATH: the disk now sits on PATH
	domstate) echo running ;;
	dominfo) [[ -f $T/dom.$2 ]] ;;
	dumpxml) [[ -f $T/xml.$2 ]] && cat "$T/xml.$2" ;;   # DOM --inactive
	define) sed -n "s/.*<driver name='qemu' type='qcow2'\(.*\)\/>.*/defined driver:\1/p" "$2" >>"$LOG" ;;
	*) return 0 ;;   # pool-refresh, autostart, start, destroy, blockcopy, blockjob, domfsfreeze/thaw
	esac
}
virt-install() { printf 'virt-install %s\n' "$*" >>"$LOG"; touch "$T/dom.$2"; }
cloud-localds() { touch "${@: -3:1}"; }
upload_vol() { printf 'upload %s %s\n' "$1" "$2" >>"$LOG"; : >"$V/$2"; }
wait_ip() { echo 192.0.2.10; }
flock() { :; }   # util-linux; not on macOS
vol_bytes() { echo 1073741824; }
called() { grep -F -- "$1" "$LOG" >/dev/null; }

: >"$V/$BASE_VOL"
echo cloud-image >"$CACHE/noble.img"
echo '#cloud-config' >"$tmp/ud"

# --- headless: an overlay on the stock volume, uploaded once
backend_new hl 2 2048 10 "$tmp/ud" stock
called "upload $CACHE/noble.img $STOCK_VOL" && ok "first headless new uploads the stock volume" || bad "stock upload: $(cat "$LOG")"
[[ $(cat "$V/boxery-hl.qcow2") == "$STOCK_VOL" ]] && ok "headless disk is an overlay on $STOCK_VOL" || bad "hl backing: $(cat "$V/boxery-hl.qcow2")"
! called "virsh blockpull" && ok "no block pull for a fresh overlay" || bad "pulled"
: >"$LOG"
backend_new hl2 2 2048 10 "$tmp/ud" stock
! called "upload $CACHE/noble.img" && ok "a second headless new reuses the stock volume" || bad "re-uploaded"
[[ $(root_vol boxery-hl.qcow2) == "$STOCK_VOL" && $(root_vol "$BASE_VOL") == "$BASE_VOL" ]] && ok "root_vol: the backing volume (a root itself falls back to the base)" || bad "root_vol: $(root_vol boxery-hl.qcow2)"

# --- desktop: on the base, as before
backend_new dt 2 2048 10 "$tmp/ud"
[[ $(cat "$V/boxery-dt.qcow2") == "$BASE_VOL" ]] && ok "desktop disk is an overlay on the base" || bad "dt backing"

# --- images keep their VM's root; VMs from them pull down to that root
backend_capture hl hl@s1
[[ $(cat "$V/boxery-hl@s1.qcow2") == "$STOCK_VOL" ]] && ok "an image of a headless VM is an overlay on the stock volume" || bad "hl@s1 backing: $(cat "$V/boxery-hl@s1.qcow2")"
backend_capture dt dt@s1
[[ $(cat "$V/boxery-dt@s1.qcow2") == "$BASE_VOL" ]] && ok "an image of a desktop VM is an overlay on the base" || bad "dt@s1 backing"
: >"$LOG"
backend_new hf 2 2048 10 "$tmp/ud" hl@s1
[[ $(cat "$V/boxery-hf.qcow2") == "$STOCK_VOL" ]] && called "blockpull boxery-hf vda --base $POOL_DIR/$STOCK_VOL" && ok "new --from a headless image pulls down to the stock volume" || bad "hf: $(grep blockpull "$LOG")"
: >"$LOG"
backend_reimage hl hl@s1
called "blockpull boxery-hl vda --base $POOL_DIR/$STOCK_VOL" && ok "reimage pulls down to the image's root" || bad "reimage: $(grep blockpull "$LOG")"
: >"$LOG"
backend_reimage dt dt@s1
called "blockpull boxery-dt vda --base $POOL_DIR/$BASE_VOL" && ok "...the base for a desktop VM" || bad "reimage dt: $(grep blockpull "$LOG")"

# --- build-base only counts what depends on the base
[[ $(dependents "$BASE_VOL") == 2 ]] && ok "base dependents: the desktop VM and its image, not headless disks" || bad "dependents: $(dependents "$BASE_VOL")"
rm "$V/boxery-dt.qcow2" "$V/boxery-dt@s1.qcow2"
[[ $(dependents "$BASE_VOL") == 0 ]] && ok "headless VMs alone don't block build-base" || bad "dependents after rm: $(dependents "$BASE_VOL")"

# --- discards reach the host: new disks get discard=unmap, older domains get it on their next cold start
before() { local a b; a=$(grep -nF -m1 -- "$1" "$LOG"); b=$(grep -nF -m1 -- "$2" "$LOG"); [[ -n $a && -n $b && ${a%%:*} -lt ${b%%:*} ]]; }
: >"$LOG"; backend_new dn 2 2048 10 "$tmp/ud"
called "--disk vol=test/boxery-dn.qcow2,bus=virtio,discard=unmap" && ok "new VM disks pass discards to the host" || bad "virt-install: $(grep virt-install "$LOG")"
dxml() { printf "<domain>\n  <name>%s</name>\n  <devices>\n    <disk type='volume' device='disk'>\n      <driver name='qemu' type='qcow2'%s/>\n    </disk>\n    <disk type='volume' device='cdrom'>\n      <driver name='qemu' type='raw'/>\n    </disk>\n  </devices>\n</domain>\n" "$1" "$2" >"$T/xml.$1"; }
dxml boxery-old ""; : >"$LOG"
ensure_discard boxery-old && called "defined driver: discard='unmap'" && [[ $(grep -c "defined driver" "$LOG") == 1 ]] && ok "an older domain's qcow2 disk gets discard=unmap (the cdrom is left alone)" || bad "ensure_discard: $(cat "$LOG")"
dxml boxery-old " discard='unmap'"; : >"$LOG"
! ensure_discard boxery-old && ! called "virsh define" && ok "a domain that already has it isn't redefined" || bad "redefined: $(cat "$LOG")"
dxml boxery-old " cache='none'"; : >"$LOG"
! ensure_discard boxery-old && ! called "virsh define" && ok "a disk driver with other attributes is left alone" || bad "custom driver: $(cat "$LOG")"
dxml boxery-old ""; : >"$LOG"
backend_start old
before "defined driver: discard='unmap'" "virsh start boxery-old" && ok "start adds it before booting" || bad "start: $(cat "$LOG")"
dxml boxery-hl ""; : >"$LOG"
backend_reimage hl hl@s1
before "defined driver: discard='unmap'" "virsh start boxery-hl" && ok "reimage (revert, lease reset) adds it before booting" || bad "reimage: $(cat "$LOG")"
virsh() { case $1 in list) printf 'boxery-a\nboxery-b\nother-vm\n' ;; dumpxml) printf "<driver name='qemu' type='qcow2'/>\n" ;; define) echo "define" >>"$LOG" ;; esac; }
: >"$LOG"; log() { echo "$*" >>"$LOG"; }
backend_init 2>/dev/null
[[ $(grep -c '^define$' "$LOG") == 2 ]] && called "2 VM(s) will pass discards" && ok "init adds it to every domain of this host, not other domains" || bad "init: $(cat "$LOG")"
log() { :; }

# --- inventory: ssh endpoint as HOST:PORT, the volume's Capacity and Allocation in bytes
virsh() {
	case "$1 ${2:-}" in
	"list --all") printf 'boxery-up\nboxery-down\nother-vm\n' ;;
	"domstate boxery-up") echo running ;;
	"domstate boxery-down") echo "shut off" ;;
	"domifaddr boxery-up") printf ' Name MAC address Protocol Address\n----\n vnet0 52:54:00:aa:bb:cc ipv4 192.0.2.10/24\n' ;;
	"domifaddr boxery-down") return 1 ;;
	"vol-info --pool")
		[[ $4 == boxery-up.qcow2 && ${5:-} == --bytes ]] || return 1
		printf 'Name:           boxery-up.qcow2\nType:           file\nCapacity:       42949672960 bytes\nAllocation:     1116691456 bytes\n' ;;
	esac
}
printf 'up\trunning\t192.0.2.10:22\t42949672960\t1116691456\ndown\tshut off\t\t\t\n' >"$tmp/list.want"
backend_list >"$tmp/list.got"
diff -u "$tmp/list.want" "$tmp/list.got" >/dev/null && ok "backend_list: NAME STATE HOST:22 CAPACITY ALLOCATION (empty = unknown), only this host's domains" || bad "backend_list: $(sed -n l "$tmp/list.got")"

echo "passed: $pass  failed: $fail"; ((fail == 0))
