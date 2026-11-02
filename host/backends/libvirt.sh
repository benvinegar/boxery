# shellcheck shell=bash disable=SC2154  # sourced by host/boxery-host (provides die/log/need/SSH_OPTS/…)
# boxery backend: libvirt/KVM (Linux). Sourced by host/boxery-host.
# Contract: see host/backends/README.md.

export LIBVIRT_DEFAULT_URI=${LIBVIRT_DEFAULT_URI:-qemu:///system}
POOL=${BOXERY_POOL:-boxery}
POOL_DIR=${BOXERY_POOL_DIR:-/var/lib/libvirt/images/boxery}
NET=${BOXERY_NET:-default}
BASE_VOL=${BOXERY_BASE_VOL:-boxery-base.qcow2}
STOCK_VOL=${BOXERY_STOCK_VOL:-boxery-stock.qcow2}   # the plain cloud image headless VMs boot (no build-base)
BASE_IMG_URL=https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
PREFIX=${BOXERY_DOMAIN_PREFIX:-boxery-}   # libvirt domain prefix; user-facing names omit it
ISOLATION=${BOXERY_NET_ISOLATION:-on}     # guest network isolation (nwfilter); off = libvirt's open NAT network
NWFILTER=boxery-guest-isolation           # one filter for every profile; parameters are per interface
# Pin effective defaults in operation journals, even if host.env changes before recovery.
export BOXERY_POOL=$POOL BOXERY_POOL_DIR=$POOL_DIR BOXERY_BASE_VOL=$BASE_VOL BOXERY_STOCK_VOL=$STOCK_VOL BOXERY_DOMAIN_PREFIX=$PREFIX BOXERY_NET=$NET
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
	if isolated; then
		virsh nwfilter-list >/dev/null 2>&1 || die "libvirt's nwfilter driver isn't available (virtnwfilterd); start it, or set BOXERY_NET_ISOLATION=off to run guests on the open NAT network"
		net_gateway >/dev/null
	fi
}

