#!/usr/bin/env bash
# patch and guest staleness against the fake backend. The stub ssh is a fake guest: each VM's root
# filesystem is $tmp/vms/NAME/root (part of its disk, so snapshots, reverts and pool resets carry it), the
# guest paths boxery uses are rewritten into it, and sudo/systemctl are stand-ins. Running the layers is
# faked (fake-provision), but it writes build-info with the lib.sh boxery pushed, so the host's layers hash
# is checked against the guest's.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
H=$ROOT/host/boxery-host
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export BOXERY_CONF=$tmp/conf BOXERY_BACKEND=fake BOXERY_FAKE_DIR=$tmp/vms BOXERY_PROXY_PORT=9999 BOXERY_BOOT_ID=boot-1 BOXERY_SSH_WAIT_TRIES=3
mkdir -p "$tmp/bin" "$tmp/guest-bin" "$BOXERY_CONF"
echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAImgmtmgmtmgmtmgmtmgmt mgmt@host" >"$BOXERY_CONF/mgmt_ed25519.pub"; touch "$BOXERY_CONF/mgmt_ed25519"
echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIlaptoplaptoplaptoplap me@laptop" >"$BOXERY_CONF/authorized_keys"
cat >"$tmp/bin/ssh" <<STUB
#!/usr/bin/env bash
port=""; while [ \$# -gt 0 ]; do case \$1 in -p) port=\$2; shift 2 ;; -o|-F|-i) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift   # user@host
case "\$*" in *cloud-init*|*6080*|*boxery-provision.ok*) exit 0 ;; esac
for d in "$tmp/vms"/*/; do
	[ "\$(cat "\$d/port" 2>/dev/null)" = "\$port" ] || continue
	[ "\$(cat "\$d/state")" = running ] || exit 255
	R=\${d}root; mkdir -p "\$d/home" "\$R/etc/boxery" "\$R/var/run" "\$R/var/log" "\$R/run/user"
	[ -s "\$R/boot_id" ] || echo boot-0 >"\$R/boot_id"
	paths() { sed -e "s#/etc/boxery#\$R/etc/boxery#g" -e "s#/usr/local/lib/boxery#\$R/usr/local/lib/boxery#g" -e "s#/usr/local/sbin#\$R/usr/local/sbin#g" \\
		-e "s#/var/log#\$R/var/log#g" -e "s#/var/run#\$R/var/run#g" -e "s#/run/user#\$R/run/user#g" -e "s#/proc/sys/kernel/random/boot_id#\$R/boot_id#g"; }
	cmd=\$(printf '%s' "\${*:-true}" | sed "s#/usr/local/sbin/boxery-provision#$tmp/guest-bin/fake-provision#g" | paths)
	cd "\$d/home" && paths | HOME="\$d/home" R="\$R" PATH="$tmp/guest-bin:\$PATH" bash -c "\$cmd"
	exit "\$?"
done
exit 255
STUB
# The guest's stand-ins. sudo runs the command as is (date and pkill would touch this machine: skipped).
cat >"$tmp/guest-bin/sudo" <<'EOF'
#!/usr/bin/env bash
case $1 in date | pkill) exit 0 ;; esac
exec "$@"
EOF
cat >"$tmp/guest-bin/systemctl" <<'EOF'
#!/usr/bin/env bash
[ "$1" = reboot ] || exit 0
echo "boot-$RANDOM$RANDOM" >"$R/boot_id"; rm -f "$R/var/run/reboot-required"; echo x >>"$R/reboots"
EOF
printf '#!/bin/sh\necho "Google Chrome 141.0.1"\n' >"$tmp/guest-bin/google-chrome"
# boxery-provision LAYER...: record the layers like the real one, then write build-info with the pushed lib.sh.
# $tmp/hold: wait for it to go away (a crash test kills the patch here). $tmp/fail: fail. $tmp/reboot-next:
# the updates ask for a reboot.
cat >"$tmp/guest-bin/fake-provision" <<EOF
#!/usr/bin/env bash
set -euo pipefail
D=\$R/usr/local/lib/boxery/layers
. "\$D/lib.sh"
echo "provisioned \$*" >>"\$R/provisions"
if [ -e "$tmp/hold" ]; then echo half-patched >"\$R/patch-marker"; touch "$tmp/held"; while [ -e "$tmp/hold" ]; do sleep 0.05; done; fi
[ ! -e "$tmp/fail" ] || { echo "E: the archive is down"; exit 1; }
for l in "\$@"; do
	echo "==> boxery layer: \$l"
	grep -qx "\$l" "\$R/etc/boxery/layers" 2>/dev/null || echo "\$l" >>"\$R/etc/boxery/layers"
done
have=(); for l in plumbing devtools desktop; do grep -qx "\$l" "\$R/etc/boxery/layers" && have+=("\$l"); done
build_info "\$D" "\$R/usr/local/sbin/boxery-provision" "\${have[@]}" >"\$R/etc/boxery/build-info"
[ ! -e "$tmp/reboot-next" ] || touch "\$R/var/run/reboot-required"
EOF
command -v sha256sum >/dev/null || printf '#!/bin/sh\nexec shasum -a 256 "$@"\n' >"$tmp/guest-bin/sha256sum"
chmod +x "$tmp/bin/ssh" "$tmp/guest-bin"/*; export PATH="$tmp/bin:$PATH"
pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }
r() { echo "$tmp/vms/$1/root"; }
guest() { "$H" ls --json | jq -c --arg n "$1" '.[] | select(.name == $n) | .guest'; }
status() { "$H" ls --json | jq -r --arg n "$1" '.[] | select(.name == $n) | "\(.guest.status) \(.guest.reasons | join(","))"'; }
K1="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIleasekeyoneleasekeyone holder1"

"$H" build-base >/dev/null 2>&1
"$H" new d1 >/dev/null 2>&1
"$H" new h1 --headless >/dev/null 2>&1

echo "== before a patch"
[[ $(status d1) == "unknown no build record" ]] && ok "a VM without build-info is unknown, not an error" || bad "d1: $(status d1)"
"$H" ls >"$tmp/out" 2>"$tmp/err" && grep -q '^d1 .* unknown$' "$tmp/out" && ok "ls: GUEST unknown" || bad "ls: $(cat "$tmp/out" "$tmp/err")"
rm -rf "$BOXERY_CONF/build-info"
"$H" ls >/dev/null 2>"$tmp/err"; grep -q 'not checked yet: d1, h1 (ls --refresh reads it)' "$tmp/err" && ok "VMs never read: ls says how to check them" || bad "ls hint: $(cat "$tmp/err")"
[[ $(status d1) == "unknown not checked" ]] && ok "...and lists them unknown (not checked)" || bad "d1: $(status d1)"
"$H" ls --refresh >/dev/null 2>&1; [[ $(status d1) == "unknown no build record" ]] && ok "ls --refresh reads them" || bad "after refresh: $(status d1)"

echo "== patch"
"$H" patch d1 >"$tmp/out" 2>"$tmp/err" && ok "patch d1" || bad "patch d1: $(cat "$tmp/err")"
[[ ! -s $tmp/out ]] && ok "...prints nothing on stdout" || bad "stdout: $(cat "$tmp/out")"
same=1; for f in lib plumbing devtools desktop; do cmp -s "$ROOT/image/layers/$f.sh" "$(r d1)/usr/local/lib/boxery/layers/$f.sh" || same=0; done
cmp -s "$ROOT/image/layers/provision.sh" "$(r d1)/usr/local/sbin/boxery-provision" || same=0
[[ $same == 1 ]] && ok "pushes the host's layer files where seeds put them" || bad "pushed files differ"
[[ -x $(r d1)/usr/local/sbin/boxery-provision && -x $(r d1)/usr/local/lib/boxery/layers/plumbing.sh ]] && ok "...executable" || bad "modes"
[[ $(cat "$(r d1)/provisions") == "provisioned plumbing devtools desktop" ]] && ok "a VM without /etc/boxery/layers gets its kind's layers (desktop)" || bad "provisions: $(cat "$(r d1)/provisions")"
grep -q '^==> boxery layer: desktop$' "$tmp/err" && ok "shows the layers' progress" || bad "progress: $(cat "$tmp/err")"
grep -q '^==> d1 patched in [0-9]*s: kernel ' "$tmp/err" && ok "says it's done" || bad "done line: $(cat "$tmp/err")"
[[ $(status d1) == "current " ]] && ok "now current: the guest's layers hash is the host's" || bad "d1 after patch: $(status d1) / $(cat "$(r d1)/etc/boxery/build-info")"
guest d1 | jq -e '.chrome == "Google Chrome 141.0.1" and (.built_at | type) == "number" and (.checked_at | type) == "number" and .age_days == 0 and .reboot_required == false' >/dev/null && ok "ls --json: guest fields" || bad "guest: $(guest d1)"
"$H" patch h1 >/dev/null 2>&1 && [[ $(cat "$(r h1)/provisions") == "provisioned plumbing devtools" ]] && ok "a headless VM gets plumbing devtools" || bad "h1: $(cat "$(r h1)/provisions" 2>/dev/null)"
[[ $(status h1) == "current " ]] && ok "...and is current" || bad "h1: $(status h1)"
printf 'plumbing\n' >"$(r h1)/etc/boxery/layers"
"$H" patch h1 >/dev/null 2>&1; [[ $(tail -1 "$(r h1)/provisions") == "provisioned plumbing" ]] && ok "later patches run the layers in /etc/boxery/layers" || bad "h1: $(cat "$(r h1)/provisions")"
printf 'plumbing\ndevtools\n' >"$(r h1)/etc/boxery/layers"; "$H" patch h1 >/dev/null 2>&1

echo "== staleness"
sed -i.bak 's/^layers_hash=.*/layers_hash=0000/' "$(r d1)/etc/boxery/build-info"
[[ $(status d1) == "current " ]] && ok "ls reads the host's record, not the guest" || bad "d1: $(status d1)"
"$H" ls --refresh >/dev/null 2>"$tmp/err"
[[ $(status d1) == "outdated layers changed" ]] && ok "built with other layers → outdated (layers changed)" || bad "d1: $(status d1)"
grep -q 'outdated guest software: d1 (layers changed). Update with: boxery patch NAME|--all' "$tmp/err" && ok "ls says how to update it" || bad "hint: $(cat "$tmp/err")"
"$H" ls 2>/dev/null | grep -q '^d1 .* outdated$' && ok "ls: GUEST outdated" || bad "ls: $("$H" ls 2>&1)"
"$H" snap d1 old >/dev/null 2>&1
mv "$(r d1)/etc/boxery/build-info.bak" "$(r d1)/etc/boxery/build-info"
sed -i.bak 's/^built_at=.*/built_at=2026-01-01T00:00:00Z/' "$(r d1)/etc/boxery/build-info"
"$H" ls --refresh >/dev/null 2>&1; [[ $(status d1) == outdated\ built\ *\ days\ ago ]] && ok "built more than 30 days ago → outdated" || bad "d1: $(status d1)"
BOXERY_STALE_DAYS=100000 "$H" ls --json | jq -e '.[] | select(.name == "d1") | .guest.status == "current"' >/dev/null && ok "BOXERY_STALE_DAYS sets the age limit" || bad "stale days"
mv "$(r d1)/etc/boxery/build-info.bak" "$(r d1)/etc/boxery/build-info"
touch "$(r d1)/var/run/reboot-required"
"$H" ls --refresh >/dev/null 2>&1; [[ $(status d1) == "outdated reboot required" ]] && ok "/var/run/reboot-required → outdated (reboot required)" || bad "d1: $(status d1)"
rm "$(r d1)/var/run/reboot-required"; "$H" stop d1 >/dev/null 2>&1
"$H" ls --refresh >/dev/null 2>&1; [[ $(status d1) == "outdated reboot required" ]] && ok "a stopped VM keeps its last record" || bad "stopped d1: $(status d1)"
"$H" start d1 >/dev/null 2>&1; [[ $(status d1) == "current " ]] && ok "start reads it again" || bad "started d1: $(status d1)"

