#!/usr/bin/env bash
# End-to-end test, run from the CONTROLLER (Linux or macOS) after `boxery setup user@host`.
# Creates a throwaway VM, exercises every path, then deletes it.
set -euo pipefail
A=${BOXERY:-$(cd "$(dirname "$0")" && pwd)/controller/boxery}
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
out=$("$A" run "$VM" bash -c 'pi --version; opencode --version; systemctl --user is-active boxery-vnc boxery-desktop boxery-novnc | sort -u; curl -fsS 127.0.0.1:8088/healthz')
grep -q '^active$' <<<"$out" && ok "desktop services active" || bad "desktop services: $out"
grep -q '^ok$' <<<"$out" && ok "LLM proxy reachable from the guest" || bad "proxy"

echo "== isolation"
code=$("$A" run "$VM" bash -c 'curl -s -o /dev/null -w %{http_code} -H "Authorization: Bearer x:y" 127.0.0.1:8088/ollama/v1/models')
[[ $code == 401 ]] && ok "forged token rejected" || bad "forged token got $code"
# The guest reaches the host's proxy, and no other loopback port, at the address its bridge uses (#67).
# Only for a TCP upstream (Lima: the gateway that maps to the host's 127.0.0.1) with the host on this
# machine, where this script can open a second loopback listener for the guest to probe.
up=$("$A" run "$VM" cat /etc/boxery/proxy-upstream 2>/dev/null || true)
dest=$("$A" host ls --json 2>/dev/null | jq -rs 'flatten | map(select(.default))[0].destination // empty' 2>/dev/null || true)
if [[ $up =~ ^TCP:([0-9.]+):([0-9]+)$ && ${BASH_REMATCH[1]} != 127.* && $dest == local ]]; then
	gw=${BASH_REMATCH[1]} pport=${BASH_REMATCH[2]} lf=$(mktemp)
	(node -e 'const s = require("http").createServer((q, r) => r.end("x")).listen(0, "127.0.0.1", () => console.log(s.address().port))' >"$lf" & echo $! >"$lf.pid")
	for _ in $(seq 50); do [[ -s $lf ]] && break; sleep 0.1; done
	lport=$(cat "$lf")
	r=$("$A" run "$VM" bash -c "for u in $gw:$pport/healthz $gw:$lport/; do curl -s -o /dev/null -w '%{http_code} ' --max-time 5 http://\$u; done" || true)
	kill "$(cat "$lf.pid")" 2>/dev/null || true; rm -f "$lf" "$lf.pid"
	read -r pcode lcode <<<"$r" || true
	[[ $pcode == 200 ]] && ok "proxy reachable at $gw:$pport" || bad "proxy at $gw:$pport: HTTP ${pcode:-?}"
	[[ $lcode == 000 ]] && ok "another host loopback port ($gw:$lport) is refused" || bad "guest reached the host's 127.0.0.1:$lport through $gw (HTTP ${lcode:-?})"
else
	echo "  - loopback probe skipped (upstream ${up:-unknown}, host ${dest:-unknown})"
fi
code=$("$A" run "$VM" bash -c 'curl -s -o /dev/null -w %{http_code} -H "Authorization: Bearer $(cat ~/.boxery/token)" 127.0.0.1:8088/ollama/v1/models')
[[ $code == 403 ]] && ok "no LLM access without an llm: grant" || bad "ungranted LLM route got $code"
"$A" grant "$VM" llm:chatgpt llm:ollama >/dev/null
code=$("$A" run "$VM" bash -c 'curl -s -o /dev/null -w %{http_code} -H "Authorization: Bearer $(cat ~/.boxery/token)" -H "content-type: application/json" -d "{}" 127.0.0.1:8088/anthropic/v1/messages')
[[ $code == 403 ]] && ok "granting chatgpt/ollama doesn't open anthropic" || bad "ungranted anthropic got $code"

echo "== pi (ChatGPT via host proxy)"
r=$("$A" run "$VM" bash -c 'cd ~/project && timeout 180 pi -p "Reply with exactly: PI_OK" </dev/null 2>&1 | tail -1')
[[ $r == *PI_OK* ]] && ok "pi answered" || bad "pi: $r"

