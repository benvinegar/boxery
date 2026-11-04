# shellcheck shell=bash disable=SC2154  # sourced by host/boxery-host (provides die/log/need/SSH_OPTS/…)
# boxery backend: Lima (macOS or Linux). Sourced by host/boxery-host.
# Contract: see host/backends/README.md.
#
# - VMs are Lima instances named boxery-NAME (plain mode: no mounts, no port forwards, no guest agent),
#   cloned from a built template instance (boxery-base) so each new VM boots a ready desktop image.
# - Guests reach the host's LLM proxy at Lima's user-network gateway (192.168.5.2), which Lima maps to the
#   host's loopback, so the proxy stays bound to 127.0.0.1. That mapping would hand guests every loopback
#   service on the host (#67), so on macOS lima_start confines each instance's host agent: see below.
# - ssh endpoint is 127.0.0.1:<lima ssh port>; `boxery-host connect` pipes to it.
# - vmType: qemu on Linux; vz on macOS by default.
# - Images (snapshots, fork sources, pool clean state) are stopped Lima instances named
#   boxery-img.<hash> (the '.' can't occur in VM names), cloned with `limactl clone` (copy-on-write on
#   APFS/btrfs). The image's name is kept in a boxery-image file in the instance dir. Lima only clones
#   stopped instances, so capturing a running VM stops it briefly; works on vz and qemu alike.
# - Headless VMs (SOURCE "stock") are fresh instances of Lima's Ubuntu 24.04 template instead of clones of
#   boxery-base; backend_new runs the plumbing + devtools layers (boxery-provision) over ssh.

LIMA_PREFIX=${BOXERY_LIMA_PREFIX:-boxery-}
LIMA_BASE=${LIMA_PREFIX}base
LIMA_GATEWAY=${BOXERY_LIMA_GATEWAY:-192.168.5.2}
LIMA_VMTYPE=${BOXERY_LIMA_VMTYPE:-$([[ $(uname) == Darwin ]] && echo vz || echo qemu)}
LIMA_ARCH=${BOXERY_LIMA_ARCH:-default}
# Start instances under the loopback-confining Seatbelt profile (lima_start). On by default on macOS, the
# only place sandbox-exec exists; BOXERY_LIMA_CONFINE=0 turns it off (tests, troubleshooting).
LIMA_CONFINE=${BOXERY_LIMA_CONFINE:-$([[ $(uname) == Darwin ]] && echo 1 || echo 0)}
export BOXERY_LIMA_PREFIX=$LIMA_PREFIX BOXERY_LIMA_GATEWAY=$LIMA_GATEWAY BOXERY_LIMA_VMTYPE=$LIMA_VMTYPE BOXERY_LIMA_ARCH=$LIMA_ARCH
linst() { echo "$LIMA_PREFIX$1"; }
lima_json() { limactl list --format json 2>/dev/null | jq -c "select(.name == \"$1\")"; }
lima_exists_inst() { local j; j=$(lima_json "$1") || die "cannot inspect Lima instances"; [[ -n $j ]]; }
# Image instance name: a hash, since image names contain '@' (not allowed by Lima) and can be long.
img_inst() { local h; h=$(printf '%s' "$1" | { shasum 2>/dev/null || sha1sum; } | cut -c1-16); echo "${LIMA_PREFIX}img.$h"; }
lima_dir() { echo "${LIMA_HOME:-$HOME/.lima}/$1"; }
lima_status() { lima_json "$1" | jq -r .status; }
lima_stop() { [[ $(lima_status "$1") == Stopped ]] || limactl stop "$1" >/dev/null 2>&1 || die "limactl stop $1 failed"; }

backend_check() {
	need limactl; need jq; need ssh
	if [[ $LIMA_CONFINE == 1 ]]; then need sandbox-exec; fi
	if [[ $(uname) != Darwin && $LIMA_VMTYPE == qemu ]]; then [[ -r /dev/kvm ]] || log "warning: /dev/kvm not accessible; Lima will use slow TCG emulation"; fi
}

