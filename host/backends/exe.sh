# shellcheck shell=bash disable=SC2154  # sourced by host/boxery-host (provides die/log/need/ROOT/PROXY_PORT/…)
# boxery backend: exe.dev (https://exe.dev). Sourced by host/boxery-host. EXPERIMENTAL.
# Contract: see host/backends/README.md.
#
# - VMs run on exe.dev, managed through its ssh API (`ssh exe.dev CMD --json`). The host only needs ssh
#   and an exe.dev account whose key ssh offers first (or BOXERY_EXE_KEY). No KVM, so it runs on macOS too.
# - exe.dev VM names: PREFIX + v-NAME (VMs), i-HASH (images), s-NAME (reimage staging), base, build.
#   PREFIX (default "bx<6 hex>-", generated once into $EXE_DIR/prefix) keeps names unique on exe.dev and
#   keeps us away from the account's other VMs.
# - ssh: exe.dev's edge authenticates `ssh NAME.exe.xyz` with the account's keys and never consults the
#   guest's sshd (exeuntu masks ssh.service). boxery's lease fencing needs the guest's own authorized_keys,
#   so the base build enables sshd on the guest's loopback only, and each VM gets a host-side tunnel:
#   one supervised `ssh -N NAME.exe.xyz -L 127.0.0.1:PORT:127.0.0.1:22 -R 127.0.0.1:GPORT:127.0.0.1:PROXY_PORT`
#   (systemd user unit on Linux, launchd agent on macOS). The VM's endpoint is 127.0.0.1:PORT, as on Lima.
#   The edge path (account key → exedev with sudo) is the backend's admin channel: build, identity, sync.
# - LLM proxy: the tunnel's -R end listens on the guest's 127.0.0.1:GPORT; boxery-llm (socat) forwards
#   the guest's 127.0.0.1:8088 there. Credentials stay on the host.
# - No cloud-init seed (exeuntu has no cloud-init). Like Lima, the backend applies the cloud-config itself
#   over the edge: write_files, authorized_keys (replaced, never merged), hostname, fresh machine-id and
#   ssh host keys, then the runcmd steps.
# - Images (snapshots, forks, pool resets; disk only, see README): an image is a paused exe.dev VM made
#   with `cp`, its boxery name kept in the exe.dev comment ("boxery-image:IMAGE:DISK_GB"). A copy boots
#   fresh from disk, even from a paused source, so RAM (and tmpfs grants) never travel. new --from =
#   `cp IMAGE-VM NAME`; reimage = `cp` to a staging name, `rm` the VM, `rename` the copy.
# - stop = clear pushed grants + `pause` (exe.dev has no stop); start = `resume`.

EXE_DIR=${BOXERY_EXE_DIR:-$HOME/.local/share/boxery/exe}
EXE_PREFIX=${BOXERY_EXE_PREFIX:-$(cat "$EXE_DIR/prefix" 2>/dev/null || true)}
EXE_KEY=${BOXERY_EXE_KEY:-}                      # identity file for exe.dev; default: whatever ssh offers
EXE_PORT_BASE=${BOXERY_EXE_PORT_BASE:-22400}     # VM slot S ↔ host port BASE+S (the tunnel's -L end)
EXE_GUEST_PORT=${BOXERY_EXE_GUEST_PORT:-18088}   # the tunnel's -R end in the guest (LLM proxy)
EXE_EGRESS=${BOXERY_EXE_EGRESS:-}                # "integrations" to cut VMs off the internet (see README)
EXE_POOL=${BOXERY_EXE_POOL:-}                    # exe.dev pool for new VMs (Work plans)
EXE_MAX_CPUS=${BOXERY_EXE_MAX_CPUS:-2}           # Personal plan: 2 vCPU / 4 GB shared by all VMs
EXE_MAX_MEM=${BOXERY_EXE_MAX_MEM:-4096}          # MiB
EXE_BASE_DISK=20                                 # GB, the base VM's disk (copies grow from it)
EXE_SUPERVISOR=${BOXERY_EXE_SUPERVISOR:-$([[ $(uname) == Darwin ]] && echo launchd || echo systemd)}
EXE_POLL=${BOXERY_EXE_POLL:-15}                  # seconds between build-base progress checks
EXE_MAX_SLOT=500
EXE_SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4
	-o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$EXE_DIR/known_hosts" -o ControlMaster=no -o ControlPath=none)
