# Host lifecycle coordination and recovery

← [Docs](README.md)

The host uses `host/boxery-operations.mjs` to supervise VM mutations. Lease workflow policy lives in `host/lease-workflows.mjs`, with CLI/SQLite/backend bindings in `host/boxery-lifecycle.mjs`; see [host module boundaries](host-modules.md). It needs Node with `node:sqlite` (Node ≥ 22.13) and the system `ps` command. There is no new daemon: the `boxery-host` process that receives a command is the operation's supervisor, its worker is `boxery-host.mjs __worker …` in a separate process group, and the existing reaper performs recovery.

## Lock boundary

Short `BEGIN IMMEDIATE` transactions in `~/.config/boxery/leases.db` arbitrate logical resource locks. The SQLite transaction is **not** held while a VM boots or a disk is copied. Unrelated VMs can progress concurrently.

| Operation | Resources held until the worker exits |
|---|---|
| `new NAME` | NAME; also the source VM name for `--from SOURCE@LABEL` |
| `fork SRC DST…` | SRC and every destination, acquired together |
| `start`, `stop`, `resize`, `rm`, `snap`, `snap-rm`, `revert`, `edge-set` | The target VM |
| `pool add`, `pool rm` | The target VM |
| Acquire key installation and commit | The claimed VM |
| Release/reset | The target VM, including readiness checks, key installation and final state commit |
| Reaper candidate | The target VM, with state/deadline revalidated after locking |

All preconditions that can race with another VM mutation are checked inside these boundaries. A second create cannot mint a token or register cleanup against an existing winning VM. Image readers retain their source lock until copies no longer depend on the image. Fork workers inherit the parent's complete resource set rather than recursively acquiring locks in different orders.

Pool claims exclude resource-locked VMs, including the interval between a reset committing FREE and its worker exiting. Reset candidates are observations only: the reaper rechecks generation, pool incarnation (`epoch`), state and deadline after obtaining the lock. Removing/re-adding a pool member changes its epoch, preventing a stale callback from matching a reused numeric generation. Guest side effects run under the same lock as these checks.

`init`, `build-base`, and direct hypervisor commands are administrative operations outside this protocol. Do not run them concurrently with lifecycle commands. `boxery-host upgrade` runs `init` under a host-wide lock: it records resource `*`. Operations that start from then on wait behind it. A pool claim still commits, but installing the lease key is a locked operation, so it waits. The upgrade itself waits for operations already in flight, and recovers abandoned ones. If the upgrader dies, its row is abandoned like any other and has no intents to replay. Once drained, and before it changes the code, the upgrade copies the store to `pre-upgrade/leases.db` (without its own row). If the upgrade rolls back, it restores that copy in place, in one transaction, while it still holds `*`. Every pool row's generation then moves past any it had, so a claim committed during the upgrade is undone and fenced rather than issued twice. The store records its schema version (`PRAGMA user_version`), and code refuses a store newer than it understands. Stop older boxery-host processes before upgrading; old processes do not participate in the SQLite lock protocol. Journals written by an older boxery-host replay unchanged: intent kinds and their data are a stable format.

## Process lifetime

A supervisor records its PID, process start time and host boot identity. Its worker runs in a separate process group and waits on a pipe until its own identity has been committed. A supervisor dying before registration closes the pipe without authorizing side effects.

Before reclaiming an abandoned operation, a successor:

1. Atomically takes ownership of the old operation and its complete resource set.
2. Stops the recorded worker process group and waits for its non-zombie processes to exit.
3. Replays the old operation's durable intents under those locks.
4. Removes its temporary seed/work files and journal, then releases the locks.

In implementation, group shutdown occurs within the same arbitration transaction as the ownership change, before any successor worker starts. A live supervisor is never preempted merely because a VM operation takes longer than the lease stale timeout. Failure to stop a group or complete recovery retains the journal and fails closed. PID start times avoid treating an unrelated reused PID as the recorded supervisor/worker.

This coordinates local boxery workers. Hypervisor operations already submitted to libvirt/Lima may outlive a CLI process; backend recovery must also inspect and repair those artifacts/jobs. It is not an authorization boundary against a host administrator or a malicious process deliberately escaping its group.

## Durable intents

Workers record intent **after preflight, before side effects**, and clear it only when the corresponding unit of work is complete. Concurrent fork children record separate create intents.

| Interrupted work | Recovery |
|---|---|
| Create | Remove the incomplete VM and backend artifacts, revoke its token and clear edge routes |
| Capture | Cancel/clean backend copy state, restore the source's capture-related state, remove the incomplete image |
| Fork | Preserve completed children; remove incomplete children and the temporary fork image |
| Remove VM | Finish VM, image, token and edge-route cleanup, including when the domain is already gone |
| Remove snapshot | Finish the validated removal idempotently |
| Revert | Retry restoring the selected image |
| Acquire key installation | Reset only if its original ACQUIRING generation/epoch still matches |
| Reset | Retry only if its original RESETTING generation/epoch still matches; finish FREE or BROKEN |
| Pool add | Preserve an already registered member; otherwise restore pet access and remove the incomplete clean image |
| Pool remove | Finish removing membership/clean image and restoring pet access |
| Pool patch | Reimage the still-free VM from its clean image (the old one, or the patched one if its capture finished); with no clean image, mark it BROKEN |

Patching a pet VM journals nothing: the layers are idempotent, so an interrupted `patch` is run again. Start/stop/resize expose the resulting hypervisor state; they do not promise rollback to the old power state or size. An interrupted resize can leave a VM stopped; `boxery start` brings it back. Edge-route publication is an atomic rename; retries set the desired routes again. Token read/modify/rename uses a short SQLite transaction, not a crash-prone mkdir lock.

The journal contains names, operation metadata and backend routing settings, not grant secrets or tokens. Seed files remain in a private per-operation work directory until cleanup. This is process-crash recovery, not a guarantee of atomicity across a machine power failure, guest application transactions, or external administrator actions.

## Running recovery

```bash
boxery-host reconcile
# Also run automatically by the existing minute-based reaper:
boxery-host reap
```

A conflicting mutation first recovers abandoned operations on its resources. `reconcile`/`reap` additionally recover abandoned operations elsewhere, then reap expired/stale leases and check inventory drift under each VM's lock.

Missing pool VMs become BROKEN and their token/edge access is revoked. Tokens/edge routes for missing pets are removed too. Unfamiliar VMs and unjournaled images are preserved: a reconciler must not guess that user data is garbage. Failed recovery is reported on stderr and retried on a later invocation; do not delete journal rows to bypass it without repairing the underlying backend state.

## Tests

`test/operations.test.mjs` drives the real host dispatcher, SQLite and fake backend. Deterministic barriers let it kill real supervisors while worker groups remain alive. It covers duplicate creates, image-reader locks, partial capture/delete/fork recovery, failed-recovery retries, acquire/reaper races, stale reset fencing, reset crashes and inventory drift. `test/leases.test.mjs` covers candidate revalidation, incarnation fencing and lock-aware claims.

Real libvirt/Lima behavior still requires the separately authorized live end-to-end checks; fake-backend tests do not prove hypervisor crash recovery.
