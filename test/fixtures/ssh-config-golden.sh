#!/usr/bin/env bash
# Render ssh_config with the Bash controller's write_ssh_config (controller/profile.sh) for each case
# test/ssh-config.test.mjs checks core/ssh-config.mjs against.
#   bash test/fixtures/ssh-config-golden.sh ROOT OUT_DIR   (re)write OUT_DIR/CASE.{case,ssh_config}
#   bash test/fixtures/ssh-config-golden.sh ROOT -         print each as "=== CASE" + its ssh_config,
#                                                          then "=== CASE (node)": core/profile.mjs's
#                                                          writeSshConfig for the same profile directory
# Temp paths print as @BASE@, $HOME as @HOME@.
set -eu
export LC_ALL=C  # glob order, as Node sorts
ROOT=$1 OUT=$2 NODE=${NODE:-node}
[ "$OUT" = - ] || mkdir -p "$OUT"
render() { # CASE HOST HOST_BIN HOST_PROFILE IDENTITY PINS DIRNAME LEASES GRANTS
	local c=$1 base; base=$(mktemp -d)
	local dir="$base/$7"; mkdir -p "$dir/leases" "$dir/grants"
	if [ "$6" = 1 ]; then : >"$dir/host-pins-keys"; fi
	for l in $8; do printf 'name=%s\nid=%s\nexpires=1\nttl=600\nholder=h\n' "${l%%:*}" "${l#*:}" >"$dir/leases/${l#*:}.lease"; done
	for g in $9; do printf '%s\n' "${g#*=}" | tr '|' '\t' >"$dir/grants/${g%%=*}"; done
	(
		export BOXERY_HOME=$base/home
		# shellcheck source=/dev/null
		. "$ROOT/controller/profile.sh"
		set_profile_paths "$dir"
		# shellcheck disable=SC2034  # read by profile.sh
		HOST=$2 HOST_BIN=$3 HOST_PROFILE=$4 IDENTITY=$5 selected=x
		h() { return 1; }  # host_pins_keys: only the marker file decides
		write_ssh_config
	)
	if [ "$OUT" = - ]; then
		printf '=== %s\n' "$c"; sed -e "s#$base#@BASE@#g" -e "s#$HOME#@HOME@#g" "$dir/ssh_config"
		# The same profile from Node: config as setup writes it, entries read from the same files.
		local q="'\\''"
		{ printf "HOST='%s'\nHOST_BIN='%s'\nIDENTITY='%s'\n" "${2//\'/$q}" "${3//\'/$q}" "${5//\'/$q}"
			if [ -n "$4" ]; then printf "HOST_PROFILE='%s'\n" "$4"; fi
			# A computed config is sourced, not parsed: that path renders the same file too.
			if [ "$c" = remote-profile ]; then printf 'P=%s\nHOST_PROFILE=$P\n' "$4"; fi; } >"$dir/config"
		mkdir -p "$base/home/host-registry"; printf '%s\n' "$dir" >"$base/home/host-registry/x"
		# As in the Bash render, the host is never asked whether it pins keys (h fails): only the marker counts.
		mkdir -p "$base/bin"; printf '#!/bin/sh\nexit 1\n' >"$base/bin/ssh"; chmod +x "$base/bin/ssh"
		PATH="$base/bin:$PATH" HOME=$HOME BOXERY_HOME=$base/home "$NODE" --input-type=module -e '
			const core = await import(process.argv[1] + "/core/boxery-core.mjs"), p = await import(process.argv[1] + "/core/profile.mjs");
			await p.writeSshConfig({ host: core.resolveHost("x") });' "$ROOT"
		printf '=== %s (node)\n' "$c"; sed -e "s#$base#@BASE@#g" -e "s#$HOME#@HOME@#g" "$dir/ssh_config"
	else
		sed -e "s#$base#@BASE@#g" -e "s#$HOME#@HOME@#g" "$dir/ssh_config" >"$OUT/$c.ssh_config"
		printf '%s\n' "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" >"$OUT/$c.case"
	fi
	rm -rf "$base"
}
L1=l-0123456789abcdef0123456789abcdef L2=l-fedcba9876543210fedcba9876543210
# shellcheck disable=SC2088  # literal ~ paths, as config stores them
{
render local-plain local '~/.local/bin/boxery-host' '' '' 1 p '' ''
render local-abs local '/opt/boxery/host/boxery-host' '' '/home/u/.ssh/id_ed25519' 1 p '' ''
render local-nopins local '~/.local/bin/boxery-host-absent' '' '' 0 p '' ''
render remote-plain 'ben@hornet' '~/.local/bin/boxery-host' '' '/home/u/.ssh/id_ed25519' 1 p '' ''
render remote-profile 'hornet' '~/.local/bin/boxery-host' 'iso' '' 1 p '' ''
render remote-nopins 'ben@hornet.example' '~/bin/boxery host' '' '' 0 p '' ''
render quoting 'u%x@h' "~/it's \"q\" \$x \`y\` \\z%p" 'p2' "/k/it's %h \"q\"" 1 'dir with space%' '' ''
render leases-grants local '~/.local/bin/boxery-host' '' '/k/id' 1 p "pool-1:$L1 pool-2:$L2" 'demo=ssh-agent||  w1=env|TOKEN|  w2=ssh-agent||'
render grants-noagent 'h' '/usr/bin/boxery-host' '' '' 1 p '' 'w3=file|/a|project/a'
render local-tilde-only local '~' '' '' 1 p '' ''
}