echo "== snapshots and images"
"$H" snaps d1 | grep -q $'^old\t.*\t0d\toutdated$' && ok "snaps: AGE and GUEST (the software it was captured with)" || bad "snaps: $("$H" snaps d1)"
"$H" snaps d1 --json | jq -e '.[0].age_days == 0 and .[0].guest.status == "outdated" and .[0].guest.reboot_required == null' >/dev/null && ok "snaps --json" || bad "snaps --json: $("$H" snaps d1 --json)"
"$H" images | grep -q '^d1@old .* 0d *outdated$' && ok "images: AGE and GUEST" || bad "images: $("$H" images)"
"$H" patch d1 >/dev/null 2>"$tmp/err"
grep -q "d1's snapshots were not patched (old): a VM made or reverted from one has its old software until you patch it" "$tmp/err" && ok "patch says the snapshots weren't patched" || bad "no snapshot note: $(cat "$tmp/err")"
"$H" snaps d1 | grep -q $'^old\t.*outdated$' && ok "...and they stay outdated" || bad "snaps: $("$H" snaps d1)"
"$H" new d2 --from d1@old >/dev/null 2>&1; [[ $(status d2) == "outdated layers changed" ]] && ok "a VM from an outdated image is outdated" || bad "d2: $(status d2)"
"$H" revert d1 old >/dev/null 2>&1; [[ $(status d1) == "outdated layers changed" ]] && ok "so is a VM reverted to one" || bad "reverted d1: $(status d1)"
"$H" rm d2 >/dev/null 2>&1; [[ ! -e $BOXERY_CONF/build-info/d2 ]] && ok "rm forgets the record" || bad "d2 record left"

