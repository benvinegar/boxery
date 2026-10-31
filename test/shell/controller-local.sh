#!/usr/bin/env bash
# Controller in local mode against the fake backend: setup, new/ls/rm, grants storage + apply script.
# shellcheck disable=SC1090  # sources the generated env.sh under test
# The "VM" is a local directory; an ssh stub executes remote scripts locally with HOME=that dir.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
A=$ROOT/controller/agentvm
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export AGENTVM_CONF=$tmp/hostconf AGENTVM_HOME=$tmp/ctl AGENTVM_BACKEND=fake AGENTVM_FAKE_DIR=$tmp/vms
export AGENTVM_HOST_BIN=$ROOT/host/agentvm-host AGENTVM_RUNTIME_DIR=$tmp/run
mkdir -p "$tmp/bin" "$AGENTVM_CONF" "$tmp/run" "$tmp/home/.ssh"
echo "ssh-ed25519 AAAAtest mgmt" >"$AGENTVM_CONF/mgmt_ed25519.pub"; touch "$AGENTVM_CONF/mgmt_ed25519"
echo "ssh-ed25519 AAAAme me@laptop" >"$tmp/home/.ssh/id_ed25519.pub"; touch "$tmp/home/.ssh/id_ed25519"
# ssh stub: control-master ops succeed; "NAME.avm 'bash -s'" runs the script locally in the VM dir.
cat >"$tmp/bin/ssh" <<STUB
#!/usr/bin/env bash
for a in "\$@"; do case \$a in -O) exit 0 ;; esac; done
host=""; while [ \$# -gt 0 ]; do case \$1 in -F|-o|-p) shift 2 ;; *.avm) host=\${1%.avm}; shift; break ;; *) shift ;; esac; done
[ -n "\$host" ] || exit 0
vm=$tmp/vms/\$host; [ -d "\$vm" ] || { echo "no such vm" >&2; exit 255; }
mkdir -p "\$vm/home/project/.git/info"
cd "\$vm/home" && HOME="\$vm/home" exec bash -c "\$*"
STUB
chmod +x "$tmp/bin/ssh"; export PATH="$tmp/bin:$PATH"
pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }

HOME=$tmp/home "$A" setup local >/dev/null 2>&1 && ok "setup local" || bad "setup local"
grep -q "^HOST=local" "$AGENTVM_HOME/config" && ok "config records HOST=local" || bad "config"
grep -q "ProxyCommand $ROOT/host/agentvm-host connect %h %p" "$AGENTVM_HOME/ssh_config" && ok "ProxyCommand runs agentvm-host directly" || bad "ProxyCommand: $(grep ProxyCommand "$AGENTVM_HOME/ssh_config")"
grep -q AAAAme "$AGENTVM_CONF/authorized_keys" && ok "setup registered the key with the local host" || bad "key not registered"
"$AGENTVM_HOST_BIN" build-base >/dev/null 2>&1
"$A" new w1 >/dev/null 2>&1 && ok "new via local host" || bad "new"
"$A" ls 2>/dev/null | grep -q '^w1 ' && ok "ls shows the VM with GRANTS column" || bad "ls"

printf 'SECRET_FILE=1\n' >"$tmp/dev.env"
export MY_TOKEN='va lue $with "quotes"'
"$A" grant w1 ssh-agent env:MY_TOKEN env:FROM_CMD --cmd 'echo computed' "file:$tmp/dev.env=project/.env" >/dev/null 2>&1 && ok "grant" || bad "grant"
! grep -q 'va lue' "$AGENTVM_HOME/grants/w1" && ok "grant store holds names, not values" || bad "value leaked into grant store"
grep -q '^Host w1.avm' "$AGENTVM_HOME/ssh_config" && ok "ssh-agent grant → ForwardAgent for that VM" || bad "ForwardAgent"
envsh=$tmp/run/agentvm/env.sh
[[ -f $envsh ]] && (unset MY_TOKEN; . "$envsh"; [[ $MY_TOKEN == 'va lue $with "quotes"' && $FROM_CMD == computed ]]) && ok "env values pushed and shell-safe" || bad "env.sh: $(cat "$envsh" 2>/dev/null)"
link=$tmp/vms/w1/home/project/.env
[[ -L $link ]] && grep -q SECRET_FILE "$link" && ok "file grant linked into project" || bad "file link"
grep -qx '/.env' "$tmp/vms/w1/home/project/.git/info/exclude" && ok "file grant git-excluded" || bad "exclude"
"$A" revoke w1 env:MY_TOKEN "file:$tmp/dev.env" >/dev/null 2>&1
if (unset MY_TOKEN; . "$envsh"; [[ -z ${MY_TOKEN:-} && $FROM_CMD == computed ]]) && [[ ! -e $link && ! -L $link ]]; then ok "revoke removes exactly the revoked items"; else bad "revoke: env=$(cat "$envsh") link=$(ls -la "$link" 2>&1)"; fi
if "$A" grant w1 env:1BAD >/dev/null 2>&1; then bad "invalid env name accepted"; else ok "invalid env name rejected"; fi
if "$A" grant w1 file:/nonexistent >/dev/null 2>&1; then bad "missing file accepted"; else ok "missing file rejected"; fi
if "$A" grant w1 "file:$tmp/dev.env=../../etc/x" >/dev/null 2>&1; then bad "path traversal accepted"; else ok "remote path traversal rejected"; fi
"$A" rm w1 >/dev/null 2>&1 && [[ ! -f $AGENTVM_HOME/grants/w1 ]] && ! grep -q '^Host w1.avm' "$AGENTVM_HOME/ssh_config" && ok "rm clears grants + ForwardAgent" || bad "rm cleanup"

echo; echo "passed: $pass  failed: $fail"; [ "$fail" -eq 0 ]
