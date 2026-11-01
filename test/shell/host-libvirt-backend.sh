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

echo "passed: $pass  failed: $fail"; ((fail == 0))