echo "== restarts"
touch "$tmp/reboot-next"
"$H" patch d1 >/dev/null 2>"$tmp/err" && ok "patch with updates that ask for a reboot" || bad "patch: $(cat "$tmp/err")"
rm "$tmp/reboot-next"
[[ $(wc -l <"$(r d1)/reboots") -eq 1 ]] && grep -q 'restarting it (the updates ask for it' "$tmp/err" && ok "restarts the VM, and says so" || bad "reboots: $(cat "$(r d1)/reboots" 2>/dev/null) / $(cat "$tmp/err")"
grep -q 'd1 patched in [0-9]*s (restarted)' "$tmp/err" && [[ $(status d1) == "current " ]] && ok "...waits for it and records the new boot as current" || bad "after restart: $(status d1) / $(cat "$tmp/err")"
"$H" patch d1 >/dev/null 2>&1; [[ $(wc -l <"$(r d1)/reboots") -eq 1 ]] && ok "no restart when nothing asks for one" || bad "extra reboot"

echo "== refusals"
"$H" stop h1 >/dev/null 2>&1
if "$H" patch h1 >/dev/null 2>"$tmp/err"; then bad "patched a stopped VM"; else grep -q 'h1 is not running (start it first)' "$tmp/err" && ok "a stopped VM: start it first" || bad "err: $(cat "$tmp/err")"; fi
"$H" start h1 >/dev/null 2>&1
if "$H" patch nope >/dev/null 2>&1; then bad "patched a missing VM"; else ok "a missing VM fails"; fi
for a in "" "d1 h1" "d1 --all" "--wait x d1" "D1"; do
	# shellcheck disable=SC2086
	if "$H" patch $a >/dev/null 2>&1; then bad "patch $a accepted"; else ok "patch $a: refused"; fi