# Loopback confinement (#67). A guest's user-mode network (gvisor-tap-vsock on vz, slirp on qemu) runs in
# Lima's host agent (or the qemu it spawns), and Lima NATs the gateway 192.168.5.2 to the host's
# 127.0.0.1, so whatever the guest dials there the host agent dials on the host's loopback. On macOS every
# instance is started under sandbox-exec with a Seatbelt profile that the host agent and its children
# inherit: no outbound connections to the host's loopback (any 127/8 address, TCP and UDP) except the LLM
# proxy and the instance's own ssh port, which the host agent itself uses (it leads to the guest's own
# sshd). The host's kernel enforces it, so root in the guest can't lift it; other destinations (the
# internet) are unaffected. The ssh port is chosen here and pinned with --ssh-port so the profile can name
# it. By default qemu guests send DNS to the host agent's resolver on a random loopback port, so confined
# qemu instances use slirp's own DNS forwarder (.3 on the user network, inside qemu) instead; vz answers
# DNS inside gvisor.
lima_free_port() { "${BOXERY_NODE:-node}" -e 'const s = require("net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })'; }
lima_profile() { # SSH_PORT → Seatbelt profile (later rules win)
	printf '(version 1)\n(allow default)\n(deny network-outbound (remote ip "localhost:*"))\n'
	printf '(allow network-outbound (remote ip "localhost:%s"))\n' "$PROXY_PORT" "$1"
}
lima_start() { # INSTANCE TIMEOUT: start it (nothing to do if it runs), confined on macOS
	local i=$1 port args=()
	[[ $(lima_status "$i") != Running ]] || return 0
	if [[ $LIMA_CONFINE != 1 ]]; then limactl start "$i" --timeout "$2"; return; fi
	port=$(lima_free_port) && [[ $port =~ ^[0-9]+$ ]] || { echo "boxery-host: no free port for $i's ssh" >&2; return 1; }
	args=(--ssh-port "$port")
	[[ $(lima_json "$i" | jq -r .vmType) == vz ]] || args+=(--dns "${LIMA_GATEWAY%.*}.3")   # also turns hostResolver off
	sandbox-exec -p "$(lima_profile "$port")" limactl start "$i" --tty=false "${args[@]}" --timeout "$2"
}

backend_init() { :; }
backend_proxy_services() { :; }   # no guest bridge service needed on the host
guest_proxy_upstream() { echo "TCP:$LIMA_GATEWAY:$PROXY_PORT"; }

# Lima template for both the builder and each VM. The desktop install (image/base-user-data.yaml) runs
# once in the builder; clones inherit its disk. Per-VM cloud-config (keys, token, configs) is applied
# by boxery-host over ssh after the clone boots (Lima owns the cloud-init seed).
lima_template() { # NAME CPUS MEM_MIB DISK_GIB
	cat <<-EOF
		minimumLimaVersion: 2.0.0
		base:
		- template:_images/ubuntu-24.04
		vmType: $LIMA_VMTYPE
		arch: $LIMA_ARCH
		cpus: $2
		memory: $(( $3 / 1024 ))GiB
		disk: $4GiB
		plain: true
		mounts: []
		user:
		  name: agent
		  home: /home/agent
		ssh:
		  loadDotSSHPubKeys: false
		  forwardAgent: false
	EOF
}

