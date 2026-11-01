#!/usr/bin/env bash
# Static checks: shellcheck (warnings are errors), node syntax checks.
set -euo pipefail
cd "$(dirname "$0")/.."
shellcheck -S warning controller/boxery host/boxery-host host/backends/*.sh e2e.sh mcp/test-mcp.sh test/shell/*.sh
for f in core/*.mjs host/*.mjs mcp/*.mjs proxy/*.mjs test/*.mjs; do node --check "$f"; done
bash -n controller/boxery host/boxery-host
echo "lint ok"
