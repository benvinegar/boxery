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