backend_build_base() {
	if lima_exists_inst "$LIMA_BASE"; then
		local deps; deps=$(limactl list --format json | jq -r '.name' | grep -c "^$LIMA_PREFIX" || true)
		((deps <= 1)) || die "$((deps - 1)) VM(s) exist; remove them before rebuilding the base (clones are independent, but keep it simple)"
		limactl delete --force "$LIMA_BASE" >/dev/null
	fi
	local tmp; tmp=$(mktemp -d)
	lima_template base 8 8192 20 >"$tmp/base.yaml"
	log "creating Lima builder instance ($LIMA_VMTYPE, $(uname -m))"
	limactl create --name "$LIMA_BASE" --tty=false "$tmp/base.yaml" >/dev/null 2>"$tmp/create.log" || { cat "$tmp/create.log" >&2; die "limactl create failed"; }
	lima_start "$LIMA_BASE" 20m >/dev/null 2>"$tmp/start.log" || { tail -20 "$tmp/start.log" >&2; die "limactl start failed"; }
	log "installing the desktop image (XFCE, VNC, Chromium/Chrome, node, pi, opencode; ~5-10 min)"
	# Reuse the libvirt build script: extract boxery-build.sh + write_files from the cloud-config and run them.
	lima_apply_cloudconfig "$BASE_USERDATA" build || die "base build failed (see output above)"
	limactl stop "$LIMA_BASE" >/dev/null
	rm -rf "$tmp"
	log "base image ready: Lima instance $LIMA_BASE"
}

# Apply a cloud-config's write_files (+ for "build": run /usr/local/sbin/boxery-build.sh; for "vm": runcmd)
# over ssh. Lima owns the instance's own cloud-init seed, so we replay ours as root.
lima_apply_cloudconfig() { # FILE build|vm [NAME]
	local f=$1 mode=$2
	"${BOXERY_NODE:-node}" "$ROOT/host/cloudconfig-sh.mjs" "$f" >"$f.files.sh" || return 1
	if [[ $mode == build ]]; then
		# The build script disables cloud-init re-runs, linger etc. exactly as in the libvirt builder.
		ssh -F "$HOME/.lima/$LIMA_BASE/ssh.config" "lima-$LIMA_BASE" 'sudo bash -s' <"$f.files.sh" || return 1
		ssh -F "$HOME/.lima/$LIMA_BASE/ssh.config" "lima-$LIMA_BASE" 'sudo bash -c "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && /usr/local/sbin/boxery-build.sh"' || return 1
		ssh -F "$HOME/.lima/$LIMA_BASE/ssh.config" "lima-$LIMA_BASE" 'test -f /var/log/boxery-build.ok' || return 1
		# The libvirt builder empties the agent user's authorized_keys via cloud-init clean; Lima re-injects
		# its own key at boot, so nothing else to do. Make the agent user's runtime services start on boot:
		ssh -F "$HOME/.lima/$LIMA_BASE/ssh.config" "lima-$LIMA_BASE" 'sudo loginctl enable-linger agent' || true
	else
		# The files include the VM's pinned ssh host key (host/hostkeys.mjs): make sshd load it now, also
		# where it runs as a long-lived ssh.service rather than socket-activated.
		if grep -q '^  - path: /etc/ssh/boxery_host_ed25519_key$' "$f"; then echo 'systemctl try-reload-or-restart ssh.service || true' >>"$f.files.sh"; fi
		ssh -F "$HOME/.lima/$(linst "$3")/ssh.config" "lima-$(linst "$3")" 'sudo bash -s' <"$f.files.sh" || return 1
	fi
	rm -f "$f.files.sh"
}

backend_has_base() { lima_exists_inst "$LIMA_BASE"; }
backend_exists() { lima_exists_inst "$(linst "$1")"; }