echo "== opencode (ollama via host proxy)"
r=$("$A" run "$VM" bash -c 'cd ~/project && timeout 240 opencode run "Reply with exactly: OC_OK" 2>&1 | tail -1')
[[ $r == *OC_OK* ]] && ok "opencode answered" || bad "opencode: $r (is ollama running on the host?)"

echo "== background task"
"$A" prompt "$VM" "Create answer.txt containing just the number 42. Do nothing else." >/dev/null
for _ in $(seq 36); do "$A" run "$VM" bash -c 'grep -q "task finished" ~/project/.boxery/*.log 2>/dev/null' && break; sleep 5; done
check "task wrote answer.txt" "$A" run "$VM" bash -c 'grep -q 42 ~/project/answer.txt'

echo "== desktop over ssh tunnel"
"$A" desktop "$VM" --no-open >/tmp/boxery-e2e-desk.$$ 2>&1 & tun=$!
sleep 3; port=$(grep -o '127.0.0.1:[0-9]*' /tmp/boxery-e2e-desk.$$ | head -1 | cut -d: -f2)
check "noVNC served on localhost:$port" curl -fsS "http://127.0.0.1:$port/vnc.html"
grep -Eq "vnc\.html\?[^#]*#password=[A-Za-z0-9]{8} " /tmp/boxery-e2e-desk.$$ && ok "desktop URL carries the session's VNC password in the fragment" || bad "desktop URL: $(cat /tmp/boxery-e2e-desk.$$)"
kill "$tun" 2>/dev/null || true; tun=""; rm -f /tmp/boxery-e2e-desk.$$
# The VNC server offers VncAuth (2) only, never None (1); its password file is the agent's, 0600, on tmpfs.
out=$("$A" run "$VM" python3 -c 'import socket; s = socket.create_connection(("127.0.0.1", 5901)); s.recv(12); s.sendall(b"RFB 003.008\n"); n = s.recv(1)[0]; print(list(s.recv(n)))' 2>/dev/null || true)
[[ $out == "[2]" ]] && ok "VNC requires a password" || bad "VNC security types: $out"
out=$("$A" run "$VM" bash -c 'stat -c "%a %U" "/run/user/$(id -u)/boxery-vnc/passwd"' 2>/dev/null || true)
[[ $out == "600 agent" ]] && ok "VNC password file is the agent's, 0600" || bad "VNC password file: $out"

echo "== laptop pi extension (vm_* tools, with the user's other extensions loaded)"
if command -v pi >/dev/null; then
	ext=$(cd "$(dirname "$0")" && pwd)/extension/index.ts
	lt=$(mktemp -d)
	r=$(cd "$lt" && timeout 240 pi --no-session -e "$ext" --vm "$VM" -p "Use vm_bash to run hostname, then vm_write ext.txt containing EXT_OK, then run hostname with the local bash tool. Reply with exactly: VM=<vm hostname> LOCAL=<local hostname>" </dev/null 2>&1 | sed 's/\x1b\][^\x07]*\x07//g' | tail -1)
	[[ $r == *"VM=$VM"* ]] && ok "vm_bash ran in VM" || bad "vm_bash: $r"
	[[ $r == *"LOCAL=$(hostname)"* ]] && ok "built-in bash stayed local" || bad "local bash: $r"
	check "vm_write landed in VM" "$A" run "$VM" bash -c 'grep -q EXT_OK ~/project/ext.txt'
	[[ ! -e $lt/ext.txt ]] && ok "nothing written locally" || bad "file leaked to laptop"
	rm -rf "$lt"
else
	echo "  - pi not installed, skipping"
fi

echo "== MCP server (stdio + http)"
if mout=$("$(cd "$(dirname "$0")" && pwd)/mcp/test-mcp.sh" "$VM" 2>&1); then ok "MCP: $(tail -1 <<<"$mout")"; else bad "MCP: $(grep '✗' <<<"$mout" | head -3)"; fi

