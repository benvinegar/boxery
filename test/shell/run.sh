#!/usr/bin/env bash
# Run all offline shell tests. BASH=/path/to/bash to run them under another bash (e.g. 3.2).
set -euo pipefail
cd "$(dirname "$0")"
B=${BASH_UNDER_TEST:-bash}
rc=0
for t in controller-config.sh host-output.sh host-init.sh host-dispatcher.sh backend-recovery.sh host-libvirt-backend.sh host-leases.sh host-images.sh host-shapes.sh host-ch-backend.sh host-exe-backend.sh host-boat-backend.sh host-upgrade.sh controller-local.sh controller-hosts.sh; do
	[ -f "$t" ] || continue
	echo "== $t ($("$B" -c 'echo $BASH_VERSION'))"
	"$B" "$t" || rc=1
done
exit $rc
