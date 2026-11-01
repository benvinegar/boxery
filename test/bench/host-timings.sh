#!/usr/bin/env bash
# Wall-clock timings of common boxery-host commands against the fake backend (no VMs, no network).
# Not a pass/fail test: run it before and after a host change to spot startup or process-count
# regressions. bash test/bench/host-timings.sh [ROUNDS]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
H=$ROOT/host/boxery-host
N=${1:-10}
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export BOXERY_CONF=$tmp/conf BOXERY_BACKEND=fake BOXERY_FAKE_DIR=$tmp/vms BOXERY_PROXY_PORT=9999 BOXERY_SSH_WAIT_TRIES=1
mkdir -p "$tmp/bin" "$BOXERY_CONF"
printf '#!/bin/sh\nexit 0\n' >"$tmp/bin/ssh"; chmod +x "$tmp/bin/ssh"
printf '#!/bin/sh\nexit 0\n' >"$tmp/bin/nc"; chmod +x "$tmp/bin/nc"   # connect execs nc; don't open sockets
echo "ssh-ed25519 AAAAtest mgmt" >"$BOXERY_CONF/mgmt_ed25519.pub"; touch "$BOXERY_CONF/mgmt_ed25519"
export PATH="$tmp/bin:$PATH"
KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIleasekeyoneleasekeyone bench"
"$H" build-base >/dev/null 2>&1
"$H" new base >/dev/null 2>&1
"$H" new p1 >/dev/null 2>&1; "$H" pool add p1 >/dev/null 2>&1

# time_it LABEL CMD…: run CMD N times, print the mean in milliseconds
time_it() {
	local label=$1; shift
	local t0 t1; t0=$(node -e 'console.log(Date.now())')
	for _ in $(seq "$N"); do "$@" >/dev/null 2>&1; done
	t1=$(node -e 'console.log(Date.now())')
	printf '%-24s %6d ms\n' "$label" $(((t1 - t0) / N))
}
new_rm() { "$H" new tmpvm && "$H" rm tmpvm; }
snap_rm() { "$H" snap base s && "$H" snap-rm base s; }
lease() { local l; l=$(echo "$KEY" | "$H" acquire --holder bench | awk '{print $2}') && "$H" release "$l"; }

echo "boxery-host timings (fake backend, mean of $N runs)"
time_it "connect" "$H" connect base
time_it "ls --json" "$H" ls --json
time_it "shapes --json" "$H" shapes --json
time_it "pool ls --json" "$H" pool ls --json
time_it "start" "$H" start base
time_it "new + rm" new_rm
time_it "snap + snap-rm" snap_rm
time_it "acquire + release" lease
