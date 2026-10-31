#!/usr/bin/env bash
# Static checks: shellcheck (warnings are errors), node syntax checks.
set -euo pipefail
cd "$(dirname "$0")/.."
shellcheck -S warning controller/agentvm host/agentvm-host host/backends/*.sh e2e.sh mcp/test-mcp.sh test/shell/*.sh
for f in core/*.mjs mcp/*.mjs proxy/*.mjs test/*.mjs; do node --check "$f"; done
bash -n controller/agentvm host/agentvm-host
echo "lint ok"
