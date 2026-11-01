#!/usr/bin/env bash
# Lima backend: loopback confinement (#67). Every start goes through sandbox-exec with a Seatbelt profile
# that lets the host agent reach only the proxy and the instance's own ssh port on the host's loopback.
# limactl and sandbox-exec are command doubles; on macOS the generated profile is also run for real
# against two loopback listeners (no VMs).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d); lsn=""
trap '[[ -z $lsn ]] || kill "$lsn" 2>/dev/null || true; rm -rf "$tmp"' EXIT
export BOXERY_CONF=$tmp/conf BOXERY_BACKEND=lima BOXERY_PROXY_PORT=9999 BOXERY_LIMA_PREFIX=boxery- CALLS=$tmp/calls.log STATE=$tmp/lima
mkdir -p "$tmp/bin" "$BOXERY_CONF" "$STATE"; : >"$CALLS"

stub() { printf '#!/usr/bin/env bash\n%s\n' "$2" >"$tmp/bin/$1"; chmod +x "$tmp/bin/$1"; }
# Instances are directories in $STATE holding their vmType and status.
stub limactl 'echo "limactl $*" >>"$CALLS"
case $1 in
list) for d in "$STATE"/*; do [[ -d $d ]] || continue; printf "{\"name\":\"%s\",\"status\":\"%s\",\"vmType\":\"%s\"}\n" "${d##*/}" "$(cat "$d/status")" "$(cat "$d/vmtype")"; done ;;
start) echo Running >"$STATE/$2/status" ;;
esac'
# sandbox-exec -p PROFILE CMD…: keep the profile, run CMD.
stub sandbox-exec 'echo "sandbox-exec $3" >>"$CALLS"; printf "%s" "$2" >"$STATE/profile"; shift 2; exec "$@"'
export PATH="$tmp/bin:$PATH"
inst() { mkdir -p "$STATE/boxery-$1"; echo "$2" >"$STATE/boxery-$1/vmtype"; echo "$3" >"$STATE/boxery-$1/status"; }
B=$ROOT/host/backend.sh

pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }

# --- confined start (vz)
inst v1 vz Stopped
BOXERY_LIMA_CONFINE=1 "$B" backend_start v1 && ok "backend_start (confined)" || bad "backend_start failed: $(cat "$CALLS")"
line=$(grep '^limactl start ' "$CALLS" || true)
port=$(sed -n 's/.*--ssh-port \([0-9][0-9]*\).*/\1/p' <<<"$line")
[[ $line == "limactl start boxery-v1 --tty=false --ssh-port $port --timeout 10m" && -n $port ]] && ok "limactl start pins a fresh ssh port ($port)" || bad "start: $line"
grep -q '^sandbox-exec limactl$' "$CALLS" && ok "limactl runs under sandbox-exec" || bad "sandbox-exec: $(cat "$CALLS")"
P=$STATE/profile
grep -qF '(deny network-outbound (remote ip "localhost:*"))' "$P" && ok "profile denies outbound connections to loopback" || bad "profile: $(cat "$P")"
grep -qF '(allow network-outbound (remote ip "localhost:9999"))' "$P" && ok "…except the proxy port" || bad "proxy allow: $(cat "$P")"
grep -qF "(allow network-outbound (remote ip \"localhost:$port\"))" "$P" && ok "…and the instance's own ssh port" || bad "ssh allow: $(cat "$P")"
[[ $(grep -c 'network-outbound' "$P") == 3 ]] && ok "nothing else on loopback is allowed" || bad "rules: $(cat "$P")"
[[ $(grep -n 'deny network-outbound' "$P" | cut -d: -f1) -lt $(grep -n 'allow network-outbound' "$P" | head -1 | cut -d: -f1) ]] && ok "the deny precedes the allows (later rules win)" || bad "rule order: $(cat "$P")"
! grep -q -- '--dns' "$CALLS" && ok "vz keeps Lima's DNS (answered inside gvisor)" || bad "vz got --dns"

