# VM startup experiments (2026-11-01)

## Recommendation

**Use ready VMs for interactive allocation.** The existing pool delivered a VM with a fresh proxy token and lease-holder SSH access in **0.49–0.54 s**, versus **12.89 s median** to cold-create one. Reset cost moves off the next caller's critical path if another clean VM is ready. This is not faster cold boot, and pool exhaustion still matters.

For cold creation, ship the safe polling improvement first (**12.89 → 11.56 s median** in this run). Next, build a dedicated, managed guest network with address reservations/IPAM and IPv4 readiness. That combination measured **8.79 s median**, without changing the guest OS image. Do not change a shared libvirt network or disable address-conflict detection automatically.

Getting materially below ~8 s probably needs both a faster guest boot path **and** a network without the early-boot DHCP race observed here. Subsecond allocation is already demonstrated with the pool; subsecond cold desktop boot is not.

## Setup and scope

- Fresh default branch: `master`, `97a381d`; changes on `perf/vm-startup`.
- Real local Linux KVM/libvirt, QEMU 11.1/q35, existing Ubuntu 24.04 desktop base (kernel 6.8.0-147).
- Host: 32 logical CPUs, ~125 GiB RAM. Existing user VMs remained running and untouched.
- Unless otherwise noted: 2 vCPU, 2 GiB RAM, 20 GiB virtual disk; fully ready means SSH, cloud-init completion and noVNC, not merely hypervisor process creation.
- Timed the checkout's `host/boxery-host`, not the installed controller (which points at another checkout). Local host timing excludes remote controller SSH, grants, and client-side connection setup.
- Private state, copied management key, unique `bxperf-` domains. Test tokens were private to this state, not the running proxy. No real LLM/API calls were made.
- Temporary DHCP host reservations were added live and removed after each test; no network restart, no persistent default-network change. Early reservation experiments reused occupied addresses: those runs are explicitly excluded below.
- Tests are small repeated samples, not a controlled p95 study. Existing host load, timers and accumulated DHCP leases can affect results. Idle benchmark VMs were periodically removed; this was not randomized A/B testing. Treat small differences cautiously.

## Measurements

Wall-clock seconds, including CLI/supervisor startup; medians are not rounded-down `ready (Ns)` logs.

| Experiment | Samples (s) | Median (s) | Interpretation |
|---|---|---:|---|
| Unmodified cold desktop | 12.966, 11.615, 12.919, 12.856 | **12.887** | Reproduces ~13 s |
| Faster SSH + DHCP polling only | 11.558, 11.882, 11.519 | **11.558** | Safe ~1.33 s improvement in this sample |
| DHCP reservations only (old polling) | 10.489, 10.352, 10.320 | **10.352** | Avoids dynamic allocation delay; IPv6 readiness now visible |
| Disable IPv6 link-local/RA only (old polling) | 12.833, 12.852, 11.602 | **12.833** | No standalone benefit while DHCP dominates |
| Reservations + no IPv6 link-local/RA + fast polling | 8.923, 8.785, 8.776 | **8.785** | Best repeatable cold result |
| Above + direct kernel/initrd + SCSI seed CD, fresh MAC/IP | 11.944, 11.704, 10.551 | **11.704** | Faster kernel, slower network readiness; not a win here |
| Smaller initramfs, quiet boot, masked snapd + fast network/polling | 9.675, 8.864, 9.925 | **9.675** | 30 → 18 MiB initrd, but no end-to-end win; also hits early network timing |
| Ed25519-only host-key generation + fast polling | 11.375, 11.472, 11.458 | **11.458** | Tiny improvement vs fast-poll baseline; not enough to justify compatibility change alone |
| Default standard shape + fast polling (4 CPU / 8 GiB / 40 GiB) | 12.433, 11.831, 12.486 | **12.433** | More RAM/CPU is not a shortcut to fast boot |
| 8 vCPU / 2 GiB / 20 GiB + fast polling | 10.912, 10.951, 11.114 | **10.951** | Modest improvement at higher CPU cost |
| `new --from` a small prepared snapshot + fast polling | 11.906, 11.704, 11.723 | **11.723** | Reuses software, not a running machine; still cold boots |
| Three-way parallel fork (one trial) | 20.168 total for 3 ready VMs | — | Better batch throughput than serial, not lower single-VM latency |
| Warm `acquire` (3 trials) | 0.488, 0.538, 0.538 | **0.538** | Includes token rotation and SSH key installation |

