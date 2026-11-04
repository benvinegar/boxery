# shellcheck shell=bash disable=SC2154  # sourced by host/boxery-host (provides die/log/need/ROOT/PROXY_PORT/…)
# boxery backend: exe.dev (https://exe.dev). Sourced by host/boxery-host. EXPERIMENTAL.
# Contract: see host/backends/README.md.
#
# - VMs run on exe.dev, managed through its ssh API (`ssh exe.dev CMD --json`). The host only needs ssh
#   and an exe.dev account whose key ssh offers first (or BOXERY_EXE_KEY). No KVM, so it runs on macOS too.
# - exe.dev VM names: PREFIX + vGEN-NAME (VMs; GEN is new for every disk, names are never reused),
#   i-HASH (images), base, build.
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
#   `cp IMAGE-VM VM`; reimage = `cp` the image to a new generation, then `rm` the old one.
# - stop = clear pushed grants + `pause` (exe.dev has no stop); start = `resume`.
# - Headless VMs (SOURCE "stock") are new exeuntu VMs instead of copies of the base: the backend applies
#   the plumbing + devtools layers (which keep what exeuntu ships) and the exe.dev specifics over the edge.

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
EXE_TUNNEL_WAIT=${BOXERY_EXE_TUNNEL_WAIT:-120}   # seconds new/start/revert wait for a tunnel to connect
EXE_MAX_SLOT=500
# Never forward the host's agent or X11 into a guest, whatever ~/.ssh/config says: guest root would get
# the exe.dev account key, i.e. root in every VM. LogLevel=ERROR keeps ssh's notices out of JSON replies.
EXE_SSH=(ssh -a -x -o ForwardAgent=no -o ForwardX11=no -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15
	-o ServerAliveCountMax=4 -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$EXE_DIR/known_hosts"
	-o ControlMaster=no -o ControlPath=none -o LogLevel=ERROR)
[[ -z $EXE_KEY ]] || EXE_SSH+=(-o IdentitiesOnly=yes -i "$EXE_KEY")
# Pin effective settings in operation journals, so crash recovery acts on the same account and names.
export BOXERY_EXE_DIR=$EXE_DIR BOXERY_EXE_KEY=$EXE_KEY BOXERY_EXE_PORT_BASE=$EXE_PORT_BASE BOXERY_EXE_GUEST_PORT=$EXE_GUEST_PORT
[[ -z $EXE_PREFIX ]] || export BOXERY_EXE_PREFIX=$EXE_PREFIX
# shellcheck source=lib/remote.sh
. "$ROOT/host/backends/lib/remote.sh"
# shellcheck disable=SC2034  # read by lib/remote.sh
REMOTE_DIR=$EXE_DIR REMOTE_SUPERVISOR=$EXE_SUPERVISOR REMOTE_PORT_BASE=$EXE_PORT_BASE REMOTE_MAX_SLOT=$EXE_MAX_SLOT
# shellcheck disable=SC2034  # read by lib/remote.sh
REMOTE_PLATFORM=exe.dev REMOTE_CHECK="ssh exe.dev whoami" REMOTE_TUNNEL_WAIT=$EXE_TUNNEL_WAIT REMOTE_TUNNEL_WAIT_VAR=BOXERY_EXE_TUNNEL_WAIT

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
# A VM's exe.dev name changes with every disk it gets (new, reimage): PREFIXv<6 hex>-NAME, the current one
# in $EXE_DIR/vms/NAME/vm. exe.dev's edge keeps routing a deleted VM's name for minutes (ssh fails with
# "VM not found", -R forwards are refused), so a VM name is never reused. The tunnel port stays.
exe_vm() { cat "$(exe_dir "$1")/vm" 2>/dev/null || echo "${EXE_PREFIX}v-$1"; }   # (the fallback never exists)
exe_vm_new() { echo "${EXE_PREFIX}v$(openssl rand -hex 3)-$1"; }
exe_vms_of() { jq -r --arg re "^${EXE_PREFIX}v[0-9a-f]{6}-$1\$" '.vms[] | select(.vm_name | test($re)) | .vm_name' <<<"$2"; }   # NAME LS_JSON
exe_base() { echo "${EXE_PREFIX}base"; }
# Image names contain '@' and '.', which exe.dev names can't: use a hash; the name lives in the comment.
exe_img() { local h; h=$(printf '%s' "$1" | { shasum 2>/dev/null || sha1sum; } | cut -c1-16); echo "${EXE_PREFIX}i-$h"; }
exe_dir() { remote_vm_dir "$1"; }
remote_unit() { echo "boxery-exe-${EXE_PREFIX}v-$1"; }   # systemd unit / launchd label (without suffix)
exe_port() { remote_port "$1"; }