[[ -z $EXE_KEY ]] || EXE_SSH+=(-o IdentitiesOnly=yes -i "$EXE_KEY")
# Pin effective settings in operation journals, so crash recovery acts on the same account and names.
export BOXERY_EXE_DIR=$EXE_DIR BOXERY_EXE_KEY=$EXE_KEY BOXERY_EXE_PORT_BASE=$EXE_PORT_BASE BOXERY_EXE_GUEST_PORT=$EXE_GUEST_PORT
[[ -z $EXE_PREFIX ]] || export BOXERY_EXE_PREFIX=$EXE_PREFIX

# ---------------------------------------------------------------- names and the exe.dev API
exe_prefix_ensure() { # generate PREFIX once (init/build-base); concurrent callers agree via link(2)
	[[ -z $EXE_PREFIX ]] || return 0
	mkdir -p "$EXE_DIR"
	local tmp; tmp=$(mktemp "$EXE_DIR/.prefix.XXXXXX")
	echo "bx$(openssl rand -hex 3)-" >"$tmp"
	ln "$tmp" "$EXE_DIR/prefix" 2>/dev/null || true
	rm -f "$tmp"
	EXE_PREFIX=$(cat "$EXE_DIR/prefix") || die "cannot read $EXE_DIR/prefix"
	export BOXERY_EXE_PREFIX=$EXE_PREFIX
}
exe_vm() { echo "${EXE_PREFIX}v-$1"; }
exe_stage() { echo "${EXE_PREFIX}s-$1"; }
exe_base() { echo "${EXE_PREFIX}base"; }
# Image names contain '@' and '.', which exe.dev names can't: use a hash; the name lives in the comment.
exe_img() { local h; h=$(printf '%s' "$1" | { shasum 2>/dev/null || sha1sum; } | cut -c1-16); echo "${EXE_PREFIX}i-$h"; }
exe_dir() { echo "$EXE_DIR/vms/$1"; }
exe_unit() { echo "boxery-exe-$(exe_vm "$1")"; }   # systemd unit / launchd label (without suffix)
exe_port() { echo $((EXE_PORT_BASE + $(cat "$(exe_dir "$1")/slot"))); }

exe_cmd() { "${EXE_SSH[@]}" exe.dev "$@" </dev/null; }   # </dev/null: never eat the caller's stdin
# exe.dev command with JSON output; prints the JSON. Fails (with exe.dev's message) on a non-zero exit
# or an {"error": …} reply. --json goes first so free-text arguments (comment) can't swallow it.
exe_do() {
	local out rc=0 msg
	out=$(exe_cmd "$1" --json "${@:2}" 2>&1) || rc=$?
	if ((rc == 0)) && jq -e 'type == "object" and has("error")' <<<"$out" >/dev/null 2>&1; then rc=1; fi
	if ((rc != 0)); then
		msg=$(jq -r '.error // empty' <<<"$out" 2>/dev/null) || msg=""
		echo "boxery-host: exe.dev $1: ${msg:-${out:0:300}}" >&2
		return 1
	fi
	printf '%s\n' "$out"
}
# The account's VMs as {"vms": [...]}. An unreachable exe.dev is an error, never an empty account.
exe_ls() {
	local j
	j=$(exe_do ls) || return 1
	jq -e '.vms | type == "array"' <<<"$j" >/dev/null 2>&1 || { echo "boxery-host: unexpected 'ls --json' reply from exe.dev: ${j:0:200}" >&2; return 1; }
	printf '%s\n' "$j"
}
exe_status() { jq -r --arg n "$1" '.vms[] | select(.vm_name == $n) | .status' <<<"$2"; }   # VM LS_JSON
exe_has() { jq -e --arg n "$1" 'any(.vms[]; .vm_name == $n)' <<<"$2" >/dev/null; }      # VM LS_JSON
# ssh destination of an exe.dev VM, as ssh arguments: "-l USER HOST" when the routing needs a username
# (ssh_user, e.g. vm+NAME@vm.exe.xyz), else "HOST".
exe_dest() { # VM [LS_JSON]
	local j=${2:-} d
	[[ -n $j ]] || j=$(exe_ls) || return 1
	d=$(jq -r --arg n "$1" '.vms[] | select(.vm_name == $n) | if (.ssh_user // "") != "" then "-l \(.ssh_user) \(.ssh_host)" else (.ssh_host // .ssh_dest // "") end' <<<"$j")
	echo "${d:-$1.exe.xyz}"
}
# Run a command in a VM through exe.dev's edge, as the image's login user (exedev, passwordless sudo).
exe_edge() { # VM COMMAND (stdin: passed through)
	local dest; dest=$(exe_dest "$1") || return 1; shift
	# shellcheck disable=SC2086  # dest is "-l USER HOST" or "HOST"
	"${EXE_SSH[@]}" $dest "$@"
}
exe_sizes() { # CPUS MEM_MIB → "--cpu=N --memory=NGB", capped to the plan (BOXERY_EXE_MAX_CPUS/MEM)
	local c=$1 m=$2
	if ((c > EXE_MAX_CPUS)); then log "capping to $EXE_MAX_CPUS vCPU (BOXERY_EXE_MAX_CPUS)"; c=$EXE_MAX_CPUS; fi
	if ((m > EXE_MAX_MEM)); then log "capping to $EXE_MAX_MEM MiB (BOXERY_EXE_MAX_MEM)"; m=$EXE_MAX_MEM; fi
	echo "--cpu=$c --memory=$(((m + 1023) / 1024))GB"
}
exe_pool_flag() { [[ -z $EXE_POOL ]] || echo "--pool=$EXE_POOL"; }
# cp SRC DST [FLAGS…]: a copy boots fresh from SRC's disk. Fails without leaving DST behind.
exe_cp() {
	local src=$1 dst=$2; shift 2
	exe_do cp "$src" "$dst" --copy-tags=false "$@" >/dev/null && return 0
	exe_do rm "$dst" >/dev/null 2>&1 || true
	return 1
}
exe_pause() { exe_do pause "$1" >/dev/null || log "warning: could not pause $1 (it keeps using pool memory)"; }
exe_disk_of_image() { jq -r --arg n "$1" '.vms[] | select(.vm_name == $n) | .comment // "" | split(":")[2] // ""' <<<"$2"; }   # IMAGE_VM LS_JSON

