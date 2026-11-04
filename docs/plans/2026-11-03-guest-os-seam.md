# Plan: a guest OS seam

← [Architecture](../../ARCHITECTURE.md#roadmap)

Status: **proposal, not built.** This prepares for macOS guests ([#155](https://github.com/modem-dev/boxery/issues/155)) without adding them. Each step leaves Linux VMs behaving exactly as they do now. Steps 1–3 pay for themselves even if macOS guests never ship.

## Problem

boxery's backends are pluggable but its guest isn't. "The guest is Ubuntu with cloud-init, systemd and apt" is spread over four places:

| Where | What it assumes |
|---|---|
| Identity ([host/seed.mjs](../../host/seed.mjs) `cloudConfig`) | The per-VM identity is cloud-config text. Backends without cloud-init replay it three different ways: [host/cloudconfig-sh.mjs](../../host/cloudconfig-sh.mjs), `lima_apply_cloudconfig` in [lima.sh](../../host/backends/lima.sh), and `remote_identity_script` in [lib/remote.sh](../../host/backends/lib/remote.sh). Each one hard-codes `systemctl`, `systemd-machine-id-setup`, `/home/agent` and `/etc/boxery` |
| Image layers ([image/layers/](../../image/layers)) | apt, systemd units, XFCE/TigerVNC. [host/backend.sh](../../host/backend.sh) `layer_files` has a fixed list of them |
| Commands run in the guest | About 25 inline shell strings across `core/` (`REMOTE_HOME`, `bash -c`, `setsid`, `stat -c`, `flock`, xdotool, `import`, `DISPLAY=:1`, Chrome paths), `core/grants-guest.sh` (`/run/user` tmpfs), and `host/` (`cloud-init status --wait`, `/proc/.../boot_id`, `/var/run/reboot-required`, `systemctl reboot`, GNU `date -s`) |
| VM records ([host/vm-records.mjs](../../host/vm-records.mjs)) | The only per-VM type is `desktop` or `headless`. Backends can say which functions they define (`__functions`) but nothing about what they can run |

A second guest OS today would mean editing all four, with no single place that lists what a guest must provide.

## Design

A **guest definition** is one module per guest OS (`linux` now, `macos` later) that owns everything guest-specific. The rest of boxery asks it rather than embedding shell. Backends stay as they are: a backend says which guests it can run, and the guest definition says what's inside the VM.

```
boxery-host ──► backend (how to run a VM: lima, libvirt, …)
     │
     └──────► guest definition (what's inside: linux, macos)
                ├─ paths: home, project, config dir, runtime (tmpfs) dir
                ├─ identity renderer: Identity → seed file / replay script
                ├─ commands: detach, file mode, lock, boot id, clock, reboot, …
                ├─ layers: which image/layers/* exist, and which are optional
                └─ capabilities: desktop, input, browser, max running VMs
```

## Steps

### 1. Record each VM's guest OS (done)

- `$CONF/vm-os/NAME` sits next to `vm-kind/NAME`, with the same shape: one token, and no record means `linux` (`host/kinds.mjs` then; see the next point). Like the kind, it's fixed for the VM's life, inherited by images and forks from the source VM, deleted with the VM's other records, and kept in the pre-upgrade copy.
- Since then, kind, OS and size are one row per VM in the host's store (`vm_records` in `leases.db`, schema version 2, [host/vm-records.mjs](../../host/vm-records.mjs)), written and deleted in one statement. Upgrading imports the old files. The OS is checked against [guests/](../../guests/) when it's written, so a VM made from an image or fork of an unknown OS is refused, and a new OS needs no schema change.
- It shows as `os` in `boxery ls --json` and so in `vm_info`. (`guest` was taken: it is the guest software's build status.)
- [guests/linux.mjs](../../guests/linux.mjs) holds the path constants that were duplicated (`/home/agent`, `~/project`, `/etc/boxery`, the grants tmpfs directory), and [guests/index.mjs](../../guests/index.mjs) looks a definition up by name. `core/` and `host/` import these instead of keeping their own copies. They import nothing, so the host still doesn't depend on `core/`. Call sites use `linux` directly. Choosing the definition by each VM's record is step 3.

No behavior change. The tests cover the record's round trip and its inheritance by images.

### 2. A neutral identity, rendered by the guest

Split `cloudConfig()` into two parts:

- `identity()`, which returns data: hostname, authorized keys, host key, files (`{path, owner, mode, content}`), proxy upstream, layers to provision, and the post-boot steps (restart sshd, restart the proxy bridge, set up git).
- The Linux renderer, which turns that data into cloud-config for seeded backends (libvirt, Cloud Hypervisor) and into **one** shell script for the backends that replay it (Lima, exe, boat).

This replaces the three replay paths with one, which on its own removes a source of drift between backends. The tests compare rendered output against what `cloudConfig` produces today, byte for byte. A macOS renderer later emits a script (`dscl`, `launchctl`, and a launchd plist in place of `boxery-llm.service`), and for macOS 27 guests it can also feed `VZMacGuestProvisioningOptions`.

### 3. Guest commands behind names

Move the inline guest shell from `core/boxery-core.mjs`, `core/boxery-jobs.ts`, `core/boxery-job-runner.sh`, `core/grants-guest.sh`, `host/patch.mjs`, `host/build-info.mjs`, `host/pool.mjs`, `host/images.mjs` and `host/boxery-lifecycle.mjs` into named functions on the guest definition: `detach`, `fileMode`, `withLock`, `bootId`, `rebootRequired`, `reboot`, `setClock`, `endSessions`, `screenshot`, `pointer`/`keys`, `browserPath`. The Linux implementations are the current strings, unchanged, and snapshot tests pin them.

This is the largest step. It can land one call site at a time.

### 4. Layers per guest

The guest definition lists its layers (now in `layer_files`, `OPTIONAL_LAYERS` in `host/vms.mjs`, and `LAYERS` in `host/build-info.mjs`). Linux keeps `image/layers/*`. A later macOS set goes in `image/layers/macos/`, starting with `plumbing` only.

### 5. Backends declare guests and limits (with [#150](https://github.com/modem-dev/boxery/issues/150))

- A new optional `backend_guests` prints the guests a backend can run, with per-guest limits. Without it, the answer is `linux`. Lima on an Apple Silicon Mac would add `macos max_running=2`.
- boxery-host checks the limits before `new`, `start`, `fork`, `pool add` and lease resets, and fails with the reason. For example: macOS allows two running macOS VMs per Mac, and `ci-1` and `ci-2` are running.
- This is the data-valued half of #150 for guests. The rest of #150 (host platforms, requirements, tested vs supported) can share the same declaration.

### 6. Tools follow the guest's capabilities

MCP and pi tool descriptions and the guidance text ("Ubuntu 24.04", XFCE, `/home/agent`) come from the guest definition. A tool the guest can't support returns a clear error and doesn't run Linux commands: for example, `vm_click` on a macOS guest without input support.

## Order and size

| Step | Size | Useful without macOS |
|---|---|---|
| 1. guest record + paths | small | some (one source for paths) |
| 2. neutral identity | medium | **yes**: three replay paths become one |
| 3. guest commands | large, incremental | yes: GNU-only flags get named and tested |
| 4. layers per guest | small | little |
| 5. guests + limits | small–medium | yes, folded into #150 |
| 6. tools follow capabilities | small | little |

Steps 1 → 2 → 3 in that order. Steps 4–6 wait for the spike in #155, so the macOS side is designed from what Lima actually does rather than from docs.

## Not in this plan

- Any macOS guest code, layers or Lima template changes. That's #155.
- Windows guests.
- Changing the image primitive (`capture`/`reimage`). DiskImageKit overlays fit it as they are, and `backend_capture` stays a backend concern.
