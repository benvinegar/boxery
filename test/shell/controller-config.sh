#!/usr/bin/env bash
# Local-only config regression test; no network or VM needed.
set -eu
CLI="$(cd "$(dirname "$0")/../.." && pwd)/controller/boxery"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export BOXERY_HOME="$tmp/config" HOME="$tmp/home"
P="$tmp/profile"
mkdir -p "$BOXERY_HOME" "$HOME/.ssh" "$tmp/bin" "$P"
printf "HOST='test-host'\nGRANT_CONFIRM=off\n" >"$P/config"; : >"$P/ssh_config"
bash "$(cd "$(dirname "$0")/../.." && pwd)/controller/boxery" host add test-host --config-dir "$P" >/dev/null
printf '#!/bin/sh\nexit 0\n' > "$tmp/bin/ssh"
chmod +x "$tmp/bin/ssh"
printf 'test public key\n' > "$tmp/key.pub"
REAL_SSH=$(command -v ssh) || { echo "SKIP: no ssh client"; exit 0; }
export PATH="$tmp/bin:$PATH"

bash "$CLI" agent-forward demo on >/dev/null
# Use the real ssh -G to resolve config (the fake ssh on PATH only stubs setup's network calls).
SSH=$REAL_SSH
get_forward() { "$SSH" -F "$P/ssh_config" -G "$1.boxery" 2>/dev/null | grep '^forwardagent '; }
[ "$(get_forward demo)" = 'forwardagent yes' ]
[ "$(get_forward other)" = 'forwardagent no' ]
bash "$CLI" setup test-host --key "$tmp/key.pub" >/dev/null
echo 'GRANT_CONFIRM=off' >>"$P/config" # setup rewrites the config; opt in again for this automation fixture
[ "$(get_forward demo)" = 'forwardagent yes' ]
bash "$CLI" agent-forward second on >/dev/null
bash "$CLI" agent-forward demo off >/dev/null
[ "$(get_forward demo)" = 'forwardagent no' ]
[ "$(get_forward second)" = 'forwardagent yes' ]
for name in '../escape' 'bad name' '*.boxery'; do
    if bash "$CLI" agent-forward "$name" on >/dev/null 2>&1; then
        echo "FAIL: accepted invalid name $name" >&2; exit 1
    fi
done
if bash "$CLI" agent-forward demo invalid >/dev/null 2>&1; then
    echo 'FAIL: accepted invalid mode' >&2; exit 1
fi
echo 'PASS: opt-in, default-off, setup persistence, multiple VMs, disable, validation'