done
touch "$tmp/fail"
if "$H" patch h1 >/dev/null 2>"$tmp/err"; then bad "a failing layer run succeeded"; else
	grep -q 'E: the archive is down' "$tmp/err" && grep -q 'patching h1 failed (log above: /var/log/boxery-patch.log in the VM)' "$tmp/err" && ok "a failing layer run fails the patch and shows its log" || bad "err: $(cat "$tmp/err")"; fi
rm "$tmp/fail"

echo "== pool VMs"
"$H" new p1 >/dev/null 2>&1; "$H" pool add p1 >/dev/null 2>&1
"$H" patch p1 >/dev/null 2>"$tmp/err" && ok "patch a free pool VM" || bad "patch p1: $(cat "$tmp/err")"
cmp -s "$(r p1)/etc/boxery/build-info" "$tmp/vms/.images/p1@boxery-clean/root/etc/boxery/build-info" && ok "its clean image is captured again, patched" || bad "clean image not patched"
grep -q 'captured its clean image p1@boxery-clean again' "$tmp/err" && ok "...and it says so" || bad "err: $(cat "$tmp/err")"
"$H" snaps p1 | grep -q $'^boxery-clean\t.*current$' && ok "snaps: the clean image is current" || bad "snaps: $("$H" snaps p1)"
! grep -q "snapshots were not patched" "$tmp/err" && ok "...and isn't listed as an unpatched snapshot" || bad "clean image called a snapshot"
[[ $(cat "$tmp/vms/p1/home/.ssh/authorized_keys") == *mgmt@host* && $(cat "$tmp/vms/p1/home/.ssh/authorized_keys") != *me@laptop* ]] && ok "only the host's key, as pool add leaves it" || bad "keys: $(cat "$tmp/vms/p1/home/.ssh/authorized_keys")"
"$H" pool ls | grep -q '^p1 *free' && ok "still free" || bad "pool: $("$H" pool ls)"
out=$(echo "$K1" | "$H" acquire --holder alice --ttl 600 2>/dev/null); lease=$(awk '{print $2}' <<<"$out")
[[ $lease == l-* ]] && ok "lease p1" || bad "acquire: $out"
if "$H" patch p1 >/dev/null 2>"$tmp/err"; then bad "patched a leased VM"; else
	grep -q 'p1 is a pool VM with an active lease (leased); patch it after the lease ends (or: patch p1 --wait S)' "$tmp/err" && ok "a leased pool VM is refused" || bad "err: $(cat "$tmp/err")"; fi