A smoke run of the committed benchmark independently measured cold `new` **11.882 s**, warm `acquire` **0.484 s**, and release/reset **8.427 s**. Reset must complete before a VM is reusable; the pool is not safely reissuing a dirty guest.

Other trials / negative results:

- A separate transient NAT network with dnsmasq `no-ping` never assigned an IP on this host. UFW is active; isolation/network policy needs investigation. **No successful no-ping performance claim**. The network and failed VM were removed.
- Three fast-network trials accidentally reused IPs still leased to different MACs; dnsmasq assigned different dynamic addresses and results remained ~11.7–11.9 s. Excluded from the fast-network result. An allocator must account for leases, not just running VMs.
- Three direct-boot trials reused previous MAC/IP leases. `domifaddr --source lease` returned stale leases immediately, so early SSH attempts spent 5 s timing out. Those trials (9.933, 9.956, 11.331 s) are not the clean direct-boot comparison. A lease is not evidence that the current incarnation is online.
- Netplan `optional-addresses: [ipv6-ll]` supplied through the seed did not survive this image's cloud-init network rendering: the resulting `.network` still waited for IPv6 link-local. Two conflict-free trials were 10.135 and 10.605 s. Do not claim it fixes readiness without inspecting generated configuration.

## Where the time goes

First baseline process trace:

| Stage | Time |
|---|---:|
| Existence + base checks | ~36 ms |
| Seed/backend upstream | ~22 ms |
| `backend_new` (mostly boot + DHCP wait) | 9,691 ms |
| Endpoint lookup | 15 ms |
| SSH wait, including a 2 s poll sleep | ~2,632 ms |
| `cloud-init status --wait` over another SSH connection | 311 ms |
| noVNC check over another SSH connection | 187 ms |

Inside `backend_new`, `virt-install` itself took ~412 ms. Disk overlays/seed creation and repeated backend shell startup are not the main 13-second cost. A persistent Node/libvirt daemon or replacing `virt-install` with hand-written XML is not the first lever.

Guest evidence:

- Baseline `systemd-analyze`: **2.846 s kernel + 6.666 s userspace**; networkd wait-online **3.033 s**.
- Baseline network link up at guest monotonic ~4.422 s; DHCP address acquired ~7.450 s.
- With reservation: DHCP acquired ~4.321 s, only ~21 ms after link up. Wait-online still waited until IPv6 link-local at ~6.265 s.
- With reservation and link-local/RA disabled: DHCP acquired ~4.226 s, ~12 ms after link up; **2.766 s kernel + 3.434 s userspace**.
- Dynamic allocation delay is consistent with dnsmasq's address-conflict ping checks; reservations removed the observed delay. We did not directly capture the ICMP exchange, so this is a supported explanation, not a packet-level proof.
- Existing bridge XML says `stp='on' delay='0'`, but `/sys/class/net/virbr0/bridge/forward_delay` is **200 centiseconds**. Host kernel logs show ~2 s listening + ~2 s learning before forwarding. Faster guest experiments brought networkd up before or close to forwarding readiness and incurred DHCP retransmission delays. This is a likely reason the direct/slim variants regress, not proof that faster kernels are inherently slower.
- Ordinary clone cloud-init active work was ~1.36 s. RSA host-key generation ~0.50 s; grub configuration ~0.20 s; normal per-VM script ~0.03 s. Removing cloud-init entirely is not a free 6-second win.

## Prioritized next steps

### 1. Make warm allocation the normal interactive path (measured ~0.5 s)

