#!/usr/bin/env bash
# Images, snapshots and forks on the host against the fake backend. Like host-leases.sh, a stub ssh runs
# commands inside the fake VM's home directory, so files "agents" write are real and we can check what
# a fork, snapshot or revert carries over and what it must not (keys, pushed grants, identity).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
H=$ROOT/host/boxery-host
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export BOXERY_CONF=$tmp/conf BOXERY_BACKEND=fake BOXERY_FAKE_DIR=$tmp/vms BOXERY_PROXY_PORT=9999 BOXERY_BOOT_ID=boot-1 BOXERY_SSH_WAIT_TRIES=2
mkdir -p "$tmp/bin" "$BOXERY_CONF"
echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAImgmtmgmtmgmtmgmtmgmt mgmt@host" >"$BOXERY_CONF/mgmt_ed25519.pub"; touch "$BOXERY_CONF/mgmt_ed25519"
echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIlaptoplaptoplaptoplap me@laptop" >"$BOXERY_CONF/authorized_keys"
cat >"$tmp/bin/ssh" <<STUB
#!/usr/bin/env bash
port=""; while [ \$# -gt 0 ]; do case \$1 in -p) port=\$2; shift 2 ;; -o|-F|-i) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift   # user@host
case "\$*" in *cloud-init*|*6080*) exit 0 ;; esac
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
f() { echo "$tmp/vms/$1/home/$2"; }
K1="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIleasekeyoneleasekeyone holder1"
token() { jq -r --arg n "$1" '.[$n]' "$BOXERY_CONF/tokens.json"; }

"$H" build-base >/dev/null 2>&1
"$H" new src >/dev/null 2>&1
mkdir -p "$(f src project)"; echo work-in-progress >"$(f src project/wip.txt)"

echo "== fork"
out=$("$H" fork src a b --mem 4096 2>/dev/null) && ok "fork src → a b" || bad "fork: $out"
[[ $(awk '{print $1}' <<<"$out" | tr '\n' ' ') == "a b " ]] && ok "prints one 'NAME ADDR' line per fork, in order" || bad "output: $out"
for n in a b; do
	grep -q work-in-progress "$(f "$n" project/wip.txt)" 2>/dev/null && ok "$n has src's files" || bad "$n is missing src's files"
