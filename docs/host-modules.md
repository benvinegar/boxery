# Host module boundaries

← [Docs](README.md)

The host is being extracted incrementally into Node, not rewritten wholesale ([plan](plans/2026-11-01-host-orchestration-in-node.md)). Lease workflows, listings and the lease commands run in Node. VM/image creation, pool membership, generic recovery dispatch and service setup still run in the legacy shell dispatcher, which `host/boxery-host` routes them to.

## Ownership

| Module | Owns | Does not own |
|---|---|---|
| `controller/boxery` | Portable Bash 3.2 laptop CLI, SSH configuration, host profiles and grants | Host lease decisions or hypervisor mechanics |
| `host/boxery-host` | Entry point (Bash): `connect` via `backend.sh`, legacy commands to `boxery-host-legacy.sh`, everything else to Node | Any command logic |
| `host/boxery-host.mjs` | CLI for listings (`ls`, `shapes`, `snaps`, `images`, `pool ls`, `ip`), `proxy-log` and the lease commands; output formats | Lease policy, hypervisor commands |
| `host/boxery-host-legacy.sh` | Initialization, VM/image mutations, pool membership, recovery dispatch (until they move to Node) | Lease acquire/reset/reaper ordering |
| `host/shapes.mjs` | Shape merging/validation and per-VM size records | Choosing a size for a command |
| `host/boxery-lifecycle.mjs` | Lease CLI parsing/output, direct SQLite/journal/backend bindings and held-lock validation | Lease policy or hypervisor commands |
| `host/backend.sh` + `host/backend.mjs` | Running one allowlisted backend function per process (argv only), parsing its metadata | Any decision about what to run |
| `host/guest.mjs` | ssh into a VM with the host's management key: commands, readiness, `authorized_keys` | Which keys a VM should accept |
| `host/config.mjs` | `$BOXERY_CONF`, `host.env` settings, journaled backend settings | Anything with side effects |
| `host/images.mjs`, `host/recovery.mjs` | Restoring a VM from its image; inventory drift checks | Lock acquisition (callers hold or take locks) |
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
      → backend.mjs → backend.sh FUNCTION ARG… (one allowlisted backend function per process)
      → guest.mjs (ssh to the VM)
```

Acquiring a resource still uses the existing supervisor and held-lock callbacks. The shell callback names are compatibility shims into Node. Before a held-lock entry point executes policy, the runtime checks the inherited resource set. Backend subprocesses are never detached: they stay in the supervisor's worker process group, so crash fencing from #17 continues to cover them.

Backend effects run as `host/backend.sh FUNCTION ARG…`: a small Bash prelude (`die`, `log`, `need`, `wait_ssh`, `vm_ssh_cmd` and the settings backends read) sources `host/backends/$BOXERY_BACKEND.sh` and runs one function from the backend contract. Anything else is refused, and arguments are argv, never evaluated. Each call is a separate process in the caller's process group, so a killed operation's backend commands are stopped with it.

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