# ---------------------------------------------------------------- per-VM tunnel (supervised ssh)
exe_tunnel_write() { # NAME LS_JSON: tunnel.sh + supervisor definition (not started)
	local d dest; d=$(exe_dir "$1"); dest=$(exe_dest "$(exe_vm "$1")" "$2")
	{
		echo '#!/usr/bin/env bash'
		echo '# boxery: ssh endpoint + LLM proxy tunnel for an exe.dev VM. Generated by host/backends/exe.sh.'
		printf 'exec'
		local a
		# shellcheck disable=SC2086  # dest is "-l USER HOST" or "HOST"
		for a in "${EXE_SSH[@]}" -N -o ExitOnForwardFailure=yes \
			-L "127.0.0.1:$(exe_port "$1"):127.0.0.1:22" -R "127.0.0.1:$EXE_GUEST_PORT:127.0.0.1:$PROXY_PORT" $dest; do
			printf ' %q' "$a"
		done
		echo
	} >"$d/tunnel.sh"
	chmod 755 "$d/tunnel.sh"
	if [[ $EXE_SUPERVISOR == launchd ]]; then
		cat >"$d/tunnel.plist" <<-EOF
			<?xml version="1.0" encoding="UTF-8"?>
			<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
			<plist version="1.0"><dict>
			  <key>Label</key><string>dev.$(exe_unit "$1")</string>
			  <key>ProgramArguments</key><array><string>$d/tunnel.sh</string></array>
			  <key>KeepAlive</key><true/><key>RunAtLoad</key><true/><key>ThrottleInterval</key><integer>5</integer>
			  <key>StandardErrorPath</key><string>$d/tunnel.log</string>
			</dict></plist>
		EOF
	else
		mkdir -p "$HOME/.config/systemd/user"
		cat >"$HOME/.config/systemd/user/$(exe_unit "$1").service" <<-EOF
			[Unit]
			Description=boxery VM $1 (exe.dev ssh tunnel)
			[Service]
			ExecStart=$d/tunnel.sh
			Restart=always
			RestartSec=5
			[Install]
			WantedBy=default.target
		EOF
		systemctl --user daemon-reload
	fi
}
exe_plist() { echo "$HOME/Library/LaunchAgents/dev.$(exe_unit "$1").plist"; }
# Started tunnels are enabled (systemd) or installed in LaunchAgents (launchd), so they come back after
# a host reboot; exe.dev VMs keep running while the host is down.
exe_tunnel_start() {
	if [[ $EXE_SUPERVISOR == launchd ]]; then
		mkdir -p "$HOME/Library/LaunchAgents"
		cp "$(exe_dir "$1")/tunnel.plist" "$(exe_plist "$1")"
		launchctl bootout "gui/$(id -u)/dev.$(exe_unit "$1")" >/dev/null 2>&1 || true
		launchctl bootstrap "gui/$(id -u)" "$(exe_plist "$1")" || die "starting the tunnel to $1 failed"
	else
		systemctl --user enable "$(exe_unit "$1").service" >/dev/null 2>&1 || die "enabling the tunnel to $1 failed"
		# restart, not start: reimage and start rewrite tunnel.sh for a running unit
		systemctl --user restart "$(exe_unit "$1").service" || die "starting the tunnel to $1 failed (journalctl --user -u $(exe_unit "$1"))"
	fi
}
exe_tunnel_stop() {
	if [[ $EXE_SUPERVISOR == launchd ]]; then
		launchctl bootout "gui/$(id -u)/dev.$(exe_unit "$1")" >/dev/null 2>&1 || true
		rm -f "$(exe_plist "$1")"
	else
		systemctl --user disable --now "$(exe_unit "$1").service" >/dev/null 2>&1 || true
	fi
}
exe_tunnel_active() {
	if [[ $EXE_SUPERVISOR == launchd ]]; then launchctl print "gui/$(id -u)/dev.$(exe_unit "$1")" >/dev/null 2>&1
	else systemctl --user is-active --quiet "$(exe_unit "$1").service"; fi
}
exe_tunnel_remove() {
	exe_tunnel_stop "$1"
	if [[ $EXE_SUPERVISOR != launchd ]]; then
		rm -f "$HOME/.config/systemd/user/$(exe_unit "$1").service"
		systemctl --user daemon-reload 2>/dev/null || true
	fi
}