backend_new() { # NAME CPUS MEM_MIB DISK_GIB USERDATA_FILE [SOURCE: VM@LABEL image | stock]
	local name=$1 cpus=$2 mem=$3 disk=$4 userdata=$5 from=${6:-} i src; i=$(linst "$1")
	local sshcfg="$HOME/.lima/$i/ssh.config"
	if [[ $from == stock ]]; then
		log "creating $name (Lima $LIMA_VMTYPE, ${cpus} vCPU, ${mem} MiB, ${disk} GiB, headless: stock Ubuntu 24.04)"
		local tmp; tmp=$(mktemp -d)
		lima_template "$name" "$cpus" "$mem" "$disk" >"$tmp/vm.yaml"
		limactl create --name "$i" --tty=false "$tmp/vm.yaml" >/dev/null 2>"$tmp/create.log" || { cat "$tmp/create.log" >&2; rm -rf "$tmp"; die "limactl create failed"; }
		rm -rf "$tmp"
	else
		src=$LIMA_BASE
		if [[ -n $from ]]; then
			src=$(img_inst "$from"); lima_exists_inst "$src" || die "no such image: $from"
			local ig; ig=$(lima_json "$src" | jq -r '.disk / 1073741824 | floor'); if ((ig > disk)); then disk=$ig; fi
		fi
		log "creating $name (Lima $LIMA_VMTYPE, ${cpus} vCPU, ${mem} MiB, ${disk} GiB, cloned from ${from:-$LIMA_BASE})"
		lima_stop "$src"
		limactl clone --tty=false "$src" "$i" --cpus "$cpus" --memory "$(( mem / 1024 ))" --disk "$disk" >/dev/null 2>&1 ||
			die "limactl clone failed"
		rm -f "$(lima_dir "$i")/boxery-image"
	fi
	lima_start "$i" 10m >/dev/null 2>&1 || die "limactl start $i failed"
	# Per-VM identity: replay the generated cloud-config (files + runcmd) as root over Lima's ssh.
	lima_apply_cloudconfig "$userdata" vm "$name" || die "applying per-VM config failed"
	# The stock image: what the cloud-config's first runcmd step does on seeded backends. boxery-host
	# checks the result (/var/log/boxery-provision.ok) and shows the log if it failed.
	if [[ $from == stock ]]; then
		ssh -F "$sshcfg" "lima-$i" 'sudo sh -c "/usr/local/sbin/boxery-provision >/var/log/boxery-provision.log 2>&1"' </dev/null || log "provisioning $name failed"
	fi
	# authorized keys (host mgmt key + registered controller keys), hostname, then the runcmd steps.
	awk '/^ssh_authorized_keys:/{f=1;next} f&&/^  - /{sub(/^  - /,""); gsub(/^"|"$/,""); print; next} f{f=0}' "$userdata" |
		ssh -F "$sshcfg" "lima-$i" 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys; sort -u -o ~/.ssh/authorized_keys ~/.ssh/authorized_keys'
	# Same as the libvirt cloud-config's runcmd: everything under the agent's home belongs to the agent
	# (write_files creates parent dirs such as ~/.pi/agent as root).
	ssh -F "$sshcfg" "lima-$i" "sudo chown -R agent:agent /home/agent; sudo hostnamectl set-hostname $(printf %q "$name"); sudo systemctl restart boxery-llm.service;
		cd ~ && git config --global user.name agent && git config --global user.email agent@boxery && git config --global init.defaultBranch main;
		mkdir -p ~/project && cd ~/project && { [ -d .git ] || git init -q; }; systemctl --user daemon-reload; systemctl --user start boxery-vnc boxery-desktop boxery-novnc 2>/dev/null || true"
	# From an image: the disk is another VM's. Give it its own machine-id (journald, DHCP client id).
	if [[ -n $from && $from != stock ]]; then ssh -F "$sshcfg" "lima-$i" 'sudo rm -f /etc/machine-id /var/lib/dbus/machine-id && sudo systemd-machine-id-setup >/dev/null' || true; fi
}