if "$H" patch p1 --wait 1 >/dev/null 2>"$tmp/err"; then bad "--wait patched a leased VM"; else
	grep -q 'p1 is leased; waiting up to 1s' "$tmp/err" && grep -q 'active lease' "$tmp/err" && ok "--wait S: refused once S runs out" || bad "err: $(cat "$tmp/err")"; fi
echo leftover >"$(r p1)/lease-work"
(sleep 2; "$H" release "$lease" >/dev/null 2>&1) &
"$H" patch p1 --wait 60 >/dev/null 2>"$tmp/err" && ok "--wait S: patched once the lease ends" || bad "patch --wait: $(cat "$tmp/err")"
wait
[[ ! -e $(r p1)/lease-work && ! -e $tmp/vms/.images/p1@boxery-clean/root/lease-work ]] && ok "...after its reset (the lease's work isn't in the clean image)" || bad "lease work captured"

echo "== patch --all"
"$H" stop h1 >/dev/null 2>&1
out=$(echo "$K1" | "$H" acquire --holder bob --ttl 600 2>/dev/null); lease=$(awk '{print $2}' <<<"$out")
n=$(wc -l <"$(r d1)/provisions")
"$H" patch --all >/dev/null 2>"$tmp/err" && ok "patch --all" || bad "patch --all: $(cat "$tmp/err")"
[[ $(wc -l <"$(r d1)/provisions") -eq $((n + 1)) ]] && ok "patches the running VMs" || bad "d1 not patched"
grep -q '^==> patched: d1; skipped: h1 (shut off), p1 (leased)$' "$tmp/err" && ok "skips stopped VMs and leased pool VMs, and says which" || bad "summary: $(cat "$tmp/err")"
echo '{"built_at":null}' >"$BOXERY_CONF/build-info/p1"
"$H" release "$lease" >/dev/null 2>&1
cmp -s "$BOXERY_CONF/build-info/p1" "$BOXERY_CONF/build-info/p1@boxery-clean" && [[ $(status p1) == "current " ]] && ok "a reset puts back its clean image's record" || bad "p1 after reset: $(status p1)"

echo "== an interrupted pool patch"
# Killed while the layers run: recovery puts the VM back to its clean image.
touch "$tmp/hold"; rm -f "$tmp/held"
"$H" patch p1 >/dev/null 2>&1 & sup=$!
for _ in $(seq 200); do [[ -e $tmp/held ]] && break; sleep 0.05; done
[[ -e $(r p1)/patch-marker ]] && ok "patch started on p1" || bad "patch didn't start"
kill -9 "$sup"; wait "$sup" 2>/dev/null || true
"$H" reconcile >/dev/null 2>&1 || true
rm -f "$tmp/hold"
[[ ! -e $(r p1)/patch-marker ]] && "$H" pool ls | grep -q '^p1 *free' && ok "recovery reimages it from its clean image; still free" || bad "after recovery: $("$H" pool ls) marker: $(ls "$(r p1)")"
# Killed during the capture, after the old clean image was removed: nothing to reset to → broken.
BOXERY_FAKE_PAUSE=capture "$H" patch p1 >/dev/null 2>&1 & sup=$!
for _ in $(seq 200); do [[ -e $tmp/vms/.barriers/p1.capture ]] && break; sleep 0.05; done
kill -9 "$sup"; wait "$sup" 2>/dev/null || true
"$H" reconcile >/dev/null 2>&1 || true
touch "$tmp/vms/.barriers/p1.capture.release"
"$H" pool ls | grep -q '^p1 *broken' && ok "...and without a clean image it is broken" || bad "pool: $("$H" pool ls)"
[[ ! -e $tmp/vms/.images/p1@boxery-clean.part ]] && ok "...with the half-made capture removed" || bad "partial capture left"
remaining=$(node --disable-warning=ExperimentalWarning --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1]);
console.log(db.prepare("SELECT count(*) AS n FROM operation_locks").get().n);
' "$BOXERY_CONF/leases.db")
[[ $remaining == 0 ]] && ok "lifecycle locks released" || bad "lock left behind"

echo; echo "passed: $pass  failed: $fail"; ((fail == 0))