exe_cmd() { "${EXE_SSH[@]}" exe.dev "$@" </dev/null; }   # </dev/null: never eat the caller's stdin
# exe.dev command with JSON output; prints the JSON. Fails (with exe.dev's message) on a non-zero exit
# or an {"error": …} reply. --json goes first so free-text arguments (comment) can't swallow it.
exe_do() {
	local out rc=0 msg ef
	ef=$(mktemp) || return 1
	out=$(exe_cmd "$1" --json "${@:2}" 2>"$ef") || rc=$?   # stderr apart: ssh notices aren't JSON
	if ((rc == 0)) && jq -e 'type == "object" and has("error")' <<<"$out" >/dev/null 2>&1; then rc=1; fi
	if ((rc != 0)); then
		msg=$(jq -r '.error // empty' <<<"$out" 2>/dev/null) || msg=""
		echo "boxery-host: exe.dev $1: ${msg:-${out:0:300}} $(head -c 300 "$ef")" >&2
		rm -f "$ef"
		return 1
	fi
	rm -f "$ef"
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
	# Only plain host/user names: these become ssh arguments (a "-oProxyCommand=…" must never get through).
	d=$(jq -r --arg n "$1" 'def ok: type == "string" and test("^[A-Za-z0-9][A-Za-z0-9.+_-]*$");
		.vms[] | select(.vm_name == $n) | if (.ssh_user | ok) and (.ssh_host | ok) then "-l \(.ssh_user) \(.ssh_host)" elif (.ssh_host | ok) then .ssh_host else "" end' <<<"$j")
	echo "${d:-$1.exe.xyz}"
}
# Run a command in a VM through exe.dev's edge, as the image's login user (exedev, passwordless sudo).
exe_edge() { # VM COMMAND (stdin: passed through)
	local dest; dest=$(exe_dest "$1") || return 1; shift
	# shellcheck disable=SC2086  # dest is "-l USER HOST" or "HOST"
	"${EXE_SSH[@]}" $dest "$@"
}
# CPUS MEM_MIB → "CPUS MEM_MIB" as exe.dev will size the VM: capped to the plan (BOXERY_EXE_MAX_CPUS/MEM),
# memory in whole GB.
exe_cap() {
	local c=$1 m=$2
	if ((c > EXE_MAX_CPUS)); then log "capping to $EXE_MAX_CPUS vCPU (BOXERY_EXE_MAX_CPUS)"; c=$EXE_MAX_CPUS; fi
	if ((m > EXE_MAX_MEM)); then log "capping to $EXE_MAX_MEM MiB (BOXERY_EXE_MAX_MEM)"; m=$EXE_MAX_MEM; fi
	echo "$c $((((m + 1023) / 1024) * 1024))"
}
exe_sizes() { local c m; read -r c m <<<"$(exe_cap "$1" "$2")"; echo "--cpu=$c --memory=$((m / 1024))GB"; }   # → cp/new flags
exe_pool_flag() { [[ -z $EXE_POOL ]] || echo "--pool=$EXE_POOL"; }
# cp SRC DST [FLAGS…]: a copy boots fresh from SRC's disk. Fails without leaving DST behind.
exe_cp() {
	local src=$1 dst=$2; shift 2
	exe_do cp "$src" "$dst" --copy-tags=false "$@" >/dev/null && return 0
	exe_do rm "$dst" >/dev/null 2>&1 || true
	return 1
}
# pause keeps RAM, and a cp only copies the disk: flush the guest first (best effort, it may be booting).
exe_sync() { exe_edge "$1" 'sync' </dev/null >/dev/null 2>&1; }
exe_pause() { exe_sync "$1" || true; exe_do pause "$1" >/dev/null || log "warning: could not pause $1 (it keeps using pool memory)"; }
# IMAGE_VM LS_JSON → the disk size (GB) in its comment, digits only: it ends up in (( arithmetic )).
exe_disk_of_image() { jq -r --arg n "$1" '.vms[] | select(.vm_name == $n) | .comment // "" | split(":")[2] // "" | select(test("^[0-9]{1,5}$")) // ""' <<<"$2"; }

# ---------------------------------------------------------------- per-VM tunnel (lib/remote.sh)
exe_tunnel_write() { # NAME LS_JSON: tunnel.sh + supervisor definition (not started)
	local dest; dest=$(exe_dest "$(exe_vm "$1")" "$2")
	# shellcheck disable=SC2086  # dest is "-l USER HOST" or "HOST"
	remote_tunnel_write "$1" "exe.dev ssh tunnel" "${EXE_SSH[@]}" -N -o ExitOnForwardFailure=yes \
		-L "127.0.0.1:$(exe_port "$1"):127.0.0.1:22" -R "127.0.0.1:$EXE_GUEST_PORT:127.0.0.1:$PROXY_PORT" $dest
}
exe_tunnel_start() { remote_tunnel_start "$1"; }
exe_tunnel_stop() { remote_tunnel_stop "$1"; }
exe_tunnel_active() { remote_tunnel_active "$1"; }
exe_tunnel_state() { remote_tunnel_state "$1"; }
exe_tunnel_remove() { remote_tunnel_remove "$1"; }
exe_alloc_slot() { remote_alloc_slot "$1"; }

# ---------------------------------------------------------------- setup
backend_check() {
	need ssh; need jq; need nc; need "${BOXERY_NODE:-node}"; need openssl
	mkdir -p "$EXE_DIR"   # known_hosts lives here
	if [[ $EXE_SUPERVISOR == launchd ]]; then need launchctl; else need systemctl; fi
	[[ -z $EXE_PREFIX || $EXE_PREFIX =~ ^[a-z][a-z0-9-]{0,19}$ ]] || die "BOXERY_EXE_PREFIX must match [a-z][a-z0-9-]{0,19}"
	local out
	out=$(exe_cmd whoami --json 2>/dev/null) || die "exe.dev doesn't know this host's ssh key: ${out:0:200}
  Run 'ssh exe.dev' once in a terminal (re-registering with your account's email adds the key), or set BOXERY_EXE_KEY."
	jq -e '.email' <<<"$out" >/dev/null 2>&1 || die "unexpected 'whoami' reply from exe.dev: ${out:0:200}"
}
backend_init() { mkdir -p "$EXE_DIR/vms"; exe_prefix_ensure; }
backend_proxy_services() { :; }   # per-VM tunnels carry the proxy; nothing host-wide
guest_proxy_upstream() { echo "TCP:127.0.0.1:$EXE_GUEST_PORT"; }

# exe.dev specifics on top of the shared build ($BASE_USERDATA), run as root after it.
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
	EOF
	remote_post_agent_session
	# Every boot: exe.dev grows the disk (cp/resize --disk) but not the filesystem, and its init resets
	# the hostname and /etc/hosts to the exe.dev name. The identity step records boxery's name.
	remote_post_boot_unit boxery-exe-boot "boxery: grow / and restore the hostname (exe.dev resets both)" /usr/local/sbin/boxery-exe-boot.sh \
		"resize2fs \"\$(findmnt -no SOURCE /)\" >/dev/null 2>&1 || true
$(remote_hostname_restore)"
	echo 'touch /var/log/boxery-exe.ok'
	echo 'sync   # the base is copied from its disk; nothing may stay in the page cache'
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
	# exeuntu ships its own opencode, and a pi that links into exedev's home: the devtools layer keeps
	# what the agent user can run and replaces the rest. Detached (lib/remote.sh): the build outlives an
	# ssh connection dropped by the edge.
	remote_build_script exe_build_post /var/log/boxery-exe.ok >"$tmp/build.sh" || { rm -rf "$tmp"; die "could not prepare the build script"; }
	exe_edge "$stg" 'sudo bash -s' <"$tmp/build.sh" || { rm -rf "$tmp"; die "starting the build on $stg failed"; }
	rm -rf "$tmp"
	local st
	st=$(remote_build_wait exe_edge "$stg" /var/log/boxery-exe.ok "$EXE_POLL") || die "build timed out; the builder VM $stg is still there (ssh $stg.exe.xyz)"
	if [[ $st != ok ]]; then
		exe_edge "$stg" 'tail -40 /var/log/boxery-build.log' </dev/null >&2 || true
		die "base build failed; the builder VM $stg is kept for debugging (ssh $stg.exe.xyz; log /var/log/boxery-build.log)"
	fi
	# VMs are independent full copies, so the old base can go even with VMs made from it. exe.dev renames
	# running VMs only. Sync through the edge before the rename: the edge may route a reused name to the
	# old base for minutes. The base itself is only ever used through the API (cp, pause).
	exe_sync "$stg" || die "could not sync $stg"
	j=$(exe_ls) || exit 1
	if exe_has "$base" "$j"; then exe_do rm "$base" >/dev/null || die "could not remove the old base $base"; fi
	exe_do rename "$stg" "$base" >/dev/null || die "rename $stg → $base failed (the build is VM $stg)"
	exe_do pause "$base" >/dev/null || log "warning: could not pause the base $base (it keeps using pool memory)"
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
	[[ -n $(exe_vms_of "$1" "$j") ]]
}

# exe.dev LLM integrations a VM can reach. New exe.dev accounts attach an `llm` integration to every VM
# (auto:all): a guest could use the account's LLM credits directly, skipping the proxy and its llm:
# grants. Checked from inside the VM, so it holds however the integration got there (auto:all, a tag, by
# hand): the default name answers on llm.int.exe.xyz (403 when not attached), and Reflection, when
# attached, lists LLM integrations under other names. Prints one name per line. Fails closed: returns 1
# when it can't tell (VM unreachable, or llm.int.exe.xyz answers neither like attached nor like 403/404).
exe_llm_integrations() { # VM
	local out code
	out=$(exe_edge "$1" 'echo "llm-probe $(curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://llm.int.exe.xyz/v1/models)"; curl -fsS --max-time 10 https://reflection.int.exe.xyz/integrations 2>/dev/null || true' </dev/null 2>/dev/null) || return 1
	code=$(sed -n 's/^llm-probe //p' <<<"$out" | head -1)
	case $code in 2??) echo llm ;; 403 | 404) ;; *) return 1 ;; esac
	sed '/^llm-probe /d' <<<"$out" | jq -r '.integrations[]? | select(.type == "llm") | .name | select(type == "string" and test("^[A-Za-z0-9._-]{1,64}$"))' 2>/dev/null | sort -u
}
# VMs get LLM access only through llm: grants. Fails (with the fix) when the VM can reach an exe.dev LLM
# integration, or when that can't be checked.
exe_llm_guard() { # VM NAME
	local names
	names=$(exe_llm_integrations "$1") || { log "couldn't check $2 for exe.dev LLM integrations (is it reachable?)"; return 1; }
	names=$(sort -u <<<"$names" | sed '/^$/d')
	[[ -z $names ]] && return 0
	log "$2 can reach exe.dev LLM integration(s): $(paste -sd, - <<<"$names"). That would let it use LLMs without an llm: grant.
  Detach them from boxery's VMs, e.g.: ssh exe.dev integrations detach $(head -1 <<<"$names") auto:all
  (check for vm:/tag: attachments too: ssh exe.dev integrations list). Then retry."
	return 1
}

