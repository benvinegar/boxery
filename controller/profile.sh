#!/usr/bin/env bash
# Shared trusted host-profile and SSH configuration plumbing (Bash 3.2).
# Registry: host-registry/NAME contains one absolute profile directory; default-host contains NAME.
# Every host is a registered NAME; BOXERY_HOME itself is only the registry root.
ROOT_DIR="${BOXERY_HOME:-$HOME/.boxery}"
REGISTRY="$ROOT_DIR/host-registry"
TAB=$(printf '\t')
NL='
'

die() { echo "boxery: $*" >&2; exit 1; }
warn() { echo "boxery: $*" >&2; }
# ---------------------------------------------------------------- JSON output (no jq on the controller)
# Field names are stable; see docs/cli.md. Arrays are printed one element per line, like boxery-host.
json_text() { # STRING → "escaped"  (\ " tab newline escaped; other control characters dropped). For secrets use json_str.
	printf '"%s"' "$(printf '%s' "$1" | LC_ALL=C tr -d '\001-\010\013-\037' |
		sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e "s/$TAB/\\\\t/g" | awk 'NR > 1 { printf "\\n" } { printf "%s", $0 }')"
}
json_str_or_null() { if [ -n "$1" ]; then json_text "$1"; else printf null; fi; }
json_num_or_null() { case $1 in '' | *[!0-9-]*) printf null ;; *) printf '%s' "$1" ;; esac; }
json_array() { # element per line on stdin → JSON array
	awk 'NR == 1 { printf "[\n%s", $0; next } { printf ",\n%s", $0 } END { print (NR ? "\n]" : "[]") }'
}
has_flag() { f=$1; shift; for a in "$@"; do [ "$a" = "$f" ] && return 0; done; return 1; }
# Create lock file PATH or fail if it exists: bash's noclobber open is O_EXCL. Not `mkdir`: uutils
# coreutils (Ubuntu 26.04's mkdir) lets several racing `mkdir DIR` all succeed. Release with rm -f.
take_lock() { (set -C; : >"$1") 2>/dev/null; }