# Lowest free slot (1..500). Serialized: concurrent `new`s race here.
exe_alloc_slot() { # NAME → slot (written to the VM dir)
	local lock=$EXE_DIR/.slot.lock i s used
	for i in $(seq 300); do mkdir "$lock" 2>/dev/null && break; sleep 0.1; [[ $i == 300 ]] && die "slot lock held ($lock)"; done
	used=" $(cat "$EXE_DIR"/vms/*/slot 2>/dev/null | tr '\n' ' ') "
	for ((s = 1; s <= EXE_MAX_SLOT; s++)); do [[ $used == *" $s "* ]] || break; done
	if ((s > EXE_MAX_SLOT)); then rmdir "$lock"; die "no free tunnel ports (max $EXE_MAX_SLOT VMs)"; fi
	echo "$s" >"$(exe_dir "$1")/slot"
	rmdir "$lock"
	echo "$s"
}

# ---------------------------------------------------------------- setup
backend_check() {
	need ssh; need jq; need nc; need node; need openssl
	mkdir -p "$EXE_DIR"   # known_hosts lives here
	if [[ $EXE_SUPERVISOR == launchd ]]; then need launchctl; else need systemctl; fi
	[[ -z $EXE_PREFIX || $EXE_PREFIX =~ ^[a-z][a-z0-9-]{0,19}$ ]] || die "BOXERY_EXE_PREFIX must match [a-z][a-z0-9-]{0,19}"
	local out
	out=$(exe_cmd whoami --json 2>&1) || die "exe.dev doesn't know this host's ssh key: ${out:0:200}
  Run 'ssh exe.dev' once in a terminal (re-registering with your account's email adds the key), or set BOXERY_EXE_KEY."
	jq -e '.email' <<<"$out" >/dev/null 2>&1 || die "unexpected 'whoami' reply from exe.dev: ${out:0:200}"
}
backend_init() { mkdir -p "$EXE_DIR/vms"; exe_prefix_ensure; }
backend_proxy_services() { :; }   # per-VM tunnels carry the proxy; nothing host-wide
guest_proxy_upstream() { echo "TCP:127.0.0.1:$EXE_GUEST_PORT"; }

# exe.dev specifics on top of the shared build (image/base-user-data.yaml), run as root after it.
exe_build_post() {
	cat <<-'EOF'
		set -e
		# exe.dev's edge doesn't use the guest's sshd, and exeuntu masks it. boxery's endpoint and lease
		# fencing need it: loopback only, keys only, only the agent user. The host reaches it through its
		# tunnel (ssh -L … 127.0.0.1:22).
		cat >/etc/ssh/sshd_config.d/50-boxery-exe.conf <<-'CONF'
			ListenAddress 127.0.0.1
			PasswordAuthentication no
			KbdInteractiveAuthentication no
			PermitRootLogin no
			AllowUsers agent
		CONF
		systemctl unmask ssh.service ssh.socket
		systemctl disable ssh.socket 2>/dev/null || true
		ssh-keygen -A
		systemctl enable ssh.service
		# exeuntu disables systemd-logind, which would start lingering users' managers at boot. Start
		# agent's (desktop, VNC, noVNC) explicitly.
		cat >/etc/systemd/system/boxery-agent-session.service <<-UNIT
			[Unit]
			Description=boxery: start the agent user's systemd manager (desktop services)
			After=systemd-user-sessions.service
			[Service]
			Type=oneshot
			RemainAfterExit=yes
			ExecStart=/bin/systemctl start user@$(id -u agent).service
			[Install]
			WantedBy=multi-user.target
		UNIT
		systemctl enable boxery-agent-session.service
		touch /var/log/boxery-exe.ok
	EOF
}

backend_build_base() {
	exe_prefix_ensure
	local base stg j; base=$(exe_base); stg=${EXE_PREFIX}build
	j=$(exe_ls) || exit 1
	if exe_has "$stg" "$j"; then exe_do rm "$stg" >/dev/null || die "could not remove a previous build VM $stg"; fi
	log "creating exe.dev builder VM $stg (exeuntu)"
	# shellcheck disable=SC2046  # exe_pool_flag: zero or one word
	exe_do new --name="$stg" --no-email --cpu="$EXE_MAX_CPUS" --memory="$(((EXE_MAX_MEM + 1023) / 1024))GB" --disk="${EXE_BASE_DISK}GB" $(exe_pool_flag) >/dev/null ||
		die "exe.dev new failed"
	local i
	for i in $(seq 60); do exe_edge "$stg" true </dev/null >/dev/null 2>&1 && break; ((i < 60)) || die "no ssh to $stg"; sleep 2; done
	log "installing the desktop image (XFCE, VNC, Chrome/Chromium, node, pi, opencode; ~5-10 min)"
	local tmp; tmp=$(mktemp -d)
	{
		echo 'set -e'
		echo 'id agent >/dev/null 2>&1 || useradd -m -s /bin/bash -c "boxery agent" -G sudo,adm agent'
		echo 'echo "agent ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/90-boxery-agent; chmod 440 /etc/sudoers.d/90-boxery-agent'
		node "$ROOT/host/cloudconfig-sh.mjs" "$ROOT/image/base-user-data.yaml" || exit 1
		echo 'cat >/usr/local/sbin/boxery-exe-post.sh <<'"'"'BOXERY_POST'"'"
		exe_build_post
		echo 'BOXERY_POST'
		echo 'chmod 755 /usr/local/sbin/boxery-exe-post.sh'
		echo 'rm -f /var/log/boxery-build.ok /var/log/boxery-exe.ok /var/log/boxery-build.done'
		# Detached: the build outlives an ssh connection dropped by the edge. Progress is polled below.
		echo 'setsid nohup bash -c "export DEBIAN_FRONTEND=noninteractive; { apt-get update -qq && /usr/local/sbin/boxery-build.sh && /usr/local/sbin/boxery-exe-post.sh; } >/var/log/boxery-build.log 2>&1; touch /var/log/boxery-build.done" </dev/null >/dev/null 2>&1 &'
	} >"$tmp/build.sh" || { rm -rf "$tmp"; die "could not prepare the build script"; }
	exe_edge "$stg" 'sudo bash -s' <"$tmp/build.sh" || { rm -rf "$tmp"; die "starting the build on $stg failed"; }
	rm -rf "$tmp"
	local t=0 st
	while :; do
		st=$(exe_edge "$stg" 'if [ -f /var/log/boxery-exe.ok ]; then echo ok; elif [ -f /var/log/boxery-build.done ]; then echo failed; else echo running; fi' </dev/null 2>/dev/null) || st=unreachable
		case $st in ok | failed) break ;; esac
		((t > 2400)) && die "build timed out; the builder VM $stg is still there (ssh $stg.exe.xyz)"
		sleep "$EXE_POLL"; t=$((t + EXE_POLL)); ((t % 60 < EXE_POLL)) && log "still building... ${t}s"
	done
	if [[ $st != ok ]]; then
		exe_edge "$stg" 'tail -40 /var/log/boxery-build.log' </dev/null >&2 || true
		die "base build failed; the builder VM $stg is kept for debugging (ssh $stg.exe.xyz; log /var/log/boxery-build.log)"
	fi
	# VMs are independent full copies, so the old base can go even with VMs made from it.
	j=$(exe_ls) || exit 1
	if exe_has "$base" "$j"; then exe_do rm "$base" >/dev/null || die "could not remove the old base $base"; fi
	exe_do rename "$stg" "$base" >/dev/null || die "rename $stg → $base failed"
	exe_pause "$base"
	log "base image ready: exe.dev VM $base"
}

