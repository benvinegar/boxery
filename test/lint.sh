#!/usr/bin/env bash
# Static checks: shellcheck (warnings are errors), node syntax checks.
set -euo pipefail
cd "$(dirname "$0")/.."
shellcheck -S warning controller/boxery core/boxery-job-runner.sh host/boxery-host host/backend.sh host/backends/*.sh host/backends/lib/*.sh image/layers/*.sh e2e.sh mcp/test-mcp.sh test/shell/*.sh test/bench/*.sh
for f in controller/*.mjs core/*.mjs guests/*.mjs host/*.mjs mcp/*.mjs proxy/*.mjs test/*.mjs test/fixtures/*.mjs evals/*.mjs evals/lib/*.mjs; do node --check "$f"; done
# VM-side TypeScript runs under type stripping: it must parse (types are checked by `npm run typecheck`)
# (only where this Node can strip types: 22.18+/23.6+; older Node skips it, like the job tests)
if node --experimental-strip-types --disable-warning=ExperimentalWarning --input-type=module-typescript -e '' 2>/dev/null; then
	for f in core/*.ts; do node --experimental-strip-types --disable-warning=ExperimentalWarning --check "$f"; done
else echo "lint: skipping core/*.ts (this node can't strip types)"; fi
for f in controller/boxery core/boxery-job-runner.sh host/boxery-host host/backend.sh host/backends/*.sh host/backends/lib/*.sh; do bash -n "$f"; done   # bash -n: catches bash 3.2 parse errors when run on macOS
echo "lint ok"
