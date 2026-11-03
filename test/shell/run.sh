#!/usr/bin/env bash
# Run all offline shell tests. BASH=/path/to/bash to run them under another bash (e.g. 3.2).
set -euo pipefail
cd "$(dirname "$0")"
B=${BASH_UNDER_TEST:-bash}
# A tripwire in front of this machine's launchctl and systemctl: tests stub them (their stubs come first on
# PATH). The real ones act on this account's launchd domain / systemd user manager whatever HOME is, so a
# test that misses a stub would replace the user's own services (one replaced dev.boxery-proxy).
trip=$(mktemp -d); trap 'rm -rf "$trip"' EXIT
for c in launchctl systemctl; do
	command -v "$c" >/dev/null || continue   # absent here: keep it absent
	printf '#!/bin/sh\necho "%s $*" >>"%s/reached"\necho "test reached the real %s (stub it)" >&2\nexit 97\n' "$c" "$trip" "$c" >"$trip/$c"
	chmod +x "$trip/$c"
done
export PATH="$trip:$PATH"
rc=0
for t in controller-config.sh host-output.sh host-init.sh host-dispatcher.sh backend-recovery.sh host-libvirt-backend.sh host-lima-backend.sh host-leases.sh host-images.sh host-shapes.sh host-ch-backend.sh host-exe-backend.sh host-boat-backend.sh host-upgrade.sh controller-local.sh controller-hosts.sh controller-hostkeys.sh; do
	[ -f "$t" ] || continue
	echo "== $t ($("$B" -c 'echo $BASH_VERSION'))"
	"$B" "$t" || rc=1
	if [ -s "$trip/reached" ]; then
		echo "  ✗ $t reached the real service manager:"; sed 's/^/    /' "$trip/reached"; rm "$trip/reached"; rc=1
	fi
done
exit $rc
