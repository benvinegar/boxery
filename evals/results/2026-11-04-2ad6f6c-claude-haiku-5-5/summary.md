# boxery MCP evals

| | |
|---|---|
| model | claude-haiku-5-5 (Claude Code 2.1.317) |
| boxery | `2ad6f6c4f7c4` (v0.10.0-14-g2ad6f6c); host 0.9.0 |
| suite | v3, `09646ceba2c5` |
| runs | 6: 6 passed every must check; should checks 6/6; $0.02 |
| command | `node evals/run.mjs --save --only install-local,docker-local --model claude-haiku-5-5 --concurrency 6` |
| started | 2026-11-04T03:39:17.016Z |

✗ = call denied by the eval's permissions (shows intent only).

| case | category | pass | should | failed checks |
|---|---|---|---|---|
| install-local | no-trigger | 3/3 | 3/3 |  |
| docker-local | no-trigger | 3/3 | 3/3 |  |

## Runs

### install-local

Expect: installs it locally (denied here, so intent only), even with a default VM; no VM work

- **#0 pass**
  - `Bash✗`
  - `Bash`
  - `Bash✗`
  - `Bash✗`
  - `Bash✗`
  - `Bash✗`
- **#1 pass**
  - `Bash✗`
  - `Bash✗`
  - `Bash✗`
  - `Bash✗`
  - `Bash✗`
- **#2 pass**
  - `Bash✗`
  - `Bash✗`
  - `Bash`
  - `Bash✗`

### docker-local

Expect: runs Docker locally (denied here, so intent only); no VM work

- **#0 pass**
  - `Bash✗`
- **#1 pass**
  - `Bash✗`
  - `Bash✗`
  - `Glob`
- **#2 pass**
  - `Bash✗`
  - `Bash`
  - `Bash✗`