done
[[ $(cat "$tmp/vms/src/state") == running ]] && ok "src keeps running" || bad "src state: $(cat "$tmp/vms/src/state")"
echo "only in a" >"$(f a project/a.txt)"
[[ ! -e $(f b project/a.txt) && ! -e $(f src project/a.txt) ]] && ok "forks are independent (writes don't leak)" || bad "fork writes leaked"
ta=$(token a)
[[ $ta != "$(token src)" && $ta != "$(token b)" && ${#ta} -eq 48 ]] && ok "each fork has its own proxy token" || bad "tokens: src=$(token src) a=$(token a) b=$(token b)"
grep -q '^hostname: a$' "$tmp/vms/a/user-data" && ok "fork gets its own hostname/seed" || bad "seed"
[[ $(cat "$tmp/vms/a/size") == "4 4096 40" ]] && ok "fork honours --mem (defaults otherwise)" || bad "size: $(cat "$tmp/vms/a/size")"
ak=$(f a .ssh/authorized_keys)
grep -q mgmt@host "$ak" && grep -q me@laptop "$ak" && ok "fork authorizes this host's keys" || bad "fork keys: $(cat "$ak" 2>/dev/null)"
mkdir -p "$BOXERY_CONF/edge"; echo '{"hosts":{"api.github.com":{"headers":{"Authorization":"Bearer x"}}}}' >"$BOXERY_CONF/edge/src.json"
"$H" fork src e1 >/dev/null 2>&1
[[ ! -e $BOXERY_CONF/edge/e1.json ]] && ok "fork gets no edge (http:) credential routes" || bad "edge routes copied to fork"
"$H" rm e1 >/dev/null 2>&1
[[ -z $("$H" images 2>/dev/null | grep '@fork-') ]] && ok "temporary fork image removed" || bad "fork image left: $("$H" images)"
"$H" rm src >/dev/null 2>&1
grep -q work-in-progress "$(f a project/wip.txt)" && ok "forks survive removing src" || bad "fork depends on src"

echo "== fork refuses"
if "$H" fork a b >/dev/null 2>&1; then bad "fork onto an existing VM"; else ok "fork onto an existing name fails"; fi
if "$H" fork nope c >/dev/null 2>&1; then bad "fork of a missing VM"; else ok "fork of a missing VM fails"; fi
if "$H" fork a c c >/dev/null 2>&1; then bad "duplicate fork names"; else ok "duplicate fork names fail"; fi
if "$H" fork a 'x;id' >/dev/null 2>&1; then bad "invalid fork name"; else ok "invalid fork name fails"; fi
[[ ! -d $tmp/vms/c ]] && ok "...and create nothing" || bad "half-made fork"
BOXERY_FAKE_FAIL_CAPTURE=1 "$H" fork a c >/dev/null 2>&1 && bad "fork with failing capture succeeded" || ok "capture failure → fork fails"
[[ ! -d $tmp/vms/c ]] && jq -e 'has("c") | not' "$BOXERY_CONF/tokens.json" >/dev/null && ok "...without a VM or token left behind" || bad "leftovers after failed capture"
BOXERY_FAKE_FAIL_NEW=1 "$H" fork a c >/dev/null 2>&1 && bad "fork with failing boot succeeded" || ok "boot failure → fork fails"
[[ ! -d $tmp/vms/c && -z $("$H" images 2>/dev/null | grep '@fork-') ]] && ok "...and cleans up the VM and the fork image" || bad "leftovers after failed boot"

echo "== a fork of a leased VM doesn't inherit the lease holder"
"$H" new p1 >/dev/null 2>&1; "$H" pool add p1 >/dev/null 2>&1
out=$(echo "$K1" | "$H" acquire --holder alice --ttl 600 2>/dev/null); set -- $out
grep -q holder1 "$(f p1 .ssh/authorized_keys)" && ok "lease key on p1" || bad "lease key missing"
mkdir -p "$(f p1 project)"; echo leased-work >"$(f p1 project/l.txt)"
"$H" fork p1 pf >/dev/null 2>&1 && ok "fork a leased VM" || bad "fork leased"
grep -q leased-work "$(f pf project/l.txt)" && ok "fork has the lease holder's work" || bad "work missing"
! grep -q holder1 "$(f pf .ssh/authorized_keys)" && ok "fork does NOT accept the lease key" || bad "LEASE KEY CARRIED INTO FORK"
"$H" pool ls | grep -q '^pf ' && bad "fork joined the pool" || ok "fork is a pet, not a pool VM"
"$H" release "$2" >/dev/null 2>&1
[[ ! -e $(f p1 project/l.txt) ]] && ok "pool reset still works (clean image)" || bad "pool reset"

echo "== snapshots are images"
"$H" new s >/dev/null 2>&1; mkdir -p "$(f s project)"
echo v1 >"$(f s project/v)"
"$H" snap s one >/dev/null 2>&1 && ok "snap" || bad snap
"$H" snaps s | cut -f1 | grep -qx one && ok "snaps lists it" || bad "snaps: $("$H" snaps s)"
"$H" images | grep -q '^s@one ' && ok "images lists s@one" || bad "images: $("$H" images)"
if "$H" snap s one >/dev/null 2>&1; then bad "duplicate snapshot"; else ok "duplicate snapshot name fails"; fi
echo v2 >"$(f s project/v)"; port=$(cat "$tmp/vms/s/port"); tok=$(token s)
"$H" revert s one >/dev/null 2>&1 && [[ $(cat "$(f s project/v)") == v1 ]] && ok "revert restores the disk" || bad "revert"
[[ $(cat "$tmp/vms/s/port") == "$port" && $(token s) == "$tok" ]] && ok "revert keeps the VM's identity (endpoint, token)" || bad "identity changed on revert"
"$H" new s2 --from s@one >/dev/null 2>&1 && [[ $(cat "$(f s2 project/v)") == v1 ]] && ok "new --from a snapshot" || bad "new --from"
if "$H" new s3 --from s@nope >/dev/null 2>&1; then bad "new --from a missing image"; else ok "new --from a missing image fails"; fi
if "$H" new s3 --from 'x;id' >/dev/null 2>&1; then bad "invalid image name accepted"; else ok "invalid image name rejected"; fi
if "$H" revert p1 boxery-clean >/dev/null 2>&1; then bad "revert of a pool VM"; else ok "revert refuses pool VMs"; fi
if "$H" snap-rm p1 boxery-clean >/dev/null 2>&1; then bad "deleted a pool VM's clean image"; else ok "snap-rm protects the pool's clean image"; fi
"$H" snap-rm s one >/dev/null 2>&1 && ! "$H" images | grep -q '^s@one ' && ok "snap-rm" || bad "snap-rm"
grep -q v1 "$(f s2 project/v)" && ok "VMs made from an image survive its removal" || bad "s2 depends on s@one"
"$H" snap s two >/dev/null 2>&1; "$H" rm s >/dev/null 2>&1
! "$H" images | grep -q '^s@' && ok "rm removes the VM's snapshots" || bad "orphan images: $("$H" images)"

echo "== concurrency: snapshots of one VM are serialized"
"$H" new c1 >/dev/null 2>&1
for i in 1 2 3 4; do ("$H" snap c1 "k$i" >/dev/null 2>&1 || true) & done; wait
(( $("$H" snaps c1 | wc -l) == 4 )) && ok "4 parallel snaps → 4 images" || bad "snaps: $("$H" snaps c1 | tr '\n' ' ')"
[[ ! -d $BOXERY_CONF/locks/c1 ]] && ok "lock released" || bad "lock left behind"
mkdir -p "$BOXERY_CONF/locks/c1"; echo 999999 >"$BOXERY_CONF/locks/c1/pid"
"$H" snap c1 k5 >/dev/null 2>&1 && ok "a dead owner's lock is taken over" || bad "stale lock blocks"

echo; echo "passed: $pass  failed: $fail"; ((fail == 0))