# --- qemu: DNS must not go to the host agent's loopback resolver
: >"$CALLS"; inst q1 qemu Stopped
BOXERY_LIMA_CONFINE=1 "$B" backend_start q1 && grep -q '^limactl start boxery-q1 --tty=false --ssh-port [0-9]* --dns 192.168.5.3 --timeout 10m$' "$CALLS" &&
	ok "qemu uses slirp's DNS forwarder (192.168.5.3), not the host agent's" || bad "qemu start: $(cat "$CALLS")"

# --- already running: nothing to start
: >"$CALLS"; inst r1 vz Running
BOXERY_LIMA_CONFINE=1 "$B" backend_start r1 && ! grep -q 'start\|sandbox-exec' "$CALLS" && ok "a running instance is left alone" || bad "running: $(cat "$CALLS")"

# --- confinement off (Linux)
: >"$CALLS"; inst v2 vz Stopped
BOXERY_LIMA_CONFINE=0 "$B" backend_start v2 && grep -q '^limactl start boxery-v2 --timeout 10m$' "$CALLS" && ! grep -q sandbox-exec "$CALLS" &&
	ok "unconfined start is plain limactl start" || bad "unconfined: $(cat "$CALLS")"

# --- every limactl start in the backend goes through lima_start (its own two: confined and not)
n=$(grep -c 'limactl start "\$' "$ROOT/host/backends/lima.sh")
[[ $n == 2 ]] && ok "no limactl start bypasses lima_start" || bad "$n limactl start call sites in lima.sh"

# --- backend_check requires sandbox-exec only when confining
for c in 1 0; do
	got=$(BOXERY_LIMA_CONFINE=$c bash -c 'die() { exit 1; }; log() { :; }; need() { echo "$1"; }; . "$1/host/backends/lima.sh"; backend_check' _ "$ROOT" | tr '\n' ' ')
	if [[ $c == 1 && $got == *sandbox-exec* ]] || [[ $c == 0 && $got != *sandbox-exec* ]]; then ok "backend_check (confine=$c) needs: $got"; else bad "backend_check (confine=$c) needs: $got"; fi
done

# --- the profile against the real Seatbelt (macOS): proxy port reachable, a second loopback port not
if [[ $(uname) == Darwin && -x /usr/bin/sandbox-exec ]]; then
	# Two listeners, in a subshell so the shell doesn't report the kill.
	(node -e 'const net = require("net"); const ports = [];
		for (let i = 0; i < 2; i++) { const s = net.createServer((c) => { c.on("error", () => {}); c.end("x"); }).listen(0, "127.0.0.1", () => { ports.push(s.address().port); if (ports.length === 2) console.log(ports.join(" ")); }); }' >"$tmp/ports" &
		echo $! >"$tmp/lsn.pid")
	lsn=$(cat "$tmp/lsn.pid")
	for _ in $(seq 50); do [[ -s $tmp/ports ]] && break; sleep 0.1; done
	read -r proxy other <"$tmp/ports"
	profile=$(PROXY_PORT=$proxy bash -c '. "$1/host/backends/lima.sh"; lima_profile 1' _ "$ROOT")
	probe() { /usr/bin/sandbox-exec -p "$profile" bash -c "exec 3<>/dev/tcp/127.0.0.1/$1" 2>/dev/null; }
	bash -c "exec 3<>/dev/tcp/127.0.0.1/$other" 2>/dev/null && ok "unconfined: the second loopback port answers" || bad "listener $other not up"
	probe "$proxy" && ok "confined: the proxy port ($proxy) answers" || bad "confined: proxy port $proxy refused"
	probe "$other" && bad "confined: second loopback port $other reachable" || ok "confined: a second loopback port ($other) is refused"
	kill "$lsn" 2>/dev/null || true; lsn=""
else
	echo "  - not macOS: skipping the live Seatbelt check"
fi

echo "passed: $pass  failed: $fail"
((fail == 0))