valid_alias() { valid_vm "${1:-}"; }
need_alias() { valid_alias "${1:-}" || die "invalid host name: ${1:-}"; }
# Only an absent path means "no selection"; symlinks (even dangling ones) are metadata.
metadata_present() { [ -e "$1" ] || [ -L "$1" ]; }
# Registry files are regular, readable data files, never shell snippets or symlinks.
one_line() {
	local line extra
	[ -f "$1" ] && [ -r "$1" ] && [ ! -L "$1" ] || die "invalid registry file: $1 (expected readable regular file, not symlink)"
	{ IFS= read -r line && ! IFS= read -r extra && [ -z "$extra" ]; } <"$1" || die "invalid registry file: $1"
	# Bash variables cannot retain NUL bytes. Compare the original bytes, not just the parsed line.
	cmp -s "$1" <(printf '%s\n' "$line") || die "invalid registry file: $1 (noncanonical bytes)"
	printf '%s\n' "$line"
}
# The default host's NAME, or nothing when none is selected.
default_host() {
	metadata_present "$ROOT_DIR/default-host" || return 0
	local name; name=$(one_line "$ROOT_DIR/default-host")
	profile_dir "$name" >/dev/null
	printf '%s\n' "$name"
}
plain_path() { case $1 in *"$NL"*|*"$TAB"*|*$(printf '\r')*) die "paths cannot contain line breaks or tabs" ;; esac; }
profile_dir() {
	need_alias "$1"
	metadata_present "$REGISTRY/$1" || die "unknown host: $1"
	dir=$(one_line "$REGISTRY/$1")
	case $dir in /*) ;; *) die "invalid profile directory for $1" ;; esac
	plain_path "$dir"
	[ -f "$dir/config" ] && [ -f "$dir/ssh_config" ] || die "incomplete profile: $1 ($dir)"
	printf '%s\n' "$dir"
}
# select_profile NAME [DIR]: DIR (MCP/pi pass the directory they resolved) skips the registry lookup.
select_profile() {
	selected=${1:-}
	if [ -z "$selected" ]; then selected=$(default_host); fi
	[ -n "$selected" ] || die "no host configured; run: boxery setup user@host|local (or boxery host use NAME)"
	if [ -n "${2:-}" ]; then
		CONF_DIR=$2
		case $CONF_DIR in /*) ;; *) die "invalid profile directory: $CONF_DIR" ;; esac
		plain_path "$CONF_DIR"
	else CONF_DIR=$(profile_dir "$selected"); fi
	set_profile_paths "$CONF_DIR"
	# Configs are trusted, user-owned shell files. Never source registry pointers as shell code.
	# shellcheck source=/dev/null
	[ ! -f "$CONF_FILE" ] || . "$CONF_FILE"
}
set_profile_paths() {
	CONF_DIR=$1; CONF_FILE="$1/config"; SSH_CONF="$1/ssh_config"; GRANTS_DIR="$1/grants"; LEASES_DIR="$1/leases"
	HOST=""; HOST_BIN='~/.local/bin/boxery-host'; HOST_PROFILE=""; IDENTITY=""
}
# Literal shell serialization (unlike printf %q, never allows a leading ~ to expand on source).
literal() { local s=$1; s=${s//\'/\'\\\'\'}; printf "'%s'" "$s"; }
valid_dest() { case $1 in ''|-*|*[!A-Za-z0-9_.@:%+-]*) return 1 ;; esac; }
check_target() {
	valid_dest "$HOST" || die "invalid ssh destination: $HOST"
	case $HOST_BIN in ''|-*) die "invalid host executable path" ;; esac
	plain_path "$HOST_BIN"
	[ -z "$HOST_PROFILE" ] || valid_vm "$HOST_PROFILE" || die "invalid host profile: $HOST_PROFILE"
}
# Expand only a leading ~ or ~/, on the remote machine; everything else is literal.
remote_path() { case $1 in '~') printf '"$HOME"' ;; '~/'*) printf '"$HOME"/%s' "$(literal "${1#\~/}")" ;; *) literal "$1" ;; esac; }
remote_bin() { remote_path "$HOST_BIN"; }
# HOST_PROFILE: a second profile on the host (boxery-host --profile NAME), passed as an argument.
profile_args() { [ -z "$HOST_PROFILE" ] || printf ' --profile %s' "$HOST_PROFILE"; }
# argv → one remote command line that the remote shell splits back into exactly these words.
literal_args() { local out="" a; for a in "$@"; do out="$out $(literal "$a")"; done; printf '%s' "${out# }"; }
# Double-quoted local-shell arguments also pass OpenSSH's ProxyCommand quote validator.
shell_double() { local s=$1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//\$/\\\$}; s=${s//\`/\\\`}; printf '"%s"' "$s"; }
ssh_value() { local s=$1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//%/%%}; printf '"%s"' "$s"; }
# One ssh_config argument, for a string whose percents are already escaped.
ssh_word() { local s=$1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; printf '"%s"' "$s"; }
# ProxyCommand goes through a shell, KnownHostsCommand doesn't: ssh splits it into argv itself and
# needs an absolute executable. So run the same command line through /bin/sh, with %H as "$1".
known_hosts_command() { printf '/bin/sh -c %s sh %%H' "$(ssh_word "exec $1 known-hosts \"\$1\"")"; }
# Include applies glob expansion after SSH-config parsing; preserve literal path characters.
ssh_include_value() {
	local s=$1
	s=${s//\\/\\\\}; s=${s//\*/\\*}; s=${s//\?/\\?}; s=${s//\[/\\[}
	ssh_value "$s"
}

