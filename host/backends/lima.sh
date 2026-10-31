# shellcheck shell=bash disable=SC2154  # sourced by host/agentvm-host (provides die/log/need/SSH_OPTS/…)
# agentvm backend: Lima (macOS or Linux). Sourced by host/agentvm-host.
# Contract: see host/backends/README.md.
#
# - VMs are Lima instances named avm-NAME (plain mode: no mounts, no port forwards, no guest agent),
#   cloned from a built template instance (avm-base) so each new VM boots a ready desktop image.
# - Guests reach the host's LLM proxy at Lima's user-network gateway (192.168.5.2), which maps to the
#   host's loopback, so the proxy stays bound to 127.0.0.1.
# - ssh endpoint is 127.0.0.1:<lima ssh port>; `agentvm-host connect` pipes to it.
# - vmType: qemu on Linux; vz on macOS by default (set AGENTVM_LIMA_VMTYPE=qemu for snapshot support).

LIMA_PREFIX=avm-
LIMA_BASE=${LIMA_PREFIX}base
LIMA_GATEWAY=${AGENTVM_LIMA_GATEWAY:-192.168.5.2}
LIMA_VMTYPE=${AGENTVM_LIMA_VMTYPE:-$([[ $(uname) == Darwin ]] && echo vz || echo qemu)}
LIMA_ARCH=${AGENTVM_LIMA_ARCH:-default}
linst() { echo "$LIMA_PREFIX$1"; }
lima_json() { limactl list --format json 2>/dev/null | jq -c "select(.name == \"$1\")"; }
lima_exists_inst() { [[ -n $(lima_json "$1") ]]; }

backend_check() {
	need limactl; need jq; need ssh
	if [[ $(uname) != Darwin && $LIMA_VMTYPE == qemu ]]; then [[ -r /dev/kvm ]] || log "warning: /dev/kvm not accessible; Lima will use slow TCG emulation"; fi
}

backend_init() { :; }
backend_proxy_services() { :; }   # no guest bridge service needed on the host
guest_proxy_upstream() { echo "TCP:$LIMA_GATEWAY:$PROXY_PORT"; }

# Lima template for both the builder and each VM. The desktop install (image/base-user-data.yaml) runs
# once in the builder; clones inherit its disk. Per-VM cloud-config (keys, token, configs) is applied
# by agentvm-host over ssh after the clone boots (Lima owns the cloud-init seed).
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
	# Reuse the libvirt build script: extract agentvm-build.sh + write_files from the cloud-config and run them.
	lima_apply_cloudconfig "$ROOT/image/base-user-data.yaml" build || die "base build failed (see output above)"
	limactl stop "$LIMA_BASE" >/dev/null
	rm -rf "$tmp"
	log "base image ready: Lima instance $LIMA_BASE"
}

