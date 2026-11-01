# Shared pool & leases

← [Docs](README.md)

Several agents, laptops or CI jobs can share a set of VMs without stepping on each other. Pool VMs are handed out with **exclusive, expiring leases**. When a lease ends, the VM is reset to its clean image, and all work from that lease is gone, including its keys.

## Set up a pool (admin)

Create VMs as usual, set them up the way you want (repos, dependencies, logins), then add them to the pool:

```bash
boxery new pool-1 && boxery new pool-2
# …install whatever a fresh lease should start with…
boxery pool add pool-1
boxery pool add pool-2
boxery pool ls
```

`pool add` locks the VM down so that only lease holders can reach it. It ends existing ssh sessions, wipes pushed grants, and captures the `NAME@boxery-clean` image that each reset returns to. Works on every backend (libvirt and Lima, including Lima vz).

To take a VM out of the pool after its lease ends, run `boxery pool rm NAME`. It becomes a normal VM again. `--force` removes it even while it's leased.

## Lease a VM

From pi, which handles everything for you:

```bash
pi --vm pool                     # lease, renew while pi runs, release on exit
pi --vm pool --vm-ttl 3600
/vm pool                         # inside a running pi; /vm off releases
```

From an agent over MCP (or pi), with the `vm_lease` tool: `{"action":"acquire"}` leases a VM and makes it current, and the lease is renewed while the session is in use and released when it ends. See [Pool leases](mcp.md#pool-leases).

From the CLI or scripts:

```bash
read NAME LEASE < <(boxery acquire --ttl 1800 --wait 60)
boxery run "$NAME" make test           # runs in ~/project
boxery renew "$NAME"             # extend
boxery release "$NAME"           # give it back; the VM is reset
boxery leases                    # what you hold
```

`acquire` exits with status 4 if no VM is free before `--wait` runs out.

## Guarantees

- **Exclusive.** A pool VM accepts only the host's key and the current lease's key. Each lease gets a fresh ssh keypair, stored in `~/.boxery/leases/`.
- **Expiring.** TTLs run from 1 minute to 8 hours (default 30 min). The pi extension renews at a third of the TTL. A reaper on the host (systemd timer or launchd agent, every minute) resets expired leases. A sleeping laptop or a crashed agent never strands a VM.
- **Fenced.** Release or expiry resets the VM to its clean image, which also removes the lease key. Forking a leased VM doesn't carry the lease key over. A holder whose lease is gone is locked out, even with a connection that was already open.
- **A proxy token per lease.** Each lease gets its own LLM proxy token, and its `http:` grants are bound to that lease. When the lease ends, the token stops working, so a copy taken from inside the VM can't spend through the proxy or use the next holder's grants.
- **Reboot-safe.** Leases are tied to the host's boot ID. After a host reboot, every lease is void and gets reset.
- **Crash-safe.** State lives in SQLite (`~/.config/boxery/leases.db`) as a small state machine with generation fencing. A failed acquire or reset never leaves a VM half-assigned. Such VMs are marked `broken` instead, and `pool ls` shows them.

```
free ──acquire──▶ acquiring ──▶ leased ──release / expiry / reboot──▶ resetting ──▶ free
                                                                          └──fail──▶ broken
```

`pool ls` and `ls` (its LEASE column, `lease.state` in `--json`) show these states.

To recover a `broken` VM, fix it, then run `boxery pool rm NAME && boxery pool add NAME`.

Design notes: [ARCHITECTURE.md → Leases](../ARCHITECTURE.md#leases). Not built yet (gateway, `--keep`, profiles): [plan](plans/2026-11-01-profiles-and-lease-extensions.md).
