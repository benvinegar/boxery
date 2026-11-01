# shellcheck shell=bash disable=SC2154  # sourced by host/boxery-host (provides die/log/need/SSH_OPTS/…)
# boxery backend: Lima (macOS or Linux). Sourced by host/boxery-host.
# Contract: see host/backends/README.md.
#
# - VMs are Lima instances named boxery-NAME (plain mode: no mounts, no port forwards, no guest agent),
#   cloned from a built template instance (boxery-base) so each new VM boots a ready desktop image.
# - Guests reach the host's LLM proxy at Lima's user-network gateway (192.168.5.2), which maps to the
#   host's loopback, so the proxy stays bound to 127.0.0.1.
# - ssh endpoint is 127.0.0.1:<lima ssh port>; `boxery-host connect` pipes to it.
# - vmType: qemu on Linux; vz on macOS by default.
# - Images (snapshots, fork sources, pool clean state) are stopped Lima instances named
#   boxery-img.<hash> (the '.' can't occur in VM names), cloned with `limactl clone` (copy-on-write on
#   APFS/btrfs). The image's name is kept in a boxery-image file in the instance dir. Lima only clones
#   stopped instances, so capturing a running VM stops it briefly; works on vz and qemu alike.

LIMA_PREFIX=${BOXERY_LIMA_PREFIX:-boxery-}
LIMA_BASE=${LIMA_PREFIX}base
LIMA_GATEWAY=${BOXERY_LIMA_GATEWAY:-192.168.5.2}
LIMA_VMTYPE=${BOXERY_LIMA_VMTYPE:-$([[ $(uname) == Darwin ]] && echo vz || echo qemu)}
LIMA_ARCH=${BOXERY_LIMA_ARCH:-default}
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
	if [[ $(uname) != Darwin && $LIMA_VMTYPE == qemu ]]; then [[ -r /dev/kvm ]] || log "warning: /dev/kvm not accessible; Lima will use slow TCG emulation"; fi
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
	limactl start "$LIMA_BASE" --timeout 20m >/dev/null 2>"$tmp/start.log" || { tail -20 "$tmp/start.log" >&2; die "limactl start failed"; }
	log "installing the desktop image (XFCE, VNC, Chromium/Chrome, node, pi, opencode; ~5-10 min)"
	# Reuse the libvirt build script: extract boxery-build.sh + write_files from the cloud-config and run them.
	lima_apply_cloudconfig "$ROOT/image/base-user-data.yaml" build || die "base build failed (see output above)"
	limactl stop "$LIMA_BASE" >/dev/null
	rm -rf "$tmp"
	log "base image ready: Lima instance $LIMA_BASE"
}

# Apply a cloud-config's write_files (+ for "build": run /usr/local/sbin/boxery-build.sh; for "vm": runcmd)
# over ssh. Lima owns the instance's own cloud-init seed, so we replay ours as root.
lima_apply_cloudconfig() { # FILE build|vm [NAME]
	local f=$1 mode=$2
	node "$ROOT/host/cloudconfig-sh.mjs" "$f" >"$f.files.sh" || return 1
	if [[ $mode == build ]]; then
		# The build script disables cloud-init re-runs, linger etc. exactly as in the libvirt builder.
		ssh -F "$HOME/.lima/$LIMA_BASE/ssh.config" "lima-$LIMA_BASE" 'sudo bash -s' <"$f.files.sh" || return 1
		ssh -F "$HOME/.lima/$LIMA_BASE/ssh.config" "lima-$LIMA_BASE" 'sudo bash -c "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && /usr/local/sbin/boxery-build.sh"' || return 1
		ssh -F "$HOME/.lima/$LIMA_BASE/ssh.config" "lima-$LIMA_BASE" 'test -f /var/log/boxery-build.ok' || return 1
		# The libvirt builder empties the agent user's authorized_keys via cloud-init clean; Lima re-injects
		# its own key at boot, so nothing else to do. Make the agent user's runtime services start on boot:
		ssh -F "$HOME/.lima/$LIMA_BASE/ssh.config" "lima-$LIMA_BASE" 'sudo loginctl enable-linger agent' || true
	else
		ssh -F "$HOME/.lima/$(linst "$3")/ssh.config" "lima-$(linst "$3")" 'sudo bash -s' <"$f.files.sh" || return 1
	fi
	rm -f "$f.files.sh"
}

backend_has_base() { lima_exists_inst "$LIMA_BASE"; }
backend_exists() { lima_exists_inst "$(linst "$1")"; }