# Per-VM identity, as root over the edge (lib/remote.sh). A VM made from another VM's disk also gets its
# own ssh host keys.
exe_identity_script() { remote_identity_script "$1" "$2" /usr/local/sbin/boxery-exe-boot.sh regen; }   # USERDATA NAME

# A headless VM's first boot on plain exeuntu: the layers boxery-host asked for (/etc/boxery/provision),
# then what the base build adds for exe.dev. Before the identity script, which needs the agent user.
exe_stock_script() {
	echo 'set -e'
	{ echo '#cloud-config'; echo 'write_files:'; layer_files; } >"$1.layers" || return 1
	"${BOXERY_NODE:-node}" "$ROOT/host/cloudconfig-sh.mjs" "$1.layers" || return 1
	rm -f "$1.layers"
	awk '$0 == "  - path: /etc/boxery/provision" { f = 1; next } f && /^    content: / { sub(/^    content: /, ""); print; exit }' "$1" |
		while IFS= read -r l; do printf 'mkdir -p /etc/boxery; echo %q >/etc/boxery/provision\n' "$l"; done
	echo 'export DEBIAN_FRONTEND=noninteractive'
	echo '/usr/local/sbin/boxery-provision >/var/log/boxery-provision.log 2>&1 || { tail -40 /var/log/boxery-provision.log >&2; exit 1; }'
	exe_build_post
}