backend_has_base() {
	[[ -n $EXE_PREFIX ]] || return 1
	local j; j=$(exe_ls) || exit 1
	exe_has "$(exe_base)" "$j"
}
# Local state first (no API call); a VM that only exists on exe.dev (crash before its state dir) still
# counts, so `rm` can clean it up.
backend_exists() {
	[[ -d $(exe_dir "$1") ]] && return 0
	[[ -n $EXE_PREFIX ]] || return 1
	local j; j=$(exe_ls) || exit 1
	exe_has "$(exe_vm "$1")" "$j"
}

# Per-VM identity, as root over the edge: what cloud-init would do with boxery_seed's user-data. Keys
# replace authorized_keys (a fork never keeps its source's lease holder), and a VM made from another
# VM's disk gets its own machine-id and ssh host keys.
exe_identity_script() { # USERDATA NAME
	echo 'set -e'
	node "$ROOT/host/cloudconfig-sh.mjs" "$1" || return 1
	echo 'install -d -m 700 -o agent -g agent /home/agent/.ssh'
	echo "cat >/home/agent/.ssh/authorized_keys <<'BOXERY_KEYS'"
	awk '/^ssh_authorized_keys:/{f=1;next} f&&/^  - /{sub(/^  - /,""); gsub(/^"|"$/,""); print; next} f{f=0}' "$1"
	echo 'BOXERY_KEYS'
	echo 'chown agent:agent /home/agent/.ssh/authorized_keys; chmod 600 /home/agent/.ssh/authorized_keys'
	echo 'rm -f /etc/machine-id /var/lib/dbus/machine-id; systemd-machine-id-setup >/dev/null'
	echo 'rm -f /etc/ssh/ssh_host_*; ssh-keygen -A >/dev/null; systemctl restart ssh.service'
	printf 'hostname %q 2>/dev/null || true; echo %q >/etc/hostname\n' "$2" "$2"
	echo 'rm -rf /run/user/*/boxery'
	echo 'chown -R agent:agent /home/agent'
	echo '[ -e /etc/agentvm ] || ln -s /etc/boxery /etc/agentvm; systemctl restart boxery-llm.service'
	echo 'uid=$(id -u agent); systemctl start "user@$uid.service"'
	echo "sudo -u agent bash -lc 'git config --global user.name agent; git config --global user.email agent@boxery; git config --global init.defaultBranch main; mkdir -p ~/project && cd ~/project && { [ -d .git ] || git init -q; }'"
	echo 'sudo -u agent XDG_RUNTIME_DIR=/run/user/$uid systemctl --user start boxery-vnc boxery-desktop boxery-novnc || true'
}