echo "== grants (env + file pushed to tmpfs, revoke removes them)"
gtmp=$(mktemp -d); printf 'E2E_FILE_OK\n' >"$gtmp/e2e.env"
E2E_GRANT_VAR=e2e-grant-ok "$A" grant "$VM" env:E2E_GRANT_VAR "file:$gtmp/e2e.env=project/.env" >/dev/null
check "env grant visible in login shell" "$A" run "$VM" bash -c 'bash -lc "test \"\$E2E_GRANT_VAR\" = e2e-grant-ok"'
check "file grant linked into project (tmpfs)" "$A" run "$VM" bash -c 'grep -q E2E_FILE_OK ~/project/.env && readlink ~/project/.env | grep -q ^/run/user/'
check "file grant git-excluded" "$A" run "$VM" bash -c 'cd ~/project && ! git status --porcelain | grep -q "\.env"'
"$A" revoke "$VM" all >/dev/null
check "revoke removed env + file" "$A" run "$VM" bash -c 'bash -lc "test -z \"\${E2E_GRANT_VAR:-}\"" && ! test -e ~/project/.env'
rm -rf "$gtmp"

echo "== edge grants (http: — credential injected by the host proxy, never in the VM)"
if command -v gh >/dev/null && gh auth token >/dev/null 2>&1; then
	"$A" grant "$VM" github --readonly >/dev/null 2>&1 && ok "grant github --readonly" || bad "grant github"
	repo=${BOXERY_E2E_PRIVATE_REPO:-modem-dev/boxery}
	check "git ls-remote https://github.com/$repo via the edge" "$A" run "$VM" bash -c "git ls-remote https://github.com/$repo HEAD | grep -q HEAD"
	check "GitHub API via \$BOXERY_EDGE" "$A" run "$VM" bash -c 'bash -lc "curl -sf \"\$BOXERY_EDGE/api.github.com/user\" | grep -q login"'
	check "read-only grant blocks writes" "$A" run "$VM" bash -c 'bash -lc "test \$(curl -s -o /dev/null -w %{http_code} -X POST \"\$BOXERY_EDGE/api.github.com/user/repos\" -d {}) = 403"'
	check "token is nowhere in the VM" bash -c "gh auth token | '$A' run '$VM' bash -c 'T=\$(cat); ! grep -rqsF -e \"\$T\" /run/user/\$(id -u) ~ 2>/dev/null && ! env | grep -qF -e \"\$T\"'"
	# Revocation is checked at the proxy: the VM's edge URL from before must now be refused. (A public
	# repo stays readable without credentials, so git can only show it for a private one.)
	edge=$("$A" run "$VM" bash -lc 'echo "$BOXERY_EDGE"')
	"$A" revoke "$VM" github >/dev/null 2>&1
	check "revoke cuts access (the VM's edge URL gets 403)" "$A" run "$VM" bash -c "test \$(curl -s -o /dev/null -w %{http_code} '$edge/api.github.com/user') = 403"
	if [[ -n ${BOXERY_E2E_PRIVATE_REPO:-} ]]; then
		check "revoke cuts git access to $repo" "$A" run "$VM" bash -c "! git ls-remote https://github.com/$repo HEAD >/dev/null 2>&1"
	fi
else
	echo "  - gh not logged in on this machine; skipping"
fi