backend_new() { # NAME CPUS MEM_MIB DISK_GIB USERDATA_FILE [SOURCE: VM@LABEL image | stock]
	local name=$1 cpus=$2 mem=$3 disk=$4 userdata=$5 from=${6:-} d vm src j srcdisk slot
	[[ -n $EXE_PREFIX ]] || die "no exe.dev prefix; run: boxery-host init --backend exe"
	[[ $name != *- ]] || die "exe.dev names can't end with '-': $name"
	d=$(exe_dir "$name"); vm=$(exe_vm_new "$name")
	j=$(exe_ls) || exit 1
	if [[ $from == stock ]]; then
		src="" srcdisk=0
	elif [[ -n $from ]]; then
		src=$(exe_img "$from"); exe_has "$src" "$j" || die "no such image: $from"
		srcdisk=$(exe_disk_of_image "$src" "$j")
	else
		src=$(exe_base); srcdisk=$EXE_BASE_DISK
	fi
	[[ -z $(exe_vms_of "$name" "$j") ]] || die "$name already exists on exe.dev ($(exe_vms_of "$name" "$j" | head -1))"
	mkdir -p "$EXE_DIR/vms"
	mkdir "$d" || die "$name already exists"
	echo "$vm" >"$d/vm"
	slot=$(exe_alloc_slot "$name")
	# Disks only grow: ask for more than the source only.
	[[ -n $srcdisk ]] || srcdisk=0
	if ((disk < srcdisk)); then disk=$srcdisk; fi
	echo "$disk" >"$d/disk"
	echo "$(exe_cap "$cpus" "$mem" 2>/dev/null) $disk" >"$d/size"   # CPUS MEM_MIB DISK_GIB, for backend_size
	local flags; flags="$(exe_sizes "$cpus" "$mem") $(exe_pool_flag)"
	if ((disk > srcdisk)); then flags="$flags --disk=${disk}GB"; fi
	if [[ $from == stock ]]; then
		# Full egress while the layers install; BOXERY_EXE_EGRESS applies once they are in (below).
		log "creating $name (exe.dev $vm, headless: plain exeuntu, 127.0.0.1:$((EXE_PORT_BASE + slot)))"
		# shellcheck disable=SC2086  # flags: word list
		exe_do new --name="$vm" --no-email $flags >/dev/null || { exe_do rm "$vm" >/dev/null 2>&1 || true; die "exe.dev new $vm failed"; }
	else
		[[ -z $EXE_EGRESS ]] || flags="$flags --egress=$EXE_EGRESS"
		log "creating $name (exe.dev $vm, copied from ${from:-the base}, 127.0.0.1:$((EXE_PORT_BASE + slot)))"
		# shellcheck disable=SC2086  # flags: word list
		exe_cp "$src" "$vm" $flags || die "exe.dev cp $src → $vm failed"
	fi
	local i; for i in $(seq 60); do exe_edge "$vm" true </dev/null >/dev/null 2>&1 && break; ((i < 60)) || die "no ssh to $vm"; sleep 2; done
	if [[ $from == stock ]]; then
		exe_stock_script "$userdata" | exe_edge "$vm" 'sudo bash -s' >&2 || die "installing boxery's layers on $name failed"
	fi
	# Piped, never written to disk: it carries the proxy token.
	exe_identity_script "$userdata" "$name" | exe_edge "$vm" 'sudo bash -s' >/dev/null || die "applying $name's identity failed"
	if [[ $from == stock && -n $EXE_EGRESS ]]; then exe_do egress "$vm" "$EXE_EGRESS" >/dev/null || die "exe.dev egress $vm $EXE_EGRESS failed"; fi
	# Before the tunnel: a refused VM never becomes usable (the failed new is cleaned up).
	exe_llm_guard "$vm" "$name" || die "refusing to create $name"
	j=$(exe_ls) || exit 1
	exe_tunnel_write "$name" "$j"
	exe_tunnel_start "$name"
}