Use today's `pool add` / `acquire` / `release`. Maintain enough already-clean, booted spares to cover bursts **and** replenishment time. A synchronous reset/reboot on release is fine if the next caller receives another FREE VM. If callers must wait for the same released VM, latency returns.

For a productized allocator:

- Target ready counts per host, shape and immutable template version; replenish asynchronously on claim, with capacity limits/backpressure.
- Match acquisition to requested shape/template. Today's unfiltered pool is not a substitute for arbitrary `new --shape/--from` semantics.
- Keep durable lease state, lifecycle locks, failure quarantine, token rotation, key fencing and reset-before-FREE guarantees.
- Pool VMs already have names. Supporting arbitrary caller-chosen names transparently needs an alias/identity design; do not just rename a running domain while leaving hostname/token/proxy/grant identity behind.
- Measure time-to-usable from the controller too: acquisition, transport setup, grants, first `run`, optional first desktop frame. The measurements above include host lease installation, not those client extras.

### 2. Ship polling fix (implemented here)

- libvirt endpoint probes: 1 s → 250 ms, preserving an ~180 s deadline.
- SSH probes: 2 s → 250 ms, preserving the legacy configured wait budget. Connection/check time now consumes that budget instead of extending it indefinitely. Fatal endpoint diagnostics still fail immediately; `BOXERY_SSH_WAIT_TRIES=1` still means one attempt.
- No readiness criteria, identity setup, snapshots, lock fencing or cloud-init guarantees removed. Worst-case extra observation delay falls from ~3 s across DHCP + SSH to ~0.5 s, but actual end-to-end gain depends on boot timing.
- Cost: up to four local `virsh` queries/SSH attempts per second while waiting. Confirm behavior at high concurrent boot counts before wide deployment.

### 3. Managed guest networking (measured path to ~8.8 s)

Prefer a boxery-owned isolated NAT network with controlled address allocation:

- Atomic IP/MAC reservation across concurrent creates; inspect static assignments and unexpired leases. Persist ownership and recover reservations after failed creates/removes.
- Fence stale endpoints/incarnations; do not confuse an old DHCP lease with readiness.
- IPv4-only networks should not block cloud-init on IPv6 link-local DAD. Preserve IPv6 on networks that actually use it; inspect cloud-init → netplan → networkd output rather than relying on ignored YAML.
- Disable STP only on a dedicated topology where there can be no L2 loops. Do not mutate the shared `default` bridge or restart it under live VMs.
- `no-ping` could avoid dynamic allocation conflict checks, but disables a safety check and was **not successfully benchmarked** here. Only consider it on a controlled subnet with a proper allocator.
- Handle host firewall rules as part of network setup. Merely creating another libvirt NAT network was insufficient on this machine.

### 4. Guest/base optimization, after fixing the network race

Retest direct kernel boot, smaller initramfs, quiet serial console, minimal devices and nonessential boot services on the managed network. Current trials do not establish a net win. Keep kernels/initrds versioned with the image and architecture; `MODULES=dep` built on one VM may omit drivers another backend needs. Disabling snapd can break snap workloads; not a blanket desktop default.

A small purpose-built headless image avoids desktop services and the stock headless path's package installation. Today `new --headless` provisions plumbing/devtools on a stock cloud image and can take far longer than 13 s. Reuse a prepared headless snapshot with `--from` to avoid reinstalling tools; a first-class versioned headless base would be cleaner.

Minimize per-instance cloud-init modules only after testing resize, filesystem growth, mounts, identity and key regeneration. Bake stable git settings/project skeletons into templates. Avoid blanket recursive `chown` of a populated fork's home if ownership is already correct: our tiny-image measurements do not cover millions of source files.

### 5. Storage / clone path (depends on source size)

- Existing fresh disks already use qcow2 overlays; virtual 20/40 GiB size is not a full copy.
- A small prepared snapshot was not faster than a cold base here. Large source overlays can make `blockpull --wait` a real extra cost; measure GiB-scale forks separately.
- Immutable versioned image roots, reference-counted backing chains, reflink/thin snapshots or background flattening can move copying off the ready path. Must redesign image deletion/GC first: current contract says forks become independent and images may be deleted immediately. Removing blockpull without changing ownership would violate it.
- Keep live-capture filesystem consistency and discard/unmap support. Avoid optimizing by returning an inconsistent disk or deleting a backing file still in use.

