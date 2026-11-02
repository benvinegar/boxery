# Plan: profiles, lease extensions and the host gateway

← [Architecture](../../ARCHITECTURE.md#roadmap)

Status: **proposal, not built.** This is the design for profiles and the parts of the lease design that were never implemented. It moved out of `ARCHITECTURE.md` in November 2026 so that file describes only what exists ([#22](https://github.com/modem-dev/boxery/issues/22)). The shipped lease system (SQLite state machine, generations and epochs, reaper, per-lease keys, boot-ID fencing) is described in [ARCHITECTURE.md → Leases](../../ARCHITECTURE.md#leases) and [pool.md](../pool.md).

Open question first: [#75](https://github.com/modem-dev/boxery/issues/75) asks whether leases should become ephemeral VMs (new on acquire, removed on release) instead of a resettable pool. Settle that before profiles build on the pool.

## 1. Host gateway (lease enforcement)

Today fencing works through each guest's `authorized_keys`, which keeps cooperating clients apart. A laptop with ordinary ssh access to the host can still use the host's management key ([#71](https://github.com/modem-dev/boxery/issues/71)). Proposed:

- Laptop keys go into the host's `authorized_keys` **restricted**: `command="boxery-host gateway",restrict,port-forwarding`, so a laptop can't bypass boxery-host. Admin access uses a separate, unrestricted key.
- The gateway checks the lease on every `connect`/`run`/`snap`/`revert`/`rm`.
- Fencing on reassignment, beyond what exists today (per-lease keypairs, ending guest sshd sessions): close the host-side `connect` processes for that VM, so old ControlMasters and tunnels die and can't reconnect.
- **Authenticated holders.** `holder` is caller-chosen text today. With a gateway, the holder becomes the key's identity (comment or fingerprint), and pets get an owner the same way.

## 2. Lease extensions

- `boxery release LEASE_ID --keep` parks the VM, still dirty, under the holder's name so they can re-acquire it by name later. KEPT VMs count against a per-holder quota (default 2), expire after a retention window (default 7 days), and are shut down when parked, since they're treated as secret-bearing.
- States would gain `LEASED → KEPT`.
- **pi session semantics:** `session_shutdown` on reload or session switch = **detach** (lease kept, heartbeat paused, normal expiry). `/vm release` = reset. `/vm release --keep` = park. The session stores `{vm_uuid, template_version, lease_id, intent}`. On `/resume` the host revalidates ownership and state; if the workspace is gone the user is told and must explicitly acquire a fresh one. Forks don't inherit a lease (they start detached). Today a lease is released whenever it stops being current ([pi-extension.md](../pi-extension.md)).
- An optional `--vm-strict` for pi that hides local mutating tools while a VM is current, so "work goes to the VM" is enforced and not only guidance.

## 3. Profiles (app-agnostic setup)

One directory per profile on the host: `profiles/<name>/profile.toml` plus scripts.

```toml
base    = "ubuntu-desktop"        # or another profile, so templates stack
cpus    = 4
memory  = "8G"
disk    = "60G"
pool    = { min = 2, max = 6 }
repo    = "git@github.com:org/app.git"
build   = "build.sh"              # slow, once per template. Host-side secrets allowed (registry tokens)
freshen = "freshen.sh"            # on acquire: checkout $BRANCH, install deps, migrate. Seconds
start   = "start.sh"              # on acquire, after secrets: launch dev server(s) in tmux
health  = "http://127.0.0.1:3000" # or tcp:port or a command
secrets = [".env"]                # pushed from the laptop on acquire (see Secrets)
snapshot = "cold"                 # "cold" (default: disk-only image) | "memory" (opt-in, per tested profile)
```

Lifecycle, expressed in the image primitive that exists today (a template is an image captured after `build.sh`):

```
base image ──build.sh──► template image P@tpl-N
P@tpl-N ──new --from──► pool VM ──boot, health──► capture VM@boxery-clean ──► FREE
acquire: (reimage clean if dirty) → freshen → push secrets → start → health → LEASED
release: reimage clean → FREE
template rebuild: nightly, or when the profile's inputs hash changes; old pool VMs drain as leases end
```

Rules:

- **The `clean` image never contains secrets.** Everything that needs secrets (the running app) starts after acquire.
- **Templates are immutable and versioned** (`tpl-<n>` plus a hash of the profile's inputs). A rebuild publishes a new version; nothing that depends on the old one breaks. (Today libvirt's `build-base` refuses to overwrite a base that VMs depend on.)
- **Snapshot contract.** Default `cold`: the clean state is a disk-only image, and a reset is a reimage plus boot (~10 s). `memory` mode (RAM included) is opt-in per profile after testing. On restore the host steps the clock, restarts services that hold external connections (`restart_on_restore = [...]`), then runs `health`. All of a VM's disks must live in one image, including Docker's `/var/lib/docker`.
- Pool sizing: when no VM is free, `acquire` clones a new one if the pool is under `pool.max`, otherwise it waits or fails.

Example profiles: `plain` (just the desktop), and an app profile such as a Node + Postgres monorepo (Docker, Node, pnpm, a migrated and seeded database; `start` = the dev server).

## 4. Secrets that aren't built yet

| Kind | Where it lives | How it gets there |
|---|---|---|
| Build-time tokens (npm registry, container registry) | the build VM only, while it runs | the host gives short-lived, scoped tokens to a throwaway **builder** VM. The template comes from a fresh export, not the builder's disk, and build logs aren't shell-traced. Prefer token-free paths (e.g. build images from source) |
| Fallback when no laptop is present (cron jobs) | host | the host fetches from 1Password (`op`, service account) and pushes the same way grants do |

Also planned: leases applying a profile's `secrets` on acquire, and per-grant approval prompts.

## 5. Tests these need

Concurrent acquire, expiry under laptop sleep, crash mid-acquire, cross-VM and guest→host isolation, secret-retention checks after reset, and a run from a real Mac.