# Apply a cloud-config's write_files (+ for "build": run /usr/local/sbin/agentvm-build.sh; for "vm": runcmd)
# over ssh. Lima owns the instance's own cloud-init seed, so we replay ours as root.
lima_apply_cloudconfig() { # FILE build|vm [NAME]
	local f=$1 mode=$2
	node -e '
		const fs = require("fs");
		const yaml = fs.readFileSync(process.argv[1], "utf8");
		// minimal cloud-config reader: write_files (path/owner/permissions/encoding/content) and runcmd lines
		const files = []; let cur = null, inContent = false, indent = 0;
		const lines = yaml.split("\n");
		let section = "";
		for (const line of lines) {
			if (/^[a-z_]+:/.test(line)) { section = line.split(":")[0]; if (cur) { files.push(cur); cur = null; } inContent = false; continue; }
			if (section !== "write_files") continue;
			const m = line.match(/^  - path: (.*)$/);
			if (m) { if (cur) files.push(cur); cur = { path: m[1].trim(), content: "" }; inContent = false; continue; }
			if (!cur) continue;
			if (inContent) {
				if (line.trim() === "" ) { cur.content += "\n"; continue; }
				const ind = line.match(/^ */)[0].length;
				if (ind >= indent) { cur.content += line.slice(indent) + "\n"; continue; }
				inContent = false;
			}
			const kv = line.match(/^    ([a-z]+): ?(.*)$/);
			if (kv) {
				if (kv[1] === "content" && kv[2].trim() === "|") { inContent = true; indent = 6; continue; }
				cur[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1");
			}
		}
		if (cur) files.push(cur);
		let sh = "set -e\n";
		for (const f of files) {
			const data = f.encoding === "b64" ? f.content.trim() : Buffer.from(f.content).toString("base64");
			sh += `mkdir -p "$(dirname ${JSON.stringify(f.path)})"; echo ${data.replace(/\s/g, "")} | base64 -d > ${JSON.stringify(f.path)}\n`;
			if (f.permissions) sh += `chmod ${f.permissions} ${JSON.stringify(f.path)}\n`;
			if (f.owner) sh += `chown ${f.owner} ${JSON.stringify(f.path)} 2>/dev/null || true\n`;
		}
		process.stdout.write(sh);
	' "$f" >"$f.files.sh"
	if [[ $mode == build ]]; then
		# The build script disables cloud-init re-runs, linger etc. exactly as in the libvirt builder.
		ssh -F "$HOME/.lima/$LIMA_BASE/ssh.config" "lima-$LIMA_BASE" 'sudo bash -s' <"$f.files.sh" || return 1
		ssh -F "$HOME/.lima/$LIMA_BASE/ssh.config" "lima-$LIMA_BASE" 'sudo bash -c "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && /usr/local/sbin/agentvm-build.sh"' || return 1
		ssh -F "$HOME/.lima/$LIMA_BASE/ssh.config" "lima-$LIMA_BASE" 'test -f /var/log/agentvm-build.ok' || return 1
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

backend_new() { # NAME CPUS MEM_MIB DISK_GIB USERDATA_FILE
	local name=$1 cpus=$2 mem=$3 disk=$4 userdata=$5 i; i=$(linst "$1")
	log "creating $name (Lima $LIMA_VMTYPE, ${cpus} vCPU, ${mem} MiB, ${disk} GiB, cloned from $LIMA_BASE)"
	[[ $(lima_json "$LIMA_BASE" | jq -r .status) == Stopped ]] || limactl stop "$LIMA_BASE" >/dev/null 2>&1 || true
	limactl clone --tty=false "$LIMA_BASE" "$i" --cpus "$cpus" --memory "$(( mem / 1024 ))" --disk "$disk" >/dev/null 2>&1 ||
		die "limactl clone failed"
	limactl start "$i" --timeout 10m >/dev/null 2>&1 || die "limactl start $i failed"
	# Per-VM identity: replay the generated cloud-config (files + runcmd) as root over Lima's ssh.
	lima_apply_cloudconfig "$userdata" vm "$name" || die "applying per-VM config failed"
	local sshcfg="$HOME/.lima/$i/ssh.config"
	# authorized keys (host mgmt key + registered controller keys), hostname, then the runcmd steps.
	awk '/^ssh_authorized_keys:/{f=1;next} f&&/^  - /{sub(/^  - /,""); gsub(/^"|"$/,""); print; next} f{f=0}' "$userdata" |
		ssh -F "$sshcfg" "lima-$i" 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys; sort -u -o ~/.ssh/authorized_keys ~/.ssh/authorized_keys'
	# Same as the libvirt cloud-config's runcmd: everything under the agent's home belongs to the agent
	# (write_files creates parent dirs such as ~/.pi/agent as root).
	ssh -F "$sshcfg" "lima-$i" "sudo chown -R agent:agent /home/agent; sudo hostnamectl set-hostname $(printf %q "$name"); sudo systemctl restart agentvm-llm.service;
		cd ~ && git config --global user.name agent && git config --global user.email agent@agentvm && git config --global init.defaultBranch main;
		mkdir -p ~/project && cd ~/project && { [ -d .git ] || git init -q; }; systemctl --user daemon-reload; systemctl --user start agentvm-vnc agentvm-desktop agentvm-novnc 2>/dev/null || true"
}

backend_list() {
	limactl list --format json 2>/dev/null | jq -r --arg p "$LIMA_PREFIX" --arg b "$LIMA_BASE" '
		select(.name | startswith($p)) | select(.name != $b) |
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

backend_snap() {
	[[ $LIMA_VMTYPE == qemu ]] || die "snapshots need Lima's qemu vmType (this backend uses $LIMA_VMTYPE); set AGENTVM_LIMA_VMTYPE=qemu"
	limactl snapshot create "$(linst "$1")" --tag "$2" >/dev/null 2>&1 || die "snapshot failed"
}
backend_snaps() { limactl snapshot list "$(linst "$1")"; }
backend_revert() {
	[[ $LIMA_VMTYPE == qemu ]] || die "snapshots need Lima's qemu vmType"
	limactl snapshot apply "$(linst "$1")" --tag "$2" >/dev/null 2>&1 || die "revert failed"
}