# Bytes the instance's disk files take on the host (blocks allocated, not their sparse size): `disk`
# (Lima 2), or `basedisk` + `diffdisk` (older Lima). Empty if it has none.
lima_disk_used() { # DIR
	local f u k=0 any=""
	for f in "$1/disk" "$1/basedisk" "$1/diffdisk"; do
		[[ -f $f ]] || continue
		u=$(du -k "$f" 2>/dev/null | awk '{ print $1 }') || u=""
		[[ $u =~ ^[0-9]+$ ]] || return 0   # unreadable: unknown, not a smaller number
		any=1 k=$((k + u))
	done
	[[ -z $any ]] || echo $((k * 1024))
}
backend_list() { # → lines: NAME<TAB>STATE<TAB>SSH<TAB>DISK_BYTES<TAB>DISK_USED_BYTES
	local n st port disk dir
	# Lima keeps sshLocalPort while an instance is stopped: only a running VM has an ssh endpoint.
	limactl list --format json 2>/dev/null | jq -r --arg p "$LIMA_PREFIX" --arg b "$LIMA_BASE" '
		select(.name | startswith($p)) | select(.name != $b) | select(.name | ltrimstr($p) | test("^[a-z][a-z0-9-]*$")) |
		[(.name | ltrimstr($p)), (.status | ascii_downcase | if . == "running" then "running" elif . == "stopped" then "shut off" else . end),
		 (if .status == "Running" and (.sshLocalPort // 0) > 0 then .sshLocalPort else 0 end), (.disk // 0), .dir] | @tsv' |
		while IFS=$'\t' read -r n st port disk dir; do
			[[ $port != 0 ]] || port=""
			[[ $disk != 0 ]] || disk=""
			printf '%s\t%s\t%s\t%s\t%s\n' "$n" "$st" "${port:+127.0.0.1:$port}" "$disk" "$(lima_disk_used "$dir")"
		done
}

backend_ssh_endpoint() {
	local j; j=$(lima_json "$(linst "$1")")
	[[ -n $j ]] || die "no such vm: $1"
	[[ $(jq -r .status <<<"$j") == Running ]] || die "$1 is not running"
	echo "127.0.0.1 $(jq -r .sshLocalPort <<<"$j")"
}
backend_wait_endpoint() {
	local j
	for _ in $(seq 120); do
		j=$(lima_json "$(linst "$1")")
		if [[ $(jq -r .status <<<"$j") == Running && $(jq -r .sshLocalPort <<<"$j") != 0 ]]; then echo "127.0.0.1 $(jq -r .sshLocalPort <<<"$j")"; return; fi
		sleep 1
	done
	die "timed out waiting for $1"
}

backend_start() { lima_start "$(linst "$1")" 10m >/dev/null 2>&1 || die "limactl start failed"; }
backend_stop() { limactl stop "$(linst "$1")" >/dev/null 2>&1 || die "limactl stop failed"; }
backend_size() { lima_json "$(linst "$1")" | jq -r '"\(.cpus) \(.memory / 1048576 | floor) \(.disk / 1073741824 | floor)"'; }
# limactl edit only changes a stopped instance, so a running VM is stopped and started again.
backend_resize() { # NAME CPUS MEM_MIB DISK_GIB (empty = unchanged)
	local i was args=() out rc=0; i=$(linst "$1"); was=$(lima_status "$i")
	[[ -z $2 ]] || args+=(--cpus "$2")
	[[ -z $3 ]] || args+=(--memory "$(awk -v m="$3" 'BEGIN { printf "%g", m / 1024 }')")
	[[ -z $4 ]] || args+=(--disk "$4")
	[[ $was == Stopped ]] || log "stopping $1 to resize it"
	lima_stop "$i"
	out=$(limactl edit --tty=false "$i" "${args[@]}" 2>&1) || rc=$?
	if [[ $was == Running ]]; then lima_start "$i" 10m >/dev/null 2>&1 || die "resized $1, but could not start it again"; fi
	((rc == 0)) || die "limactl edit failed: $(printf '%s' "$out" | tail -1)"
}
backend_rm() { backend_exists "$1" || die "no such vm: $1"; limactl delete --force "$(linst "$1")" >/dev/null 2>&1; }

backend_cleanup_new() {
	local i; i=$(linst "$1")
	if lima_exists_inst "$i"; then limactl delete --force "$i" >/dev/null 2>&1 || die "could not clean $1"; fi
	if lima_exists_inst "$i.new"; then limactl delete --force "$i.new" >/dev/null 2>&1 || die "could not clean $1.new"; fi
}
backend_cleanup_image() {
	local im; im=$(img_inst "$1")
	# A clone killed before boxery-image was written is not in backend_images, but is still ours.
	if lima_exists_inst "$im"; then limactl delete --force "$im" >/dev/null 2>&1 || die "could not clean image $1"; fi
}
backend_recover_capture() {
	backend_cleanup_image "$2"
	if [[ $3 == running ]] && backend_exists "$1"; then backend_start "$1"; fi
}

# ---------------------------------------------------------------- images
backend_capture() { # NAME IMAGE
	local i im was; i=$(linst "$1"); im=$(img_inst "$2")
	lima_exists_inst "$i" || die "no such vm: $1"
	lima_exists_inst "$im" && die "image $2 exists"
	was=$(lima_status "$i")
	[[ $was == Stopped ]] || log "stopping $1 to capture it (Lima clones stopped instances only)"
	lima_stop "$i"
	local rc=0; limactl clone --tty=false "$i" "$im" >/dev/null 2>&1 || rc=$?
	if ((rc == 0)); then printf '%s\n%s\n' "$2" "$(date +%Y-%m-%dT%H:%M:%S)" >"$(lima_dir "$im")/boxery-image"; fi
	if [[ $was == Running ]]; then lima_start "$i" 10m >/dev/null 2>&1 || log "warning: could not restart $1"; fi
	((rc == 0)) || { limactl delete --force "$im" >/dev/null 2>&1 || true; die "limactl clone failed"; }
}

backend_images() { # → IMAGE<TAB>CREATED<TAB>SIZE
	limactl list --format json 2>/dev/null | jq -r --arg p "${LIMA_PREFIX}img." 'select(.name | startswith($p)) | "\(.dir)\t\(.disk / 1073741824 | floor)GiB"' |
		while IFS=$'\t' read -r dir size; do
			[[ -f $dir/boxery-image ]] || continue
			printf '%s\t%s\t%s\n' "$(sed -n 1p "$dir/boxery-image")" "$(sed -n 2p "$dir/boxery-image")" "$size"
		done
}
backend_image_rm() { local im; im=$(img_inst "$1"); lima_exists_inst "$im" || die "no such image: $1"; limactl delete --force "$im" >/dev/null 2>&1; }

backend_reimage() { # NAME IMAGE: replace the instance with a clone of the image (same name and size); ends running
	local i im tmp j; i=$(linst "$1"); im=$(img_inst "$2"); tmp="$i.new"
	lima_exists_inst "$im" || die "no such image: $2"
	j=$(lima_json "$i")
	if [[ -z $j ]] && lima_exists_inst "$tmp"; then
		# Recovery after the old instance was deleted but before its replacement was renamed.
		limactl rename --tty=false "$tmp" "$i" >/dev/null 2>&1 || die "could not recover $1.new"
		lima_start "$i" 10m >/dev/null 2>&1 || die "could not start recovered $1"
		return
	fi
	[[ -n $j ]] || die "no such vm: $1"
	limactl delete --force "$tmp" >/dev/null 2>&1 || true
	# Clone first, swap after: a failed clone leaves the VM as it was.
	limactl clone --tty=false "$im" "$tmp" --cpus "$(jq -r .cpus <<<"$j")" --memory "$(jq -r '.memory / 1073741824 | floor' <<<"$j")" \
		--disk "$(jq -r '.disk / 1073741824 | floor' <<<"$j")" >/dev/null 2>&1 || die "limactl clone failed"
	rm -f "$(lima_dir "$tmp")/boxery-image"
	limactl delete --force "$i" >/dev/null 2>&1 || die "could not remove the old $1"
	limactl rename --tty=false "$tmp" "$i" >/dev/null 2>&1 || die "limactl rename failed (the new disk is instance $tmp)"
	lima_start "$i" 10m >/dev/null 2>&1 || die "limactl start failed"
}
