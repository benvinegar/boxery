#!/usr/bin/env bash
# Lease lifecycle on the host against the fake backend. A stub ssh runs commands inside the fake VM's
# home directory (selected by port), so authorized_keys and files written by "agents" are real files:
# we can check that a lease key is installed, and that release/expiry resets the VM and removes it.
set -euo pipefail
node --disable-warning=ExperimentalWarning -e 'require("node:sqlite")' 2>/dev/null || { echo "SKIP: node:sqlite unavailable (need Node >= 22.13)"; exit 0; }
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
H=$ROOT/host/boxery-host
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export BOXERY_CONF=$tmp/conf BOXERY_BACKEND=fake BOXERY_FAKE_DIR=$tmp/vms BOXERY_PROXY_PORT=9999 BOXERY_BOOT_ID=boot-1 BOXERY_SSH_WAIT_TRIES=2
mkdir -p "$tmp/bin" "$BOXERY_CONF"
echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAImgmtmgmtmgmtmgmtmgmt mgmt@host" >"$BOXERY_CONF/mgmt_ed25519.pub"; touch "$BOXERY_CONF/mgmt_ed25519"
cat >"$tmp/bin/ssh" <<STUB
#!/usr/bin/env bash
port=""; while [ \$# -gt 0 ]; do case \$1 in -p) port=\$2; shift 2 ;; -o|-F|-i) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift   # user@host
[ -z "\${BOXERY_FAKE_SSH_FAIL:-}" ] || exit 255
case "\$*" in *cloud-init*|*6080*) exit 0 ;; esac   # boot readiness checks: a fake VM is always ready
for d in "$tmp/vms"/*/; do
	if [ "\$(cat "\$d/port" 2>/dev/null)" = "\$port" ]; then
		[ "\$(cat "\$d/state")" = running ] || exit 255
		mkdir -p "\$d/home"; cd "\$d/home" && HOME="\$d/home" exec bash -c "\${*:-true}"
	fi
done
exit 255
STUB
chmod +x "$tmp/bin/ssh"; export PATH="$tmp/bin:$PATH"
pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }
has() { local out; out=$("$@" 2>/dev/null) || true; grep -q -- "$PATTERN" <<<"$out"; }
vmfile() { echo "$tmp/vms/$1/home/$2"; }
K1="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIleasekeyoneleasekeyone holder1"
K2="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIleasekeytwoleasekeytwo holder2"

"$H" build-base >/dev/null 2>&1
for n in p1 p2; do "$H" new "$n" >/dev/null 2>&1; "$H" pool add "$n" >/dev/null 2>&1; done
"$H" new pet >/dev/null 2>&1
[[ $("$H" pool ls | grep -c free) == 2 ]] && ok "pool add → 2 FREE" || bad "pool ls: $("$H" pool ls)"
[[ $(cat "$(vmfile p1 .ssh/authorized_keys)") == *mgmt@host* && $(grep -c . "$(vmfile p1 .ssh/authorized_keys)") == 1 ]] && ok "pool VM accepts only the host key" || bad "authorized_keys: $(cat "$(vmfile p1 .ssh/authorized_keys)")"

out=$(echo "$K1" | "$H" acquire --holder alice@mac --ttl 600 2>/dev/null); set -- $out; L1n=$1 L1=$2
[[ $L1 =~ ^l-[0-9a-f]{32}$ ]] && ok "acquire → NAME LEASE_ID EXPIRES ($L1n)" || bad "acquire: $out"
grep -q holder1 "$(vmfile "$L1n" .ssh/authorized_keys)" && ok "lease key installed in the VM" || bad "lease key missing"
out2=$(echo "$K2" | "$H" acquire --holder bob@mac --ttl 600 --json 2>/dev/null)
jq -e '(.name | test("^p[12]$")) and (.lease_id | test("^l-[0-9a-f]{32}$")) and (.expires_at | type) == "number" and (keys | length) == 3' <<<"$out2" >/dev/null \
	&& ok "acquire --json → {name, lease_id, expires_at}" || bad "acquire --json: $out2"
L2n=$(jq -r .name <<<"$out2")
[[ $L2n != "$L1n" ]] && ok "second acquire gets the other VM" || bad "same VM twice: $L1n $L2n"
if echo "$K2" | "$H" acquire --holder carol --ttl 600 --json >/dev/null 2>&1; then bad "acquire succeeded on an exhausted pool"; else [[ $? == 4 ]] && ok "exhausted pool → exit 4" || bad "wrong exit code"; fi
PATTERN="^$L1n  *.*leased" has "$H" ls && ok "ls shows LEASED" || bad "ls lease column: $("$H" ls 2>&1 | tr '\n' '|')"
"$H" ls --json | jq -e --arg n "$L1n" '.[] | select(.name == $n) | .lease.state == "leased" and .lease.holder == "alice@mac" and (.lease.expires_at | type) == "number"' >/dev/null && ok "ls --json carries lease state" || bad "ls --json: $("$H" ls --json)"
"$H" ls --json | jq -e '.[] | select(.name == "pet") | .lease == null' >/dev/null && ok "ls --json: pets have lease null" || bad "ls --json pet"
"$H" pool ls --json | jq -e --arg n "$L1n" 'length == 2 and (.[] | select(.name == $n) | .state == "leased" and .expires_in > 0)' >/dev/null && ok "pool ls --json" || bad "pool ls --json: $("$H" pool ls --json)"
if "$H" rm "$L1n" >/dev/null 2>&1; then bad "rm of a pool VM allowed"; else ok "rm refuses pool VMs"; fi

echo "agent was here" >"$(vmfile "$L1n" project-file)"
"$H" renew "$L1" --ttl 900 >/dev/null 2>&1 && ok "renew" || bad renew
j=$("$H" renew "$L1" --ttl 900 --json 2>/dev/null)
jq -e --arg n "$L1n" --arg l "$L1" '.name == $n and .lease_id == $l and (.expires_at | type) == "number" and (keys | length) == 3' <<<"$j" >/dev/null \
	&& ok "renew --json → {name, lease_id, expires_at}" || bad "renew --json: $j"
"$H" help | grep -q '^  renew LEASE \[--ttl S\] \[--json\]' && ok "help advertises renew --json (controllers probe it)" || bad "help: no renew --json"
"$H" release "$L1" >/dev/null 2>&1 && ok "release" || bad release
! grep -q holder1 "$(vmfile "$L1n" .ssh/authorized_keys)" && ok "release removed the lease key (fenced)" || bad "old key still authorized"
[[ ! -e $(vmfile "$L1n" project-file) ]] && ok "release reset the VM to its clean snapshot" || bad "leftover state after release"
if "$H" renew "$L1" >/dev/null 2>&1; then bad "renew of a released lease worked"; else ok "released lease can't be renewed"; fi
PATTERN="^$L1n *free" has "$H" pool ls && ok "VM back to FREE" || bad "state after release: $("$H" pool ls)"

# expiry → reap
BOXERY_NOW=$(( $(date +%s) + 3600 )) "$H" reap >/dev/null 2>&1
! grep -q holder2 "$(vmfile "$L2n" .ssh/authorized_keys)" && ok "reaper reset the expired lease (key gone)" || bad "expired lease not reaped"
[[ $("$H" pool ls | grep -c free) == 2 ]] && ok "both VMs FREE after reap" || bad "$("$H" pool ls)"

# host reboot voids leases
out=$(echo "$K1" | "$H" acquire --holder alice --ttl 3600 2>/dev/null); set -- $out
BOXERY_BOOT_ID=boot-2 "$H" reap >/dev/null 2>&1
PATTERN="^$1 *free" has "$H" pool ls && ok "leases from before a reboot are reaped" || bad "reboot: $("$H" pool ls)"

# key install fails during acquire → VM goes back, never stuck ACQUIRING
if echo "$K1" | BOXERY_FAKE_SSH_FAIL=1 "$H" acquire --holder alice >/dev/null 2>&1; then bad "acquire succeeded without installing the key"; else ok "acquire fails when the key can't be installed"; fi
out=$("$H" pool ls 2>/dev/null); ! grep -q acquiring <<<"$out" && ok "failed acquire leaves nothing ACQUIRING" || bad "stuck: $("$H" pool ls)"
PATTERN=broken has "$H" pool ls && ok "...and the VM it couldn't reach is marked BROKEN" || bad "expected BROKEN: $("$H" pool ls)"

# a failed reset marks the VM BROKEN and it's never handed out again
out=$(echo "$K1" | "$H" acquire --holder alice 2>/dev/null) || true
[[ -n $out ]] || { bad "no FREE VM left for the failed-reset test: $("$H" pool ls)"; out="x x"; }
set -- $out
BOXERY_FAKE_FAIL_REVERT=1 "$H" release "$2" >/dev/null 2>&1 || true
PATTERN="^$1 *broken" has "$H" pool ls && ok "failed reset → BROKEN" || bad "after failed reset of $1: $("$H" pool ls | tr "\n" "|")"
if echo "$K1" | "$H" acquire --holder alice >/dev/null 2>&1; then bad "a BROKEN VM was leased"; else ok "BROKEN VMs are not leased"; fi

# concurrent acquires from separate processes against a fresh pool of 4
for n in p3 p4; do "$H" new "$n" >/dev/null 2>&1; "$H" pool add "$n" >/dev/null 2>&1; done
"$H" pool rm p1 --force >/dev/null 2>&1; "$H" pool rm p2 --force >/dev/null 2>&1
for n in p1 p2; do "$H" pool add "$n" >/dev/null 2>&1; done
for i in 1 2 3 4 5 6; do (echo "$K1" | "$H" acquire --holder "c$i" 2>"$tmp/acqerr.$i" >"$tmp/acq.$i" || true) & done; wait
got=$(cat "$tmp"/acq.* | awk '{print $1}' | sort)
# numeric comparison: BSD wc pads its count with spaces
(( $(wc -l <<<"$got") == 4 && $(sort -u <<<"$got" | wc -l) == 4 )) && ok "6 parallel acquires on 4 VMs → 4 distinct leases" || bad "parallel: $(tr '\n' ' ' <<<"$got") errors: $(cat "$tmp"/acqerr.* | grep -v 'leased to\|exhausted' | sort -u | tr '\n' '|')"

"$H" pool rm pet >/dev/null 2>&1 && bad "pool rm of a non-pool VM" || ok "pool rm rejects non-pool VMs"

# --- lease reset clears edge routes (the next holder must not inherit them)
for l in $(cat "$tmp"/acq.* | awk '{print $2}'); do "$H" release "$l" >/dev/null 2>&1 || true; done
out=$(echo "$K1" | "$H" acquire --holder edge 2>/dev/null) || true; set -- $out
if [[ -n ${1:-} ]]; then
	echo '{"api.example.com":{"headers":{"Authorization":"Bearer x"}}}' | "$H" edge-set "$1" >/dev/null 2>&1
	[[ -f $BOXERY_CONF/edge/$1.json ]] || bad "edge-set on leased VM"
	"$H" release "$2" >/dev/null 2>&1
	[[ ! -f $BOXERY_CONF/edge/$1.json ]] && ok "release clears edge routes" || bad "edge routes survived release"
else bad "acquire for edge test"; fi

echo "passed: $pass  failed: $fail"; ((fail == 0))