backend_new() { # NAME CPUS MEM_MIB DISK_GIB USERDATA_FILE [IMAGE]
	local name=$1 cpus=$2 mem=$3 disk=$4 userdata=$5 from=${6:-} d vm src j srcdisk slot
	[[ -n $EXE_PREFIX ]] || die "no exe.dev prefix; run: boxery-host init --backend exe"
	d=$(exe_dir "$name"); vm=$(exe_vm "$name")
	j=$(exe_ls) || exit 1
	if [[ -n $from ]]; then
		src=$(exe_img "$from"); exe_has "$src" "$j" || die "no such image: $from"
		srcdisk=$(exe_disk_of_image "$src" "$j")
	else
		src=$(exe_base); srcdisk=$EXE_BASE_DISK
	fi
	exe_has "$vm" "$j" && die "$name already exists on exe.dev ($vm)"
	mkdir -p "$EXE_DIR/vms"
	mkdir "$d" || die "$name already exists"
	slot=$(exe_alloc_slot "$name")
	# Disks only grow: ask for more than the source only.
	[[ -n $srcdisk ]] || srcdisk=0
	if ((disk < srcdisk)); then disk=$srcdisk; fi
	echo "$disk" >"$d/disk"
	local flags; flags="$(exe_sizes "$cpus" "$mem") $(exe_pool_flag)"
	if ((disk > srcdisk)); then flags="$flags --disk=${disk}GB"; fi
	[[ -z $EXE_EGRESS ]] || flags="$flags --egress=$EXE_EGRESS"
	log "creating $name (exe.dev $vm, copied from ${from:-the base}, 127.0.0.1:$((EXE_PORT_BASE + slot)))"
	# shellcheck disable=SC2086  # flags: word list
	exe_cp "$src" "$vm" $flags || die "exe.dev cp $src → $vm failed"
	local i; for i in $(seq 60); do exe_edge "$vm" true </dev/null >/dev/null 2>&1 && break; ((i < 60)) || die "no ssh to $vm"; sleep 2; done
	exe_identity_script "$userdata" "$name" >"$d/identity.sh" || die "could not prepare $name's identity"
	exe_edge "$vm" 'sudo bash -s' <"$d/identity.sh" >/dev/null || die "applying $name's identity failed"
	rm -f "$d/identity.sh"
	j=$(exe_ls) || exit 1
	exe_tunnel_write "$name" "$j"
	exe_tunnel_start "$name"
}

