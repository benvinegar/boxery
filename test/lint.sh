#!/usr/bin/env bash
# Static checks: shellcheck (warnings are errors), node syntax checks.
set -euo pipefail
cd "$(dirname "$0")/.."
shellcheck -S warning controller/boxery controller/jobs.sh host/boxery-host host/backend.sh host/backends/*.sh image/layers/*.sh e2e.sh mcp/test-mcp.sh test/shell/*.sh test/bench/*.sh
for f in core/*.mjs host/*.mjs mcp/*.mjs proxy/*.mjs test/*.mjs test/fixtures/*.mjs; do node --check "$f"; done
for f in controller/boxery controller/jobs.sh host/boxery-host host/backend.sh host/backends/*.sh; do bash -n "$f"; done   # bash -n: catches bash 3.2 parse errors when run on macOS
echo "lint ok"