valid_snap() { case "${1:-}" in [A-Za-z0-9]*) ;; *) return 1 ;; esac; case "$1" in *[!A-Za-z0-9._-]*) return 1 ;; esac; [ ${#1} -le 64 ]; }
valid_vm() { case "${1:-}" in [a-z]*) ;; *) return 1 ;; esac; case "$1" in *[!a-z0-9-]*) return 1 ;; esac; [ ${#1} -le 31 ]; }
need_vm() { valid_vm "${1:-}" || die "invalid VM name: ${1:-}"; }
valid_image() { case "${1:-}" in *@*) valid_vm "${1%%@*}" && valid_snap "${1#*@}" ;; *) return 1 ;; esac; }
need_host() { [ -n "$HOST" ] || die "host $selected is not configured; run: boxery setup user@host|local --name $selected"; }
# HOST=local: the VM host is this machine (e.g. a Mac running Lima, or the Linux host itself).
is_local() { [ "$HOST" = local ]; }
# shellcheck disable=SC2088  # matching a literal "~/" prefix stored in config
local_host_bin() { case $HOST_BIN in "~/"*) printf '%s\n' "$HOME/${HOST_BIN#\~/}" ;; *) printf '%s\n' "$HOST_BIN" ;; esac; }
# ssh joins argv with spaces and the remote shell re-parses it, so every argument is quoted
# (unquoted snapshot names or flags would be executed on the host). stdin passes through.
h() { host_cmd "" "$@"; }
# h, replacing this shell (Node's core/profile.mjs): a timeout or Ctrl-C there then reaches the host command
# (HOST=local) or the ssh (a remote host; the command on the host keeps running).
h_exec() { host_cmd exec "$@"; }
host_cmd() { # ""|exec ARG...
	local x=$1; shift
	need_host
	check_target
	if is_local; then $x "$(local_host_bin)" ${HOST_PROFILE:+--profile "$HOST_PROFILE"} "$@"
	else $x ssh -o LogLevel=ERROR -- "$HOST" "exec $(remote_bin)$(profile_args) $(literal_args "$@")"; fi
}
vm_ssh() { ssh -F "$SSH_CONF" "$@"; }
# Close the shared (ControlMaster) connection; required after revert/stop/rm or it points at a dead session.
drop_master() { [ -n "${1:-}" ] && ssh -F "$SSH_CONF" -O exit "$1.boxery" >/dev/null 2>&1 || true; }
open_url() {
	if command -v open >/dev/null 2>&1 && [ "$(uname)" = Darwin ]; then open "$1"
	elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 &
	else echo "open: $1"; fi
}
free_port() { # start
	p=$1
	while (echo >/dev/tcp/127.0.0.1/$p) >/dev/null 2>&1; do p=$((p + 1)); done
	echo "$p"
}

