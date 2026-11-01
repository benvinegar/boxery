# Plan: host orchestration in Node

Status: draft, not started. Continues the extraction described in [host module boundaries](../host-modules.md).

## Goal

Make Node the only orchestration language on the host. Bash stays where it fits: the hypervisor
backends (`host/backends/*.sh`) and a few lines of entry-point glue. The public CLI, the JSON/text
output, the lock and recovery protocol, and the backend contract stay unchanged.

## Why

The host has been moving to Node piece by piece (SQLite leases, the operation supervisor, lease policy),
but `host/boxery-host` (891 lines of bash) still owns dispatch, the seed, shapes, images, pool membership
and recovery. The two languages now call each other repeatedly. Acquiring a lease today:

```
boxery-host acquire                     bash
  → boxery-lifecycle.mjs acquire        node
    → boxery-operations.mjs run         node   (supervisor, per locked step)
      → boxery-host __call _lease_acquire   bash   (worker)
        → boxery-lifecycle.mjs install-held node
          → boxery-host __backend lease-keys bash
            → backend function / ssh
```

A mutating command takes the same detour: `boxery-host new` execs `boxery-operations.mjs dispatch`,
which re-enters `boxery-host __dispatch new`. Each hop re-parses arguments (`resources()` in
boxery-operations.mjs duplicates the `new`/`fork` flag parsing), and every hop is another process with
its own error-handling style. The bash side makes 46 `jq` calls to reshape JSON for Node. Node ≥ 22.13
is already required on the host, so keeping this logic in bash doesn't save a dependency.

## Target shape

```
host/boxery-host          bash, ~25 lines: resolve ROOT, `connect` fast path, exec node
host/boxery-host.mjs      CLI: one command table (argument parsing, usage, output formatting)
host/config.mjs           CONF, host.env loading, one settings allowlist (today there are two)
host/backend.sh           bash prelude (die, log, need, SSH_OPTS, wait_ssh, vm_ssh_cmd) + source
                          backends/$BACKEND.sh + dispatch to an allowlisted backend_* function
host/backend.mjs          typed wrapper: backend.list() → rows, backend.capture(name, image), …
host/guest.mjs            ssh to a VM: run, waitSsh, setKeys (pet / lease)
host/seed.mjs             pure: (name, cred, keys, upstream, ollamaModels) → cloud-config text
host/shapes.mjs           pure: built-ins + $CONF/shapes.json → validated shapes; per-VM records
host/vms.mjs              new, fork, rm, start, stop, resize
host/images.mjs           snap, snaps, snap-rm, revert, images, restore
host/pool.mjs             pool add / rm / ls, edge-set
host/recovery.mjs         intent replay (today's recover_operation) and drift reconciliation
host/services.mjs         init: systemd units / launchd plists for proxy and reaper
```

Unchanged: `boxery-leases.mjs`, `lease-workflows.mjs`, the supervisor in `boxery-operations.mjs`
(its worker becomes Node), `proxy/`, and every `backends/*.sh`. `boxery-lifecycle.mjs`'s CLI moves into
`boxery-host.mjs`, and its runtime bindings stay as they are.

The same acquire afterwards:

```
boxery-host acquire → node (lease policy in process; supervisor in process)
  → node worker (own process group, for crash fencing)
    → bash host/backend.sh backend_… / ssh
```

### Rules that carry over

- **Process groups.** The worker still runs `detached` in its own group behind the fd-3 gate, and backend
  subprocesses are never detached, so `stopAbandoned` still kills everything an operation started. The
  Node worker reads the gate synchronously before doing anything, then closes fd 3.
- **Journal format is frozen.** Intent kinds (`create`, `remove`, `capture`, `fork-image`,
  `snapshot-remove`, `revert`, `acquire`, `reset`, `pool-add`, `pool-rm`) and their data arrays stay
  byte-identical, so a Node recoverer can replay intents a bash worker wrote before an upgrade.
- **Output is a contract.** `docs/cli.md` field names, one-element-per-line JSON arrays (the controller
  depends on them), the `NAME HOST:PORT` line from `new`/`fork`, text tables, the `boxery-host:` error
  prefix, `==>` logs on stderr, and exit codes.
- **Backends are argv-only.** `backend.sh` dispatches a fixed allowlist of `backend_*` names and never
  evaluates caller-supplied code. It replaces `__backend`, `__call` and `__dispatch`.

### `connect` stays in bash

`connect` is the ssh ProxyCommand for every new VM connection. Today it's bash + `nc` and never starts
Node. Starting Node there would add ~50 ms to each connection. The wrapper keeps a fast path: source
`backend.sh`, call `backend_ssh_endpoint`, `exec nc`. Every other command execs Node.

### Finding node over non-interactive ssh

The controller runs `boxery-host` over plain `ssh host cmd`, where nvm/fnm shims often aren't on PATH.
Mutating commands already need Node, but `ls` currently degrades gracefully without it. `init` will
record `BOXERY_NODE=<absolute path>` in `host.env` (it already bakes that path into the service files),
and the wrapper will use it, falling back to `command -v node`. This also fixes the existing nvm case.

## Phases

Each phase ships on its own, keeps the CLI unchanged, and has to pass `npm test`, `npm run test:shell`
(including bash 3.2 for the controller) and `npm run lint`. Real-hypervisor e2e (`e2e.sh`) on libvirt
and Lima runs before each phase merges, since the fake backend doesn't prove hypervisor behavior.

