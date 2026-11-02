# RAM-template proof of concept

**Status:** the initial prototype findings below are historical. A subsequent opt-in
Boxery integration is implemented and measured in the [integration addendum](#integration-addendum-2026-11-02).
Defaults remain unchanged; this is still experimental, not a completed security review.

## Result

**The architectural change works in an isolated prototype.** New Cloud Hypervisor processes restore a prebooted desktop from RAM + CPU/device state, with private qcow2 disks. No pre-running spare is handed out.

Reproduced with the automated preparation script, five trials per mode, 2 vCPU / 2 GiB guest, local tmpfs template:

| Path | Assigned shell + desktop-service readiness, median | Rendered browser screenshot, median |
|---|---:|---:|
| Cold boot of the same prototype guest | **3,051.75 ms** | **3,548.70 ms** |
| Eager RAM restore (`copy`) | **165.23 ms** | **354.07 ms** |
| Copy-on-write RAM restore | **135.45 ms** | **649.92 ms** |

COW is ~22.5× faster to this readiness milestone than the matched cold prototype. Eager restore is faster to the first rendered frame, at the cost of eagerly populating ~2 GiB per clone. Lazy restore moves some work into first use; API/agent availability alone would overstate the result.

These are **not end-to-end `boxery new` numbers**. The previous production-path ~13 s measurement includes SSH/cloud-init/DHCP; this prototype uses a new vsock agent, no virtual NIC, disabled cloud-init/SSH, and an already-installed blank Chrome desktop. Its matched cold control has exactly those same choices. No internet request, controller, production lease, real proxy token or grant flow was timed. The screenshot renders local clone-specific HTML.

## What was built

Under [`test/bench/ram-template/`](../../test/bench/ram-template/):

- `prepare.py`: downloads pinned/verified Cloud Hypervisor v54.0 binaries, creates a private-state/prefix libvirt builder, copies its kernel/initrd and an independent root disk, boots it under CH, waits for the blank browser to settle, pauses it, saves RAM/device state, and stops the source permanently. Cleans up its builder and copied management key.
- `prepare-guest.sh`: configures only that disposable guest. Installs the experimental service units, disables cloud-init/SSH and removes credentials/cloud-init user-data. Clears stale Chrome singleton locks on cold startup. Never run it on a host or useful VM.
- `guest-agent.py`: experimental root vsock server. Refuses commands before assignment, explicitly reseeds the guest kernel RNG from 64 fresh host bytes, creates per-clone credentials/hostname/machine-ID file, checks a real non-root shell command and HTTP readiness, and renders/captures a browser frame over CDP. No Playwright dependency is needed: the CDP client uses Node's built-in WebSocket.
- `bench.py`: starts a new VMM + private disk for every trial, compares cold/eager/COW/optional modes, records cumulative timing and process memory, runs simultaneous-clone checks and an optional burst, hashes the RAM template before/after, and terminates VMMs in `finally`.
- `test_bench.py`: seven host-only unit tests for path isolation, immutable source config, vsock handshake/error handling, and process cleanup.
- `results/*.jsonl`: raw measurements, without assignment secrets, disks, RAM images, or binaries.

Both the initial hand-built template and a newly built template from the automated script reproduced subsecond restore. One-off RAM capture for the final automated template took **273.54 ms**; preparing/exporting the OS image and warming services are separate build-time costs.

## Mechanism

```text
Prepare once:
  Ubuntu desktop + blank Chrome + unassigned vsock agent
  → check readiness / sync → pause → save RAM + CPU/devices
  → stop source permanently; retain its matching disk, immutable

Per clone:
  qcow2 overlay on immutable disk
  → new VMM process with restored CPU/devices
  → either eager-copy RAM or map template RAM privately (COW)
  → assign fresh entropy / experimental credentials / instance label
  → real shell command + noVNC/CDP probes → browser render/capture
```

Each clone gets private Unix socket paths. Cloud Hypervisor's hybrid vsock permits the same guest CID behind different host sockets; no shared guest Ethernet/IP or privileged TAP setup is used. For restore, the experiment copies the small snapshot metadata and rewrites documented configuration paths to the clone's disk, serial log and vsock socket. It hardlinks the RAM template, so no 2 GiB file copy is performed for COW clones.

`/proc/PID/maps` confirms a private writable mapping of `memory-ranges` for COW clones, versus no template mapping for eager-copy clones. The RAM template SHA-256 remained unchanged after all clone operations. Source disk files are read-only; each clone writes only its overlay.

## Cache, storage and burst experiments

Host: AMD Ryzen AI MAX+ 395, 32 logical CPUs, ~125 GiB RAM, existing user VMs running. Guest: Ubuntu 24.04.5, kernel 6.8.0-147, Chrome 156; generic distro kernel, not a custom microVM kernel. Chrome uses the existing TigerVNC desktop with GPU disabled.

Five trials per mode on a **disk-backed** template, not tmpfs:

| Path | Normal file cache: ready / frame median | Template-file cache eviction requested: ready / frame median |
|---|---:|---:|
| Matched cold boot | 4,433.59 / 4,875.83 ms | 4,096.23 / 4,573.88 ms |
| Eager restore | 175.68 / 361.04 ms | 287.33 / 491.44 ms |
| COW restore | 149.63 / 684.34 ms | 270.10 / 947.65 ms |

Eviction is `fsync` + `POSIX_FADV_DONTNEED` on **only this experiment's RAM template and root disk**, immediately before each trial. It is advisory, not proof of a globally cold machine or cold SSD controller. Kernel/initrd and small metadata may remain cached. No system-wide drop-caches or user-VM disruption was performed. Cold/warm control variation also shows these are small samples, not stable p95 guarantees. Modes alternate within rounds but ordering is not randomized.

One **8-clone COW burst** on the disk-backed cached template:

- All eight assigned, with working shell + noVNC/CDP services: **404.58 ms total**, including all private-overlay creation and VMM startup.
- No eight-frame rendering workload was included in that burst milestone.
- Summed VMM process PSS after readiness: **522.71 MiB**, plus template/page-cache memory outside that sum. This is not total host memory consumption.
- Two simultaneous COW clones after probes had ~28–31 MiB private dirty memory each in the disk-backed runs; shared mapped pages are apportioned by PSS. Workloads and browser rendering subsequently dirty more pages. This is not a steady-state density guarantee.
- Eager restore processes had ~2 GiB PSS, consistent with copying all configured guest RAM.

Raw data:

- `settled-template-repro.jsonl`: automated final preparation, five rounds (primary table).
- `tmpfs.jsonl`: initial successful template, five rounds; COW ready/frame medians 118.90/619.14 ms, eager 184.88/365.04 ms, cold 3,069.55/3,509.59 ms.
- `disk-warm.jsonl`, `disk-evicted.jsonl`: disk-backed cache experiments.
- `burst.jsonl`: eight-clone burst and isolation checks.
- `thp.jsonl`: eager/COW/COW-without-host-THP comparison; disabling THP did not help (COW frame medians ~625 vs ~635 ms).
- `early-template-smoke.jsonl`: automatic template captured immediately after first readiness, before adding a settling delay; one COW trial was ~412 ms ready / ~879 ms frame with more dirty memory. The final preparation waits 5 s before capture and then rechecks readiness. Early snapshots reproduce unfinished startup work in every clone.
- `retained-template-smoke.jsonl`: the final automated template relocated to disk-backed cache, then successfully restored again (COW ~160 ms ready / ~704 ms frame in one trial).

## Checks that passed

Across independent preparations and repeated restore modes:

- Every restored agent starts unassigned; it rejects command probes before assignment.
- A fresh host-supplied experimental secret is required after assignment.
- Clone A rejects clone B's secret.
- A filesystem marker written in A is absent in simultaneous B and in fresh clones.
- Machine-ID **files** and sampled kernel random output differ between clones.
- Actual shell command runs as `agent`; noVNC returns 200; Chrome reports a CDP version.
- Browser creates clone-specific content and returns a valid PNG; images were visually checked.
- Actual COW file mappings are present, and the template RAM hash remains unchanged.
- **Duplicated kernel `boot_id` is detected and reported**, not hidden.
- All experimental VMMs stop on normal completion, including the tested failed restore. No existing VM was stopped or modified; no shared network/base configuration was changed.

These are functional checks, **not a complete security assessment**. Distinct random samples alone do not prove entropy safety; the explicit reseed is a separate mechanism. Fresh file contents alone do not prove all services have a fresh identity.

## Negative results / problems encountered

- Eager restore beats COW to the first rendered frame despite a slightly slower first readiness result. Lazy faults/COW work are real costs; sub-40 ms agent availability is not the user-facing latency.
- Host THP off did not improve COW first-frame latency in this workload.
- CH `ondemand`/userfaultfd restore fails with `Operation not permitted` on this host. `/dev/userfaultfd` is root-only and the syscall is restricted. COW restore does **not** need that permission. No permissions/sysctls were changed to force it.
- The older existing base has Playwright under a different installation path; the first screenshot attempt failed. The final prototype uses the browser's CDP protocol and Node's built-in WebSocket instead of assuming a package path.
- An early cold comparison failed because Chrome inherited its previous hostname/PID singleton lock and assignment renamed the guest before Chrome launched. The cold-start unit now removes those stale lock files. Disk + RAM cloning preserves application state that a cold boot normally would not expect.
- The source must settle: snapping at the first HTTP response captured active browser/OS initialization and produced slower, dirtier clones. The build-time settling delay is explicit and reproducibility was retested.

## Production blockers / next implementation steps

1. **Network and transport.** Add preconfigured, isolated TAP/routing or namespace-based networking; use a narrowly privileged setup helper/FD handoff rather than granting broad privileges to every VMM. Rebind routes/IPs safely after restore or use per-clone namespaces with an identical internal address. Test real git/package/LLM/browser traffic. Current local HTML screenshot proves no internet behavior.
2. **Real identity and credential lifecycle.** Integrate host journals, supervised recovery, locks, leases, proxy tokens, grants and controller SSH. The prototype's assignment secret is not a Boxery token or lease. Reject stale generations and handle failed assignment atomically.
3. **Global assignment barrier / userspace state.** The agent fences host commands, but the already-running browser and other services resume before assignment. Explicit kernel reseeding does not reset application-cached RNG state. Start/restart unsafe services only after assignment, or build a tested restore-aware barrier. Templates must never carry user credentials, logged-in browser profiles, or tmpfs grants. Keep ordinary user snapshots disk-only.
4. **Incarnation identity.** Kernel `boot_id` is identical after RAM restore. `core/boxery-jobs.ts` currently relies on it to fence stale process/job metadata after a reboot. Introduce a host-assigned Boxery incarnation, and use it for relevant guest job/reset logic. Rewriting `/etc/machine-id` does not update cached identities in systemd, D-Bus or applications; design/test those explicitly.
5. **Clock and service correctness.** Test pause duration, time stepping, expired tokens, scheduled jobs, stale sockets, browser IPC/locks, reboot, shutdown, and repeated restore. Successful probes are not coverage for all long-running services.
6. **Template ownership and compatibility.** Version/refcount both disk and RAM; never mutate/truncate a template in use. Pin hypervisor/device/CPU/architecture compatibility, match VM shapes (do not assume arbitrary CPU/RAM resize works across a captured device state), and define GC, upgrade and host-reboot behavior. Test full host crash recovery and page-source loss.
7. **Real workload performance.** Compare eager/COW under memory pressure, concurrent browser rendering, builds/tests and long-lived page dirtying. A hybrid working-set restore may balance latency and memory, but was not implemented. Cold cache, slow storage and background activity can change the winner.

## Validation and retained artifacts

- Host-only Python tests: **7 passed**.
- `npm test`: **247 passed**.
- `npm run test:shell`: full suite passed (an initial combined validation command exceeded its outer time budget; the full shell suite was rerun successfully).
- `npm run lint`, Python syntax compilation, shell syntax and ShellCheck: passed.
- The automated builder and its copied management key were removed. All experiment VMMs stopped; temporary multi-GiB tmpfs artifacts were deleted.
- One immutable prepared template (~7.3 GiB allocated disk) remains in a private directory under `~/.cache/boxery-ram-template.*` for further iteration. No VMM using it is running. Checked-in artifacts are only code, documentation and credential-free JSONL results.

## Recommendation

Proceed with a separate **experimental fast-template path in the CH backend**, not a replacement of ordinary disk snapshots/forks. Start with trusted, secret-free headless and desktop templates; use a restore-aware assignment barrier and real Boxery fencing before enabling user workloads. Retain the existing cold path as fallback.

For latency-sensitive desktop use with enough RAM, **eager restore deserves equal consideration**: ~0.35 s to a frame in the matched tmpfs reproduction versus ~0.65 s for COW. For many mostly-idle guests, COW has a compelling memory-sharing advantage and still reaches a frame well below a second in cached tests.

Reproduction commands and constraints are in the benchmark README. This prototype is on `experiment/ram-templates`, separate from the polling PR. It does not install or enable a new production backend.

## Integration addendum (2026-11-02)

Implemented [`host/fast/`](../../host/fast/README.md), selected by `BOXERY_CH_FAST=1`.
This is no longer just the no-NIC benchmark, but it is not enabled by default or merged.

Five full controller/core creates, same CH/passt profile, 2 vCPU / 2048 MiB / 20 GiB,
warm tmpfs assets:

| Path | Median | Range |
|---|---:|---:|
| Empty desktop, RAM template | **1.947 s** | 1.835–2.007 s |
| Ordinary cold desktop, `--cold` | **7.545 s** | 7.210–7.731 s |

Approximately **3.9×** faster for this matched end-to-end comparison. These are not
0.15-s Boxery creates, cold-storage or 8-GiB-shape results. First subsequent Chrome
launch, public HTTPS navigation and browser/desktop screenshots added 1.219 s in the
benchmark's functional run. Raw records: [`fast-results.jsonl`](../../test/bench/fast-results.jsonl).
The original ~13-s libvirt number remains a different backend/network comparison.

### Requirements exercised

- Minimal pre-user assignment target; no prestarted browser/user workloads. One-shot
  root listener closes before normal services. Explicit kernel entropy reseed, clock,
  fresh machine-id/hostname/SSH keys/credentials and incarnation; PID 1 re-exec and
  journald restart before user services.
- Two clones of the SAME kernel template verified: duplicated kernel boot ID, but
  distinct machine IDs, incarnation IDs, SSH host public keys, random samples and
  D-Bus instance IDs. PID 1's actual sd-bus machine-ID cache and journald's recorded
  machine ID matched each clone's new file. Random samples are not by themselves
  proof of entropy safety.
- Fresh controller key, SSH, real public HTTPS/git, file write/read/edit/copy, jobs,
  fresh Chrome/Playwright, actual screenshots, dummy environment grant/revoke and
  headless refusal of desktop tools.
- Real proxy bridge health; valid scoped token reaches route authorization (403),
  invalid/released tokens fail authentication (401). No paid model inference was issued.
- Guest reboot honors an updated GRUB command line. Templates boot through pinned
  EDK2 firmware, not a fixed direct kernel that would ignore guest kernel updates.
- Stop/start while leased preserves its active lease token/key, not the original
  create token. Pool reset removes lease tmpfs data, rejects the expired SSH key and
  revokes its proxy token before returning FREE.
- Live user snapshots and forks remain DISK ONLY. New-from-image cold-boots, preserves
  persisted files, loses tmpfs grants, regenerates keys/tokens and fences stale jobs.
- SIGKILL of a create supervisor after unit metadata publication, followed by real
  journal recovery, removed its unit/data/token. VM and passt processes are supervised
  inside the VM's systemd cgroup. No surviving test VMs, images or pool members remain.
- Immutable versioned paired assets, exact shape/CPU/architecture/hypervisor/agent
  compatibility and cold bypass/fallback. No automated GC can invalidate a backing
  version. Kernel boot ID plus incarnation fences Boxery job metadata.

The browser test also exposed an existing helper bug: `process.exit()` truncated
large screenshot JSON while stdout was buffered. It now awaits the write callback;
a separate 1-MiB regression test exercises the real helper over a mocked transport.

### Remaining limits / deployment status

- The real integration used explicit **rootless passt**, not privileged TAP. It leaves
  shared host networking alone but DOES NOT implement TAP's private/LAN egress filter.
  It requires eager shared RAM: budget roughly the VM's configured RAM per instance.
- The TAP/COW adapter has offline namespace/lifecycle tests, not real privileged
  networking validation here. The earlier prototype's COW latency/memory results
  must not be relabeled as integrated Boxery results.
- Full hardware reboot/upgrade/failure matrices, CPU migration, cold-cache/load/burst
  benchmarks, safe template GC and an independent security review remain outstanding.
- Existing users' base images, VMs, default backend and network configuration were
  not changed. Testing used a private disposable profile and temporary services.

Validation: **252 Node tests**, **17 fast-path Python tests**, the complete offline
shell suite and lint passed; Python compilation and diff whitespace checks passed.
`npm run typecheck` could not run because this checkout has no `tsc` installed.
The original seven prototype Python tests remain separate from the new adapter suite.

References: [CH v54 snapshot/restore](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v54.0/docs/snapshot_restore.md), [Firecracker entropy/clone considerations](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/random-for-clones.md), [QEMU VM templating](https://www.qemu.org/docs/master/system/vm-templating.html).
