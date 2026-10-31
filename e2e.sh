#!/usr/bin/env bash
# End-to-end test, run from the CONTROLLER (Linux or macOS) after `agentvm setup user@host`.
# Creates a throwaway VM, exercises every path, then deletes it.
set -euo pipefail
A=${AGENTVM:-$(cd "$(dirname "$0")" && pwd)/controller/agentvm}
VM=${1:-e2e$(date +%H%M%S)}
pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
cleanup() { "$A" rm "$VM" >/dev/null 2>&1 || true; [[ -n ${tun:-} ]] && kill "$tun" 2>/dev/null || true; }
trap cleanup EXIT

echo "== create $VM"
t0=$(date +%s); "$A" new "$VM" >/dev/null; ok "created in $(($(date +%s) - t0))s"

echo "== guest basics"
out=$("$A" run "$VM" 'pi --version; opencode --version; systemctl --user is-active agentvm-vnc agentvm-desktop agentvm-novnc | sort -u; curl -fsS 127.0.0.1:8088/healthz')
grep -q '^active$' <<<"$out" && ok "desktop services active" || bad "desktop services: $out"
grep -q '^ok$' <<<"$out" && ok "LLM proxy reachable over vsock" || bad "proxy"

echo "== isolation"
code=$("$A" run "$VM" 'curl -s -o /dev/null -w %{http_code} -H "Authorization: Bearer x:y" 127.0.0.1:8088/ollama/v1/models')
[[ $code == 401 ]] && ok "forged token rejected" || bad "forged token got $code"

echo "== pi (ChatGPT via host proxy)"
r=$("$A" run "$VM" 'cd ~/project && timeout 180 pi -p "Reply with exactly: PI_OK" </dev/null 2>&1 | tail -1')
[[ $r == *PI_OK* ]] && ok "pi answered" || bad "pi: $r"

echo "== opencode (ollama via host proxy)"
r=$("$A" run "$VM" 'cd ~/project && timeout 240 opencode run "Reply with exactly: OC_OK" 2>&1 | tail -1')
[[ $r == *OC_OK* ]] && ok "opencode answered" || bad "opencode: $r (is ollama running on the host?)"

echo "== background task"
"$A" prompt "$VM" "Create answer.txt containing just the number 42. Do nothing else." >/dev/null
for _ in $(seq 36); do "$A" run "$VM" 'grep -q "task finished" ~/project/.agentvm/*.log 2>/dev/null' && break; sleep 5; done
check "task wrote answer.txt" "$A" run "$VM" 'grep -q 42 ~/project/answer.txt'

echo "== desktop over ssh tunnel"
"$A" desktop "$VM" --no-open >/tmp/agentvm-e2e-desk.$$ 2>&1 & tun=$!
sleep 3; port=$(grep -o '127.0.0.1:[0-9]*' /tmp/agentvm-e2e-desk.$$ | head -1 | cut -d: -f2)
check "noVNC served on localhost:$port" curl -fsS "http://127.0.0.1:$port/vnc.html"
kill "$tun" 2>/dev/null || true; tun=""; rm -f /tmp/agentvm-e2e-desk.$$

echo "== snapshot / revert"
"$A" snap "$VM" e2e >/dev/null
"$A" run "$VM" 'rm -f ~/project/answer.txt'
"$A" revert "$VM" e2e >/dev/null
check "revert restored answer.txt" "$A" run "$VM" 'test -f ~/project/answer.txt'

echo "== rm"
"$A" rm "$VM" >/dev/null && ok "removed" || bad "rm"
trap - EXIT
echo; echo "passed: $pass  failed: $fail"
((fail == 0))
