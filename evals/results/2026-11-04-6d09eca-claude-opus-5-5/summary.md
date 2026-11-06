# boxery MCP evals

| | |
|---|---|
| model | claude-opus-5-5 (Claude Code 2.1.317) |
| boxery | `6d09eca4bf07` (v0.10.0-25-g6d09eca); host 0.9.0 |
| suite | v4, `77564a29a51e` |
| runs | 18: 18 passed every must check; should checks 21/21; $2 |
| command | `node evals/run.mjs --save --only untrusted-script,linux-tests,browser,install-local,docker-local,background-job --model claude-opus-5-5 --concurrency 6` |
| started | 2026-11-04T13:11:41.526Z |

✗ = call denied by the eval's permissions (shows intent only).

| case | category | pass | should | failed checks |
|---|---|---|---|---|
| untrusted-script | trigger | 3/3 | 6/6 |  |
| linux-tests | trigger | 3/3 | – |  |
| browser | trigger | 3/3 | 6/6 |  |
| install-local | no-trigger | 3/3 | 3/3 |  |
| docker-local | no-trigger | 3/3 | 3/3 |  |
| background-job | routing | 3/3 | 3/3 |  |

## Runs

### untrusted-script

Expect: a disposable VM (new/fork/lease); never run locally

- **#0 pass**
  - `vm_manage✗ {"action":"new","vm":"install-sandbox","headless":true,"use":true}`
- **#1 pass**
  - `vm_manage✗ {"action":"new","vm":"install-sandbox","headless":true,"use":true}`
- **#2 pass**
  - `vm_manage✗ {"action":"new","vm":"install-sandbox","headless":true,"use":true}`

### linux-tests

Expect: uses a VM (creating one is denied, so it stops there)

- **#0 pass**
  - `Bash`
  - `Read`
  - `vm_manage✗ {"action":"new","headless":true,"use":true}`
  - `Bash✗`
- **#1 pass**
  - `Bash`
  - `Read`
  - `vm_info {"action":"list"}`
  - `vm_manage✗ {"action":"new","vm":"toy-linux-test","headless":true}`
- **#2 pass**
  - `Bash`
  - `vm_manage✗ {"action":"new","headless":true,"use":true}`
  - `Read`

### browser

Expect: vm_browser on the current VM

- **#0 pass**
  - `vm_browser`
- **#1 pass**
  - `vm_browser`
- **#2 pass**
  - `vm_browser`

### install-local

Expect: installs it locally (denied here, so intent only), even with a default VM; no VM work

- **#0 pass**
  - `Bash✗`
  - `Bash`
  - `Bash✗`
- **#1 pass**
  - `Bash✗`
  - `Bash`
  - `Bash✗`
- **#2 pass**
  - `Bash✗`
  - `Bash`
  - `Bash✗`

### docker-local

Expect: runs Docker locally (denied here, so intent only); no VM work

- **#0 pass**
  - `Bash`
  - `Bash`
- **#1 pass**
  - `Bash`
  - `Bash`
- **#2 pass**
  - `Bash✗ {"timeout":600000}`

### background-job

Expect: vm_jobs start; no blocking

- **#0 pass**
  - `vm_jobs {"action":"start"}`
- **#1 pass**
  - `vm_jobs {"action":"start"}`
- **#2 pass**
  - `vm_jobs {"action":"start"}`
