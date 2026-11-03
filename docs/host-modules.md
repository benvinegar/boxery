# Host module boundaries

← [Docs](README.md)

The host runs in Node. Bash remains where it fits: the entry point (`host/boxery-host`), the ssh ProxyCommand path, and the hypervisor backends (`host/backends/*.sh`) ([plan](plans/2026-11-01-host-orchestration-in-node.md)).

## Ownership

| Module | Owns | Does not own |
|---|---|---|
| `controller/boxery` | Portable Bash 3.2 laptop CLI, SSH configuration, host profiles and grants | Host lease decisions or hypervisor mechanics |
| `host/boxery-host` | Entry point (Bash): `connect` via `backend.sh`, everything else to Node (the node `init` recorded) | Any command logic |
| `host/boxery-host.mjs` + `host/cli.mjs` | Node version check; CLI: argument dispatch, listings and their output formats, supervised mutating commands, private worker entry points | Lease policy, hypervisor commands |
| `host/setup.mjs` | `init` (state directory, `host.env`, proxy/reaper/runner-manager services), `build-base`, `add-key` | VM lifecycle |
| `host/runners.mjs` | `runners`: GitHub Actions runner configuration, the GitHub token file, the REST client (JIT configs, registrations), the runner manager (host runners): one lease per runner, through `boxery-host acquire/renew/release`, and `runners __once` (local runners: the same slot served once, with the JIT config from the controller on stdin) ([GitHub runners](github-runners.md)) | Lease transitions, locks or resets (it is an ordinary lease holder) |
| `host/vms.mjs`, `host/images.mjs`, `host/pool.mjs` | VM, image and pool-membership commands; edge routes | Locking (the supervisor holds locks around them) |
| `host/seed.mjs` | Per-VM cloud-config: keys, proxy token, agent configs | Delivering it to the guest (backends) |
| `host/recovery.mjs` | Replaying an abandoned operation's intents; inventory drift | Deciding which operations are abandoned |
| `host/boxery-lifecycle.mjs` | Lease runtime: binds lease policy to SQLite, the journal, backend effects and the supervisor; held-lock validation | Lease policy or hypervisor commands |
| `host/lease-workflows.mjs` | Lease workflow ordering, stale-state decisions, reset outcomes and retry/reap policy | Files, environment variables, subprocesses, SQLite implementation or CLI formatting |
| `host/boxery-leases.mjs` | Transactional lease state machine, generations/incarnations, expiry and claim eligibility | Guest side effects |
| `host/boxery-operations.mjs` | Resource arbitration, worker supervision, durable intent storage, abandoned-operation recovery scheduling, token file transactions | Guest or lease workflow policy |
| `host/backend.sh` + `host/backend.mjs` | Running one allowlisted backend function per process (argv only), parsing its metadata | Any decision about what to run |
| `host/guest.mjs` | ssh into a VM with the host's management key: commands, readiness, `authorized_keys` | Which keys a VM should accept |
| `host/hostkeys.mjs` | Each VM's pinned ssh host key: generation for the seed, the `host-keys/NAME` record, `known-hosts`/`pin`, pinning through trusted channels | Delivering the key to the guest (seed, backends) |
| `host/runtime.mjs`, `host/config.mjs`, `host/shapes.mjs`, `host/util.mjs` | Per-command context (store, backend, journal, held locks), configuration, shapes, shared helpers | Side effects of their own |
| `host/backends/*.sh` | Hypervisor-specific effects and idempotent recovery hooks | Pool ownership or lease transitions |

`core/boxery-core.mjs` remains the agent-facing transport/tool implementation. It is not a dependency of the host.

## Call paths

A mutating command (`new`, `fork`, `start`, `stop`, `resize`, `rm`, `snap`, `snap-rm`, `revert`, `edge-set`, `pool add|rm`):

```text
host/boxery-host (Bash) → exec node boxery-host.mjs COMMAND …      supervisor: takes the VMs' locks
  → node boxery-host.mjs __worker __dispatch COMMAND …              worker: own process group, waits on fd 3
    → vms.mjs / images.mjs / pool.mjs (journals intents)
      → backend.mjs → backend.sh FUNCTION ARG…                      one allowlisted backend function per process
      → guest.mjs (ssh to the VM)
```

