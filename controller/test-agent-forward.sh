#!/usr/bin/env bash
# Local-only config regression test; no network or VM needed.
set -eu
CLI="$(cd "$(dirname "$0")" && pwd)/agentvm"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export AGENTVM_HOME="$tmp/config"
export AGENTVM_HOST=test-host
mkdir -p "$AGENTVM_HOME" "$tmp/bin"
printf '#!/bin/sh\nexit 0\n' > "$tmp/bin/ssh"
chmod +x "$tmp/bin/ssh"
printf 'test public key\n' > "$tmp/key.pub"
export PATH="$tmp/bin:$PATH"

bash "$CLI" agent-forward demo on >/dev/null
# Use real ssh -G to resolve config (fake ssh is only for setup's network calls).
SSH=$(command -p -v ssh)
get_forward() { "$SSH" -F "$AGENTVM_HOME/ssh_config" -G "$1.avm" 2>/dev/null | grep '^forwardagent '; }
[ "$(get_forward demo)" = 'forwardagent yes' ]
[ "$(get_forward other)" = 'forwardagent no' ]
bash "$CLI" setup test-host --key "$tmp/key.pub" >/dev/null
[ "$(get_forward demo)" = 'forwardagent yes' ]
bash "$CLI" agent-forward second on >/dev/null
bash "$CLI" agent-forward demo off >/dev/null
[ "$(get_forward demo)" = 'forwardagent no' ]
[ "$(get_forward second)" = 'forwardagent yes' ]
for name in '../escape' 'bad name' '*.avm'; do
    if bash "$CLI" agent-forward "$name" on >/dev/null 2>&1; then
        echo "FAIL: accepted invalid name $name" >&2; exit 1
    fi
done
if bash "$CLI" agent-forward demo invalid >/dev/null 2>&1; then
    echo 'FAIL: accepted invalid mode' >&2; exit 1
fi
echo 'PASS: opt-in, default-off, setup persistence, multiple VMs, disable, validation'
