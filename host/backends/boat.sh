# shellcheck shell=bash disable=SC2154  # sourced by host/boxery-host (provides die/log/need/ROOT/PROXY_PORT/…)
# boxery backend: boat.dev (https://boat.dev). Sourced by host/boxery-host. EXPERIMENTAL.
# Contract: see host/backends/README.md ("Remote backends" for the shared tunnel model, lib/remote.sh).
#
# - VMs are boat sandboxes (full Ubuntu 24.04 VMs), managed through boat's REST API with curl and an API
#   key (BOAT_API_KEY, saved by init in $BOAT_DIR/api-key). No KVM on the host, so it runs on macOS too.
# - Sandboxes are named PREFIXvm-NAME (VMs) and PREFIXbuild (the builder). PREFIX (default "bx<6 hex>-",
#   generated once into $BOAT_DIR/prefix) keeps the account's other sandboxes out of reach. Names, not
#   labels: boat drops the labels of a sandbox created from a saved snapshot.
#   A VM's sandbox id (bx_…) changes with every disk it gets (new, revert, pool reset); the current one
#   is $BOAT_DIR/vms/NAME/id.
# - ssh: boat runs a real sshd (user `user`, passwordless sudo) and authorizes keys over the API
#   (POST /sandboxes/ID/sshkey answers the address and the host key to pin). The host's own key
#   ($BOAT_DIR/id_ed25519) is the admin channel: build, identity, sync. Each VM gets one supervised
#   tunnel as `user`: -L 127.0.0.1:PORT → guest :22 (the VM's endpoint), -R guest :GPORT → host proxy.
#   Every resume puts the sandbox on a new machine (new address, new host key): start re-pins it and
#   rewrites the tunnel.
# - The guest's sshd is public (boat needs it), so the base lets `agent` in from loopback only (the
#   tunnel's end): the lease holder's key can't bypass the host.
# - Images (snapshots, forks, pool resets; disk only, see README) are saved snapshots, named
#   PREFIXi-HASH (saved snapshot names are [a-z0-9-]); the image name and disk are kept in
#   $BOAT_DIR/images/. A saved snapshot is an exact, independent copy of a running or stopped sandbox.
#   new --from = POST /sandboxes {from}; reimage = a new sandbox from the image, then delete the old one.
# - stop = POST /stop (boat saves the disk and drops the machine: memory and tmpfs grants are gone, as
#   after a shutdown); start = POST /resume.
# - Sizes are boat's four types (small 2/4, default 4/8, large 8/16, xlarge 16/32 vCPU/GB): a VM gets the
#   smallest one that fits, up to BOXERY_BOAT_MAX_TYPE. resize = stop, then resume with the new type.
# - Sandboxes are created with noEnv (none of the account's environment, logins or CLI token; they can't
#   act on the account) and without auto-stop.