backend_list() { # → lines: NAME<TAB>STATE<TAB>ADDR<TAB>DISK
	[[ -n $EXE_PREFIX ]] || return 0
	local j n st addr disk
	j=$(exe_ls) || exit 1
	jq -r --arg p "${EXE_PREFIX}v-" '.vms[] | select(.vm_name | startswith($p)) | [(.vm_name | ltrimstr($p)), .status] | @tsv' <<<"$j" |
		while IFS=$'\t' read -r n st; do
			[[ $n =~ ^[a-z][a-z0-9-]*$ ]] || continue
			addr="" disk=""
			[[ ! -f $(exe_dir "$n")/disk ]] || disk="$(cat "$(exe_dir "$n")/disk")GiB"
			if [[ $st == running && -f $(exe_dir "$n")/slot ]] && exe_tunnel_active "$n"; then addr="127.0.0.1:$(exe_port "$n")"; fi
			[[ $st != stopped ]] || st="shut off"
			printf '%s\t%s\t%s\t%s\n' "$n" "$st" "$addr" "$disk"
		done
}

# No API call: `connect` runs this for every ssh session.
backend_ssh_endpoint() {
	[[ -f $(exe_dir "$1")/slot ]] || die "no such vm: $1"
	exe_tunnel_active "$1" || die "$1 is not running (or its tunnel is down: boxery-host start $1)"
	echo "127.0.0.1 $(exe_port "$1")"
}
# The tunnel's local end is up. ssh readiness (through it) is the dispatcher's wait_ssh.
backend_wait_endpoint() {
	local i p
	[[ -f $(exe_dir "$1")/slot ]] || die "no such vm: $1"
	p=$(exe_port "$1")
	for i in $(seq 120); do
		exe_tunnel_active "$1" && nc -z 127.0.0.1 "$p" >/dev/null 2>&1 && { echo "127.0.0.1 $p"; return; }
		sleep 1
	done
	die "timed out waiting for the tunnel to $1 ($(exe_dir "$1")/tunnel.sh)"
}

backend_start() {
	backend_exists "$1" || die "no such vm: $1"
	local vm j st; vm=$(exe_vm "$1")
	j=$(exe_ls) || exit 1
	st=$(exe_status "$vm" "$j")
	[[ -n $st ]] || die "$1 is gone from exe.dev ($vm)"
	# resume restores a paused VM, or cold-boots a stopped one.
	[[ $st == running ]] || exe_do resume "$vm" >/dev/null || die "exe.dev resume $vm failed"
	exe_tunnel_write "$1" "$j"
	exe_tunnel_start "$1"
}
backend_stop() {
	backend_exists "$1" || die "no such vm: $1"
	local vm; vm=$(exe_vm "$1")
	exe_tunnel_stop "$1"
	# pause keeps RAM; a real shutdown would drop the grants pushed to tmpfs, so drop them first.
	exe_edge "$vm" 'sudo rm -rf /run/user/*/boxery' </dev/null >/dev/null 2>&1 || true
	exe_do pause "$vm" >/dev/null || die "exe.dev pause $vm failed"
}

# Remove NAME's exe.dev VM(s), tunnel and local state, whatever exists. Idempotent.
exe_destroy() {
	local j v
	j=$(exe_ls) || exit 1
	exe_tunnel_remove "$1"
	for v in "$(exe_vm "$1")" "$(exe_stage "$1")"; do
		if exe_has "$v" "$j"; then exe_do rm "$v" >/dev/null || die "could not remove exe.dev VM $v"; fi
	done
	rm -rf "$(exe_dir "$1")" || die "could not remove $(exe_dir "$1")"
}
backend_rm() { backend_exists "$1" || die "no such vm: $1"; exe_destroy "$1"; }

