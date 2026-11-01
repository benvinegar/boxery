#!/usr/bin/env bash
# Recovery hooks against command doubles only: never invoke real libvirt/Lima.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export BOXERY_POOL=test BOXERY_POOL_DIR=$tmp/pool BOXERY_DOMAIN_PREFIX=boxery- BOXERY_LIMA_PREFIX=boxery-
die() { echo "$*" >&2; exit 1; }
log() { :; }
(
	# shellcheck source=host/backends/libvirt.sh
	. "$ROOT/host/backends/libvirt.sh"
	domain=0 disk=1 seed=1 image=1 mock_job=0 mock_state=running abort_fails=0
	virsh() {
		printf '%s\n' "$*" >>"$tmp/virsh.log"
		case $1 in
		list) [[ $domain == 0 ]] || echo boxery-vm; return 0 ;;
		pool-refresh|domfsthaw) return 0 ;;
		dominfo) [[ $domain == 1 ]] ;;
		domstate) echo "$mock_state" ;;
		vol-info)
			case $4 in boxery-vm.qcow2) [[ $disk == 1 ]] ;; boxery-vm-seed.iso) [[ $seed == 1 ]] ;; *) [[ $image == 1 ]] ;; esac ;;
		vol-delete)
			case $4 in boxery-vm.qcow2) disk=0 ;; boxery-vm-seed.iso) seed=0 ;; *) image=0 ;; esac ;;
		blockjob)
			case $4 in
			--info) [[ $* == *--raw* ]] || die "recovery must use raw blockjob output"; [[ $mock_job == 0 ]] || echo 'Type: Block Copy'; return 0 ;;
			--abort) [[ $abort_fails == 0 ]] || return 1; mock_job=0 ;;
			esac ;;
		destroy) mock_state='shut off' ;;
		start) mock_state=running ;;
		*) die "unexpected virsh command: $*" ;;
		esac
	}
	vol_bytes() { echo 100; }
	new_overlay() { disk=1; }
	pull_to_base() { :; }

	backend_cleanup_new vm
	[[ $disk == 0 && $seed == 0 ]] || die "partial pre-domain volumes remain"
	backend_cleanup_new vm # idempotent

	domain=1 image=1 mock_job=1 mock_state=running
	backend_recover_capture vm vm@one running
	[[ $domain == 1 && $mock_state == running && $image == 0 && $mock_job == 0 ]] || die "capture recovery damaged the source or left its job/image"
	image=1 mock_job=0 mock_state=paused
	backend_recover_capture vm vm@two 'shut off'
	[[ $mock_state == 'shut off' && $image == 0 ]] || die "capture left a formerly stopped source paused"

	image=1 mock_job=1 mock_state=running abort_fails=1
	if ( backend_recover_capture vm vm@three running ) >/dev/null 2>&1; then die "failed blockjob abort was swallowed"; fi
	[[ $image == 1 ]] || die "image deleted while capture still active"
	abort_fails=0 mock_job=0 image=1 disk=0
	backend_reimage vm vm@clean
	[[ $disk == 1 && $mock_state == running ]] || die "reimage could not retry after old disk deletion"
)
(
	# shellcheck source=host/backends/lima.sh
	. "$ROOT/host/backends/lima.sh"
	export LIMA_HOME=$tmp/lima; mkdir -p "$LIMA_HOME"
	outage=0
	limactl() {
		printf '%s\n' "$*" >>"$tmp/lima.log"
		case $1 in
		list)
			[[ $outage == 0 ]] || return 1
			for d in "$LIMA_HOME"/*; do
				[[ -d $d ]] || continue
				printf '{"name":"%s","status":"Stopped"}\n' "${d##*/}"
			done ;;
		delete) rm -rf "${LIMA_HOME:?}/$3" ;;
		rename) mv "$LIMA_HOME/$3" "$LIMA_HOME/$4" ;;
		start) touch "$LIMA_HOME/$2/running" ;;
		*) die "unexpected limactl command: $*" ;;
		esac
	}
	im=$(img_inst vm@one)
	mkdir "$LIMA_HOME/$im" # no boxery-image metadata yet
	backend_cleanup_image vm@one
	[[ ! -d $LIMA_HOME/$im ]] || die "unpublished image clone remains"
	backend_cleanup_image vm@one

	mkdir "$LIMA_HOME/$im" "$LIMA_HOME/boxery-vm.new"
	backend_reimage vm vm@one
	[[ -e $LIMA_HOME/boxery-vm/running && ! -d $LIMA_HOME/boxery-vm.new ]] || die "staged replacement was not recovered"
	mkdir "$LIMA_HOME/boxery-vm.new"
	backend_cleanup_new vm
	[[ ! -d $LIMA_HOME/boxery-vm && ! -d $LIMA_HOME/boxery-vm.new ]] || die "partial instance/staging directories remain"
	outage=1
	if ( backend_cleanup_image vm@one ) >/dev/null 2>&1; then die "unavailable Lima treated as an absent image"; fi
	[[ -d $LIMA_HOME/$im ]] || die "outage cleanup removed the image"
)
echo 'PASS: libvirt/Lima recovery hooks (command doubles, no real VMs)'
