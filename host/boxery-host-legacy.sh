#!/usr/bin/env bash
# boxery-host init | build-base | add-key: the commands that have not moved to Node yet
# (docs/plans/2026-11-01-host-orchestration-in-node.md). Called only through host/boxery-host.
set -euo pipefail

resolve() { local p=$1; while [ -L "$p" ]; do local t; t=$(readlink "$p"); case $t in /*) p=$t ;; *) p=$(dirname "$p")/$t ;; esac; done; echo "$p"; }  # macOS has no readlink -f
ROOT=$(cd "$(dirname "$(resolve "$0")")/.." && pwd)
CONF=${BOXERY_CONF:-$HOME/.config/boxery}
export CACHE=${BOXERY_CACHE:-$HOME/.cache/boxery}   # used by backends
# Settings persisted by `init` (backend, proxy port/unit). Explicit env vars win over the file.
if [ -f "$CONF/host.env" ]; then
	while IFS='=' read -r k v; do
		case $k in BOXERY_BACKEND | BOXERY_PROXY_PORT | BOXERY_PROXY_UNIT | BOXERY_POOL | BOXERY_POOL_DIR | BOXERY_BASE_VOL | BOXERY_DOMAIN_PREFIX | BOXERY_LIMA_PREFIX | BOXERY_CH_DIR | BOXERY_CH_NET | BOXERY_CH_DNS | BOXERY_CH_FIRMWARE | BOXERY_CH_SUDO | BOXERY_EXE_DIR | BOXERY_EXE_PREFIX | BOXERY_EXE_KEY | BOXERY_EXE_PORT_BASE | BOXERY_EXE_GUEST_PORT | BOXERY_EXE_EGRESS | BOXERY_EXE_POOL | BOXERY_EXE_MAX_CPUS | BOXERY_EXE_MAX_MEM) [ -n "${!k:-}" ] || export "$k=$v" ;; esac
	done <"$CONF/host.env"
fi
PROXY_PORT=${BOXERY_PROXY_PORT:-8088}
BACKEND=${BOXERY_BACKEND:-libvirt}
PROXY_UNIT=${BOXERY_PROXY_UNIT:-boxery-proxy}   # override to run a second boxery install side by side

die() { echo "boxery-host: $*" >&2; exit 1; }
log() { echo "==> $*" >&2; }
need() { command -v "$1" >/dev/null || die "missing dependency: $1"; }
NODE=(node --disable-warning=ExperimentalWarning)   # node:sqlite is still flagged experimental on Node 22
MGMT_KEY=$CONF/mgmt_ed25519   # host's own passwordless key for managing VMs (works without an ssh-agent)
host_pubkey() {
	[[ -f $MGMT_KEY ]] || ssh-keygen -q -t ed25519 -N "" -C "boxery-host@$(hostname)" -f "$MGMT_KEY"
	cat "$MGMT_KEY.pub"
}
load_backend() {
	local f="$ROOT/host/backends/$BACKEND.sh"
	[[ -f $f ]] || die "unknown backend '$BACKEND' (have: $(ls "$ROOT/host/backends" | sed -n 's/\.sh$//p' | tr '\n' ' '))"
	# shellcheck source=/dev/null
	. "$f"
}
ensure_tokens() { mkdir -p "$CONF"; chmod 700 "$CONF"; [[ -f $CONF/tokens.json ]] || echo '{}' >"$CONF/tokens.json"; chmod 600 "$CONF/tokens.json"; }

# LLM proxy + backend's guest bridge: systemd user units on Linux, launchd agents on macOS.
start_proxy_services() {
	local node; node=$(command -v node)
	if [[ $(uname) == Darwin ]]; then
		mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
		local plist=$HOME/Library/LaunchAgents/dev.$PROXY_UNIT.plist
		cat >"$plist" <<-EOF
			<?xml version="1.0" encoding="UTF-8"?>
			<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
			<plist version="1.0"><dict>
			  <key>Label</key><string>dev.$PROXY_UNIT</string>
			  <key>ProgramArguments</key><array><string>$node</string><string>$ROOT/proxy/boxery-proxy.mjs</string></array>
			  <key>EnvironmentVariables</key><dict><key>BOXERY_PROXY_PORT</key><string>$PROXY_PORT</string><key>BOXERY_PROXY_BIND</key><string>$(proxy_bind)</string><key>BOXERY_CONF</key><string>$CONF</string></dict>
			  <key>KeepAlive</key><true/><key>RunAtLoad</key><true/>
			  <key>StandardOutPath</key><string>$HOME/Library/Logs/$PROXY_UNIT.log</string>
			  <key>StandardErrorPath</key><string>$HOME/Library/Logs/$PROXY_UNIT.log</string>
			</dict></plist>
		EOF
		launchctl bootout "gui/$(id -u)/dev.$PROXY_UNIT" 2>/dev/null || true
		launchctl bootstrap "gui/$(id -u)" "$plist"
	else
		mkdir -p "$HOME/.config/systemd/user"
		cat >"$HOME/.config/systemd/user/$PROXY_UNIT.service" <<-EOF
			[Unit]
			Description=boxery LLM proxy (per-VM tokens -> host credentials)
			[Service]
			Environment=BOXERY_PROXY_PORT=$PROXY_PORT
			Environment=BOXERY_PROXY_BIND=$(proxy_bind)
			Environment=BOXERY_CONF=$CONF
			ExecStart=$node $ROOT/proxy/boxery-proxy.mjs
			Restart=always
			RestartSec=2
			[Install]
			WantedBy=default.target
		EOF
		local extra; extra=$(backend_proxy_services)
		systemctl --user daemon-reload
		systemctl --user enable --now "$PROXY_UNIT.service" $extra >/dev/null
		systemctl --user restart "$PROXY_UNIT.service" $extra
	fi
	sleep 1
}
# Reaper: resets expired/orphaned leases every minute.
REAPER_UNIT=${BOXERY_REAPER_UNIT:-${PROXY_UNIT/proxy/reaper}}
start_reaper() {
	local env="BOXERY_CONF=$CONF BOXERY_BACKEND=$BACKEND"
	if [[ $(uname) == Darwin ]]; then
		local plist=$HOME/Library/LaunchAgents/dev.$REAPER_UNIT.plist
		cat >"$plist" <<-EOF
			<?xml version="1.0" encoding="UTF-8"?>
			<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
			<plist version="1.0"><dict>
			  <key>Label</key><string>dev.$REAPER_UNIT</string>
			  <key>ProgramArguments</key><array><string>$ROOT/host/boxery-host</string><string>reap</string></array>
			  <key>EnvironmentVariables</key><dict><key>BOXERY_CONF</key><string>$CONF</string><key>PATH</key><string>$(dirname "$(command -v node)"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
			  <key>StartInterval</key><integer>60</integer>
			  <key>StandardOutPath</key><string>$HOME/Library/Logs/$REAPER_UNIT.log</string>
			  <key>StandardErrorPath</key><string>$HOME/Library/Logs/$REAPER_UNIT.log</string>
			</dict></plist>
		EOF
		launchctl bootout "gui/$(id -u)/dev.$REAPER_UNIT" 2>/dev/null || true
		launchctl bootstrap "gui/$(id -u)" "$plist"
	else
		cat >"$HOME/.config/systemd/user/$REAPER_UNIT.service" <<-EOF
			[Unit]
			Description=boxery: reset expired/orphaned leases
			[Service]
			Type=oneshot
			Environment=$env PATH=$(dirname "$(command -v node)"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
			ExecStart=$ROOT/host/boxery-host reap
		EOF
		cat >"$HOME/.config/systemd/user/$REAPER_UNIT.timer" <<-EOF
			[Unit]
			Description=boxery: lease reaper every minute
			[Timer]
			OnBootSec=1min
			OnUnitActiveSec=1min
			AccuracySec=10s
			[Install]
			WantedBy=timers.target
		EOF
		systemctl --user daemon-reload
		systemctl --user enable --now "$REAPER_UNIT.timer" >/dev/null
	fi
}

proxy_bind() { if declare -F backend_proxy_bind >/dev/null; then backend_proxy_bind; else echo 127.0.0.1; fi; }

cmd_init() {
	need jq; need node; need nc; need ps
	"${NODE[@]}" -e 'require("node:sqlite")' 2>/dev/null || die "node $(node --version) lacks node:sqlite; need Node >= 22.13"
	backend_check
	ensure_tokens
	touch "$CONF/authorized_keys"; chmod 600 "$CONF/authorized_keys"
	host_pubkey >/dev/null
	[[ -f $CONF/proxy.env ]] || cat >"$CONF/proxy.env" <<-'EOF'
		# Optional upstream API keys for the boxery LLM proxy (stay on the host).
		# ChatGPT/Codex OAuth is read from ~/.pi/agent/auth.json automatically.
		#OPENAI_API_KEY=
		#ANTHROPIC_API_KEY=
	EOF
	chmod 600 "$CONF/proxy.env"
	{
		printf 'BOXERY_BACKEND=%s\nBOXERY_PROXY_PORT=%s\nBOXERY_PROXY_UNIT=%s\n' "$BACKEND" "$PROXY_PORT" "$PROXY_UNIT"
		printf 'BOXERY_NODE=%s\n' "$(command -v node)"   # host/boxery-host runs this node (PATH may lack it over ssh)
		for k in BOXERY_POOL BOXERY_POOL_DIR BOXERY_BASE_VOL BOXERY_DOMAIN_PREFIX BOXERY_LIMA_PREFIX BOXERY_CH_DIR BOXERY_CH_NET BOXERY_CH_DNS BOXERY_CH_FIRMWARE BOXERY_EXE_DIR BOXERY_EXE_PREFIX BOXERY_EXE_KEY BOXERY_EXE_PORT_BASE BOXERY_EXE_GUEST_PORT BOXERY_EXE_EGRESS BOXERY_EXE_POOL BOXERY_EXE_MAX_CPUS BOXERY_EXE_MAX_MEM; do [ -z "${!k:-}" ] || printf '%s=%s\n' "$k" "${!k}"; done
		[ -z "${BOXERY_CH_SUDO+x}" ] || printf 'BOXERY_CH_SUDO=%s\n' "$BOXERY_CH_SUDO"   # "" (run as root) is a real value
	} >"$CONF/host.env"
	backend_init
	mkdir -p "$HOME/.local/bin" "$HOME/.config/systemd/user"
	if [[ -z ${BOXERY_CONF:-} ]]; then
		ln -sf "$ROOT/host/boxery-host" "$HOME/.local/bin/boxery-host"
		ln -sf "$ROOT/controller/boxery" "$HOME/.local/bin/boxery"
	fi
	start_proxy_services
	[[ -n ${BOXERY_NO_SERVICES:-} ]] || start_reaper
	log "init done. Next: boxery-host build-base"
}

cmd_add_key() { # pubkey on stdin
	mkdir -p "$CONF"; touch "$CONF/authorized_keys"
	local k; k=$(cat)
	[[ $k == ssh-* || $k == ecdsa-* ]] || die "expected an ssh public key on stdin"
	grep -qxF "$k" "$CONF/authorized_keys" || echo "$k" >>"$CONF/authorized_keys"
	log "key registered ($(wc -l <"$CONF/authorized_keys") total)"
}

# image/layers: plumbing (every VM) → devtools → desktop. The desktop base build applies all three.
layer_files() { # → write_files list entries (indented for a top-level write_files:)
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
# The desktop build's cloud-config: image/base-user-data.yaml with the layers at its marker line.
base_userdata() { # → path
	local out=$CACHE/base-user-data.yaml line
	mkdir -p "$CACHE"
	while IFS= read -r line; do
		if [[ $line == "  # @boxery-layers" ]]; then layer_files || die "could not read image/layers"; else printf '%s\n' "$line"; fi
	done <"$ROOT/image/base-user-data.yaml" >"$out.tmp" || die "could not write $out"
	mv "$out.tmp" "$out"
	echo "$out"
}
# BASE_USERDATA: the desktop build's cloud-config, for backend_build_base.
cmd_build_base() { backend_check; BASE_USERDATA=$(base_userdata); export BASE_USERDATA; backend_build_base; }

load_backend
case ${1:-} in
init)
	if [[ ${2:-} == --backend ]]; then BACKEND=$3; load_backend; fi
	cmd_init ;;
build-base) cmd_build_base ;;
add-key) cmd_add_key ;;
*) die "not a legacy command: ${1:-} (run boxery-host help)" ;;
esac