While commands are being moved, the bash wrapper routes them: ported commands go to Node, all others to
the old script (renamed to `host/boxery-host-legacy.sh`). A command moves over only when every test
that covers it passes against the Node version.

### Phase 0: lock down current behavior

- Golden tests for every text and JSON output that isn't covered yet: `ls`, `shapes`, `pool ls`,
  `snaps`, `images`, `usage`, error messages for invalid names, snapshot names and flags.
- Baseline timings with the fake backend (`ls`, `new`, `acquire`/`release`) and for `connect`, so
  regressions in startup cost are visible.
- Check whether any backend relies on state across function calls within one operation. Each call will
  become its own process. Initial survey: backend globals are config-derived at load time, so this looks safe.

### Phase 1: backend shim, and the end of `__backend`

- Add `host/backend.sh` and `host/backend.mjs`. The wrapper caps metadata output (reuse the 16 MiB cap in
  `boxery-lifecycle.mjs`) and reports optional functions (`backend_resize`, `backend_legacy_*`,
  `backend_proxy_bind`) through one capabilities call.
- Port the lease bridge's effects to Node: `restore_vm`, `lease_set_keys`, `wait_ssh`, guest commands, and
  `_reconcile_drift`. `boxery-lifecycle.mjs` calls them directly, and `__backend` goes away.
- This is the smallest change that removes a whole bash hop from the lease path, and it proves the shim
  works before anything else depends on it.

### Phase 2: read-only commands

- Add `boxery-host.mjs` and `config.mjs`, and put the routing wrapper in place.
- Port `ls`, `shapes`, `snaps`, `images`, `ip`, `pool ls`, `proxy-log`, `backend` and `help`.
- `shapes.mjs` takes over the merge and validation that are currently one large jq expression, with unit
  tests for override, extension and invalid input.

### Phase 3: mutating commands and recovery

The order matters, because recovery has to handle intents from either language:

1. **Node worker and recovery.** `boxery-operations.mjs` spawns `node boxery-host.mjs __dispatch` as the
   worker. Port `recover_operation` to `recovery.mjs` first: it depends only on intent data and backend
   functions, not on which language recorded the intent. Workers record intents in process
   (`recordIntent`) rather than through the `operations intent` CLI.
2. **`edge-set`, `start`, `stop`, `resize`.**
3. **`snap`, `snap-rm`, `revert`, `rm`.**
4. **`new` and `fork`.** `seed.mjs` replaces the jq/base64/`node -e` seed pipeline. The output stays the same
   cloud-config: keys emitted as JSON strings, base64 `write_files`. Fork children run in process
   with `Promise.allSettled` under the parent's lock set, each child recording its own `create` intent,
   as today. One failed child must not cancel the others.
5. **`pool add` / `pool rm`, and the lease callbacks.** `lock()` in the lifecycle runtime runs
   `flows.install/releaseHeld/reset/reapHeld` in the Node worker directly. The `_lease_*` bash shims go away.

At the end of this phase, `boxery-host-legacy.sh` handles only `init`, `build-base` and `add-key`.

### Phase 4: init and cleanup

- `services.mjs` generates the systemd units and launchd plists (same unit names, paths and env).
  `init` records `BOXERY_NODE` and stops requiring `jq` for the libvirt backend. Lima and Cloud
  Hypervisor still use jq, and their `backend_check` already says so.
- Delete `boxery-host-legacy.sh` and the routing table, so the wrapper keeps only `connect` and `exec node`.
- Update `ARCHITECTURE.md`, `docs/host-modules.md` (new ownership table and call path),
  `docs/lifecycle.md`, `docs/install.md` (jq is per backend) and `host/backends/README.md` (a backend is
  sourced by `host/backend.sh`, and lists what the prelude provides).

## Done when

- `host/boxery-host` is under ~40 lines, and no orchestration code outside `backends/` is bash.
- The host core makes no jq calls.
- A lease step is at most node → node worker → backend shell.
- All existing tests pass without changes to their assertions, except paths in tests that call private
  entry points (`operations.test.mjs` callback-boundary checks).
- e2e passes on libvirt and Lima, and the Cloud Hypervisor stub suite passes.

## Risks

| Risk | Mitigation |
|---|---|
| Output drift breaks the controller, which parses host output without jq | Phase 0 golden tests; controller-local/controller-hosts suites run against the real host CLI |
| Upgrade with an abandoned bash operation in the journal | Frozen intent format; Node recovery lands before any command moves |
| Node worker leaks a backend child outside the group | Never pass `detached` below the worker; keep `BOXERY_FAKE_DAEMON` tests; close fd 3 after the gate |
| Startup cost on hot paths | `connect` fast path in bash; Phase 0 baselines |
| Fake backend hides real hypervisor timing/ordering bugs | e2e on libvirt and Lima per phase; Cloud Hypervisor stub suite |
| Long-lived mixed state during migration | Route per command in the wrapper; aim to finish Phase 3 in consecutive PRs, not over months |

## Non-goals

- The laptop controller (`controller/boxery`). Whether it stays bash 3.2 is a separate decision.
- Rewriting the backends, or removing jq from the Lima and Cloud Hypervisor backends.
- Any change to the lock protocol, lease state machine, CLI surface or backend contract.