echo "== leases (the test VM joins the pool for this section)"
if "$A" pool add "$VM" >/dev/null 2>&1; then
	check "pool VM refuses non-holders (incl. connections opened before pool add)" bash -c "! '$A' run '$VM' true"
	# Other FREE pool VMs may exist: keep acquiring until we hold ours, then give the others back.
	held=(); LID=""
	while lout=$("$A" acquire --ttl 120 2>/dev/null); do
		set -- $lout
		if [[ $1 == "$VM" ]]; then LID=$2; break; fi
		held+=("$1")
	done
	for o in ${held[@]+"${held[@]}"}; do "$A" release "$o" >/dev/null 2>&1 || true; done
	if [[ -n $LID ]]; then
		ok "acquire → $VM"
		check "lease holder can use it" "$A" run "$VM" bash -c 'echo lease-work > ~/project/lease.txt'
		# Lease keys and ssh_config live in the default host's profile directory.
		pdir=$("$A" host ls --json | jq -r 'map(select(.default))[0].dir')
		stale=/tmp/boxery-e2e-stale.$$; cp "$pdir/leases/$LID.key" "$stale"
		"$A" release "$VM" >/dev/null 2>&1 && ok "release" || bad release
		check "released lease key is locked out" bash -c "! ssh -F '$pdir/ssh_config' -i '$stale' -o IdentitiesOnly=yes -o BatchMode=yes '$VM.boxery' true"
		rm -f "$stale"
		"$A" pool rm "$VM" >/dev/null 2>&1 && ok "pool rm" || bad "pool rm"
		check "reset on release: work from the lease is gone" "$A" run "$VM" bash -c 'test ! -e ~/project/lease.txt'
	else
		bad "could not acquire $VM from the pool"
		"$A" pool rm "$VM" --force >/dev/null 2>&1 || true
	fi
	check "VM usable again after leaving the pool" "$A" run "$VM" true
else
	bad "pool add $VM"
fi

echo "== snapshot / revert"
"$A" snap "$VM" e2e >/dev/null
"$A" run "$VM" bash -c 'rm -f ~/project/answer.txt'
"$A" revert "$VM" e2e >/dev/null
check "revert restored answer.txt" "$A" run "$VM" bash -c 'test -f ~/project/answer.txt'
[[ $("$A" run "$VM" hostname) == "$VM" ]] && ok "revert kept the VM's identity" || bad "hostname after revert"
"$A" rm "${VM}s" >/dev/null 2>&1 || true
"$A" new "${VM}s" --from "$VM@e2e" >/dev/null && check "new --from a snapshot has its files" "$A" run "${VM}s" bash -c 'test -f ~/project/answer.txt' || bad "new --from"
"$A" rm "${VM}s" >/dev/null 2>&1 || true

echo "== fork (running VM → 2 copies)"
"$A" run "$VM" bash -c 'echo fork-me > ~/project/fork.txt'
t0=$(date +%s)
if "$A" fork "$VM" "${VM}a" "${VM}b" >/dev/null; then
	ok "forked into 2 in $(($(date +%s) - t0))s"
	for f in "${VM}a" "${VM}b"; do
		r=$("$A" run "$f" bash -c 'echo "$(hostname) $(cat ~/project/fork.txt) $(curl -fsS 127.0.0.1:8088/healthz)"')
		[[ $r == "$f fork-me ok" ]] && ok "$f: own hostname, src's files, proxy works" || bad "$f: $r"
	done
	"$A" run "${VM}a" bash -c 'echo only-a > ~/project/a.txt'
	check "forks are independent" "$A" run "${VM}b" bash -c '! test -e ~/project/a.txt'
	check "source kept running" "$A" run "$VM" true
	[[ $("$A" run "${VM}a" bash -c 'cat /etc/machine-id') != $("$A" run "${VM}b" bash -c 'cat /etc/machine-id') ]] && ok "forks have distinct machine-ids" || bad "same machine-id"
else
	bad "fork"
fi
"$A" rm "${VM}a" >/dev/null 2>&1 || true; "$A" rm "${VM}b" >/dev/null 2>&1 || true

echo "== resize (running VM: restart, new size inside the guest)"
n=$("$A" run "$VM" nproc); m=$((n + 1))
if "$A" resize "$VM" --cpus "$m" >/dev/null; then
	[[ $("$A" run "$VM" nproc) == "$m" ]] && ok "resize $n → $m vCPUs, visible in the guest" || bad "nproc after resize: $("$A" run "$VM" nproc)"
	check "VM still has its files after resize" "$A" run "$VM" test -f answer.txt
else
	bad "resize"
fi

echo "== rm"
"$A" rm "$VM" >/dev/null && ok "removed" || bad "rm"
trap - EXIT
echo; echo "passed: $pass  failed: $fail"
((fail == 0))