backend_list() { # → lines: NAME<TAB>STATE<TAB>SSH<TAB>DISK_BYTES<TAB>DISK_USED_BYTES<TAB>TUNNEL
	[[ -n $EXE_PREFIX ]] || return 0
	local j n st addr disk tun
	j=$(exe_ls) || exit 1
	jq -r --arg re "^${EXE_PREFIX}v[0-9a-f]{6}-(?<n>.+)$" '.vms[] | (.vm_name | capture($re)) as $m | select($m) | [$m.n, .status, .vm_name] | @tsv' <<<"$j" |
		while IFS=$'\t' read -r n st v; do
			[[ $n =~ ^[a-z][a-z0-9-]*$ ]] || continue
			[[ ! -f $(exe_dir "$n")/vm || $(exe_vm "$n") == "$v" ]] || continue   # a reimage's leftover disk
			addr="" disk="" tun=""
			# the size it was given (exe.dev reports neither size nor usage): DISK_USED stays unknown
			disk=$(cat "$(exe_dir "$n")/disk" 2>/dev/null) || disk=""
			if [[ $disk =~ ^[0-9]+$ ]]; then disk=$((disk * 1073741824)); else disk=""; fi
			[[ ! -f $(exe_dir "$n")/slot ]] || tun=$(exe_tunnel_state "$n")
			if [[ $st == running && $tun == up ]]; then addr="127.0.0.1:$(exe_port "$n")"; fi
			[[ $st != stopped ]] || st="shut off"
			printf '%s\t%s\t%s\t%s\t\t%s\n' "$n" "$st" "$addr" "$disk" "$tun"
		done
}