backend_new() { # NAME CPUS MEM_MIB DISK_GIB USERDATA_FILE [IMAGE]
	local name=$1 cpus=$2 mem=$3 disk=$4 userdata=$5 from=${6:-} i src; i=$(linst "$1")
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
	limactl start "$i" --timeout 10m >/dev/null 2>&1 || die "limactl start $i failed"
	# Per-VM identity: replay the generated cloud-config (files + runcmd) as root over Lima's ssh.
	lima_apply_cloudconfig "$userdata" vm "$name" || die "applying per-VM config failed"
	local sshcfg="$HOME/.lima/$i/ssh.config"
	# authorized keys (host mgmt key + registered controller keys), hostname, then the runcmd steps.
	awk '/^ssh_authorized_keys:/{f=1;next} f&&/^  - /{sub(/^  - /,""); gsub(/^"|"$/,""); print; next} f{f=0}' "$userdata" |
		ssh -F "$sshcfg" "lima-$i" 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys; sort -u -o ~/.ssh/authorized_keys ~/.ssh/authorized_keys'
	# Same as the libvirt cloud-config's runcmd: everything under the agent's home belongs to the agent
	# (write_files creates parent dirs such as ~/.pi/agent as root).
	ssh -F "$sshcfg" "lima-$i" "sudo chown -R agent:agent /home/agent; sudo hostnamectl set-hostname $(printf %q "$name"); { [ -e /etc/agentvm ] || sudo ln -s /etc/boxery /etc/agentvm; sudo systemctl restart boxery-llm.service 2>/dev/null || sudo systemctl restart agentvm-llm.service; };
		cd ~ && git config --global user.name agent && git config --global user.email agent@boxery && git config --global init.defaultBranch main;
		mkdir -p ~/project && cd ~/project && { [ -d .git ] || git init -q; }; systemctl --user daemon-reload; systemctl --user start boxery-vnc boxery-desktop boxery-novnc 2>/dev/null || systemctl --user start agentvm-vnc agentvm-desktop agentvm-novnc 2>/dev/null || true"
	# From an image: the disk is another VM's. Give it its own machine-id (journald, DHCP client id).
	if [[ -n $from ]]; then ssh -F "$sshcfg" "lima-$i" 'sudo rm -f /etc/machine-id /var/lib/dbus/machine-id && sudo systemd-machine-id-setup >/dev/null' || true; fi
}

backend_list() {
	limactl list --format json 2>/dev/null | jq -r --arg p "$LIMA_PREFIX" --arg b "$LIMA_BASE" '
		select(.name | startswith($p)) | select(.name != $b) | select(.name | ltrimstr($p) | test("^[a-z][a-z0-9-]*$")) |
		[(.name | ltrimstr($p)), (.status | ascii_downcase | if . == "running" then "running" elif . == "stopped" then "shut off" else . end),
		 (if .sshLocalPort and .sshLocalPort > 0 then "127.0.0.1:\(.sshLocalPort)" else "" end), (.disk / 1073741824 | floor | tostring) + "GiB"] | @tsv'
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

backend_start() { limactl start "$(linst "$1")" --timeout 10m >/dev/null 2>&1 || die "limactl start failed"; }
backend_stop() { limactl stop "$(linst "$1")" >/dev/null 2>&1 || die "limactl stop failed"; }
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
	if [[ $was == Running ]]; then limactl start "$i" --timeout 10m >/dev/null 2>&1 || log "warning: could not restart $1"; fi
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
		limactl start "$i" --timeout 10m >/dev/null 2>&1 || die "could not start recovered $1"
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
	limactl start "$i" --timeout 10m >/dev/null 2>&1 || die "limactl start failed"
}

# VMs from before images may have Lima snapshots (qemu vmType). Still listed, revertable and deletable.
backend_legacy_snaps() { [[ $LIMA_VMTYPE == qemu ]] || return 0; limactl snapshot list "$(linst "$1")" 2>/dev/null | awk 'NR > 1 {print $2}' || true; }
backend_legacy_revert() { backend_legacy_snaps "$1" | grep -xF "$2" >/dev/null || return 1; limactl snapshot apply "$(linst "$1")" --tag "$2" >/dev/null 2>&1 || die "revert failed"; }
backend_legacy_snap_rm() { backend_legacy_snaps "$1" | grep -xF "$2" >/dev/null || return 1; limactl snapshot delete "$(linst "$1")" --tag "$2" >/dev/null 2>&1; }