# Does the host pin VM host keys (boxery-host known-hosts, #70)? Asked once, then remembered in the
# profile: an older host has no record to check keys against, and strict checking would lock every VM out.
host_pins_keys() {
	[ ! -f "$CONF_DIR/host-pins-keys" ] || return 0
	[ -n "$HOST" ] || return 1
	if h help 2>/dev/null | grep -q '^  known-hosts NAME'; then : >"$CONF_DIR/host-pins-keys"; return 0; fi
	return 1
}
# An ssh_config written before the host pinned keys trusts any VM key: rewrite it once the host does
# (after upgrade-host). Asked at most once a day while the host is older.
refresh_ssh_config() {
	[ -f "$SSH_CONF" ] && [ -n "$HOST" ] || return 0
	# Up to 0.9.0 a remote host's KnownHostsCommand was a shell line ssh can't run (relative `ssh`,
	# shell quoting): every VM failed host key verification. Rewrite those; a host that pins keys stays one.
	if grep -q '^  KnownHostsCommand ' "$SSH_CONF"; then
		grep -q '^  KnownHostsCommand /bin/sh -c ' "$SSH_CONF" || write_ssh_config
		return 0
	fi
	local probe="$CONF_DIR/.host-pins-keys-checked"
	if [ -f "$probe" ] && [ -z "$(find "$probe" -mmin +1440 2>/dev/null)" ]; then return 0; fi
	if host_pins_keys; then write_ssh_config; rm -f "$probe"
	else : >"$probe"; warn "host $selected doesn't pin VM ssh host keys yet, so VM connections aren't verified; run: boxery upgrade-host"; fi
}
write_ssh_config() {
	mkdir -p "$CONF_DIR"
	key="${IDENTITY:-}"
	local pins=""; if host_pins_keys; then pins=1; fi
	{
		echo "# generated by boxery setup — VMs are reached as <name>.boxery through the host"
		# Leased pool VMs: use that lease's own key (IdentitiesOnly so nothing else is offered).
		for lf in "$LEASES_DIR"/*.lease; do
			[ -f "$lf" ] || continue
			ln=$(sed -n 's/^name=//p' "$lf"); li=$(sed -n 's/^id=//p' "$lf")
			echo "Host $ln.boxery"
			echo "  IdentityFile $(ssh_value "$LEASES_DIR/$li.key")"
			echo "  IdentitiesOnly yes"
		done
		# Per-VM ssh-agent grants survive setup regenerating this file. Never forward to the host.
		for gf in "$GRANTS_DIR"/*; do
			[ -f "$gf" ] || continue
			has_grant "${gf##*/}" ssh-agent || continue
			echo "Host ${gf##*/}.boxery"
			echo "  ForwardAgent yes"
		done
		echo "Host *.boxery"
		echo "  ForwardAgent no"
		echo "  User agent"
		if is_local; then proxy="$(shell_double "$(local_host_bin)")$(profile_args)"
		else proxy="ssh -o LogLevel=ERROR -- $(shell_double "$HOST") $(shell_double "exec $(remote_bin)$(profile_args)")"; fi
		# ssh joins remote argv; the entire executable expression survives the local shell as one arg.
		# OpenSSH expands percent tokens before the local shell, so escape user-supplied percents.
		proxy=${proxy//%/%%}
		echo "  ProxyCommand $proxy connect %h %p"
		if [ -n "$pins" ]; then
			# Each VM's host key is pinned on the host (host/hostkeys.mjs) and checked strictly: the host
			# prints the known_hosts line for %H (NAME.boxery, the name ssh matches keys against; nothing
			# for a VM without one, which ssh then refuses). No local known_hosts: a VM's key changes on
			# the host (new, fork, pin), and the host's record is the only one.
			echo "  KnownHostsCommand $(known_hosts_command "$proxy")"
			echo "  StrictHostKeyChecking yes"
			echo "  UserKnownHostsFile none"
			echo "  GlobalKnownHostsFile none"
			echo "  CheckHostIP no"
			echo "  UpdateHostKeys no"
		else
			# A host from before pinned keys: nothing to check against (refresh_ssh_config upgrades this).
			echo "  StrictHostKeyChecking no"
			echo "  UserKnownHostsFile /dev/null"
		fi
		echo "  LogLevel ERROR"
		echo "  ConnectTimeout 15"
		echo "  ServerAliveInterval 10"
		echo "  ServerAliveCountMax 3"
		echo "  ControlMaster auto"
		echo "  ControlPath $(ssh_value "$CONF_DIR/cm-")%h"
		echo "  ControlPersist 10m"
		if [ -n "$key" ]; then echo "  IdentityFile $(ssh_value "$key")"; fi
	} >"$SSH_CONF.tmp.$$"
	# Publish whole: other boxery processes (and ssh -F) read this while grant changes rewrite it.
	mv "$SSH_CONF.tmp.$$" "$SSH_CONF"
}


grant_file() { echo "$GRANTS_DIR/$1"; }
has_grant() { [ -f "$(grant_file "$1")" ] && awk -F'\t' -v k="$2" '$1==k{f=1} END{exit !f}' "$(grant_file "$1")"; }