A lease step:

```text
boxery-host.mjs acquire | release | reap
  → boxery-lifecycle.mjs (runtime) → lease-workflows.mjs (policy)
    → boxery-leases.mjs (short state transactions)
    → supervise(VM) → node boxery-host.mjs __worker __call _lease_acquire | _lease_release | _lease_reset | _reap_candidate …
      → backend.mjs / guest.mjs
```

The supervisor runs in the process that received the command. Each worker runs in its own process group behind the fd-3 gate, and backend subprocesses are never detached, so crash fencing (#17) covers everything an operation started. Before a held-lock callback acts, the runtime checks the inherited resource set (`BOXERY_LOCKS`).

Backend effects run as `host/backend.sh FUNCTION ARG…`: a small Bash prelude (`die`, `log`, `need`, `wait_ssh`, `vm_ssh_cmd` and the settings backends read) sources `host/backends/$BOXERY_BACKEND.sh` and runs one function from the backend contract. Anything else is refused, and arguments are argv, never evaluated.

The private entry points (`__worker`, `__dispatch`, `__call CALLBACK`, `__recover`) dispatch fixed tables. They are implementation details, not a public CLI or an authorization API.

## Policy dependencies

`LeaseWorkflows` receives:

- **store:** synchronous state transactions; errors propagate rather than masquerading as stale state;
- **backend:** asynchronous effects (`clearEdge`, `restore`, `waitReady`, `stepClock`, `setKeys`);
- **journal:** record intent before effects, complete it only after a committed outcome;
- **lock:** route work through the supervisor with the target VM pinned;
- **reclaim, clock, sleep, log:** explicit retry/reaper dependencies.

This lets tests assert ordering directly. In particular, reset cannot publish FREE before readiness and key installation, a failed database commit retains its intent, and a stale generation/incarnation cannot clear a new holder's grants.

## Compatibility and tests

Documented CLI arguments, listing output (tables and JSON), environment overrides, pool state semantics, the intent journal format and backend contracts are unchanged by the move to Node. Lease command stdout stays machine-readable (`NAME LEASE_ID EXPIRES_AT` for acquire; `NAME EXPIRES_AT` for renew); diagnostics stay on stderr. The controller still needs only Bash 3.2 and SSH.

- `test/shell/host-output.sh`: exact output of listings, usage and common errors.
- `test/lease-workflows.test.mjs`: injected policy tests, no SQLite or subprocesses, so they also run on a Node without `node:sqlite`.
- `test/leases.test.mjs`: real SQLite transaction/state tests.
- `test/operations.test.mjs`: real dispatcher/supervisor crash tests against the fake backend, plus runtime parsing and callback-boundary checks.
- `test/host-backend.test.mjs`, `test/host-shapes.test.mjs`, `test/host-seed.test.mjs`, `test/host-setup.test.mjs`: the backend shim, guest ssh, configuration, shapes, seed and service files, without SQLite.
- `test/shell/host-init.sh`: `init`, `add-key` and `build-base` with stubbed service managers.
- `test/runners.test.mjs`: the GitHub runner manager's policy with injected pool/guest/GitHub fakes, the REST client against a local stub server, and a full `boxery-host runners run` against the fake backend; `test/shell/host-runners.sh`: the `runners` CLI, the controller passthrough, and the guest layer's `boxery-runner`; `test/shell/controller-runners-once.sh`: `boxery runners once` end to end with a stub `gh` (the JIT config only ever on stdin, cleanup after a job, Ctrl-C, a refused registration and a killed controller).
- `test/bench/host-timings.sh`: not a test; mean timings of common commands, to compare before and after a change.
- `test/shell/*.sh`: controller, backend and CLI integration contracts, including Bash 3.2.

See [Lifecycle coordination and recovery](lifecycle.md) for the locking, recovery and upgrade contract.