BOAT_DIR=${BOXERY_BOAT_DIR:-$HOME/.local/share/boxery/boat}
BOAT_PREFIX=${BOXERY_BOAT_PREFIX:-$(cat "$BOAT_DIR/prefix" 2>/dev/null || true)}
BOAT_API=${BOXERY_BOAT_API:-https://boat.dev/api/v1}
BOAT_ORG=${BOXERY_BOAT_ORG:-}                      # bill an organization (X-Boat-Org); default: the active wallet
BOAT_PORT_BASE=${BOXERY_BOAT_PORT_BASE:-22600}     # VM slot S ↔ host port BASE+S (the tunnel's -L end)
BOAT_GUEST_PORT=${BOXERY_BOAT_GUEST_PORT:-18088}   # the tunnel's -R end in the guest (LLM proxy)
BOAT_MAX_TYPE=${BOXERY_BOAT_MAX_TYPE:-large}       # xlarge needs the $100 plan
BOAT_TTL=${BOXERY_BOAT_TTL:-}                      # seconds until boat auto-stops a VM; empty = never (the trial needs ≤ 7200)
BOAT_TUNNEL_WAIT=${BOXERY_BOAT_TUNNEL_WAIT:-120}   # seconds new/start/revert wait for a tunnel to connect
BOAT_SUPERVISOR=${BOXERY_BOAT_SUPERVISOR:-$([[ $(uname) == Darwin ]] && echo launchd || echo systemd)}
BOAT_POLL=${BOXERY_BOAT_POLL:-5}                   # seconds between state polls
BOAT_TRIES=${BOXERY_BOAT_TRIES:-180}               # polls before giving up (sandbox start, stop, saves)
BOAT_KEY=$BOAT_DIR/id_ed25519                      # the host's admin key for `user` in every sandbox
BOAT_MAX_SLOT=500
# Never forward the host's agent or X11 into a guest, whatever ~/.ssh/config says. Host keys come from
# boat's API (pinned per VM), never trusted on first use.
BOAT_SSH=(ssh -a -x -o ForwardAgent=no -o ForwardX11=no -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15
	-o ServerAliveCountMax=4 -o StrictHostKeyChecking=yes -o ControlMaster=no -o ControlPath=none -o LogLevel=ERROR
	-o IdentitiesOnly=yes -i "$BOAT_KEY")
# Pin effective settings in operation journals, so crash recovery acts on the same account and names.
export BOXERY_BOAT_DIR=$BOAT_DIR BOXERY_BOAT_API=$BOAT_API BOXERY_BOAT_PORT_BASE=$BOAT_PORT_BASE BOXERY_BOAT_GUEST_PORT=$BOAT_GUEST_PORT
[[ -z $BOAT_PREFIX ]] || export BOXERY_BOAT_PREFIX=$BOAT_PREFIX
# shellcheck source=lib/remote.sh
. "$ROOT/host/backends/lib/remote.sh"
# shellcheck disable=SC2034  # read by lib/remote.sh
REMOTE_DIR=$BOAT_DIR REMOTE_SUPERVISOR=$BOAT_SUPERVISOR REMOTE_PORT_BASE=$BOAT_PORT_BASE REMOTE_MAX_SLOT=$BOAT_MAX_SLOT
# shellcheck disable=SC2034  # read by lib/remote.sh
REMOTE_PLATFORM=boat.dev REMOTE_CHECK="curl -sS -o /dev/null -w %{http_code} https://boat.dev/api/v1/me" REMOTE_TUNNEL_WAIT=$BOAT_TUNNEL_WAIT REMOTE_TUNNEL_WAIT_VAR=BOXERY_BOAT_TUNNEL_WAIT
remote_unit() { echo "boxery-boat-${BOAT_PREFIX}$1"; }   # systemd unit / launchd label (without suffix)

# ---------------------------------------------------------------- names
boat_prefix_ensure() { # generate PREFIX once (init/build-base); concurrent callers agree via link(2)
	[[ -z $BOAT_PREFIX ]] || return 0
	mkdir -p "$BOAT_DIR"
	local tmp; tmp=$(mktemp "$BOAT_DIR/.prefix.XXXXXX")
	echo "bx$(openssl rand -hex 3)-" >"$tmp"
	ln "$tmp" "$BOAT_DIR/prefix" 2>/dev/null || true
	rm -f "$tmp"
	BOAT_PREFIX=$(cat "$BOAT_DIR/prefix") || die "cannot read $BOAT_DIR/prefix"
	export BOXERY_BOAT_PREFIX=$BOAT_PREFIX
}
boat_dir() { remote_vm_dir "$1"; }
boat_id() { cat "$(boat_dir "$1")/id" 2>/dev/null; }
boat_base() { echo "${BOAT_PREFIX}base"; }   # the base: a saved snapshot
# Image names contain '@' and '.', which saved snapshot names can't: use a hash; the name lives in
# $BOAT_DIR/images/SNAPSHOT ("IMAGE<TAB>DISK_GIB").
boat_img() { local h; h=$(printf '%s' "$1" | { shasum 2>/dev/null || sha1sum; } | cut -c1-16); echo "${BOAT_PREFIX}i-$h"; }

# ---------------------------------------------------------------- the boat API
boat_api_key() {
	if [[ -n ${BOAT_API_KEY:-} ]]; then echo "$BOAT_API_KEY"; return; fi
	[[ -s $BOAT_DIR/api-key ]] || { echo "boxery-host: no boat API key: set BOAT_API_KEY and run boxery-host init --backend boat" >&2; return 1; }
	cat "$BOAT_DIR/api-key"
}
# METHOD PATH [JSON_BODY [HEADER]] → the reply's JSON. Fails (with boat's message) on HTTP ≥ 400 or
# {"ok": false}. The key goes through a curl config on a pipe, never the command line. Retries what boat
# says is safe to retry: 429 rate_limited and 503 (nothing was created), and 5xx on GET/DELETE.
boat_api() {
	local m=$1 path=$2 body=${3:-} hdr=${4:-} key out code msg try=0 args
	key=$(boat_api_key) || return 1
	args=(-sS --max-time 120 -X "$m" -H 'Accept: application/json' -w '\n%{http_code}')
	[[ -z $BOAT_ORG ]] || args+=(-H "X-Boat-Org: $BOAT_ORG")
	[[ -z $hdr ]] || args+=(-H "$hdr")
	[[ -z $body ]] || args+=(-H 'Content-Type: application/json' --data-binary @-)
	while :; do
		out=$(printf '%s' "$body" | curl "${args[@]}" -K <(printf 'header = "Authorization: Bearer %s"\n' "$key") "$BOAT_API$path" 2>&1) || out=$'\n000'
		code=${out##*$'\n'}; out=${out%$'\n'*}
		if [[ $code =~ ^2[0-9][0-9]$ ]] && ! jq -e 'type == "object" and .ok == false' <<<"$out" >/dev/null 2>&1; then
			printf '%s\n' "$out"; return 0
		fi
		msg=$(jq -r '"\(.code // .error.code // "error"): \(.message // .error.message // "")"' <<<"$out" 2>/dev/null) || msg=${out:0:300}
		try=$((try + 1))
		if ((try < ${BOXERY_BOAT_RETRIES:-5})); then
			case $code:$m:$msg in
			429:*:rate_limited* | 429:*:IP_RATE_LIMIT* | 503:* | 5[0-9][0-9]:GET:* | 5[0-9][0-9]:DELETE:* | 000:GET:*) sleep $((try * 2)); continue ;;
			esac
		fi
		echo "boxery-host: boat $m $path: HTTP $code $msg" >&2
		return 1
	done
}
# Every sandbox of this host (all states, every page) as one JSON array. An unreachable API is an
# error, never an empty account.
boat_sandboxes() {
	local cursor="" page all='[]' q
	while :; do
		q="/sandboxes?namePrefix=${BOAT_PREFIX}&state=init,provisioning,provisioned,cloning,ready,idle,running,archiving,archived,error&limit=200"
		[[ -z $cursor ]] || q="$q&cursor=$cursor"
		page=$(boat_api GET "$q") || return 1
		jq -e '.sandboxes | type == "array"' <<<"$page" >/dev/null 2>&1 || { echo "boxery-host: unexpected GET /sandboxes reply from boat: ${page:0:200}" >&2; return 1; }
		# The name filter is the API's; check it again here: only this host's sandboxes are ever touched.
		all=$(jq -c --argjson a "$all" --arg p "$BOAT_PREFIX" '$a + [.sandboxes[] | select(.name | type == "string" and startswith($p))]' <<<"$page")
		cursor=$(jq -r '.pageInfo.nextCursor // empty | select(test("^[A-Za-z0-9._~=-]+$"))' <<<"$page")
		[[ -n $cursor ]] || break
	done
	printf '%s\n' "$all"
}
boat_vm_ids() { jq -r --arg n "${BOAT_PREFIX}vm-$1" '.[] | select(.name == $n) | .id' <<<"$2"; }   # NAME SANDBOXES
boat_state_of() { jq -r --arg i "$1" '.[] | select(.id == $i) | .state' <<<"$2"; }                                                 # ID SANDBOXES
boat_get() { boat_api GET "/sandboxes/$1" | jq -c '.sandbox // .'; }
boat_delete() { boat_api DELETE "/sandboxes/$1" "" "X-Ascii-Confirm-Delete: $1" >/dev/null; }
boat_saved() { boat_api GET "/saved-snapshots" | jq -c '.snapshots // []'; }
boat_saved_status() { jq -r --arg n "$1" '.[] | select(.name == $n) | .status' <<<"$2"; }   # NAME SAVED
# Poll a sandbox until it runs commands (ready, idle, running). Fails on error, or when it stops.
boat_wait_ready() { # ID
	local i st
	for ((i = 1; i <= BOAT_TRIES; i++)); do
		st=$(boat_get "$1" | jq -r '.state') || st=""
		case $st in ready | idle | running) return 0 ;; error | archived) echo "boxery-host: boat sandbox $1 is $st" >&2; return 1 ;; esac
		sleep "$BOAT_POLL"
	done
	echo "boxery-host: timed out waiting for boat sandbox $1 to start" >&2; return 1
}
boat_wait_stopped() { # ID
	local i st
	for ((i = 1; i <= BOAT_TRIES; i++)); do
		st=$(boat_get "$1" | jq -r '.state') || st=""
		[[ $st == archived ]] && return 0
		sleep "$BOAT_POLL"
	done
	echo "boxery-host: timed out waiting for boat sandbox $1 to stop" >&2; return 1
}
# Save sandbox ID as saved snapshot NAME and wait until it's ready. A failed save is removed.
boat_save() { # ID NAME
	local i st
	boat_api POST /saved-snapshots "$(jq -nc --arg s "$1" --arg n "$2" '{sandboxId: $s, name: $n}')" >/dev/null || return 1
	for ((i = 1; i <= BOAT_TRIES; i++)); do
		st=$(boat_api GET "/saved-snapshots/$2" | jq -r '.snapshot.status // .status') || st=""
		case $st in ready) return 0 ;; failed) break ;; esac
		sleep "$BOAT_POLL"
	done
	boat_api DELETE "/saved-snapshots/$2" >/dev/null 2>&1 || true
	echo "boxery-host: saving snapshot $2 failed (${st:-timed out})" >&2; return 1
}

