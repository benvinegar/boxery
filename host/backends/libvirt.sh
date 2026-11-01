# shellcheck shell=bash disable=SC2154  # sourced by host/boxery-host (provides die/log/need/SSH_OPTS/…)
# boxery backend: libvirt/KVM (Linux). Sourced by host/boxery-host.
# Contract: see host/backends/README.md.

export LIBVIRT_DEFAULT_URI=${LIBVIRT_DEFAULT_URI:-qemu:///system}
POOL=${BOXERY_POOL:-boxery}
POOL_DIR=${BOXERY_POOL_DIR:-/var/lib/libvirt/images/boxery}
NET=${BOXERY_NET:-default}
BASE_VOL=${BOXERY_BASE_VOL:-boxery-base.qcow2}
BASE_IMG_URL=https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
PREFIX=${BOXERY_DOMAIN_PREFIX:-boxery-}   # libvirt domain prefix; user-facing names omit it
dom() { echo "$PREFIX$1"; }
exists() { virsh dominfo "$(dom "$1")" >/dev/null 2>&1; }

upload_vol() { # file vol format
	local f=$1 v=$2 fmt=$3
	virsh vol-delete --pool "$POOL" "$v" >/dev/null 2>&1 || true
	virsh vol-create-as "$POOL" "$v" "$(stat -c %s "$f")" --format "$fmt" >/dev/null
	virsh vol-upload --pool "$POOL" "$v" "$f"
}

vm_ip() {
	virsh domifaddr "$(dom "$1")" --source lease 2>/dev/null | awk '/ipv4/{split($4,a,"/"); print a[1]; exit}'
}

wait_ip() {
	local ip
	for _ in $(seq 180); do ip=$(vm_ip "$1"); [[ -n $ip ]] && { echo "$ip"; return; }; sleep 1; done
	die "timed out waiting for $1 to get an IP"
}



backend_check() {
	need virsh; need virt-install; need cloud-localds; need qemu-img
	[[ -r /dev/kvm ]] || die "/dev/kvm not accessible"
}

backend_init() {
	if ! virsh pool-info "$POOL" >/dev/null 2>&1; then
		log "creating storage pool $POOL at $POOL_DIR"
		virsh pool-define-as "$POOL" dir --target "$POOL_DIR" >/dev/null
		virsh pool-build "$POOL" >/dev/null; virsh pool-start "$POOL" >/dev/null; virsh pool-autostart "$POOL" >/dev/null
	fi
}

# How guests reach the LLM proxy: socat in the guest connects to vsock CID 2 (the host).
backend_proxy_services() {
	cat >"$HOME/.config/systemd/user/boxery-vsock.service" <<-EOF
		[Unit]
		Description=boxery: expose LLM proxy to guests over vsock port $PROXY_PORT
		After=boxery-proxy.service
		[Service]
		ExecStart=$(command -v socat) VSOCK-LISTEN:$PROXY_PORT,reuseaddr,fork TCP:127.0.0.1:$PROXY_PORT
		Restart=always
		RestartSec=2
		[Install]
		WantedBy=default.target
	EOF
	echo boxery-vsock.service
}
guest_proxy_upstream() { echo "VSOCK-CONNECT:2:$PROXY_PORT"; }

backend_build_base() {
	local name=boxery-base-build
	mkdir -p "$CACHE"
	if [[ ! -f $CACHE/noble.img ]]; then
		log "downloading Ubuntu 24.04 cloud image"
		curl -fL --progress-bar -o "$CACHE/noble.img.part" "$BASE_IMG_URL" && mv "$CACHE/noble.img.part" "$CACHE/noble.img"
	fi
	# Existing VMs are qcow2 overlays backed by $BASE_VOL; rewriting it would corrupt them.
	local deps; deps=$(virsh list --all --name | grep -c "^$PREFIX" || true)
	if virsh vol-info --pool "$POOL" "$BASE_VOL" >/dev/null 2>&1 && ((deps > 0)); then
		die "$deps VM(s) depend on $BASE_VOL; remove them first (versioned templates are planned, see ARCHITECTURE.md)"
	fi
	virsh destroy "$name" >/dev/null 2>&1 || true
	virsh undefine "$name" >/dev/null 2>&1 || true
	log "uploading base disk"
	upload_vol "$CACHE/noble.img" "$BASE_VOL" qcow2
	virsh vol-resize --pool "$POOL" "$BASE_VOL" 20G >/dev/null
	local tmp; tmp=$(mktemp -d)
	printf 'instance-id: boxery-base-%s\nlocal-hostname: boxery-base\n' "$(date +%s)" >"$tmp/meta-data"
	cloud-localds "$tmp/seed.iso" "$ROOT/image/base-user-data.yaml" "$tmp/meta-data"
	upload_vol "$tmp/seed.iso" boxery-base-seed.iso raw
	rm -rf "$tmp"
	virsh vol-delete --pool "$POOL" build.log >/dev/null 2>&1 || true
	log "booting builder VM (installs XFCE, VNC, node, pi, opencode; ~5-10 min)"
	virt-install --name "$name" --memory 8192 --vcpus 8 --osinfo ubuntu24.04 \
		--disk "vol=$POOL/$BASE_VOL,bus=virtio" --disk "vol=$POOL/boxery-base-seed.iso,device=cdrom" \
		--network "network=$NET,model=virtio" --graphics none \
		--serial "pty,log.file=$POOL_DIR/build.log" \
		--events on_reboot=destroy --import --noautoconsole >/dev/null
	local t=0
	while [[ $(virsh domstate "$name" 2>/dev/null) == running ]]; do
		sleep 10; t=$((t + 10))
		((t % 60 == 0)) && log "still building... ${t}s"
		((t > 2400)) && die "build timed out"
	done
	virsh pool-refresh "$POOL" >/dev/null
	local blog; blog=$(mktemp)
	virsh vol-download --pool "$POOL" build.log "$blog" >/dev/null 2>&1 || true
	cp "$blog" "$CACHE/build.log" 2>/dev/null || true
	virsh undefine "$name" >/dev/null
	virsh vol-delete --pool "$POOL" boxery-base-seed.iso >/dev/null
	if grep -q BOXERY_BUILD_OK "$blog"; then
		log "base image ready: $POOL/$BASE_VOL"
	else
		tail -40 "$blog" >&2
		die "base build failed; full serial log in $CACHE/build.log"
	fi
}


backend_has_base() { virsh vol-info --pool "$POOL" "$BASE_VOL" >/dev/null 2>&1; }
backend_exists() { exists "$1"; }

backend_new() { # NAME CPUS MEM_MIB DISK_GIB USERDATA_FILE
	local name=$1 cpus=$2 mem=$3 disk=$4 userdata=$5 d; d=$(dom "$1")
	local tmp; tmp=$(mktemp -d)
	printf 'instance-id: %s-%s\nlocal-hostname: %s\n' "$name" "$(date +%s)" "$name" >"$tmp/meta-data"
	cloud-localds "$tmp/seed.iso" "$userdata" "$tmp/meta-data"
	upload_vol "$tmp/seed.iso" "$d-seed.iso" raw
	rm -rf "$tmp"
	log "creating $name (${cpus} vCPU, ${mem} MiB, ${disk} GiB overlay on $BASE_VOL)"
	virsh vol-create-as "$POOL" "$d.qcow2" "${disk}G" --format qcow2 \
		--backing-vol "$BASE_VOL" --backing-vol-format qcow2 >/dev/null
	virt-install --name "$d" --memory "$mem" --vcpus "$cpus" --osinfo ubuntu24.04 \
		--disk "vol=$POOL/$d.qcow2,bus=virtio" --disk "vol=$POOL/$d-seed.iso,device=cdrom" \
		--network "network=$NET,model=virtio" \
		--vsock cid.auto=yes \
		--graphics none --console pty,target_type=serial \
		--channel unix,target.type=virtio,target.name=org.qemu.guest_agent.0 \
		--metadata "description=boxery $name" \
		--import --noautoconsole >/dev/null
	virsh autostart "$d" >/dev/null 2>&1 || true
	wait_ip "$name" >/dev/null
}

backend_list() { # → lines: NAME<TAB>STATE<TAB>ADDR<TAB>DISK
	virsh list --all --name | grep "^$PREFIX" | while read -r d; do
		local n=${d#"$PREFIX"}
		printf '%s\t%s\t%s\t%s\n' "$n" "$(virsh domstate "$d" | head -1)" "$(vm_ip "$n")" \
			"$(virsh vol-info --pool "$POOL" "$d.qcow2" 2>/dev/null | awk '/Allocation/{print $2$3}')"
	done
}

# Where the VM's sshd is reachable from this host: "HOST PORT".
backend_ssh_endpoint() {
	exists "$1" || die "no such vm: $1"
	local ip; ip=$(vm_ip "$1"); [[ -n $ip ]] || die "$1 has no IP (stopped?)"
	echo "$ip 22"
}
backend_wait_endpoint() { echo "$(wait_ip "$1") 22"; }

backend_start() { virsh start "$(dom "$1")" >/dev/null; }
backend_stop() { virsh shutdown "$(dom "$1")" >/dev/null; }

backend_rm() {
	local d; d=$(dom "$1")
	exists "$1" || die "no such vm: $1"
	virsh destroy "$d" >/dev/null 2>&1 || true
	virsh snapshot-list "$d" --name 2>/dev/null | while read -r s; do if [[ -n $s ]]; then virsh snapshot-delete "$d" "$s" >/dev/null; fi; done
	virsh undefine "$d" --nvram >/dev/null 2>&1 || virsh undefine "$d" >/dev/null
	virsh vol-delete --pool "$POOL" "$d.qcow2" >/dev/null 2>&1 || true
	virsh vol-delete --pool "$POOL" "$d-seed.iso" >/dev/null 2>&1 || true
}

backend_snap() { # NAME SNAP
	timeout 600 virsh snapshot-create-as "$(dom "$1")" "$2" --atomic >/dev/null || { virsh resume "$(dom "$1")" >/dev/null 2>&1; die "snapshot failed"; }
}
backend_snap_rm() { virsh snapshot-delete "$(dom "$1")" "$2" >/dev/null; }
backend_snaps() { virsh snapshot-list "$(dom "$1")"; }
backend_snap_names() { virsh snapshot-list "$(dom "$1")" --name | sed '/^$/d'; }
backend_revert() { virsh snapshot-revert "$(dom "$1")" "$2" --running >/dev/null; }