### 6. More invasive approaches (not demonstrated here)

| Approach | Potential | Important constraints |
|---|---|---|
| Saved RAM/checkpoint restore | Skip kernel/userspace initialization | Read potentially GiB of RAM; consistent disk/RAM pair; device/CPU compatibility; per-clone MAC/IP/vsock/token/keys/machine-id; RNG reseeding/VM generation ID; stale TCP/SSH sessions and clocks; never expose captured grants/secrets |
| Firecracker / Cloud Hypervisor direct boot | Smaller device model, tailored headless kernel/init | Backend/kernel/network/image work; desktop/browser workload requirements; this machine lacks the CH executable, so no cross-hypervisor comparison was run |
| CRIU/process or container warm pools | Fast ready-to-run sandboxes | Not interchangeable with a VM security/kernel boundary; explicitly different product semantics |
| Persistent host daemon / libvirt bindings | Amortize process and metadata startup | Here tens/hundreds of ms vs seconds of guest/network boot; operational/security complexity |
| Cache image/model discovery; direct image lookup | Reduce metadata overhead, especially many images or slow Ollama | `ollamaModels` can wait up to 3 s when a local server hangs; image existence currently enumerates images. Not a bottleneck in this run |
| Batch precreation / parallel boot | Improve throughput | Current fork already parallelizes. One 3-VM batch took ~20 s, so unlimited fan-out is not a latency fix; bound CPU/I/O contention |
| Lazy desktop readiness | SSH-only callers return earlier | noVNC check was only ~0.2 s here; little win, and changes what “ready” promises |
| Remote exe/boat/Lima backends | Provider-dependent | Their API, transport and boot paths differ; local libvirt timings are not evidence for those providers. Warm allocation still applies |

## Reproduce

```sh
# Existing initialized libvirt host + desktop base required. Creates REAL VMs, then removes them.
# Uses an isolated state directory/domain prefix; never changes network or base configuration.
node test/bench/vm-startup.mjs 5 --cpus 2 --mem 2048 --disk 20 > results.jsonl

# Optional stage diagnostics on normal creation; stdout protocol is unchanged.
BOXERY_TIMINGS=1 host/boxery-host new my-benchmark --shape small
host/boxery-host rm my-benchmark

# Host process overhead only (fake backend, not VM boot latency):
bash test/bench/host-timings.sh 10
```

The real benchmark emits cold-create, warm-acquire and reset wall times, stage diagnostics, and summaries. It removes each cold VM before starting the next, then prepares one pool VM for repeated acquire/release. It retains its private state and prints recovery instructions if cleanup fails. Private management keys, tokens and journals are not checked in.

Advanced network/kernel variants above were temporary experimental wrappers, **not shipped defaults**. Raw local logs are under `/tmp/boxery-startup-bench/` for this session; this directory is temporary, not a durable results artifact.

## Validation and cleanup

- `npm test`: **247 passed**.
- `npm run test:shell`: passed, including new real-loop polling/deadline tests against doubles.
- `npm run lint`: passed.
- Real benchmark smoke test: passed; no benchmark domains/volumes remained.
- All experimental VMs, snapshots, kernel/initrd volumes, the transient network, live reservation entries and private copied-key state were removed. Existing user VMs/base/network persistence were not changed. Expiring DHCP leases from deleted benchmark VMs may remain in libvirt/dnsmasq until their normal expiry.

References: [dnsmasq manual](https://dnsmasq.org/docs/dnsmasq-man.html), [libvirt network XML](https://libvirt.org/formatnetwork.html), [libvirt DHCP/STP troubleshooting](https://libvirt.gitlab.io/libvirt-wiki/PXE_boot_or_dhcp_on_guest_failed.html), [Netplan YAML](https://netplan.readthedocs.io/en/latest/netplan-yaml/).