# ---------------------------------------------------------------- sizes: boat's fixed types
boat_types() { printf 'small 2 4096 51\ndefault 4 8192 51\nlarge 8 16384 111\nxlarge 16 32768 251\n'; }   # TYPE CPUS MEM_MIB DISK_GIB
boat_type_size() { boat_types | awk -v t="$1" '$1 == t { print $2, $3, $4 }'; }
# CPUS MEM_MIB DISK_GIB → the smallest type that fits, up to BOXERY_BOAT_MAX_TYPE (logged when it differs).
boat_type_for() {
	local t c m k pick="" last=""
	while read -r t c m k; do
		last=$t
		if [[ -z $pick ]] && ((c >= $1 && m >= $2 && k >= $3)); then pick=$t; fi
		[[ $t != "$BOAT_MAX_TYPE" ]] || break
	done < <(boat_types)
	if [[ -z $pick ]]; then log "capping to boat type $last (BOXERY_BOAT_MAX_TYPE)"; pick=$last; fi
	read -r c m k <<<"$(boat_type_size "$pick")"
	[[ "$c $m $k" == "$1 $2 $3" ]] || log "boat type $pick: $c vCPU, $m MiB, $k GiB"
	echo "$pick"
}

# ---------------------------------------------------------------- ssh
# Authorize the host's key on sandbox ID (running) and pin its address and host key in DIR: dest
# ("HOST PORT USER") and known_hosts. Every resume, fork and new sandbox has a new machine.
boat_ssh_setup() { # DIR ID
	local r h p u k
	r=$(boat_api POST "/sandboxes/$2/sshkey" "$(jq -nc --arg k "$(cat "$BOAT_KEY.pub")" '{key: $k}')") || return 1
	# Only plain values: these become ssh arguments and a known_hosts line.
	read -r h p u k < <(jq -r 'def plain: type == "string" and test("^[A-Za-z0-9][A-Za-z0-9.:_-]*$");
		(if (.sshEndpoint | plain) then (.sshEndpoint | capture("^(?<h>.+):(?<p>[0-9]{1,5})$") // {h: "", p: ""}) else {h: (.machineIp // ""), p: "22"} end) as $e |
		[(if ($e.h | plain) then $e.h else "-" end), $e.p, (if (.sshUser | plain) then .sshUser else "user" end),
		 (.hostKey // "" | select(test("^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+) [A-Za-z0-9+/=]+$")) // "-" | sub(" "; "_"))] | @tsv' <<<"$r")
	[[ $h != - && $p =~ ^[0-9]+$ && -n $k && $k != - ]] || { echo "boxery-host: boat sshkey for $2: no usable address or host key: ${r:0:200}" >&2; return 1; }
	echo "$2 ${k/_/ }" >"$1/known_hosts"
	echo "$h $p $u" >"$1/dest"
}
boat_ssh_args() { # DIR → ssh arguments for the sandbox recorded in DIR
	local h p u; read -r h p u <"$1/dest" || return 1
	printf '%s\n' -o "HostKeyAlias=$(cat "$1/id")" -o "UserKnownHostsFile=$1/known_hosts" -p "$p" "$u@$h"
}
# Run a command in the sandbox recorded in DIR, as `user` (passwordless sudo). stdin is passed through.
boat_run() { # DIR COMMAND
	local a=() l; while IFS= read -r l; do a+=("$l"); done < <(boat_ssh_args "$1")
	((${#a[@]})) || { echo "boxery-host: no ssh address recorded in $1" >&2; return 1; }
	"${BOAT_SSH[@]}" "${a[@]}" "${@:2}"
}
boat_wait_ssh() { # DIR
	local i; for i in $(seq 60); do boat_run "$1" true </dev/null >/dev/null 2>&1 && return 0; sleep 2; done
	echo "boxery-host: no ssh to boat sandbox $(cat "$1/id")" >&2; return 1
}
# A sandbox that just started: wait for it, authorize and pin, wait for ssh.
boat_attach() { boat_wait_ready "$2" && boat_ssh_setup "$1" "$2" && boat_wait_ssh "$1"; }   # DIR ID
boat_sync() { boat_run "$1" 'sync' </dev/null >/dev/null 2>&1; }   # DIR
# The VM's ssh host key as boat's API reported it at the last attach (new, start, reimage). It is the
# machine's own sshd, which the tunnel's -L end also reaches, so boxery-host pins it for NAME
# (host/hostkeys.mjs) instead of seeding a key of its own: every resume puts the VM on a new machine.
backend_platform_host_key() { # NAME
	local kh; kh=$(boat_dir "$1")/known_hosts
	[[ -f $kh ]] || return 1
	awk '{ print $2, $3; exit }' "$kh"
}

boat_tunnel_write() { # NAME
	local d a=() l; d=$(boat_dir "$1")
	while IFS= read -r l; do a+=("$l"); done < <(boat_ssh_args "$d")
	((${#a[@]})) || die "no ssh address recorded for $1"
	remote_tunnel_write "$1" "boat.dev ssh tunnel" "${BOAT_SSH[@]}" -N -o ExitOnForwardFailure=yes \
		-L "127.0.0.1:$(remote_port "$1"):127.0.0.1:22" -R "127.0.0.1:$BOAT_GUEST_PORT:127.0.0.1:$PROXY_PORT" "${a[@]}"
}

# ---------------------------------------------------------------- setup
backend_check() {
	need curl; need jq; need ssh; need ssh-keygen; need nc; need "${BOXERY_NODE:-node}"; need openssl
	mkdir -p "$BOAT_DIR"
	if [[ $BOAT_SUPERVISOR == launchd ]]; then need launchctl; else need systemctl; fi
	[[ -z $BOAT_PREFIX || $BOAT_PREFIX =~ ^[a-z][a-z0-9-]{0,19}$ ]] || die "BOXERY_BOAT_PREFIX must match [a-z][a-z0-9-]{0,19}"
	boat_type_size "$BOAT_MAX_TYPE" | grep . >/dev/null || die "BOXERY_BOAT_MAX_TYPE must be small, default, large or xlarge"
	[[ -z $BOAT_TTL || $BOAT_TTL =~ ^[1-9][0-9]{0,6}$ ]] || die "BOXERY_BOAT_TTL must be a number of seconds (or empty: no auto-stop)"
	local out; out=$(boat_api GET /me) || die "boat.dev refused the API key (BOAT_API_KEY, or $BOAT_DIR/api-key)"
	jq -e 'type == "object"' <<<"$out" >/dev/null 2>&1 || die "unexpected GET /me reply from boat: ${out:0:200}"
}
backend_init() {
	mkdir -p "$BOAT_DIR/vms" "$BOAT_DIR/images"; chmod 700 "$BOAT_DIR"
	boat_prefix_ensure
	if [[ -n ${BOAT_API_KEY:-} ]]; then (umask 077; printf '%s\n' "$BOAT_API_KEY" >"$BOAT_DIR/api-key"); fi
	[[ -f $BOAT_KEY ]] || ssh-keygen -q -t ed25519 -N "" -C "boxery-host@$(hostname) (boat)" -f "$BOAT_KEY"
}
backend_proxy_services() { :; }   # per-VM tunnels carry the proxy; nothing host-wide
guest_proxy_upstream() { echo "TCP:127.0.0.1:$BOAT_GUEST_PORT"; }

# boat specifics on top of the shared build (image/base-user-data.yaml), run as root after it.
boat_build_post() {
	cat <<-'EOF'
		set -e
		# boat needs its public sshd (its own CLI, our tunnels as `user`). `agent` (the lease holder's
		# keys) is only let in from loopback, i.e. through the host's tunnel.
		cat >/etc/ssh/sshd_config.d/60-boxery-boat.conf <<-'CONF'
			Match User agent Address *,!127.0.0.1,!::1
			    DenyUsers agent
		CONF
		# The shared build deletes the ssh host keys (a golden image mustn't carry them); without any, sshd
		# refuses everyone. Put back the machine's own (saved before the build), so the key the host pinned
		# for this builder stays valid and the build can still be polled. boat reports the live key
		# through its API anyway, and every new machine gets its own.
		if [ -d /root/.boxery-hostkeys ]; then cp -p /root/.boxery-hostkeys/ssh_host_* /etc/ssh/ && rm -rf /root/.boxery-hostkeys; fi
		ssh-keygen -A
		sshd -t
		systemctl reload ssh.service 2>/dev/null || systemctl restart ssh.service
	EOF
	remote_post_agent_session
	# boat's snapshots don't keep the hostname: restore boxery's at every boot (resume, fork, new).
	remote_post_boot_unit boxery-boat-boot "boxery: restore the hostname (boat.dev resets it)" /usr/local/sbin/boxery-boat-boot.sh \
		"$(remote_hostname_restore)"
	echo 'touch /var/log/boxery-boat.ok'
	echo 'sync'
}

boat_ttl() { if [[ -n $BOAT_TTL ]]; then echo "$BOAT_TTL"; else echo null; fi; }   # → ttlSeconds
# POST /sandboxes as a boxery sandbox: named, no auto-stop (BOXERY_BOAT_TTL), no account environment. The
# labels are informational (boat keeps them only on sandboxes not created from a saved snapshot).
boat_create() { # ROLE NAME TYPE [FROM] → the new sandbox's id
	local body r id
	body=$(jq -nc --arg p "$BOAT_PREFIX" --arg r "$1" --arg n "$2" --arg t "$3" --arg f "${4:-}" --argjson ttl "$(boat_ttl)" '{type: $t, ttlSeconds: $ttl, noEnv: true,
		name: (if $r == "vm" then "\($p)vm-\($n)" else "\($p)\($r)" end), labels: ({"boxery.host": $p, "boxery.role": $r} + (if $r == "vm" then {"boxery.vm": $n} else {} end))}
		+ (if $f != "" then {from: $f} else {} end)')
	r=$(boat_api POST /sandboxes "$body" "Idempotency-Key: boxery-$(openssl rand -hex 16)") || return 1
	id=$(jq -r '.sandbox.id // .id // empty | select(test("^bx_[A-Za-z0-9]+$"))' <<<"$r")
	[[ -n $id ]] || { echo "boxery-host: unexpected POST /sandboxes reply from boat: ${r:0:200}" >&2; return 1; }
	echo "$id"
}

# The build poller's runner: if ssh fails (boat moved the builder, or its host key changed), re-pin once.
boat_build_run() { boat_run "$@" || { boat_ssh_setup "$1" "$(cat "$1/id")" >/dev/null 2>&1 && boat_run "$@"; }; }   # DIR COMMAND

backend_build_base() {
	boat_prefix_ensure
	local base d id j old st tmp; base=$(boat_base); d=$BOAT_DIR/build
	j=$(boat_sandboxes) || exit 1
	for old in $(jq -r --arg n "${BOAT_PREFIX}build" '.[] | select(.name == $n) | .id' <<<"$j"); do boat_delete "$old" || die "could not remove a previous builder sandbox $old"; done
	rm -rf "$d"; mkdir -p "$d"
	log "creating a boat builder sandbox (type default)"
	id=$(boat_create build build default) || die "boat: creating the builder failed"
	echo "$id" >"$d/id"
	boat_attach "$d" "$id" || die "builder sandbox $id never came up"
	log "installing the desktop image (XFCE, VNC, Chrome/Chromium, node, pi, opencode; ~5-10 min)"
	tmp=$(mktemp -d)
	# boat preinstalls its own opencode and pi, as wrapper scripts npm won't overwrite. The machine's ssh
	# host keys are kept aside for the post-build (the shared build deletes them).
	remote_build_script boat_build_post /var/log/boxery-boat.ok 'rm -f /usr/local/bin/opencode /usr/local/bin/pi' \
		'rm -rf /root/.boxery-hostkeys; mkdir -m 700 /root/.boxery-hostkeys; cp -p /etc/ssh/ssh_host_* /root/.boxery-hostkeys/' >"$tmp/build.sh" ||
		{ rm -rf "$tmp"; die "could not prepare the build script"; }
	boat_run "$d" 'sudo bash -s' <"$tmp/build.sh" || { rm -rf "$tmp"; die "starting the build on $id failed"; }
	rm -rf "$tmp"
	st=$(remote_build_wait boat_build_run "$d" /var/log/boxery-boat.ok "$BOAT_POLL") || die "build timed out; the builder sandbox $id is still there"
	if [[ $st != ok ]]; then
		boat_run "$d" 'tail -40 /var/log/boxery-build.log' </dev/null >&2 || true
		die "base build failed; the builder sandbox $id is kept for debugging (log /var/log/boxery-build.log)"
	fi
	boat_sync "$d" || die "could not sync $id"
	# Saving the same name replaces it once the new save is ready; VMs made from the old base keep their disks.
	boat_save "$id" "$base" || die "saving the base failed (the build is sandbox $id)"
	boat_delete "$id" || log "warning: could not delete the builder sandbox $id"
	rm -rf "$d"
	log "base image ready: boat saved snapshot $base"
}

backend_has_base() {
	[[ -n $BOAT_PREFIX ]] || return 1
	local s; s=$(boat_saved) || exit 2
	[[ $(boat_saved_status "$(boat_base)" "$s") == ready ]]
}
# Local state first (no API call); a VM that only exists on boat (crash before its state dir) still
# counts, so `rm` can clean it up.
backend_exists() {
	[[ -d $(boat_dir "$1") ]] && return 0
	[[ -n $BOAT_PREFIX ]] || return 1
	local j; j=$(boat_sandboxes) || exit 1
	[[ -n $(boat_vm_ids "$1" "$j") ]]
}

# Per-VM identity, as root over ssh (lib/remote.sh). boat gives every machine its own ssh host keys and
# pins them through the API: keep them.
boat_identity_script() { remote_identity_script "$1" "$2" /usr/local/sbin/boxery-boat-boot.sh keep; }   # USERDATA NAME

backend_new() { # NAME CPUS MEM_MIB DISK_GIB USERDATA_FILE [SOURCE: VM@LABEL image]
	local name=$1 userdata=$5 from=${6:-} d src j type slot id
	[[ -n $BOAT_PREFIX ]] || die "no boat prefix; run: boxery-host init --backend boat"
	[[ $from != stock ]] || die "headless VMs (new --headless) aren't supported on boat yet; run boxery-host build-base and create a desktop VM"
	d=$(boat_dir "$name")
	if [[ -n $from ]]; then
		src=$(boat_img "$from"); [[ -f $BOAT_DIR/images/$src ]] || die "no such image: $from"
	else
		src=$(boat_base)
	fi
	j=$(boat_sandboxes) || exit 1
	[[ -z $(boat_vm_ids "$name" "$j") ]] || die "$name already exists on boat ($(boat_vm_ids "$name" "$j" | head -1))"
	type=$(boat_type_for "$2" "$3" "$4")
	mkdir -p "$BOAT_DIR/vms"
	mkdir "$d" || die "$name already exists"
	slot=$(remote_alloc_slot "$name")
	echo "$type" >"$d/type"
	echo "$(boat_type_size "$type")" >"$d/size"   # CPUS MEM_MIB DISK_GIB, for backend_size
	log "creating $name (boat $type sandbox from ${from:-the base}, 127.0.0.1:$((BOAT_PORT_BASE + slot)))"
	id=$(boat_create vm "$name" "$type" "$src") || die "boat: creating $name failed"
	echo "$id" >"$d/id"
	boat_attach "$d" "$id" || die "$name ($id) never came up"
	# Piped, never written to disk: it carries the proxy token.
	boat_identity_script "$userdata" "$name" | boat_run "$d" 'sudo bash -s' >/dev/null || die "applying $name's identity failed"
	boat_tunnel_write "$name"
	remote_tunnel_start "$name"
}

backend_list() { # → lines: NAME<TAB>STATE<TAB>SSH<TAB>DISK_BYTES<TAB>DISK_USED_BYTES<TAB>TUNNEL
	[[ -n $BOAT_PREFIX ]] || return 0
	local j n st id addr disk tun
	j=$(boat_sandboxes) || exit 1
	jq -r --arg re "^${BOAT_PREFIX}vm-(?<n>.+)$" '.[] | (.name | capture($re)) as $m | select($m) | [$m.n, .state, .id] | @tsv' <<<"$j" |
		while IFS=$'\t' read -r n st id; do
			[[ $n =~ ^[a-z][a-z0-9-]*$ ]] || continue
			[[ ! -f $(boat_dir "$n")/id || $(boat_id "$n") == "$id" ]] || continue   # a reimage's leftover sandbox
			addr="" disk="" tun=""
			# the boat type's disk (boat doesn't report usage): DISK_USED stays unknown
			disk=$(awk '{ print $3 }' "$(boat_dir "$n")/size" 2>/dev/null) || disk=""
			if [[ $disk =~ ^[0-9]+$ ]]; then disk=$((disk * 1073741824)); else disk=""; fi
			[[ ! -f $(boat_dir "$n")/slot ]] || tun=$(remote_tunnel_state "$n")
			case $st in ready | idle | running) st=running ;; archived) st="shut off" ;; archiving) st=stopping ;; init | provision* | cloning) st=starting ;; esac
			if [[ $st == running && $tun == up ]]; then addr="127.0.0.1:$(remote_port "$n")"; fi
			printf '%s\t%s\t%s\t%s\t\t%s\n' "$n" "$st" "$addr" "$disk" "$tun"
		done
}

backend_endpoint_problem() { remote_endpoint_problem "$1"; }   # README: local checks only
backend_ssh_endpoint() { remote_ssh_endpoint "$1"; }
backend_wait_endpoint() { remote_wait_endpoint "$1"; }

# A stopped sandbox comes back on a new machine: wait, re-pin, rewrite the tunnel. A type recorded while
# it was stopped (resize) is applied by the resume.
backend_start() {
	backend_exists "$1" || die "no such vm: $1"
	local d id st body; d=$(boat_dir "$1"); id=$(boat_id "$1")
	st=$(boat_get "$id" | jq -r '.state') || die "cannot read $1 ($id) from boat"
	case $st in
	ready | idle | running | init | provision* | cloning) ;;   # running, or on its way: boat_attach waits
	*)
		[[ $st != archiving ]] || boat_wait_stopped "$id" || die "$1 is still stopping"
		body=$(jq -nc --arg t "$(cat "$d/type.pending" 2>/dev/null)" --argjson ttl "$(boat_ttl)" '{ttlSeconds: $ttl} + (if $t != "" then {type: $t} else {} end)')
		boat_api POST "/sandboxes/$id/resume" "$body" >/dev/null || die "boat: resuming $1 ($id) failed"
		[[ ! -f $d/type.pending ]] || mv "$d/type.pending" "$d/type"
		;;
	esac
	boat_attach "$d" "$id" || die "$1 ($id) never came up"
	boat_tunnel_write "$1"
	remote_tunnel_start "$1"
}
# boat saves the disk and drops the machine: memory and tmpfs (pushed grants) are gone, as after a
# shutdown. sync first: the save reads the disk, not the page cache. Waits until the save is done, so
# a snapshot or fork of the stopped VM has everything.
backend_stop() {
	backend_exists "$1" || die "no such vm: $1"
	local d id st; d=$(boat_dir "$1"); id=$(boat_id "$1")
	remote_tunnel_stop "$1"
	st=$(boat_get "$id" | jq -r '.state') || die "cannot read $1 ($id) from boat"
	[[ $st != archived ]] || return 0
	if [[ $st != archiving ]]; then
		boat_sync "$d" || log "warning: couldn't reach $1 to flush it before stopping"
		boat_api POST "/sandboxes/$id/stop" '{}' >/dev/null || die "boat: stopping $1 ($id) failed"
	fi
	boat_wait_stopped "$id" || die "$1 ($id) did not finish stopping"
	log "note: boat keeps a stopped VM's disk for 14 days; snapshot it (boxery snap) to keep it longer"
}

backend_size() { # → CPUS MEM_MIB DISK_GIB of the VM's boat type
	[[ -f $(boat_dir "$1")/size ]] || die "no recorded size for $1"
	cat "$(boat_dir "$1")/size"
}
# The smallest type that fits; boat changes types on resume only. A running VM is stopped and resumed
# with it (and left running, also on failure); a stopped one gets it at its next start. A type's disk
# comes with it, so without a disk size a VM can move to a smaller type: boat refuses (type_too_small)
# when its data doesn't fit, and the VM stays as it was.
backend_resize() { # NAME CPUS MEM_MIB DISK_GIB (empty = unchanged)
	local d id c m k type cur st; d=$(boat_dir "$1"); id=$(boat_id "$1")
	read -r c m k <"$d/size" || die "no recorded size for $1"
	type=$(boat_type_for "${2:-$c}" "${3:-$m}" "${4:-0}")
	cur=$(cat "$d/type.pending" 2>/dev/null || cat "$d/type")
	[[ $type != "$cur" ]] || { log "$1 is already a boat $type"; return 0; }
	st=$(boat_get "$id" | jq -r '.state') || die "cannot read $1 ($id) from boat"
	echo "$(boat_type_size "$type")" >"$d/size"
	if [[ $st == archived ]]; then echo "$type" >"$d/type.pending"; return 0; fi
	log "stopping $1 to move it to a boat $type"
	remote_tunnel_stop "$1"
	boat_sync "$d" || true
	boat_api POST "/sandboxes/$id/stop" '{}' >/dev/null && boat_wait_stopped "$id" || { backend_start "$1"; die "could not stop $1 to resize it"; }
	if boat_api POST "/sandboxes/$id/resume" "$(jq -nc --arg t "$type" --argjson ttl "$(boat_ttl)" '{type: $t, ttlSeconds: $ttl}')" >/dev/null; then
		echo "$type" >"$d/type"; rm -f "$d/type.pending"
	else
		echo "$(boat_type_size "$cur")" >"$d/size"
		backend_start "$1"
		die "boat refused type $type for $1 (it is back on $cur)"
	fi
	boat_attach "$d" "$id" || die "resized $1, but it never came back"
	boat_tunnel_write "$1"
	remote_tunnel_start "$1"
}

# Remove NAME's sandboxes (every generation), tunnel and local state, whatever exists. Idempotent.
boat_destroy() {
	local j id
	j=$(boat_sandboxes) || exit 1
	remote_tunnel_remove "$1"
	for id in $(boat_vm_ids "$1" "$j"); do boat_delete "$id" || die "could not delete boat sandbox $id ($1)"; done
	rm -rf "$(boat_dir "$1")" || die "could not remove $(boat_dir "$1")"
}
backend_rm() { backend_exists "$1" || die "no such vm: $1"; boat_destroy "$1"; }

# ---------------------------------------------------------------- images (see README: disk only)
# A saved snapshot of a running sandbox captures its disk at that moment; the source keeps running.
backend_capture() { # NAME IMAGE
	backend_exists "$1" || die "no such vm: $1"
	local d id img s; d=$(boat_dir "$1"); id=$(boat_id "$1"); img=$(boat_img "$2")
	s=$(boat_saved) || exit 1
	[[ -z $(boat_saved_status "$img" "$s") ]] || die "image $2 exists"
	mkdir -p "$BOAT_DIR/images"
	# Recorded first: an interrupted save is still found (and removed) by cleanup_image.
	printf '%s\t%s\n' "$2" "$(awk '{print $3}' "$d/size")" >"$BOAT_DIR/images/$img"
	[[ $(boat_get "$id" | jq -r '.state') == archived ]] || boat_sync "$d" || log "warning: couldn't sync $1's filesystems; $2 is crash-consistent"
	boat_save "$id" "$img" || { rm -f "$BOAT_DIR/images/$img"; die "saving $1 as $2 failed"; }
}
backend_images() { # → IMAGE<TAB>CREATED<TAB>SIZE
	[[ -n $BOAT_PREFIX ]] || return 0
	local s n st c f i k
	s=$(boat_saved) || exit 1
	jq -r --arg p "${BOAT_PREFIX}i-" '.[] | select(.name | startswith($p)) | [.name, .status, ((.createdAt // "") | tostring | .[0:19])] | @tsv' <<<"$s" |
		while IFS=$'\t' read -r n st c; do
			f=$BOAT_DIR/images/$n
			[[ $st == ready && -f $f ]] || continue
			IFS=$'\t' read -r i k <"$f"
			[[ $k =~ ^[0-9]{1,5}$ ]] && k="${k}GiB" || k=""
			printf '%s\t%s\t%s\n' "$i" "$c" "$k"
		done
}
backend_image_rm() {
	local img s; img=$(boat_img "$1")
	s=$(boat_saved) || exit 1
	[[ -n $(boat_saved_status "$img" "$s") ]] || die "no such image: $1"
	boat_api DELETE "/saved-snapshots/$img" >/dev/null || die "could not remove image $1"
	rm -f "$BOAT_DIR/images/$img"
}

# NAME IMAGE: a new sandbox from the image, same type, slot and tunnel port; ends running. Idempotent:
# a retry makes a fresh sandbox and deletes every other generation, the old VM and any sandbox an
# interrupted run left behind.
backend_reimage() {
	backend_exists "$1" || die "no such vm: $1"
	local d img j new v type; d=$(boat_dir "$1"); img=$(boat_img "$2")
	[[ -f $BOAT_DIR/images/$img ]] || die "no such image: $2"
	j=$(boat_sandboxes) || exit 1
	# The image may come from before a resize: keep the VM's own type.
	type=$(cat "$d/type.pending" 2>/dev/null || cat "$d/type")
	# Create first, switch after: a failed create leaves the VM as it was.
	new=$(boat_create vm "$1" "$type" "$img") || die "creating $1 from $2 failed"
	remote_tunnel_stop "$1"
	echo "$new" >"$d/id.tmp" && mv "$d/id.tmp" "$d/id" || die "could not record $1's new sandbox $new"
	echo "$type" >"$d/type"; rm -f "$d/type.pending"
	for v in $(boat_vm_ids "$1" "$j"); do   # j predates the create: all of these are old
		boat_delete "$v" || log "warning: could not delete $1's old sandbox $v"
	done
	boat_attach "$d" "$new" || die "$1 ($new) never came up"
	boat_tunnel_write "$1"
	remote_tunnel_start "$1"
}

# ---------------------------------------------------------------- crash recovery (README: idempotent)
backend_cleanup_new() { # NAME: remove a VM whose create was interrupted, whatever got created
	[[ -n $BOAT_PREFIX ]] || { rm -rf "$(boat_dir "$1")"; return 0; }
	boat_destroy "$1"
	remote_clear_stale_slot_lock
}
backend_cleanup_image() { # IMAGE: saved or still saving
	[[ -n $BOAT_PREFIX ]] || return 0
	local s img; img=$(boat_img "$1")
	s=$(boat_saved) || exit 1
	if [[ -n $(boat_saved_status "$img" "$s") ]]; then boat_api DELETE "/saved-snapshots/$img" >/dev/null || die "could not remove image $1"; fi
	rm -f "$BOAT_DIR/images/$img"
}
# A save never changes the source, so there is nothing to restore.
backend_recover_capture() { backend_cleanup_image "$2"; }