backend_endpoint_problem() { remote_endpoint_problem "$1"; }   # README: local checks only
backend_ssh_endpoint() { remote_ssh_endpoint "$1"; }
backend_wait_endpoint() { remote_wait_endpoint "$1"; }

backend_start() {
	backend_exists "$1" || die "no such vm: $1"
	local vm j st; vm=$(exe_vm "$1")
	j=$(exe_ls) || exit 1
	st=$(exe_status "$vm" "$j")
	[[ -n $st ]] || die "$1 is gone from exe.dev ($vm)"
	if [[ -f $(exe_dir "$1")/resized ]]; then
		# Resized while paused: resume would bring back the old CPUs, memory and disk. Boot it fresh.
		exe_do restart "$vm" >/dev/null || die "exe.dev restart $vm failed"
		rm -f "$(exe_dir "$1")/resized"
	elif [[ $st != running ]]; then
		# resume restores a paused VM, or cold-boots a stopped one.
		exe_do resume "$vm" >/dev/null || die "exe.dev resume $vm failed"
	fi
	# Integrations can be attached after a VM was created (auto:all covers existing VMs too).
	if ! exe_llm_guard "$vm" "$1"; then
		exe_pause "$vm"
		die "refusing to start $1 (paused again)"
	fi
	exe_tunnel_write "$1" "$j"
	exe_tunnel_start "$1"
}
backend_stop() {
	backend_exists "$1" || die "no such vm: $1"
	local vm; vm=$(exe_vm "$1")
	exe_tunnel_stop "$1"
	# pause keeps RAM; a real shutdown would drop the grants pushed to tmpfs, so drop them first. sync:
	# a later snapshot or fork copies the paused VM's disk, not its page cache.
	exe_edge "$vm" 'sudo rm -rf /run/user/*/boxery; sync' </dev/null >/dev/null 2>&1 || log "warning: couldn't reach $1 to flush it before pausing"
	exe_do pause "$vm" >/dev/null || die "exe.dev pause $vm failed"
}

