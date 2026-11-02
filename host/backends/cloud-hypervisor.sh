# shellcheck shell=bash disable=SC2154  # sourced by host/boxery-host (provides die/log/need/SSH_OPTS/…)
# boxery backend: Cloud Hypervisor (Linux + KVM). Sourced by host/boxery-host. EXPERIMENTAL.
# Contract: see host/backends/README.md.
#
# - Boots the stock Ubuntu cloud image through firmware (rust-hypervisor-firmware or CLOUDHV.fd), so the
#   golden image is built exactly like the libvirt one: base qcow2 + cloud-init seed + base-user-data.yaml.
# - Each VM is a qcow2 overlay on that base, plus a seed ISO, run by one systemd user unit
#   (boxery-ch-NAME.service → $CH_DIR/vms/NAME/launch.sh). No libvirt.
# - Networking is routed, not bridged: VM slot S gets its own TAP (bxchS) with the host at 10.77.S.1 and
#   the guest at 10.77.S.2 (static, via cloud-init network-config). There is no shared L2, so guests
#   can't ARP-spoof each other. nftables (table inet boxery_ch) drops guest→host, guest→guest and
#   guest→private ranges (RFC1918, CGNAT/Tailscale, link-local), and NATs the rest to the internet.
# - LLM proxy: Cloud Hypervisor's vsock is "hybrid": a guest connect to CID 2 port P arrives on the host
#   as a connection to the Unix socket <vm>/vsock.sock_P. Each VM's vsock.sock_PORT is a symlink to one
#   host-wide socket served by boxery-ch-vsock.service (socat → 127.0.0.1:PORT). The guest side is the
#   same as libvirt: VSOCK-CONNECT:2:PORT.
# - Images (snapshots, forks, pool resets; disk only, see README): $CH_DIR/images/IMAGE.qcow2, each a copy
#   of a VM's overlay (so it depends only on the base). Capture of a running VM: guest `sync`, pause (v54
#   drains and flushes qcow2 metadata), reflink copy, resume. New-from-image and reimage copy the image.
# - Headless VMs (SOURCE "stock") are overlays on stock.qcow2, a copy of the plain cloud image, instead of
#   the built base; cloud-init applies the plumbing + devtools layers at first boot. An overlay names its
#   backing file in its qcow2 header, so images and copies of either kind need nothing else.
#
# Privileges: TAP devices and nftables need root. Commands that need it run through $BOXERY_CH_SUDO
# (default "sudo -n", so passwordless sudo; set it to "" when running as root). The cloud-hypervisor
# binary needs cap_net_admin to open the TAPs: sudo setcap cap_net_admin+ep "$(command -v cloud-hypervisor)".
# VMs don't autostart after a host reboot (TAPs and nftables rules are recreated by `start`).

CH_DIR=${BOXERY_CH_DIR:-$HOME/.local/share/boxery/ch}
CH_NET=${BOXERY_CH_NET:-10.77}                 # first two octets; slot S uses $CH_NET.S.0/24
CH_DNS=${BOXERY_CH_DNS:-1.1.1.1 9.9.9.9}       # guests can't reach private resolvers (that's the point)
CH_FIRMWARE=${BOXERY_CH_FIRMWARE:-$CH_DIR/firmware}
CH_TAP=bxch                                    # TAP name prefix (≤ 15 chars total)
CH_BASE=$CH_DIR/base.qcow2
CH_STOCK=$CH_DIR/stock.qcow2   # the plain cloud image headless VMs boot (no build-base)
ch_arch() { case $(uname -m) in aarch64 | arm64) echo arm64 ;; *) echo amd64 ;; esac; }
CH_IMG_URL=https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-$(ch_arch).img
CH_IMG=${CACHE:-$HOME/.cache/boxery}/noble-$(ch_arch).img   # the libvirt backend caches amd64 as noble.img
CH_MIN_VERSION=54   # image_type/backing_files disk options; pause() that drains and flushes qcow2 metadata
CH_MAX_SLOT=250
read -r -a CH_SUDO <<<"${BOXERY_CH_SUDO-sudo -n}"
# Pin effective settings in operation journals, so crash recovery acts on the same directories and network.
export BOXERY_CH_DIR=$CH_DIR BOXERY_CH_NET=$CH_NET BOXERY_CH_DNS=$CH_DNS BOXERY_CH_FIRMWARE=$CH_FIRMWARE BOXERY_CH_SUDO="${CH_SUDO[*]-}"

