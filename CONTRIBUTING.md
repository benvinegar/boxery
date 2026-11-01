# Contributing / testing

| Layer | Command | Needs |
|---|---|---|
| Lint (shellcheck + node syntax) | `npm run lint` | shellcheck, node |
| Type check: VM-side TypeScript (`core/*.ts`, run by Node's type stripping, no build step) | `npm i --no-save typescript@5.9.3 @types/node@22 && npm run typecheck` | node |
| Unit/integration tests: core helpers, proxy, MCP, SQLite leases and lifecycle crash recovery (real host dispatcher with a fake backend), background jobs (real CLI + MCP, helper run as in a VM) | `npm test` | node ≥ 20; lease/lifecycle cases need node ≥ 22.13, job cases ≥ 22.18 |
| Shell tests: host dispatcher against the `fake` backend, leases, images/forks (`host-images.sh`: the behaviour every backend must match), controller local mode + grants, named registry/import/defaults, injection/concurrency regressions | `npm run test:shell` | bash, jq, openssl, node ≥ 22.13, ps (procps on Linux) |
| Same under macOS's bash 3.2 | `docker run --rm -v "$PWD":/src:ro bash:3.2 bash -c 'apk add -q openssh-client jq coreutils openssl nodejs perl git procps-ng; cp -r /src /w && cd /w && bash test/shell/run.sh'` | docker |
| MCP protocol against a live VM | `mcp/test-mcp.sh VM` | a VM |
| End-to-end (create VM → agents → proxy → extension → MCP → grants → snapshots → rm) | `./e2e.sh` | a configured host (libvirt or Lima) |

CI (`.github/workflows/ci.yml`) runs lint, unit tests on Node 22/24/26, shell tests, bash 3.2, and a real macOS runner on every push and PR. `e2e.sh` needs KVM or Lima, so it runs manually (or on a self-hosted runner).

`test/copy.test.mjs` exercises streaming transfers with real tar and isolated fake SSH endpoints: 192 MiB archives with bounded agent buffers, all endpoint combinations, producer/consumer failures, cancellation/KILL escalation (including descriptor-free descendants), metadata deadline/late-preparation faults, read-only cleanup, non-writable parents and pinned routing. `COPY_TEST_TAR=/path/to/bsdtar node --test test/copy.test.mjs` checks BSD tar locally; native macOS CI uses its system tar. Fixture subprocesses live under `test/fixtures/`.

`test/parity.test.mjs` keeps the CLI and the agent tools in step: a new `vm_*` tool or action, or a new `boxery` command, fails it until it is mapped to its counterpart or listed with a reason it has none. When both sides need a feature, give the CLI the tool's implementation rather than a second one (as `boxery cp` runs `vm_copy`).

`test/lease-workflows.test.mjs` tests lease policy directly through injected store/backend/journal dependencies, without SQLite or subprocesses. [Host module boundaries](docs/host-modules.md) documents ownership and dependencies. `test/operations.test.mjs` uses deterministic fake-backend barriers to SIGKILL supervisors while their worker groups are alive, checking both recovery and external side effects. Keep these tests offline: they use only temporary config and VM directories. The [lifecycle contract](docs/lifecycle.md) documents resource boundaries, durable intents and backend recovery responsibilities.

Backends live in `host/backends/<name>.sh` and implement the contract in `host/backends/README.md`; `fake.sh` is the test double.

Named-host interface/layout: [docs/hosts.md](docs/hosts.md). `test/hosts.test.mjs` uses independent fake profile directories and SSH/controller stubs to check duplicate VM names, per-call contexts, cross-host copies, timeout cleanup and HTTP session isolation. `test/shell/controller-hosts.sh` exercises the actual controller and real `ssh -G` config parser without connecting to any host, including remote tilde and hostile executable paths. All profiles and grants are temporary; never point offline tests at a real BOXERY_HOME. For native macOS Bash 3.2: `BASH_UNDER_TEST=/bin/bash npm run test:shell`.

Live local/Hornet MCP checks are separate and require explicit user authorization and any host-required lease. Registration is not lease acquisition. Do not import private app recipes, credentials, or local agent task files into public changes.