backend_size() { # → CPUS MEM_MIB DISK_GIB, as created/resized (exe.dev's ls doesn't report sizes)
	[[ -f $(exe_dir "$1")/size ]] || die "no recorded size for $1"
	cat "$(exe_dir "$1")/size"
}
# exe.dev resize, then a restart of a running VM so the guest sees the new CPUs, memory and disk
# (boxery-growfs grows / at boot). A paused VM is left paused, and its next start restarts it: a resumed
# VM keeps its old size.
backend_resize() { # NAME CPUS MEM_MIB DISK_GIB (empty = unchanged)
	local vm d c m k j st flags=""; vm=$(exe_vm "$1"); d=$(exe_dir "$1")
	read -r c m k <"$d/size" || die "no recorded size for $1"
	[[ -z $2 && -z $3 ]] || read -r c m <<<"$(exe_cap "${2:-$c}" "${3:-$m}")"
	[[ -z $2 ]] || flags="$flags --cpu=$c"
	[[ -z $3 ]] || flags="$flags --memory=$((m / 1024))GB"
	[[ -z $4 ]] || { k=$4; flags="$flags --disk=${k}GB"; }
	j=$(exe_ls) || exit 1
	st=$(exe_status "$vm" "$j")
	[[ -n $st ]] || die "$1 is gone from exe.dev ($vm)"
	# shellcheck disable=SC2086
	exe_do resize "$vm" $flags >/dev/null || die "exe.dev resize $vm failed"
	echo "$c $m $k" >"$d/size"; echo "$k" >"$d/disk"
	if [[ $st == running ]]; then
		log "restarting $1 to apply the new size"
		exe_sync "$vm" || true
		exe_do restart "$vm" >/dev/null || die "resized $1, but exe.dev restart failed"
		exe_tunnel_start "$1"   # reconnect now rather than after the keepalive notices
	else
		touch "$d/resized"
	fi
}