ch_dir() { echo "$CH_DIR/vms/$1"; }
ch_unit() { echo "boxery-ch-$1.service"; }
ch_slot() { cat "$(ch_dir "$1")/slot"; }
ch_ip() { echo "$CH_NET.$(ch_slot "$1").2"; }
ch_mac() { printf '52:54:00:77:%02x:%02x' $(($1 / 256)) $(($1 % 256)); }
ch_root() { if ((${#CH_SUDO[@]})); then "${CH_SUDO[@]}" "$@"; else "$@"; fi; }   # bash < 4.4: "${empty[@]}" trips set -u
ch_remote() { local d; d=$(ch_dir "$1"); shift; ch-remote --api-socket "$d/api.sock" "$@"; }
ch_active() { systemctl --user is-active --quiet "$(ch_unit "$1")"; }
ch_copy() { cp --reflink=auto --sparse=always "$1" "$2"; }   # instant on XFS/btrfs, a full copy elsewhere

backend_check() {
	need cloud-hypervisor; need ch-remote; need qemu-img; need cloud-localds; need ip; need nft; need socat; need curl; need jq
	local v; v=$(cloud-hypervisor --version 2>/dev/null | sed -n 's/.*v\([0-9][0-9]*\)\..*/\1/p')
	[[ -n $v ]] && ((v >= CH_MIN_VERSION)) || die "need cloud-hypervisor v$CH_MIN_VERSION or newer (found: $(cloud-hypervisor --version 2>&1 | head -1)); older versions can't open qcow2 overlays or corrupt them in snapshots"
	[[ -r /dev/kvm && -w /dev/kvm ]] || die "/dev/kvm not accessible (add yourself to the kvm group)"
	[[ $CH_DIR != *[[:space:],=]* ]] || die "BOXERY_CH_DIR must not contain spaces, commas or '=' (cloud-hypervisor option syntax)"
	[[ $CH_NET =~ ^[0-9]{1,3}\.[0-9]{1,3}$ ]] || die "BOXERY_CH_NET must be two octets, e.g. 10.77"
	[[ -f $CH_FIRMWARE ]] || die "no firmware at $CH_FIRMWARE; download hypervisor-fw (rust-hypervisor-firmware) or CLOUDHV.fd from the cloud-hypervisor GitHub releases and set BOXERY_CH_FIRMWARE"
	if ((EUID != 0)); then
		getcap "$(command -v cloud-hypervisor)" 2>/dev/null | grep -q cap_net_admin ||
			die "cloud-hypervisor needs cap_net_admin to open TAPs: sudo setcap cap_net_admin+ep $(command -v cloud-hypervisor)"
		((${#CH_SUDO[@]} == 0)) || ch_root true || die "'${CH_SUDO[*]}' doesn't work; set up passwordless sudo or BOXERY_CH_SUDO"
	fi
}

# Guest isolation. Reloaded atomically on every start/new: nftables rules don't survive a reboot or an
# `nft flush ruleset`, and BOXERY_CH_NET may have changed.
ch_nft_rules() {
	cat <<-EOF
		table inet boxery_ch {
		  set blocked4 {
		    type ipv4_addr; flags interval
		    elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/3 }
		  }
		  chain input {
		    type filter hook input priority 0; policy accept;
		    iifname "$CH_TAP*" ct state established,related accept
		    iifname "$CH_TAP*" counter drop
		  }
		  chain forward {
		    type filter hook forward priority 0; policy accept;
		    iifname "$CH_TAP*" fib saddr . iif oif missing counter drop
		    oifname "$CH_TAP*" ct state established,related accept
		    oifname "$CH_TAP*" counter drop
		    iifname "$CH_TAP*" meta nfproto ipv6 counter drop
		    iifname "$CH_TAP*" ip daddr @blocked4 counter drop
		    iifname "$CH_TAP*" accept
		  }
		  chain postrouting {
		    type nat hook postrouting priority 100; policy accept;
		    ip saddr $CH_NET.0.0/16 oifname != "$CH_TAP*" masquerade
		  }
		}
	EOF
}
ch_firewall() {
	ch_root sysctl -qw net.ipv4.ip_forward=1
	# "table …; delete table …" first: one transaction that replaces the table whether or not it exists.
	{ echo "table inet boxery_ch"; echo "delete table inet boxery_ch"; ch_nft_rules; } | ch_root nft -f - || die "loading nftables rules failed"
}

ch_net_up() { # SLOT
	local tap=$CH_TAP$1
	ch_firewall
	ch_root ip link show "$tap" >/dev/null 2>&1 || ch_root ip tuntap add dev "$tap" mode tap user "$(id -un)" || die "creating $tap failed"
	ch_root ip addr replace "$CH_NET.$1.1/24" dev "$tap"
	ch_root ip link set "$tap" up
}
ch_net_down() { ch_root ip link del "$CH_TAP$1" 2>/dev/null || true; }

# Lowest free slot (1..250); slot 0 is the base-image builder. Serialized: concurrent `new`s race here.
ch_alloc_slot() { # NAME → slot (written to the VM dir)
	local lock=$CH_DIR/.slot.lock i s used
	for i in $(seq 300); do mkdir "$lock" 2>/dev/null && break; sleep 0.1; [[ $i == 300 ]] && die "slot lock held ($lock)"; done
	used=" $(cat "$CH_DIR"/vms/*/slot 2>/dev/null | tr '\n' ' ') "
	for ((s = 1; s <= CH_MAX_SLOT; s++)); do [[ $used == *" $s "* ]] || break; done
	if ((s > CH_MAX_SLOT)); then rmdir "$lock"; die "no free network slots (max $CH_MAX_SLOT VMs)"; fi
	echo "$s" >"$(ch_dir "$1")/slot"
	rmdir "$lock"
	echo "$s"
}

ch_seed() { # OUT_ISO USERDATA INSTANCE_ID HOSTNAME SLOT
	local tmp dns; tmp=$(mktemp -d)
	dns=$(echo "$CH_DNS" | sed 's/  */, /g')
	printf 'instance-id: %s\nlocal-hostname: %s\n' "$3" "$4" >"$tmp/meta-data"
	cat >"$tmp/network-config" <<-EOF
		version: 2
		ethernets:
		  eth0:
		    match:
		      macaddress: "$(ch_mac "$5")"
		    set-name: eth0
		    addresses: [$CH_NET.$5.2/24]
		    routes:
		      - to: default
		        via: $CH_NET.$5.1
		    nameservers:
		      addresses: [$dns]
	EOF
	cloud-localds -N "$tmp/network-config" "$1" "$2" "$tmp/meta-data" || { rm -rf "$tmp"; die "cloud-localds failed"; }
	rm -rf "$tmp"
}

ch_args() { # DIR SLOT CPUS MEM_MIB → cloud-hypervisor arguments for a cold boot, one per line
	printf '%s\n' --api-socket "path=$1/api.sock" --firmware "$CH_FIRMWARE" \
		--cpus "boot=$3" --memory "size=$4M" \
		--disk "path=$1/disk.qcow2,image_type=qcow2,backing_files=on" "path=$1/seed.iso,readonly=on,image_type=raw" \
		--net "tap=$CH_TAP$2,mac=$(ch_mac "$2")" \
		--vsock "cid=3,socket=$1/vsock.sock" \
		--serial "file=$1/serial.log" --console off --rng src=/dev/urandom
}

# launch.sh: what the unit runs.
ch_write_launch() { # NAME SLOT CPUS MEM_MIB
	local d; d=$(ch_dir "$1")
	{
		echo '#!/usr/bin/env bash'
		echo 'set -euo pipefail'
		printf 'cd %q\n' "$d"
		echo 'rm -f api.sock vsock.sock'
		printf 'exec %q' "$(command -v cloud-hypervisor)"
		ch_args "$d" "$2" "$3" "$4" | while IFS= read -r a; do printf ' %q' "$a"; done
		echo
	} >"$d/launch.sh"
	chmod 755 "$d/launch.sh"
	mkdir -p "$HOME/.config/systemd/user"
	cat >"$HOME/.config/systemd/user/$(ch_unit "$1")" <<-EOF
		[Unit]
		Description=boxery VM $1 (cloud-hypervisor)
		[Service]
		ExecStart=$d/launch.sh
		TimeoutStopSec=20
		Restart=no
	EOF
	systemctl --user daemon-reload
}

backend_init() {
	mkdir -p "$CH_DIR/vms" "$CH_DIR/images"
	ch_firewall
}

backend_proxy_services() {
	mkdir -p "$CH_DIR"
	cat >"$HOME/.config/systemd/user/boxery-ch-vsock.service" <<-EOF
		[Unit]
		Description=boxery: LLM proxy for cloud-hypervisor guests (hybrid vsock socket)
		After=boxery-proxy.service
		[Service]
		ExecStart=$(command -v socat) UNIX-LISTEN:$CH_DIR/proxy.sock,fork,unlink-early,mode=600 TCP:127.0.0.1:$PROXY_PORT
		Restart=always
		RestartSec=2
		[Install]
		WantedBy=default.target
	EOF
	echo boxery-ch-vsock.service
}
guest_proxy_upstream() { echo "VSOCK-CONNECT:2:$PROXY_PORT"; }

ch_cloud_image() { # download the Ubuntu cloud image once
	mkdir -p "$CACHE"
	if [[ ! -f $CH_IMG ]]; then
		log "downloading Ubuntu 24.04 cloud image"
		curl -fL --progress-bar -o "$CH_IMG.part.$$" "$CH_IMG_URL" && mv "$CH_IMG.part.$$" "$CH_IMG" ||
			{ rm -f "$CH_IMG.part.$$"; die "downloading $CH_IMG_URL failed"; }
	fi
}
# stock.qcow2, made on the first headless `new`; concurrent `new`s wait for one copy.
ch_stock_ensure() {
	mkdir -p "$CH_DIR"
	(
		flock 9
		[[ ! -f $CH_STOCK ]] || exit 0
		ch_cloud_image
		cp "$CH_IMG" "$CH_STOCK.part" && mv "$CH_STOCK.part" "$CH_STOCK" || { rm -f "$CH_STOCK.part"; die "copying the stock image failed"; }
	) 9>"$CH_DIR/.stock.lock" || exit 1
}
ch_backing() { qemu-img info --output=json "$1" 2>/dev/null | jq -r '."backing-filename" // empty' 2>/dev/null || true; }   # FILE → its backing file

backend_build_base() {
	mkdir -p "$CACHE" "$CH_DIR/vms" "$CH_DIR/images"   # before counting: find on a missing dir + pipefail = silent exit
	# Desktop VMs and their images are overlays on $CH_BASE; headless ones (on $CH_STOCK) don't count.
	local deps=0 f
	while IFS= read -r f; do [[ $(ch_backing "$f") != "$CH_BASE" ]] || deps=$((deps + 1)); done < <(find "$CH_DIR/vms" -mindepth 2 -maxdepth 2 -name disk.qcow2; find "$CH_DIR/images" -name '*.qcow2')
	[[ ! -f $CH_BASE ]] || ((deps == 0)) || die "$deps VM(s)/image(s) depend on $CH_BASE; remove them first"
	ch_cloud_image
	local b=$CH_DIR/build part=$CH_DIR/base.qcow2.part
	rm -rf "$b"; mkdir -p "$b"
	cp "$CH_IMG" "$part"
	qemu-img resize -q "$part" 20G
	ch_seed "$b/seed.iso" "$BASE_USERDATA" "boxery-base-$(date +%s)" boxery-base 0
	ch_net_up 0
	log "booting builder VM (installs XFCE, VNC, node, pi, opencode; ~5-10 min)"
	# Same arguments as a VM; its "disk.qcow2" is the base being built.
	ln -s "$part" "$b/disk.qcow2"
	local args=() a
	while IFS= read -r a; do args+=("$a"); done < <(ch_args "$b" 0 8 8192)
	cloud-hypervisor "${args[@]}" >"$b/vmm.log" 2>&1 &
	local pid=$! t=0
	while kill -0 "$pid" 2>/dev/null; do   # base-user-data.yaml powers off when done; CH then exits
		sleep 10; t=$((t + 10))
		((t % 60 == 0)) && log "still building... ${t}s"
		((t > 2400)) && { kill "$pid"; ch_net_down 0; die "build timed out"; }
	done
	wait "$pid" || true
	ch_net_down 0
	cp "$b/serial.log" "$CACHE/build.log" 2>/dev/null || true
	if grep -q BOXERY_BUILD_OK "$b/serial.log" 2>/dev/null; then
		mv "$part" "$CH_BASE"
		rm -rf "$b"
		log "base image ready: $CH_BASE"
	else
		tail -40 "$b/serial.log" >&2 2>/dev/null || tail -40 "$b/vmm.log" >&2
		die "base build failed; serial log in $CACHE/build.log, VMM log in $b/vmm.log"
	fi
}

backend_has_base() { [[ -f $CH_BASE ]]; }
backend_exists() { [[ -d $(ch_dir "$1") ]]; }

backend_new() { # NAME CPUS MEM_MIB DISK_GIB USERDATA_FILE [SOURCE: VM@LABEL image | stock]
	local name=$1 cpus=$2 mem=$3 disk=$4 userdata=$5 from=${6:-} d slot root=$CH_BASE; d=$(ch_dir "$1")
	if [[ $from == stock ]]; then ch_stock_ensure; root=$CH_STOCK from=""
	else [[ -z $from || -f $(ch_image "$from") ]] || die "no such image: $from"; fi
	mkdir -p "$CH_DIR/vms"
	mkdir "$d" || die "$name already exists"
	slot=$(ch_alloc_slot "$name")   # new slot → new TAP, MAC and IP; the seed has a new instance-id
	log "creating $name (${cpus} vCPU, ${mem} MiB, ${disk} GiB overlay on ${from:-$root}, $CH_NET.$slot.2)"
	if [[ -n $from ]]; then
		ch_copy "$(ch_image "$from")" "$d/disk.qcow2" || die "copying $from failed"
		qemu-img resize -q "$d/disk.qcow2" "${disk}G" 2>/dev/null || true   # grow only; a bigger image keeps its size
	else
		qemu-img create -q -f qcow2 -F qcow2 -b "$root" "$d/disk.qcow2" "${disk}G" || die "qemu-img create failed"
	fi
	ch_seed "$d/seed.iso" "$userdata" "$name-$(date +%s)" "$name" "$slot"
	ln -sfn "$CH_DIR/proxy.sock" "$d/vsock.sock_$PROXY_PORT"
	ch_write_launch "$name" "$slot" "$cpus" "$mem"
	backend_start "$name"
}

backend_list() { # → lines: NAME<TAB>STATE<TAB>SSH<TAB>DISK_BYTES<TAB>DISK_USED_BYTES
	local d n st ssh disk size used
	# An unreachable user manager would make every VM look stopped; that's an error, not an empty host.
	systemctl --user show-environment >/dev/null 2>&1 || die "cannot reach the systemd user manager (systemctl --user)"
	for d in "$CH_DIR"/vms/*/; do
		[[ -f $d/slot ]] || continue
		n=$(basename "$d") st="shut off" ssh="" size="" used="" disk=${d%/}/disk.qcow2
		if ch_active "$n"; then st=running ssh="$(ch_ip "$n"):22"; fi
		if [[ -f $disk ]]; then
			# virtual size from the qcow2 header (-U: the running VMM may hold the image); used = the
			# overlay's allocated blocks (its backing base/stock image is shared and not counted)
			size=$(qemu-img info -U --output=json "$disk" 2>/dev/null | jq -r '."virtual-size" // empty' 2>/dev/null) || size=""
			used=$(du -k "$disk" 2>/dev/null | awk '{ print $1 }') || used=""
			if [[ $used =~ ^[0-9]+$ ]]; then used=$((used * 1024)); else used=""; fi
		fi
		printf '%s\t%s\t%s\t%s\t%s\n' "$n" "$st" "$ssh" "$size" "$used"
	done
}

backend_ssh_endpoint() {
	backend_exists "$1" || die "no such vm: $1"
	ch_active "$1" || die "$1 is not running"
	echo "$(ch_ip "$1") 22"
}
# The VM is booted. The API answers before boot (and briefly when boot then fails), so check the state.
# ssh readiness is the dispatcher's wait_ssh.
backend_wait_endpoint() {
	local i
	for i in $(seq 120); do
		ch_remote "$1" info 2>/dev/null | jq -e '.state == "Running"' >/dev/null 2>&1 && { echo "$(ch_ip "$1") 22"; return; }
		ch_active "$1" || ((i < 4)) || die "$1's VMM exited (journalctl --user -u $(ch_unit "$1"))"
		sleep 0.5
	done
	die "timed out waiting for $1 to start (journalctl --user -u $(ch_unit "$1"))"
}

backend_start() {
	backend_exists "$1" || die "no such vm: $1"
	ch_net_up "$(ch_slot "$1")"
	ln -sfn "$CH_DIR/proxy.sock" "$(ch_dir "$1")/vsock.sock_$PROXY_PORT"
	systemctl --user start "$(ch_unit "$1")" || die "starting $1 failed (journalctl --user -u $(ch_unit "$1"))"
}
backend_stop() { ch_active "$1" || return 0; ch_remote "$1" power-button >/dev/null || die "power-button failed"; }
ch_kill() { systemctl --user stop "$(ch_unit "$1")" 2>/dev/null || true; }

backend_rm() {
	backend_exists "$1" || die "no such vm: $1"
	local slot; slot=$(ch_slot "$1" 2>/dev/null) || slot=""
	ch_kill "$1"
	rm -f "$HOME/.config/systemd/user/$(ch_unit "$1")"
	systemctl --user daemon-reload 2>/dev/null || true
	[[ -z $slot ]] || ch_net_down "$slot"
	rm -rf "$(ch_dir "$1")"
}

# ---------------------------------------------------------------- images (see README: disk only)
ch_image() { echo "$CH_DIR/images/$1.qcow2"; }

backend_capture() { # NAME IMAGE   (VM may be running; it keeps running)
	backend_exists "$1" || die "no such vm: $1"
	local d img; d=$(ch_dir "$1"); img=$(ch_image "$2")
	[[ ! -e $img ]] || die "image $2 exists"
	mkdir -p "$CH_DIR/images"
	if ch_active "$1"; then
		vm_ssh_cmd "$1" "$(ch_ip "$1")" 22 sync >/dev/null 2>&1 || log "warning: couldn't sync $1's filesystems; $2 is crash-consistent"
		ch_remote "$1" pause >/dev/null || die "pausing $1 failed"
		if ! ch_copy "$d/disk.qcow2" "$img.part"; then
			ch_remote "$1" resume >/dev/null 2>&1; rm -f "$img.part"; die "copying $1's disk failed"
		fi
		ch_remote "$1" resume >/dev/null || die "resuming $1 failed"
	else
		ch_copy "$d/disk.qcow2" "$img.part" || { rm -f "$img.part"; die "copying $1's disk failed"; }
	fi
	mv "$img.part" "$img"
}

backend_images() { # → IMAGE<TAB>CREATED<TAB>SIZE
	local f
	for f in "$CH_DIR"/images/*@*.qcow2; do
		[[ -f $f ]] || continue
		printf '%s\t%s\t%sMiB\n' "$(basename "$f" .qcow2)" "$(date -r "$f" +%Y-%m-%dT%H:%M:%S)" "$(du -k "$f" | awk '{ printf "%d", $1 / 1024 }')"
	done
}
backend_image_rm() { [[ -f $(ch_image "$1") ]] || die "no such image: $1"; rm -f "$(ch_image "$1")"; }

backend_reimage() { # NAME IMAGE   (keeps slot, MAC, IP and seed; ends running)
	backend_exists "$1" || die "no such vm: $1"
	local d img; d=$(ch_dir "$1"); img=$(ch_image "$2")
	[[ -f $img ]] || die "no such image: $2"
	ch_kill "$1"
	ch_copy "$img" "$d/disk.qcow2.new" || { rm -f "$d/disk.qcow2.new"; die "copying $2 failed"; }
	mv "$d/disk.qcow2.new" "$d/disk.qcow2"
	backend_start "$1"
}

# ---------------------------------------------------------------- crash recovery (README: idempotent)
backend_cleanup_new() { # NAME: remove a VM whose create was interrupted, whatever got created
	local d slot=""; d=$(ch_dir "$1")
	systemctl --user show-environment >/dev/null 2>&1 || die "cannot reach the systemd user manager during recovery"
	[[ ! -f $d/slot ]] || slot=$(cat "$d/slot")
	ch_kill "$1"
	rm -f "$HOME/.config/systemd/user/$(ch_unit "$1")"
	systemctl --user daemon-reload || die "systemctl --user daemon-reload failed during recovery"
	[[ -z $slot ]] || ch_net_down "$slot"
	rm -rf "$d" || die "could not remove $d"
	rmdir "$CH_DIR/.slot.lock" 2>/dev/null || true   # held only for milliseconds; a leftover means its holder died
}
backend_cleanup_image() { rm -f "$(ch_image "$1")" "$(ch_image "$1").part" || die "could not remove image $1"; }
backend_recover_capture() { # NAME IMAGE ORIGINAL_STATE: a capture died, maybe with NAME paused
	if backend_exists "$1" && ch_active "$1" && ch_remote "$1" info 2>/dev/null | jq -e '.state == "Paused"' >/dev/null 2>&1; then
		ch_remote "$1" resume >/dev/null || die "could not resume $1 after an interrupted capture"
	fi
	backend_cleanup_image "$2"
}
