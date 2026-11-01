#!/usr/bin/env bash
# Run all offline shell tests, in parallel. BASH_UNDER_TEST=/path/to/bash runs them under another bash
# (e.g. 3.2); JOBS=N caps how many run at once (default: the CPU count). Each test's output is printed
# whole once it finishes, in list order. Tests must keep their state in their own mktemp -d.
# This script itself runs under bash 3.2 on macOS, so no wait -n: it polls for finished tests.
set -euo pipefail
cd "$(dirname "$0")"
B=${BASH_UNDER_TEST:-bash}
JOBS=${JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)}
[ "$JOBS" -ge 1 ] || JOBS=1
tests=()
# Slowest first, so a long test doesn't start last.
for t in host-exe-backend.sh host-dispatcher.sh controller-local.sh host-leases.sh host-ch-backend.sh host-boat-backend.sh host-upgrade.sh host-output.sh host-images.sh host-shapes.sh host-init.sh controller-hosts.sh controller-config.sh backend-recovery.sh host-libvirt-backend.sh; do
	[ -f "$t" ] && tests+=("$t")
done
ver=$("$B" -c 'echo $BASH_VERSION')
out=$(mktemp -d)
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$out"' EXIT

# one TEST: run it with its output in $out/TEST.log; $out/TEST.done ("RC SECONDS") appears when it's finished
one() {
	local s rc; s=$(date +%s)
	"$B" "$1" >"$out/$1.log" 2>&1 && rc=0 || rc=$?
	echo "$rc $(($(date +%s) - s))" >"$out/$1.tmp" && mv "$out/$1.tmp" "$out/$1.done"
}
rc=0 next=0 started=0 n=${#tests[@]}
# Print every finished test from $next on, stopping at the first one still running.
flush() {
	local t trc secs
	while [ "$next" -lt "$n" ] && [ -f "$out/${tests[$next]}.done" ]; do
		t=${tests[$next]}; read -r trc secs <"$out/$t.done"
		echo "== $t ($ver, ${secs}s)"; cat "$out/$t.log"
		[ "$trc" = 0 ] || { echo "!! $t exited $trc"; rc=1; }
		next=$((next + 1))
	done
}
running() {
	local c=0 i
	for ((i = next; i < started; i++)); do [ -f "$out/${tests[$i]}.done" ] || c=$((c + 1)); done
	echo "$c"
}
while [ "$next" -lt "$n" ]; do
	if [ "$started" -lt "$n" ] && [ "$(running)" -lt "$JOBS" ]; then
		one "${tests[$started]}" &
		started=$((started + 1))
	else
		flush
		if [ "$next" -lt "$n" ]; then sleep 0.1; fi
	fi
done
exit $rc
