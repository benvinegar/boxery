# shellcheck shell=bash
# Helpers shared by the layer scripts. Sourced, never run.

# Install the packages that aren't installed yet. The starting image may already ship them (exeuntu
# ships most dev tools); one `apt-get update` per provisioning run, and only if something is missing.
pkgs() {
	local p missing=()
	for p in "$@"; do dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' || missing+=("$p"); done
	((${#missing[@]})) || return 0
	apt_update_once
	apt-get install -y -q --no-install-recommends "${missing[@]}"
}

# One `apt-get update` per provisioning run (/run is a tmpfs: the next boot starts over).
apt_update_once() {
	[ -e /run/boxery-apt-updated ] || { apt-get update -qq && touch /run/boxery-apt-updated; }
}

# The hash of a VM's layer files, as boxery-host computes it from its own copy (host/build-info.mjs,
# layersHash): one "SHA256  NAME" line for lib, provision and each LAYER, in that order, hashed again.
# A host whose layers differ from the ones a VM was built with lists that VM as outdated.
layers_hash() { # DIR PROVISION LAYER...
	local d=$1 p=$2 l
	shift 2
	{
		printf '%s  lib\n' "$(sha256sum <"$d/lib.sh" | cut -d' ' -f1)"
		printf '%s  provision\n' "$(sha256sum <"$p" | cut -d' ' -f1)"
		for l in "$@"; do printf '%s  %s\n' "$(sha256sum <"$d/$l.sh" | cut -d' ' -f1)" "$l"; done
	} | sha256sum | cut -d' ' -f1
}

# What a VM was built with, as key=value lines (host/build-info.mjs parses them): when, which layers
# (and their hash), the kernel it boots (the newest installed), and the desktop's browser and
# playwright-core. Written last by boxery-provision; `boxery ls` compares it with the host's layers.
build_info() { # DIR PROVISION LAYER...
	local d=$1 p=$2 k pw
	shift 2
	k=$(find /lib/modules -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null | sort -V | tail -1) || k=
	echo "built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	echo "layers=$*"
	echo "layers_hash=$(layers_hash "$d" "$p" "$@")"
	echo "kernel=${k:-$(uname -r)}"
	case " $* " in *" desktop "*)
		echo "chrome=$(google-chrome --version 2>/dev/null | head -1)"
		pw=/opt/boxery/node_modules/playwright-core/package.json
		echo "playwright_core=$(node -p "require('$pw').version" 2>/dev/null)" ;;
	esac
}
