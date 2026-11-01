# Host module boundaries

← [Docs](README.md)

The host is being extracted incrementally into Node, not rewritten wholesale. The first cohesive workflow is lease acquisition, installation, renewal, release, reset and reaping. VM/image creation, pool membership, generic recovery dispatch and service setup still use the existing shell dispatcher.

## Ownership

| Module | Owns | Does not own |
|---|---|---|
| `controller/boxery` | Portable Bash 3.2 laptop CLI, SSH configuration, host profiles and grants | Host lease decisions or hypervisor mechanics |
| `host/boxery-host` | Host configuration, initialization, VM/image commands, recovery dispatch, backend loading and guest SSH effects | Lease acquire/reset/reaper ordering |
| `host/boxery-lifecycle.mjs` | Lease CLI parsing/output, direct SQLite/journal bindings, subprocess adapter and held-lock validation | Lease policy or hypervisor commands |
| `host/lease-workflows.mjs` | Lease workflow ordering, stale-state decisions, reset outcomes and retry/reap policy | Files, environment variables, subprocesses, SQLite implementation or CLI formatting |
| `host/boxery-leases.mjs` | Transactional lease state machine, generations/incarnations, expiry and claim eligibility | Guest side effects |
| `host/boxery-operations.mjs` | Resource arbitration, worker supervision, durable intent storage and abandoned-operation recovery scheduling | Guest or lease workflow policy |
| `host/backends/*.sh` | Hypervisor-specific effects and idempotent recovery hooks | Pool ownership or lease transitions |

`core/boxery-core.mjs` remains the agent-facing transport/tool implementation. It is not a dependency of host lease policy. Its eventual transport/file/desktop/lifecycle split should be a separate change rather than coupled to this extraction.

## Lease call path

```text
boxery-host CLI
  → boxery-lifecycle.mjs (runtime adapter)
    → lease-workflows.mjs (policy)
      → boxery-leases.mjs (short state transactions)
      → boxery-operations.mjs (locks + journal)
      → boxery-host __backend (allowlisted argv bridge)
        → existing backend functions / guest SSH
```

Acquiring a resource still uses the existing supervisor and held-lock callbacks. The shell callback names are compatibility shims into Node. Before a held-lock entry point executes policy, the runtime checks the inherited resource set. Backend subprocesses are never detached: they stay in the supervisor's worker process group, so crash fencing from #17 continues to cover them.

The private `__backend` bridge offers only the effects required by these workflows: restore a VM, wait for SSH readiness, install lease keys, execute a guest command, and run inventory reconciliation. It dispatches a fixed action allowlist and passes arguments as argv; it does not evaluate a caller-supplied host function. These private entry points are implementation details, not new public CLI or authorization APIs.

## Policy dependencies

`LeaseWorkflows` receives:

- **store:** synchronous state transactions; errors propagate rather than masquerading as stale state;
- **backend:** asynchronous effects (`clearEdge`, `restore`, `waitReady`, `stepClock`, `setKeys`);
- **journal:** record intent before effects, complete it only after a committed outcome;
- **lock:** route work through the supervisor with the target VM pinned;
- **reclaim, clock, sleep, log:** explicit retry/reaper dependencies.

This lets tests assert ordering directly. In particular, reset cannot publish FREE before readiness and key installation, a failed database commit retains its intent, and a stale generation/incarnation cannot clear a new holder's grants.

## Compatibility and tests

Documented CLI arguments, listing JSON shapes, environment overrides, pool state semantics and backend contracts remain unchanged. Lease command stdout stays machine-readable (`NAME LEASE_ID EXPIRES_AT` for acquire; `NAME EXPIRES_AT` for renew); diagnostics stay on stderr. Diagnostic expiry timestamps now use ISO 8601 rather than platform-specific `date` output. The controller still needs only Bash 3.2 and SSH.

- `test/lease-workflows.test.mjs`: injected policy tests, no SQLite or subprocesses; also run on Node 20.
- `test/leases.test.mjs`: real SQLite transaction/state tests.
- `test/operations.test.mjs`: real dispatcher/supervisor crash tests against the fake backend, plus runtime parsing and callback-boundary checks.
- `test/shell/*.sh`: existing controller, backend and CLI integration contracts, including Bash 3.2.

See [Lifecycle coordination and recovery](lifecycle.md) for the locking, recovery and upgrade contract. This extraction does not change that protocol or add a service/dependency.
