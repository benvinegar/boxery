#!/usr/bin/env bash
# Run one hypervisor backend function: host/backend.sh FUNCTION [ARG...]
# Sources host/backends/$BOXERY_BACKEND.sh into the prelude below, which is everything a backend may use
# from the host: die, log, need, wait_ssh, vm_ssh_cmd, ROOT, CACHE, PROXY_PORT, SSH_OPTS. FUNCTION must
# be a backend contract function (host/backends/README.md). Arguments stay argv; nothing is evaluated.
#   host/backend.sh __functions             contract functions this backend defines, one per line
#   host/backend.sh __connect NAME [PORT]   stdio to the VM's sshd (the ssh ProxyCommand; never starts Node)
#   host/backend.sh __layer_files           image/layers as cloud-config write_files entries (for seeds)
# Called by host/backend.mjs, and by host/boxery-host for connect.
set -euo pipefail

resolve() { local p=$1; while [ -L "$p" ]; do local t; t=$(readlink "$p"); case $t in /*) p=$t ;; *) p=$(dirname "$p")/$t ;; esac; done; echo "$p"; }  # macOS has no readlink -f
ROOT=$(cd "$(dirname "$(resolve "$0")")/.." && pwd)
CONF=${BOXERY_CONF:-$HOME/.config/boxery}
# Settings persisted by `init`. Explicit env vars win over the file. Same list as HOST_ENV in host/config.mjs.
if [ -f "$CONF/host.env" ]; then
	while IFS='=' read -r k v; do
		case $k in BOXERY_BACKEND | BOXERY_PROXY_PORT | BOXERY_PROXY_UNIT | BOXERY_POOL | BOXERY_POOL_DIR | BOXERY_BASE_VOL | BOXERY_DOMAIN_PREFIX | BOXERY_NET | BOXERY_NET_ISOLATION | LIBVIRT_DEFAULT_URI | LIMA_HOME | BOXERY_LIMA_PREFIX | BOXERY_LIMA_GATEWAY | BOXERY_LIMA_VMTYPE | BOXERY_LIMA_ARCH | BOXERY_CH_DIR | BOXERY_CH_NET | BOXERY_CH_DNS | BOXERY_CH_FIRMWARE | BOXERY_CH_SUDO | BOXERY_EXE_DIR | BOXERY_EXE_PREFIX | BOXERY_EXE_KEY | BOXERY_EXE_PORT_BASE | BOXERY_EXE_GUEST_PORT | BOXERY_EXE_EGRESS | BOXERY_EXE_POOL | BOXERY_EXE_MAX_CPUS | BOXERY_EXE_MAX_MEM | BOXERY_BOAT_DIR | BOXERY_BOAT_PREFIX | BOXERY_BOAT_API | BOXERY_BOAT_ORG | BOXERY_BOAT_PORT_BASE | BOXERY_BOAT_GUEST_PORT | BOXERY_BOAT_MAX_TYPE | BOXERY_BOAT_TTL) [ -n "${!k:-}" ] || export "$k=$v" ;; esac
	done <"$CONF/host.env"
fi
export CACHE=${BOXERY_CACHE:-$HOME/.cache/boxery}
# shellcheck disable=SC2034  # read by the sourced backend
PROXY_PORT=${BOXERY_PROXY_PORT:-8088}
BACKEND=${BOXERY_BACKEND:-libvirt}
SSH_OPTS=(-o IdentitiesOnly=yes -o IdentityFile="$CONF/mgmt_ed25519" -o BatchMode=yes -o LogLevel=ERROR -o ConnectTimeout=5)
# ssh to VM NAME checks its pinned host key, like host/guest.mjs (host/hostkeys.mjs). A VM without one
# is refused.
host_key_opts() { # NAME
	[[ $1 =~ ^[a-z][a-z0-9-]{0,30}$ ]] || die "invalid name '$1'"
	printf '%s\n' -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$CONF/host-keys/$1" -o GlobalKnownHostsFile=/dev/null \
		-o "HostKeyAlias=$1.boxery" -o CheckHostIP=no -o UpdateHostKeys=no
}

die() { echo "boxery-host: $*" >&2; exit 1; }
log() { echo "==> $*" >&2; }
need() { command -v "$1" >/dev/null || die "missing dependency: $1"; }
vm_ssh_cmd() { # NAME HOST PORT CMD…   as agent in VM NAME at HOST:PORT
	local n=$1 h=$2 p=$3 k=() l; shift 3
	while IFS= read -r l; do k+=("$l"); done < <(host_key_opts "$n")
	ssh "${SSH_OPTS[@]}" "${k[@]}" -p "$p" "agent@$h" "$@"
}
wait_ssh() { # NAME HOST [PORT]   (tries × 2s; BOXERY_SSH_WAIT_TRIES, default 180 = 6 min)
	for _ in $(seq "${BOXERY_SSH_WAIT_TRIES:-180}"); do vm_ssh_cmd "$1" "$2" "${3:-22}" true 2>/dev/null && return; sleep 2; done
	die "timed out waiting for ssh on $2:${3:-22}"
}

# image/layers: plumbing (every VM) → devtools → desktop, plus their runner. A headless VM's seed and the
# desktop build's cloud-config carry them as write_files entries (indented for a top-level write_files:).
layer_files() {
	local f dst mode
	for f in lib plumbing devtools desktop provision; do
		case $f in
		provision) dst=/usr/local/sbin/boxery-provision mode=0755 ;;
		lib) dst=/usr/local/lib/boxery/layers/lib.sh mode=0644 ;;
		*) dst=/usr/local/lib/boxery/layers/$f.sh mode=0755 ;;
		esac
		printf '  - path: %s\n    permissions: "%s"\n    encoding: b64\n    content: %s\n' "$dst" "$mode" "$(base64 <"$ROOT/image/layers/$f.sh" | tr -d '\n')"
	done
}

f="$ROOT/host/backends/$BACKEND.sh"
[[ -f $f ]] || die "unknown backend '$BACKEND' (have: $(ls "$ROOT/host/backends" | sed -n 's/\.sh$//p' | tr '\n' ' '))"
# shellcheck source=/dev/null
. "$f"

CONTRACT=" backend_check backend_init backend_proxy_services backend_proxy_bind guest_proxy_upstream backend_build_base
	backend_has_base backend_exists backend_new backend_list backend_ssh_endpoint backend_wait_endpoint backend_start backend_stop
	backend_rm backend_size backend_resize backend_capture backend_images backend_image_rm backend_reimage backend_cleanup_new
	backend_cleanup_image backend_recover_capture backend_endpoint_problem backend_host_key backend_platform_host_key "
case ${1:-} in
__layer_files) layer_files ;;
__functions)
	for fn in $CONTRACT; do if declare -F "$fn" >/dev/null; then echo "$fn"; fi; done ;;
__connect)
	n=${2:-}; n=${n%.boxery}; port=${3:-22}
	[[ $n =~ ^[a-z][a-z0-9-]{0,30}$ ]] || die "invalid name '$n' (use [a-z][a-z0-9-]*)"
	ep=$(backend_ssh_endpoint "$n")
	[[ $port == 22 ]] || die "connect: only the ssh port is supported (forward other ports over ssh)"
	exec nc "${ep% *}" "${ep#* }" ;;
*)
	[[ -n ${1:-} && $CONTRACT == *[[:space:]]"$1"[[:space:]]* ]] && declare -F "$1" >/dev/null || die "not a $BACKEND backend function: ${1:-}"
	"$@" ;;
esac