# ---------------------------------------------------------------- guest network isolation
# Guests share libvirt's NAT network ($NET, a bridge). Each guest's interface references the nwfilter
# below, which libvirt instantiates on the host for that interface whenever the domain starts, so it
# lives in the domain XML: new VMs, forks, reverts, lease resets and reboots all keep it. Root in the
# guest can't lift it. Same policy as the cloud-hypervisor backend's nftables rules:
#   - no MAC, IP or ARP spoofing: the guest's IP is the one dnsmasq leased it (CTRL_IP_LEARNING=dhcp,
#     only DHCP answers from DHCPSERVER count), so a static address or another guest's IP goes nowhere;
#   - to the host (the bridge address): DHCP and DNS (libvirt's dnsmasq) only;
#   - no traffic to other guests, the host's other addresses, private, CGNAT/Tailscale, link-local
#     (cloud metadata), loopback or multicast/broadcast ranges; no IPv6 and no other L2 protocols;
#   - from outside: only replies, and ssh from the host (connect, wait_ssh, guest setup);
#   - everything else goes out through libvirt's NAT to the internet.
# The LLM proxy needs no IP path: it is vsock (CID 2), which nwfilter doesn't see.
# L3 rules (tcp/udp/all) get conntrack; the L2 root chain must accept IPv4 frames (priority -650, as
# libvirt's clean-traffic does) for them to be evaluated at all.
# BOXERY_NET_ISOLATION=off: new VMs get no filter, and `start` removes it from existing ones.
isolated() {
	case $ISOLATION in on) return 0 ;; off) return 1 ;; esac
	die "BOXERY_NET_ISOLATION must be on or off (got '$ISOLATION')"
}
ISOLATION_BLOCKED="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/3"
# The network's own (host) address: its DHCP and DNS server, and where host ssh comes from.
net_gateway() {
	local x gw=""
	x=$(virsh net-dumpxml "$NET" 2>/dev/null) || die "no libvirt network '$NET' (BOXERY_NET)"
	gw=$(sed -n "/family=.ipv6/d; s/.*<ip address=['\"]\([0-9.]*\)['\"].*/\1/p" <<<"$x" | head -1)
	[[ -n $gw ]] || die "libvirt network '$NET' has no IPv4 address (BOXERY_NET); isolation needs one, or set BOXERY_NET_ISOLATION=off"
	# Guest-to-guest traffic is dropped because the network's subnet is in a blocked range.
	case $gw in 10.* | 192.168.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].*) ;;
	*) die "libvirt network '$NET' ($gw) isn't on a private range, so isolation couldn't keep guests apart; use a 10/8, 172.16/12 or 192.168/16 network, or set BOXERY_NET_ISOLATION=off" ;;
	esac
	echo "$gw"
}
isolation_filter_xml() { # [UUID]   (libvirt only redefines a filter under its existing UUID)
	local r p=200
	echo "<filter name='$NWFILTER' chain='root'>"
	[[ -z ${1:-} ]] || echo "  <uuid>$1</uuid>"
	cat <<-'EOF'
		  <filterref filter='no-mac-spoofing'/>
		  <filterref filter='no-ip-spoofing'/>
		  <rule action='accept' direction='inout' priority='-650'><mac protocolid='ipv4'/></rule>
		  <filterref filter='no-arp-spoofing'/>
		  <rule action='accept' direction='inout' priority='-500'><mac protocolid='arp'/></rule>
		  <filterref filter='qemu-announce-self-rarp'/>
		  <rule action='accept' direction='out' priority='100' statematch='false'><udp srcportstart='68' dstportstart='67' dstipaddr='255.255.255.255'/></rule>
		  <rule action='accept' direction='in' priority='110' statematch='false'><udp srcipaddr='$DHCPSERVER' srcportstart='67' dstportstart='68'/></rule>
		  <rule action='accept' direction='out' priority='120'><udp dstipaddr='$DHCPSERVER' srcportstart='68' dstportstart='67'/></rule>
		  <rule action='accept' direction='out' priority='130'><udp dstipaddr='$DHCPSERVER' dstportstart='53'/></rule>
		  <rule action='accept' direction='out' priority='140'><tcp dstipaddr='$DHCPSERVER' dstportstart='53'/></rule>
		  <rule action='accept' direction='in' priority='150'><tcp srcipaddr='$DHCPSERVER' dstportstart='22'/></rule>
	EOF
	for r in $ISOLATION_BLOCKED; do
		echo "  <rule action='drop' direction='out' priority='$p'><all dstipaddr='${r%/*}' dstipmask='${r#*/}'/></rule>"
		p=$((p + 1))
	done
	cat <<-'EOF'
		  <rule action='accept' direction='out' priority='500'><all/></rule>
		  <rule action='accept' direction='in' priority='510'><icmp state='RELATED'/></rule>
		  <rule action='drop' direction='inout' priority='900'><all/></rule>
		  <filterref filter='no-other-l2-traffic'/>
		</filter>
	EOF
}
# Define (or update in place: running guests pick up the new rules at once) the filter.
isolation_define() {
	local uuid="" x f
	if x=$(virsh nwfilter-dumpxml "$NWFILTER" 2>/dev/null); then uuid=$(sed -n 's:.*<uuid>\(.*\)</uuid>.*:\1:p' <<<"$x" | head -1); fi
	f=$(mktemp); isolation_filter_xml "$uuid" >"$f"
	if ! virsh nwfilter-define "$f" >/dev/null; then rm -f "$f"; die "could not define the $NWFILTER network filter"; fi
	rm -f "$f"
}
isolation_ensure_filter() { isolated || return 0; virsh nwfilter-dumpxml "$NWFILTER" >/dev/null 2>&1 || isolation_define; }
# virt-install's --network for a new domain (base build, new VM).
net_arg() {
	local a="network=$NET,model=virtio"
	if isolated; then
		local gw; gw=$(net_gateway) || exit 1
		a+=",filterref.filter=$NWFILTER,xpath0.create=./filterref/parameter,xpath1.create=./filterref/parameter"
		a+=",xpath2.set=./filterref/parameter[1]/@name=DHCPSERVER,xpath3.set=./filterref/parameter[1]/@value=$gw"
		a+=",xpath4.set=./filterref/parameter[2]/@name=CTRL_IP_LEARNING,xpath5.set=./filterref/parameter[2]/@value=dhcp"
	fi
	echo "$a"
}
# Rewrite DOM's interfaces on $NET in its persistent config: add the filter (isolation on, or the
# network's gateway changed) or remove it (off). Applies from the next cold start. An interface with
# another filter is left alone. Returns 1 when nothing changed.
ensure_isolation() { # DOM
	local xml new gw="" f; xml=$(virsh dumpxml "$1" --inactive 2>/dev/null) || return 1
	if isolated; then gw=$(net_gateway) || return 1; fi
	new=$(isolation_rewrite "$NET" "$NWFILTER" "$gw" <<<"$xml") || return 1   # 1: already as wanted
	f=$(mktemp); printf '%s\n' "$new" >"$f"
	if ! virsh define "$f" >/dev/null; then rm -f "$f"; log "could not update network isolation on $1 (left as it was)"; return 1; fi
	rm -f "$f"
}
# NET FILTER GATEWAY (empty = remove) < domain XML > domain XML. Exits 1 (no output) if every interface
# on NET already is as wanted: FILTER with DHCPSERVER=GATEWAY and DHCP learning, or no FILTER.
isolation_rewrite() {
	awk -v net="$1" -v name="$2" -v gw="$3" '
		function flush(   n, i, ours, other, ok, out, skip) {
			if (index(block, "<source network=\x27" net "\x27") == 0) { out_all = out_all block; return }
			ours = index(block, "<filterref filter=\x27" name "\x27") > 0
			other = !ours && index(block, "<filterref ") > 0
			ok = gw == "" ? !ours : (ours && index(block, "<parameter name=\x27DHCPSERVER\x27 value=\x27" gw "\x27/>") && index(block, "<parameter name=\x27CTRL_IP_LEARNING\x27 value=\x27dhcp\x27/>"))
			if (other || ok) { out_all = out_all block; return }   # someone else filters it, or nothing to do
			changed = 1; n = split(block, L, "\n"); out = ""
			for (i = 1; i < n; i++) {
				if (skip) { if (L[i] ~ /<\/filterref>/) skip = 0; continue }
				if (index(L[i], "<filterref filter=\x27" name "\x27")) { if (L[i] !~ /\/>/) skip = 1; continue }
				if (L[i] ~ /<\/interface>/ && gw != "")
					out = out "      <filterref filter=\x27" name "\x27>\n        <parameter name=\x27CTRL_IP_LEARNING\x27 value=\x27dhcp\x27/>\n        <parameter name=\x27DHCPSERVER\x27 value=\x27" gw "\x27/>\n      </filterref>\n"
				out = out L[i] "\n"
			}
			out_all = out_all out
		}
		/<interface type=.network.>/ { inb = 1; block = "" }
		inb { block = block $0 "\n"; if ($0 ~ /<\/interface>/) { inb = 0; flush() }; next }
		{ out_all = out_all $0 "\n" }
		END { if (!changed) exit 1; printf "%s", out_all }
	'
}

