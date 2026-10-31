#!/usr/bin/env bash
# Controller in local mode against the fake backend: setup, new/ls/rm, grants storage + apply script.
# shellcheck disable=SC1090  # sources the generated env.sh under test
# The "VM" is a local directory; an ssh stub executes remote scripts locally with HOME=that dir.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
A=$ROOT/controller/boxery
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export BOXERY_CONF=$tmp/hostconf BOXERY_HOME=$tmp/ctl BOXERY_BACKEND=fake BOXERY_FAKE_DIR=$tmp/vms
export BOXERY_HOST_BIN=$ROOT/host/boxery-host BOXERY_RUNTIME_DIR=$tmp/run
mkdir -p "$tmp/bin" "$BOXERY_CONF" "$tmp/run" "$tmp/home/.ssh"
echo "ssh-ed25519 AAAAtest mgmt" >"$BOXERY_CONF/mgmt_ed25519.pub"; touch "$BOXERY_CONF/mgmt_ed25519"
echo "ssh-ed25519 AAAAme me@laptop" >"$tmp/home/.ssh/id_ed25519.pub"; touch "$tmp/home/.ssh/id_ed25519"
# ssh stub: control-master ops succeed; "NAME.boxery 'bash -s'" runs the script locally in the VM dir.
cat >"$tmp/bin/ssh" <<STUB
#!/usr/bin/env bash
for a in "\$@"; do case \$a in -O) exit 0 ;; esac; done
host=""; port=""; while [ \$# -gt 0 ]; do case \$1 in -p) port=\$2; shift 2 ;; -F|-o|-i) shift 2 ;; *.boxery) host=\${1%.boxery}; shift; break ;; agent@*) shift; break ;; *) shift ;; esac; done
if [ -z "\$host" ] && [ -n "\$port" ]; then for d in $tmp/vms/*/; do [ "\$(cat "\$d/port" 2>/dev/null)" = "\$port" ] && host=\$(basename "\$d"); done; fi
case "\$*" in *cloud-init*|*6080*) exit 0 ;; esac
[ -n "\$host" ] || exit 0
vm=$tmp/vms/\$host; [ -d "\$vm" ] || { echo "no such vm" >&2; exit 255; }
mkdir -p "\$vm/home/project/.git/info"
cd "\$vm/home" && HOME="\$vm/home" exec bash -c "\${*:-true}"
STUB
chmod +x "$tmp/bin/ssh"; export PATH="$tmp/bin:$PATH"
pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }

HOME=$tmp/home "$A" setup local >/dev/null 2>&1 && ok "setup local" || bad "setup local"
grep -q "^HOST=local" "$BOXERY_HOME/config" && ok "config records HOST=local" || bad "config"
grep -q "ProxyCommand $ROOT/host/boxery-host connect %h %p" "$BOXERY_HOME/ssh_config" && ok "ProxyCommand runs boxery-host directly" || bad "ProxyCommand: $(grep ProxyCommand "$BOXERY_HOME/ssh_config")"
grep -q AAAAme "$BOXERY_CONF/authorized_keys" && ok "setup registered the key with the local host" || bad "key not registered"
"$BOXERY_HOST_BIN" build-base >/dev/null 2>&1
"$A" new w1 >/dev/null 2>&1 && ok "new via local host" || bad "new"
"$A" ls 2>/dev/null | grep -q '^w1 ' && ok "ls shows the VM with GRANTS column" || bad "ls"

printf 'SECRET_FILE=1\n' >"$tmp/dev.env"
export MY_TOKEN='va lue $with "quotes"'
"$A" grant w1 ssh-agent env:MY_TOKEN env:FROM_CMD --cmd 'echo computed' "file:$tmp/dev.env=project/.env" >/dev/null 2>&1 && ok "grant" || bad "grant"
! grep -q 'va lue' "$BOXERY_HOME/grants/w1" && ok "grant store holds names, not values" || bad "value leaked into grant store"
grep -q '^Host w1.boxery' "$BOXERY_HOME/ssh_config" && ok "ssh-agent grant → ForwardAgent for that VM" || bad "ForwardAgent"
envsh=$tmp/run/boxery/env.sh
[[ -f $envsh ]] && (unset MY_TOKEN; . "$envsh"; [[ $MY_TOKEN == 'va lue $with "quotes"' && $FROM_CMD == computed ]]) && ok "env values pushed and shell-safe" || bad "env.sh: $(cat "$envsh" 2>/dev/null)"
link=$tmp/vms/w1/home/project/.env
[[ -L $link ]] && grep -q SECRET_FILE "$link" && ok "file grant linked into project" || bad "file link"
grep -qx '/.env' "$tmp/vms/w1/home/project/.git/info/exclude" && ok "file grant git-excluded" || bad "exclude"
"$A" revoke w1 env:MY_TOKEN "file:$tmp/dev.env" >/dev/null 2>&1
if (unset MY_TOKEN; . "$envsh"; [[ -z ${MY_TOKEN:-} && $FROM_CMD == computed ]]) && [[ ! -e $link && ! -L $link ]]; then ok "revoke removes exactly the revoked items"; else bad "revoke: env=$(cat "$envsh") link=$(ls -la "$link" 2>&1)"; fi
if "$A" grant w1 env:1BAD >/dev/null 2>&1; then bad "invalid env name accepted"; else ok "invalid env name rejected"; fi
if "$A" grant w1 file:/nonexistent >/dev/null 2>&1; then bad "missing file accepted"; else ok "missing file rejected"; fi
if "$A" grant w1 "file:$tmp/dev.env=../../etc/x" >/dev/null 2>&1; then bad "path traversal accepted"; else ok "remote path traversal rejected"; fi
"$A" rm w1 >/dev/null 2>&1 && [[ ! -f $BOXERY_HOME/grants/w1 ]] && ! grep -q '^Host w1.boxery' "$BOXERY_HOME/ssh_config" && ok "rm clears grants + ForwardAgent" || bad "rm cleanup"

# --- leases from the controller (local mode → fake backend)
if node --disable-warning=ExperimentalWarning -e 'require("node:sqlite")' 2>/dev/null; then
"$A" new lp1 >/dev/null 2>&1
BOXERY_SSH_WAIT_TRIES=2 "$BOXERY_HOST_BIN" pool add lp1 >/dev/null 2>&1 && ok "pool add via host" || bad "pool add"
out=$("$A" acquire --ttl 600 2>/dev/null) && set -- $out && [ "$1" = lp1 ] && ok "acquire → $1 $2" || bad "acquire: $out"
lid=${2:-x}
[ -f "$BOXERY_HOME/leases/$lid.lease" ] && [ -f "$BOXERY_HOME/leases/$lid.key" ] && ok "lease record + private key stored locally" || bad "local lease files"
[ "$(stat -c %a "$BOXERY_HOME/leases" 2>/dev/null || stat -f %Lp "$BOXERY_HOME/leases")" = 700 ] && ok "leases dir is 0700" || bad "leases dir perms"
grep -A2 "^Host lp1.boxery" "$BOXERY_HOME/ssh_config" | grep -q "IdentityFile $BOXERY_HOME/leases/$lid.key" && ok "ssh_config uses the lease key for lp1" || bad "ssh_config lease identity"
grep -q "boxery-lease" "$tmp/vms/lp1/home/.ssh/authorized_keys" && ok "lease key authorized in the VM" || bad "lease key not in VM"
"$A" leases | grep -q "^lp1 " && ok "leases lists it" || bad "leases"
"$A" renew lp1 >/dev/null 2>&1 && ok "renew by name" || bad "renew"
if "$A" acquire >/dev/null 2>&1; then bad "second acquire on a 1-VM pool succeeded"; else ok "pool exhausted for a second acquire"; fi
"$A" release lp1 >/dev/null 2>&1 && ok "release" || bad "release"
[ ! -f "$BOXERY_HOME/leases/$lid.lease" ] && [ ! -f "$BOXERY_HOME/leases/$lid.key" ] && ok "release forgets the lease and deletes its key" || bad "lease files left"
! grep -q "^Host lp1.boxery" "$BOXERY_HOME/ssh_config" && ok "ssh_config entry removed" || bad "ssh_config entry left"
! grep -q "boxery-lease" "$tmp/vms/lp1/home/.ssh/authorized_keys" && ok "VM no longer accepts the old lease key" || bad "old lease key still authorized"
"$A" acquire >/dev/null 2>&1 && ok "VM can be acquired again after release" || bad "re-acquire"
else echo "  - node:sqlite unavailable; skipping lease checks"; fi

# --- concurrent grant/revoke must not corrupt the store or the guest state (P1 #9)
"$A" new w4 >/dev/null 2>&1
for i in 1 2 3 4 5 6; do env "V$i=x" "$A" grant w4 "env:V$i" >/dev/null 2>&1 & done; wait
[ "$(grep -c '^env' "$BOXERY_HOME/grants/w4")" = 6 ] && ok "6 parallel grants → 6 entries" || bad "grant store: $(cat "$BOXERY_HOME/grants/w4")"
for i in 1 2 3 4 5 6; do "$A" revoke w4 "env:V$i" >/dev/null 2>&1 & done; wait
[ ! -f "$BOXERY_HOME/grants/w4" ] && ok "6 parallel revokes → store empty" || bad "left: $(cat "$BOXERY_HOME/grants/w4" 2>/dev/null)"
"$A" rm w4 >/dev/null 2>&1 || true

# --- regression (code review P0 #1): args must not be re-parsed by the host shell
"$A" new w2 >/dev/null 2>&1
rm -f "$tmp/pwned"
"$A" snap w2 "x; touch $tmp/pwned #" >/dev/null 2>&1 || true
[ ! -e "$tmp/pwned" ] && ok "snapshot name cannot inject commands (local mode)" || bad "INJECTION via snapshot name"
if "$A" new w3 --cpus '1; touch '"$tmp"'/pwned' >/dev/null 2>&1; then bad "non-numeric --cpus accepted"; else ok "non-numeric --cpus rejected"; fi
[ ! -e "$tmp/pwned" ] && ok "--cpus cannot inject" || bad "INJECTION via --cpus"
# remote mode: an ssh stub that, like real ssh, joins argv into one string and runs it with sh -c
cat >"$tmp/bin/sshjoin" <<STUB2
#!/usr/bin/env bash
while [ \$# -gt 0 ]; do case \$1 in -o|-F|-p) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift  # destination
exec sh -c "\$*"
STUB2
chmod +x "$tmp/bin/sshjoin"
rm -f "$tmp/pwned"
( export BOXERY_HOST=fakehost; ssh() { "$tmp/bin/sshjoin" "$@"; }; export -f ssh
  . /dev/stdin <<<"$(sed -n '/^quote_args()/p' "$A")"
  cmdline="echo$(quote_args snap w2 "x; touch $tmp/pwned #")"
  sh -c "$cmdline" >/dev/null )
[ ! -e "$tmp/pwned" ] && ok "remote transport quotes every argument" || bad "INJECTION via remote transport"
"$A" rm w2 >/dev/null 2>&1 || true

echo; echo "passed: $pass  failed: $fail"; [ "$fail" -eq 0 ]