# Remove NAME's exe.dev VM(s) (every generation), tunnel and local state, whatever exists. Idempotent.
exe_destroy() {
	local j vms
	j=$(exe_ls) || exit 1
	exe_tunnel_remove "$1"
	vms=$(exe_vms_of "$1" "$j")
	# shellcheck disable=SC2086  # vms: names, one per line
	[[ -z $vms ]] || exe_do rm $vms >/dev/null || die "could not remove exe.dev VM(s) $(echo $vms)"
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
	# A paused VM was synced by stop (or by its capture), so its disk is current.
	if [[ $(exe_status "$vm" "$j") == running ]]; then
		exe_sync "$vm" || log "warning: couldn't sync $1's filesystems; $2 is crash-consistent"
	fi
	# The image VM boots the agent's disk until it's paused: same pool and egress policy as a VM.
	local flags; flags=$(exe_pool_flag)
	[[ -z $EXE_EGRESS ]] || flags="$flags --egress=$EXE_EGRESS"
	# shellcheck disable=SC2086
	exe_cp "$vm" "$img" $flags || die "copying $1 failed"
	# The comment names the image; without it the copy isn't listed (cleanup_image still finds it).
	exe_do comment "$img" "'boxery-image:$2:$disk'" >/dev/null || { exe_do rm "$img" >/dev/null 2>&1 || true; die "labelling image $2 failed"; }
	# A paused image holds disk only, no pool CPU or memory. No sync: the copy is booting from a synced
	# disk, and the edge may route a reused image name (snap-rm, then snap) to its predecessor.
	exe_do pause "$img" >/dev/null || log "warning: could not pause image $2 (it keeps using pool memory)"
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

# NAME IMAGE: the image's disk under a new exe.dev name (see exe_vm), same tunnel slot; ends running.
# Idempotent: a retry makes a fresh copy and removes every other generation, the old VM and any copy
# an interrupted run left behind.
backend_reimage() {
	backend_exists "$1" || die "no such vm: $1"
	local d new img j v disk srcdisk flags; d=$(exe_dir "$1"); new=$(exe_vm_new "$1"); img=$(exe_img "$2")
	j=$(exe_ls) || exit 1
	exe_has "$img" "$j" || die "no such image: $2"
	disk=$(cat "$d/disk" 2>/dev/null || echo 0); srcdisk=$(exe_disk_of_image "$img" "$j")
	flags=$(exe_pool_flag)
	# The image may come from before a resize: keep the VM's own CPU and memory.
	local c m; if read -r c m _ <"$d/size" 2>/dev/null; then flags="$flags $(exe_sizes "$c" "$m")"; fi
	if ((disk > ${srcdisk:-0})); then flags="$flags --disk=${disk}GB"; fi
	[[ -z $EXE_EGRESS ]] || flags="$flags --egress=$EXE_EGRESS"
	# Copy first, switch after: a failed copy leaves the VM as it was.
	# shellcheck disable=SC2086
	exe_cp "$img" "$new" $flags || die "copying $2 failed"
	# A pool reset makes a new exe.dev VM, which auto:all integrations attach to. Check before switching.
	if ! exe_llm_guard "$new" "$1"; then
		exe_do rm "$new" >/dev/null 2>&1 || log "warning: could not remove the refused copy (ssh exe.dev rm $new)"
		exit 1
	fi
	exe_tunnel_stop "$1"
	echo "$new" >"$d/vm.tmp" && mv "$d/vm.tmp" "$d/vm" || die "could not record $1's new exe.dev VM $new"
	rm -f "$d/resized"   # the copy booted fresh at the VM's size
	for v in $(exe_vms_of "$1" "$j"); do   # j predates the copy: all of these are old
		exe_do rm "$v" >/dev/null || log "warning: could not remove $1's old disk (ssh exe.dev rm $v)"
	done
	j=$(exe_ls) || exit 1
	exe_tunnel_write "$1" "$j"
	exe_tunnel_start "$1"
}

# ---------------------------------------------------------------- crash recovery (README: idempotent)
backend_cleanup_new() { # NAME: remove a VM whose create was interrupted, whatever got created
	[[ -n $EXE_PREFIX ]] || { rm -rf "$(exe_dir "$1")"; return 0; }
	exe_destroy "$1"
	remote_clear_stale_slot_lock
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