backend_init() {
	if ! virsh pool-info "$POOL" >/dev/null 2>&1; then
		log "creating storage pool $POOL at $POOL_DIR"
		virsh pool-define-as "$POOL" dir --target "$POOL_DIR" >/dev/null
		virsh pool-build "$POOL" >/dev/null; virsh pool-start "$POOL" >/dev/null; virsh pool-autostart "$POOL" >/dev/null
	fi
	if isolated; then isolation_define; fi
	local d n=0 i=0
	while read -r d; do
		ensure_discard "$d" && n=$((n + 1))
		ensure_isolation "$d" && i=$((i + 1))
	done < <(virsh list --all --name | awk -v p="$PREFIX" 'index($0,p) == 1')
	((n == 0)) || log "$n VM(s) will pass discards to the host from their next cold start (stop + start, revert or lease reset)"
	if ((i > 0)); then
		if isolated; then log "$i VM(s) get guest network isolation from their next cold start (stop + start, revert or lease reset); until then they are on the open NAT network"
		else log "$i VM(s) lose guest network isolation from their next cold start (BOXERY_NET_ISOLATION=off)"; fi
	fi
}

# Disks pass the guest's discards (online discard, fstrim) to the host, so space freed in the guest is
# freed in its overlay and isn't copied into snapshots, forks and reimages. libvirt's default ignores them.
# For a domain made before boxery set this, add it to the persistent config (applies on the next cold
# start). Returns 1 when nothing changed; a disk driver with other attributes is left alone.
ensure_discard() { # DOM
	local xml f; xml=$(virsh dumpxml "$1" --inactive 2>/dev/null) || return 1
	[[ $xml == *"<driver name='qemu' type='qcow2'/>"* ]] || return 1
	f=$(mktemp); printf '%s\n' "${xml//"<driver name='qemu' type='qcow2'/>"/"<driver name='qemu' type='qcow2' discard='unmap'/>"}" >"$f"
	if ! virsh define "$f" >/dev/null; then rm -f "$f"; log "could not enable discard on $1 (left as it was)"; return 1; fi
	rm -f "$f"
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

cloud_image() { # download the Ubuntu cloud image once
	mkdir -p "$CACHE"
	if [[ ! -f $CACHE/noble.img ]]; then
		log "downloading Ubuntu 24.04 cloud image"
		curl -fL --progress-bar -o "$CACHE/noble.img.part.$$" "$BASE_IMG_URL" && mv "$CACHE/noble.img.part.$$" "$CACHE/noble.img" ||
			{ rm -f "$CACHE/noble.img.part.$$"; die "downloading $BASE_IMG_URL failed"; }
	fi
}
# The stock volume: the cloud image as it is, uploaded on the first headless `new`. Concurrent `new`s
# wait for one upload (flock; the backend is Linux-only).
stock_ensure() {
	mkdir -p "$CACHE"
	(
		flock 9
		virsh vol-info --pool "$POOL" "$STOCK_VOL" >/dev/null 2>&1 && exit 0
		cloud_image
		log "uploading the stock Ubuntu image ($STOCK_VOL)"
		upload_vol "$CACHE/noble.img" "$STOCK_VOL" qcow2 || { virsh vol-delete --pool "$POOL" "$STOCK_VOL" >/dev/null 2>&1; die "uploading $STOCK_VOL failed"; }
	) 9>"$CACHE/stock.lock" || exit 1
}
# Volumes (VM disks, images) whose backing chain ends at VOL. Every boxery disk is one overlay deep.
dependents() { # VOL → count
	virsh pool-refresh "$POOL" >/dev/null 2>&1 || true
	virsh vol-list "$POOL" 2>/dev/null | awk -v p="$PREFIX" 'NR > 2 && index($1, p) == 1 && $1 ~ /\.qcow2$/ {print $1}' | while read -r v; do
		[[ $v == "$BASE_VOL" || $v == "$STOCK_VOL" || $(root_vol "$v") != "$1" ]] || echo "$v"
	done | wc -l | tr -d ' '
}

backend_build_base() {
	local name=boxery-base-build
	cloud_image
	# Existing desktop VMs and their images are qcow2 overlays backed by $BASE_VOL; rewriting it would
	# corrupt them. Headless VMs are backed by $STOCK_VOL and don't count.
	local deps; deps=$(dependents "$BASE_VOL")
	if virsh vol-info --pool "$POOL" "$BASE_VOL" >/dev/null 2>&1 && ((deps > 0)); then
		die "$deps VM disk(s)/image(s) depend on $BASE_VOL; remove them first (versioned templates are planned, see ARCHITECTURE.md)"
	fi
	virsh destroy "$name" >/dev/null 2>&1 || true
	virsh undefine "$name" >/dev/null 2>&1 || true
	isolation_ensure_filter
	local net; net=$(net_arg) || exit 1
	log "uploading base disk"
	upload_vol "$CACHE/noble.img" "$BASE_VOL" qcow2
	virsh vol-resize --pool "$POOL" "$BASE_VOL" 20G >/dev/null
	local tmp; tmp=$(mktemp -d)
	printf 'instance-id: boxery-base-%s\nlocal-hostname: boxery-base\n' "$(date +%s)" >"$tmp/meta-data"
	cloud-localds "$tmp/seed.iso" "$BASE_USERDATA" "$tmp/meta-data"
	upload_vol "$tmp/seed.iso" boxery-base-seed.iso raw
	rm -rf "$tmp"
	virsh vol-delete --pool "$POOL" build.log >/dev/null 2>&1 || true
	log "booting builder VM (installs XFCE, VNC, node, pi, opencode; ~5-10 min)"
	virt-install --name "$name" --memory 8192 --vcpus 8 --osinfo ubuntu24.04 \
		--disk "vol=$POOL/$BASE_VOL,bus=virtio,discard=unmap" --disk "vol=$POOL/boxery-base-seed.iso,device=cdrom" \
		--network "$net" --graphics none \
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

# Disks: every VM disk and every image is a qcow2 overlay directly on a root volume (chain depth 1):
# $BASE_VOL (desktop) or $STOCK_VOL (headless). An image has its VM's root.
#   VM disk:  $PREFIX$NAME.qcow2        image:  $PREFIX$IMAGE.qcow2 (IMAGE = vm@label, so '@' marks images)
# capture = shallow live block copy of a VM's overlay into a new overlay on the base (the VM keeps
# running; filesystems are frozen through the guest agent for the final sync). A VM made from an image
# starts on an overlay backed by that image and pulls the image's data into its own overlay
# (blockpull --base), so it never depends on the image afterwards and images can be deleted any time.
vol() { echo "$PREFIX$1.qcow2"; }
vol_path() { echo "$POOL_DIR/$(vol "$1")"; }
vol_bytes() { virsh vol-info --pool "$POOL" "$(vol "$1")" --bytes | awk '/Capacity/{print $2}'; }
new_overlay() { # VOLNAME BYTES BACKING_VOL
	virsh vol-create-as "$POOL" "$1" "$2" --format qcow2 --backing-vol "$3" --backing-vol-format qcow2 >/dev/null
}
# The root volume under VOLNAME (its backing file), e.g. boxery-base.qcow2.
root_vol() { # VOLNAME → volume name ($BASE_VOL if it has no backing file: shouldn't happen)
	local p; p=$(virsh vol-dumpxml --pool "$POOL" "$1" 2>/dev/null | awk '/<backingStore>/ { b = 1 } b && /<path>/ { sub(/.*<path>/, ""); sub(/<\/path>.*/, ""); print; exit }')
	if [[ -n $p ]]; then echo "${p##*/}"; else echo "$BASE_VOL"; fi
}
# Pull everything above the root into the VM's own overlay. Needs the domain running.
pull_to_base() { # NAME ROOT_VOL
	virsh blockpull "$(dom "$1")" vda --base "$POOL_DIR/$2" --wait >/dev/null || die "blockpull failed for $1"
}

backend_new() { # NAME CPUS MEM_MIB DISK_GIB USERDATA_FILE [SOURCE: VM@LABEL image | stock]
	local name=$1 cpus=$2 mem=$3 disk=$4 userdata=$5 from=${6:-} d; d=$(dom "$1")
	isolation_ensure_filter
	local net; net=$(net_arg) || exit 1
	local tmp; tmp=$(mktemp -d)
	printf 'instance-id: %s-%s\nlocal-hostname: %s\n' "$name" "$(date +%s)" "$name" >"$tmp/meta-data"
	# DHCP client id = MAC, not the machine-id DUID: a VM made from an image starts with its source's
	# machine-id and would otherwise get the source's IP lease.
	printf 'version: 2\nethernets:\n  primary:\n    match:\n      name: "en*"\n    dhcp4: true\n    dhcp-identifier: mac\n' >"$tmp/network-config"
	cloud-localds --network-config="$tmp/network-config" "$tmp/seed.iso" "$userdata" "$tmp/meta-data"
	upload_vol "$tmp/seed.iso" "$d-seed.iso" raw
	rm -rf "$tmp"
	local bytes=$((disk * 1024 * 1024 * 1024)) backing=$BASE_VOL
	if [[ $from == stock ]]; then
		stock_ensure; backing=$STOCK_VOL
	elif [[ -n $from ]]; then
		virsh vol-info --pool "$POOL" "$(vol "$from")" >/dev/null 2>&1 || die "no such image: $from"
		local ib; ib=$(vol_bytes "$from"); if ((ib > bytes)); then bytes=$ib; fi
		backing=$(vol "$from")
	fi
	log "creating $name (${cpus} vCPU, ${mem} MiB, $((bytes / 1073741824)) GiB overlay on $backing)"
	new_overlay "$d.qcow2" "$bytes" "$backing"
	virt-install --name "$d" --memory "$mem" --vcpus "$cpus" --osinfo ubuntu24.04 \
		--disk "vol=$POOL/$d.qcow2,bus=virtio,discard=unmap" --disk "vol=$POOL/$d-seed.iso,device=cdrom" \
		--network "$net" \
		--vsock cid.auto=yes \
		--graphics none --console pty,target_type=serial \
		--channel unix,target.type=virtio,target.name=org.qemu.guest_agent.0 \
		--metadata "description=boxery $name" \
		--import --noautoconsole >/dev/null
	virsh autostart "$d" >/dev/null 2>&1 || true
	[[ -z $from || $from == stock ]] || pull_to_base "$name" "$(root_vol "$backing")"
	wait_ip "$name" >/dev/null
}

backend_list() { # → lines: NAME<TAB>STATE<TAB>SSH<TAB>DISK_BYTES<TAB>DISK_USED_BYTES
	local domains; domains=$(virsh list --all --name) || die "cannot list libvirt domains"
	printf '%s\n' "$domains" | awk -v p="$PREFIX" 'index($0,p) == 1' | while read -r d; do
		local n=${d#"$PREFIX"} ip
		ip=$(vm_ip "$n") || ip=""   # a stopped domain has no lease: domifaddr fails
		# The volume's Capacity is the disk's configured size; its Allocation is what the overlay
		# takes on the host (the base it sits on is shared, and not counted).
		printf '%s\t%s\t%s\t%s\n' "$n" "$(virsh domstate "$d" | head -1)" "${ip:+$ip:22}" \
			"$(virsh vol-info --pool "$POOL" "$(vol "$n")" --bytes 2>/dev/null | awk '/^Capacity:/ { c = $2 } /^Allocation:/ { a = $2 } END { printf "%s\t%s", c, a }')"
	done
}

# Where the VM's sshd is reachable from this host: "HOST PORT".
backend_ssh_endpoint() {
	exists "$1" || die "no such vm: $1"
	local ip; ip=$(vm_ip "$1"); [[ -n $ip ]] || die "$1 has no IP (stopped?)"
	echo "$ip 22"
}
backend_wait_endpoint() { echo "$(wait_ip "$1") 22"; }

backend_start() {
	local d; d=$(dom "$1")
	ensure_discard "$d" || true
	isolation_ensure_filter; ensure_isolation "$d" || true
	virsh start "$d" >/dev/null
}
backend_stop() { virsh shutdown "$(dom "$1")" >/dev/null; }
backend_size() {
	local d; d=$(dom "$1")
	printf '%s %s %s\n' "$(virsh vcpucount "$d" --config --maximum)" \
		"$(virsh dominfo "$d" | awk '/^Max memory:/ { print int($3 / 1024) }')" "$(($(vol_bytes "$1") / 1073741824))"
}
# CPU and memory go into the persistent config, the disk grows offline; the guest's cloud-init growpart
# extends the root filesystem on the next boot. Raising and lowering need the limits set in opposite order.
libvirt_set_vcpus() { # DOM FROM TO
	if (($3 > $2)); then virsh setvcpus "$1" "$3" --config --maximum && virsh setvcpus "$1" "$3" --config
	else virsh setvcpus "$1" "$3" --config && virsh setvcpus "$1" "$3" --config --maximum; fi >/dev/null
}
libvirt_set_mem() { # DOM FROM_MIB TO_MIB
	if (($3 > $2)); then virsh setmaxmem "$1" "${3}M" --config && virsh setmem "$1" "${3}M" --config
	else virsh setmem "$1" "${3}M" --config && virsh setmaxmem "$1" "${3}M" --config; fi >/dev/null
}
backend_resize() { # NAME CPUS MEM_MIB DISK_GIB (empty = unchanged)
	local name=$1 d st c m i rc=0; d=$(dom "$1"); st=$(virsh domstate "$d" | head -1)
	read -r c m _ < <(backend_size "$name")
	if [[ $st != "shut off" ]]; then
		log "stopping $name to resize it"
		virsh shutdown "$d" >/dev/null || die "could not shut down $name"
		for i in $(seq 120); do [[ $(virsh domstate "$d" | head -1) == "shut off" ]] && break; ((i < 120)) || die "$name did not shut down within 2 minutes"; sleep 1; done
	fi
	{ [[ -z $2 ]] || libvirt_set_vcpus "$d" "$c" "$2"; } && { [[ -z $3 ]] || libvirt_set_mem "$d" "$m" "$3"; } &&
		{ [[ -z $4 ]] || virsh vol-resize --pool "$POOL" "$d.qcow2" "${4}G" >/dev/null; } || rc=$?
	if [[ $st == running ]]; then
		isolation_ensure_filter; ensure_isolation "$d" || true
		virsh start "$d" >/dev/null || die "could not start $name again after resizing it"
	fi
	((rc == 0)) || die "resizing $name failed partway; check: virsh dominfo $d"
}

backend_rm() {
	local d; d=$(dom "$1")
	exists "$1" || die "no such vm: $1"
	virsh destroy "$d" >/dev/null 2>&1 || true
	virsh undefine "$d" --nvram >/dev/null 2>&1 || virsh undefine "$d" >/dev/null
	virsh vol-delete --pool "$POOL" "$d.qcow2" >/dev/null 2>&1 || true
	virsh vol-delete --pool "$POOL" "$d-seed.iso" >/dev/null 2>&1 || true
}

# Recovery must handle a create killed before a domain exists (volumes may already exist).
backend_cleanup_new() {
	virsh list --all --name >/dev/null || die "cannot inspect libvirt during recovery"
	virsh pool-refresh "$POOL" >/dev/null || die "cannot inspect storage pool during recovery"
	local d v; d=$(dom "$1")
	if exists "$1"; then backend_rm "$1"; fi
	for v in "$d.qcow2" "$d-seed.iso"; do
		if virsh vol-info --pool "$POOL" "$v" >/dev/null 2>&1; then
			virsh vol-delete --pool "$POOL" "$v" >/dev/null || die "could not clean $v"
		fi
	done
}
backend_cleanup_image() {
	virsh pool-refresh "$POOL" >/dev/null || die "cannot inspect storage pool during recovery"
	if virsh vol-info --pool "$POOL" "$(vol "$1")" >/dev/null 2>&1; then backend_image_rm "$1"; fi
}
backend_recover_capture() { # NAME IMAGE ORIGINAL_STATE
	local d job state; d=$(dom "$1")
	virsh list --all --name >/dev/null || die "cannot inspect libvirt during recovery"
	if exists "$1"; then
		state=$(virsh domstate "$d")
		if [[ $state == running || $state == paused ]]; then
			job=$(virsh blockjob "$d" vda --info --raw) || die "cannot inspect $1's block job"
			[[ -z $job ]] || virsh blockjob "$d" vda --abort >/dev/null || die "cannot stop $1's block job"
			virsh domfsthaw "$d" >/dev/null 2>&1 || true
			if [[ $3 != running && $3 != paused && $state == paused ]]; then virsh destroy "$d" >/dev/null; fi
		fi
	fi
	backend_cleanup_image "$2"
}

# ---------------------------------------------------------------- images
backend_capture() { # NAME IMAGE   (VM may be running; it keeps running)
	local name=$1 img=$2 d st started=0 frozen=0 rc=0; d=$(dom "$1")
	exists "$name" || die "no such vm: $name"
	st=$(virsh domstate "$d" | head -1)
	new_overlay "$(vol "$img")" "$(vol_bytes "$name")" "$(root_vol "$(vol "$name")")" || die "could not create $img"
	# blockcopy needs a running domain; boot a stopped one paused (the guest never runs).
	if [[ $st != running && $st != paused ]]; then
		virsh start "$d" --paused >/dev/null || { virsh vol-delete --pool "$POOL" "$(vol "$img")" >/dev/null; die "could not start $name paused to capture it"; }
		started=1
	fi
	virsh blockcopy "$d" vda "$(vol_path "$img")" --shallow --reuse-external --transient-job --wait >/dev/null || rc=$?
	if ((rc == 0)); then
		# Cancelling a mirror that is in sync completes it without pivoting: the copy is a point-in-time
		# image. Freeze guest filesystems around that moment so it's also filesystem-consistent.
		if ((!started)) && virsh domfsfreeze "$d" >/dev/null 2>&1; then frozen=1; fi
		virsh blockjob "$d" vda --abort >/dev/null || rc=$?
		if ((frozen)); then virsh domfsthaw "$d" >/dev/null || log "warning: could not thaw $name's filesystems"; fi
	fi
	if ((started)); then virsh destroy "$d" >/dev/null 2>&1 || true; fi
	if ((rc != 0)); then virsh vol-delete --pool "$POOL" "$(vol "$img")" >/dev/null 2>&1 || true; die "block copy of $name failed"; fi
	if ((!started && !frozen)); then log "warning: no guest agent on $name; $img is crash-consistent, not frozen"; fi
}

backend_images() { # → IMAGE<TAB>CREATED<TAB>SIZE
	virsh pool-refresh "$POOL" >/dev/null 2>&1 || true
	virsh vol-list "$POOL" 2>/dev/null | awk -v p="$PREFIX" 'NR > 2 && index($1, p) == 1 && $1 ~ /@.*\.qcow2$/ {print $1}' | while read -r v; do
		local i=${v#"$PREFIX"}; i=${i%.qcow2}
		local x; x=$(virsh vol-dumpxml --pool "$POOL" "$v")
		local m; m=$(sed -n 's:.*<mtime>\([0-9]*\)\..*</mtime>.*:\1:p' <<<"$x" | head -1)
		local a; a=$(sed -n "s:.*<allocation unit='bytes'>\([0-9]*\)</allocation>.*:\1:p" <<<"$x" | head -1)
		printf '%s\t%s\t%sMiB\n' "$i" "$(date -d "@$m" +%Y-%m-%dT%H:%M:%S 2>/dev/null)" "$((a / 1048576))"
	done
}
backend_image_rm() { virsh vol-delete --pool "$POOL" "$(vol "$1")" >/dev/null || die "could not remove image $1"; }

backend_reimage() { # NAME IMAGE   (keeps the domain: MAC, seed, vsock CID; ends running)
	local name=$1 img=$2 d; d=$(dom "$1")
	exists "$name" || die "no such vm: $name"
	virsh vol-info --pool "$POOL" "$(vol "$img")" >/dev/null 2>&1 || die "no such image: $img"
	local bytes ib; ib=$(vol_bytes "$img"); bytes=$ib
	if virsh vol-info --pool "$POOL" "$d.qcow2" >/dev/null 2>&1; then bytes=$(vol_bytes "$name"); fi
	if ((ib > bytes)); then bytes=$ib; fi
	virsh destroy "$d" >/dev/null 2>&1 || true
	# A retry may follow a crash between deleting the old disk and creating its replacement.
	if virsh vol-info --pool "$POOL" "$d.qcow2" >/dev/null 2>&1; then
		virsh vol-delete --pool "$POOL" "$d.qcow2" >/dev/null || die "could not remove $name's disk"
	fi
	new_overlay "$d.qcow2" "$bytes" "$(vol "$img")" || die "could not create $name's disk from $img"
	ensure_discard "$d" || true
	isolation_ensure_filter; ensure_isolation "$d" || true
	virsh start "$d" >/dev/null || die "could not start $name"
	pull_to_base "$name" "$(root_vol "$(vol "$img")")"
}
