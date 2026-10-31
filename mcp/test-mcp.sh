#!/usr/bin/env bash
# MCP server protocol test against a live VM (stdio + HTTP). Usage: mcp/test-mcp.sh VM
set -euo pipefail
VM=${1:?usage: test-mcp.sh VM}
S=$(cd "$(dirname "$0")" && pwd)/boxery-mcp.mjs
pass=0; fail=0
ok() { echo "  ✓ $*"; pass=$((pass + 1)); }
bad() { echo "  ✗ $*"; fail=$((fail + 1)); }
init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}'

echo "== stdio"
out=$({ printf '%s\n' "$init" '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
	'{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
	'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"vm_bash","arguments":{"command":"hostname"}}}' \
	'{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"vm_write","arguments":{"path":"mcp-test.txt","content":"a\nb\n"}}}'
	sleep 4
	printf '%s\n' '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"vm_edit","arguments":{"path":"mcp-test.txt","edits":[{"oldText":"b","newText":"MCP_OK"}]}}}'
	sleep 3
	printf '%s\n' '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"vm_read","arguments":{"path":"mcp-test.txt"}}}' \
	'{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"vm_screenshot","arguments":{}}}' \
	'{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"vm_bash","arguments":{"command":"exit 3"}}}' \
	'{"jsonrpc":"2.0","id":9,"method":"nope"}' \
	'{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"vm_browser","arguments":{"code":"await page.setContent(\"<title>BROWSER_OK</title>\"); return await page.title();","screenshot":true}}}'
	sleep 8; } | node "$S" --vm "$VM" 2>/dev/null)
r() { jq -c "select(.id==$1)" <<<"$out"; }
[[ $(r 1 | jq -r .result.serverInfo.name) == boxery ]] && ok initialize || bad "initialize: $(r 1)"
[[ $(r 2 | jq '.result.tools | length') -ge 12 ]] && ok "tools/list ($(r 2 | jq '.result.tools|length') tools)" || bad tools/list
[[ $(r 3 | jq -r '.result.content[0].text') == "$VM"* ]] && ok "vm_bash" || bad "vm_bash: $(r 3)"
[[ $(r 6 | jq -r '.result.content[0].text') == *MCP_OK* ]] && ok "vm_write + vm_edit + vm_read" || bad "edit/read: $(r 5) $(r 6)"
[[ $(r 7 | jq -r '.result.content[1].type') == image ]] && ok "vm_screenshot returns image" || bad "screenshot: $(r 7 | cut -c1-200)"
[[ $(r 8 | jq -r .result.isError) == true ]] && ok "non-zero exit → isError" || bad "exit 3: $(r 8)"
[[ $(r 9 | jq -r .error.code) == -32601 ]] && ok "unknown method → -32601" || bad "unknown method: $(r 9)"
[[ $(r 10 | jq -r '.result.content[0].text') == *BROWSER_OK* && $(r 10 | jq -r '.result.content[1].type') == image ]] && ok "vm_browser controls sandboxed Chromium + screenshot" || bad "browser: $(r 10 | cut -c1-500)"

echo "== http"
port=$((20000 + RANDOM % 20000)); tok=$(openssl rand -hex 16)
BOXERY_MCP_TOKEN=$tok node "$S" --http "127.0.0.1:$port" --vm "$VM" 2>/dev/null & pid=$!
trap 'kill $pid 2>/dev/null || true' EXIT
for _ in $(seq 50); do curl -fs "127.0.0.1:$port/healthz" >/dev/null && break; sleep 0.1; done
U="http://127.0.0.1:$port/mcp"; H=(-H "content-type: application/json" -H "accept: application/json, text/event-stream")
[[ $(curl -s -o /dev/null -w '%{http_code}' "${H[@]}" -d "$init" "$U") == 401 ]] && ok "no token → 401" || bad "no token"
[[ $(curl -s -o /dev/null -w '%{http_code}' "${H[@]}" -H "authorization: Bearer $tok" -H "origin: https://evil.example" -d "$init" "$U") == 403 ]] && ok "foreign Origin → 403" || bad origin
sid=$(curl -s -D - -o /dev/null "${H[@]}" -H "authorization: Bearer $tok" -d "$init" "$U" | awk -F': ' 'tolower($1)=="mcp-session-id"{print $2}' | tr -d '\r')
[[ -n $sid ]] && ok "initialize → Mcp-Session-Id" || bad "no session id"
res=$(curl -s "${H[@]}" -H "authorization: Bearer $tok" -H "mcp-session-id: $sid" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"vm_bash","arguments":{"command":"hostname"}}}' "$U")
[[ $(jq -r '.result.content[0].text' <<<"$res") == "$VM"* ]] && ok "vm_bash over http" || bad "http vm_bash: $res"
[[ $(curl -s -o /dev/null -w '%{http_code}' "${H[@]}" -H "authorization: Bearer $tok" -d '{"jsonrpc":"2.0","id":3,"method":"tools/list"}' "$U") == 404 ]] && ok "missing session → 404" || bad "missing session"

echo; echo "passed: $pass  failed: $fail"
((fail == 0))