# ---------------------------------------------------------------- images (see README: disk only)
backend_capture() { # NAME IMAGE   (VM may be running; it keeps running)
	backend_exists "$1" || die "no such vm: $1"
	local vm img j disk; vm=$(exe_vm "$1"); img=$(exe_img "$2")
	j=$(exe_ls) || exit 1
	exe_has "$vm" "$j" || die "$1 is gone from exe.dev ($vm)"
	exe_has "$img" "$j" && die "image $2 exists"
	disk=$(cat "$(exe_dir "$1")/disk" 2>/dev/null || echo "$EXE_BASE_DISK")
	if [[ $(exe_status "$vm" "$j") == running ]]; then
		exe_edge "$vm" sync </dev/null >/dev/null 2>&1 || log "warning: couldn't sync $1's filesystems; $2 is crash-consistent"
	fi
	exe_cp "$vm" "$img" || die "copying $1 failed"
	# The comment names the image; without it the copy isn't listed (cleanup_image still finds it).
	exe_do comment "$img" "'boxery-image:$2:$disk'" >/dev/null || { exe_do rm "$img" >/dev/null 2>&1 || true; die "labelling image $2 failed"; }
	exe_pause "$img"   # a paused image holds disk only, no pool CPU or memory
}

backend_images() { # → IMAGE<TAB>CREATED<TAB>SIZE
	[[ -n $EXE_PREFIX ]] || return 0
	local j; j=$(exe_ls) || exit 1
	jq -r --arg p "${EXE_PREFIX}i-" '.vms[] | select(.vm_name | startswith($p)) | select((.comment // "") | startswith("boxery-image:")) |
		(.comment | split(":")) as $c | [$c[1], ((.created_at // "") | tostring | .[0:19]), (if ($c[2] // "") != "" then "\($c[2])GiB" else "" end)] | @tsv' <<<"$j"
}
backend_image_rm() {
	local j img; img=$(exe_img "$1")
	j=$(exe_ls) || exit 1
	exe_has "$img" "$j" || die "no such image: $1"
	exe_do rm "$img" >/dev/null || die "could not remove image $1"
}

backend_reimage() { # NAME IMAGE: same exe.dev name (endpoint) and tunnel slot; ends running
	backend_exists "$1" || die "no such vm: $1"
	local vm stg img j disk srcdisk flags=""; vm=$(exe_vm "$1"); stg=$(exe_stage "$1"); img=$(exe_img "$2")
	j=$(exe_ls) || exit 1
	exe_has "$img" "$j" || die "no such image: $2"
	if ! exe_has "$vm" "$j"; then
		# Recovery: interrupted after the old VM was removed, before its replacement was renamed.
		exe_has "$stg" "$j" || die "$1 is gone from exe.dev ($vm)"
	else
		if exe_has "$stg" "$j"; then exe_do rm "$stg" >/dev/null || die "could not remove a stale $stg"; fi
		disk=$(cat "$(exe_dir "$1")/disk" 2>/dev/null || echo 0); srcdisk=$(exe_disk_of_image "$img" "$j")
		flags=$(exe_pool_flag)
		if ((disk > ${srcdisk:-0})); then flags="$flags --disk=${disk}GB"; fi
		[[ -z $EXE_EGRESS ]] || flags="$flags --egress=$EXE_EGRESS"
		# Copy first, swap after: a failed copy leaves the VM as it was.
		# shellcheck disable=SC2086
		exe_cp "$img" "$stg" $flags || die "copying $2 failed"
		exe_tunnel_stop "$1"
		exe_do rm "$vm" >/dev/null || die "could not remove the old $1 (the new disk is exe.dev VM $stg)"
	fi
	exe_do rename "$stg" "$vm" >/dev/null || die "exe.dev rename $stg → $vm failed (retry: boxery-host revert)"
	j=$(exe_ls) || exit 1
	exe_tunnel_write "$1" "$j"
	exe_tunnel_start "$1"
}

# ---------------------------------------------------------------- crash recovery (README: idempotent)
backend_cleanup_new() { # NAME: remove a VM whose create was interrupted, whatever got created
	[[ -n $EXE_PREFIX ]] || { rm -rf "$(exe_dir "$1")"; return 0; }
	exe_destroy "$1"
	rmdir "$EXE_DIR/.slot.lock" 2>/dev/null || true   # held only for milliseconds; a leftover means its holder died
}
backend_cleanup_image() { # IMAGE: labelled or not (a cp killed before its comment)
	[[ -n $EXE_PREFIX ]] || return 0
	local j img; img=$(exe_img "$1")
	j=$(exe_ls) || exit 1
	if exe_has "$img" "$j"; then exe_do rm "$img" >/dev/null || die "could not remove image $1"; fi
}
# Capture never changes the source, so there is nothing to restore. A cp still running on exe.dev's
# side after its CLI died may land after this cleanup; the next recovery or `images` shows it.
backend_recover_capture() { backend_cleanup_image "$2"; }
