# Experimental RAM-template creation (Cloud Hypervisor)

Opt-in acceleration for **new, empty VMs**, not user snapshots or a running spare pool.
Defaults remain cold boot + TAP. Other backends are unchanged.

On this x86_64 Linux host, five full controller/core desktop creates (2 vCPU, 2048 MiB,
20 GiB, warm tmpfs assets, CH v54, eager restore + passt) measured:

| Path | Median | Range |
|---|---:|---:|
| RAM-template `new` | **1.947 s** | 1.835–2.007 s |
| Same profile, `new --cold` | **7.545 s** | 7.210–7.731 s |

These include controller, identity/token creation, private disk creation, network, assignment,
SSH and ordinary readiness checks. They exclude one-time template building and subsequent
browser launch. In the final functional run, launching Chrome, loading example.com and
receiving browser + desktop screenshots took another 1.219 s. They are not disk-cold,
8-GiB-shape or multi-host performance claims.

## Design and invariants

1. `build.py` creates a **disposable** VM from a trusted, secret-free Boxery base using
   a separate management journal and unique name. Never supply an existing user VM.
   It refreshes the current image layers, scrubs credentials, disables cloud-init and
   ordinary services, and boots an assignment-only target through EDK2 firmware.
2. The source has no NIC. After its root assignment agent is ready, it is paused and
   saved. It never resumes. Its matching disk, RAM, device state and firmware are
   published together in a new immutable version; a shape index changes atomically.
3. Each create has a new VMM process, qcow2 overlay, private vsock socket and network
   identity. The host attaches networking before resuming the saved kernel.
4. Before SSH, D-Bus, logind, user managers, browsers or jobs start, the one-shot agent
   mixes 512 fresh entropy bits into the kernel and forces reseeding; corrects time;
   installs a fresh machine-id, hostname, SSH host/authorized keys and proxy credentials;
   re-execs PID 1 and restarts journald; configures networking and filesystem growth;
   and writes a fresh `/run/boxery/incarnation`. The root listener closes at release.
5. Normal Boxery readiness, journals, locks, leases, grant revocation and recovery still
   apply. VMM and passt children live in the VM's systemd cgroup, not detached workers.

The Linux **kernel `boot_id` remains cloned**. Boxery jobs fence on `boot_id:incarnation`.
Applications requiring a genuine new kernel boot must use `new --cold` (tool argument
`cold: true`). Do not treat changing `/etc/machine-id` alone as restore safety.

**Snapshots, `--from`, forks, reverts and pool resets remain disk-only.** They cold boot
and run assignment before releasing services. Ordinary restarts preserve current lease
keys/tokens rather than replaying the original create seed. Firmware boot is intentional:
`sudo reboot` must use the guest's updated GRUB/kernel, not a frozen direct-boot kernel.
Images retain small `.fast.json` boot metadata, never live user RAM.

## Requirements

- Linux x86_64, KVM, systemd user manager; Cloud Hypervisor + ch-remote v54+.
- Python 3.11+ for building, Python 3.9+ at runtime, qemu-img, cloud-localds, socat.
- A working local libvirt or CH source profile, with a trusted Boxery Ubuntu/ext4
  `/dev/vda1` base and management key. Custom/untrusted images are not sanitized into
  safe templates by this tool.
- Current EDK2 `CLOUDHV.fd`. Old Rust firmware panicked with this Ubuntu kernel in
  validation. Tested EDK2 release: `ch-97eeb7b09`, SHA256
  `dc2fc8f0e43b96712d9fccc52a3a590769606412b3e1bc911d217addd3bef624`.
- TAP: the existing backend's explicit administrative network setup/permissions.
  Alternatively, **explicitly** select passt with vhost-user support.

### Networking and memory trade-offs

**TAP** keeps the existing nftables anti-host/anti-LAN policy and can use
`BOXERY_CH_RESTORE_MODE=copyonwrite`. New fast TAP prefixes and firewall tables are
profile-namespaced; different TAP profiles still require different `BOXERY_CH_NET`s.
The new RAM adapter's TAP/COW integration was not exercised with real privileged
networking on this machine; COW was measured separately in the earlier prototype.

**passt** changes no shared host interfaces, routes, sysctls or firewall rules. Each VM
has an IPv4-only userspace NIC and localhost SSH forwarding. Controller SSH, desktop,
files and proxy traffic keep their existing transports. **This is not equivalent to
TAP's egress filtering:** private/LAN destinations follow the host's routing policy.
Do not use it as a hostile-network isolation boundary.

passt's vhost-user NIC requires shared RAM, so it uses **eager `copy` restore**, not
COW. Budget approximately the configured RAM per running VM, including otherwise
unused pages. An 8-GiB shape is not a 150-MiB clone. No userfaultfd privileges or
passwordless-sudo workaround are used.

## Build and enable a separate profile

Run from this checkout, with CH binaries on PATH. Pick a NEW storage directory/profile
and a free forwarding port range; do not repoint an existing profile's base or network.
Obtain and verify the firmware above from cloud-hypervisor/edk2 first.

```bash
DATA="$HOME/.local/share/boxery/ch-ram-preview"
FW=/absolute/path/to/CLOUDHV.fd
mkdir -p -m 700 "$DATA"

# Uses the current working source profile (BOXERY_CONF can select it).
# --cold-base creates an independent conventional fallback; it refuses overwrite.
python3 host/fast/build.py --templates "$DATA/templates" --firmware "$FW" \
  --network passt --shape small --cold-base "$DATA/base.qcow2"
python3 host/fast/build.py --templates "$DATA/templates" --firmware "$FW" \
  --network passt --shape small --kind headless

BOXERY_CH_DIR="$DATA" BOXERY_CH_FIRMWARE="$FW" BOXERY_CH_FAST=1 \
BOXERY_CH_NET_MODE=passt BOXERY_CH_PORT_BASE=24000 \
  host/boxery-host --profile ram-preview init --backend cloud-hypervisor
host/boxery-host --profile ram-preview new demo --shape small
host/boxery-host --profile ram-preview new fresh-kernel --shape small --cold
```

Install a sufficiently recent passt on the host first; `BOXERY_CH_PASST` can select an
absolute executable path. The tested passt source revision was
`6aa4f88bd9846411edff3ed70460475b538addca`.

Register/select this host profile using the normal controller setup. Existing `new`,
`vm_manage`, desktop, browser, file, jobs and grant interfaces need no fast-specific
client protocol. `--cold` bypasses Boxery's RAM-template selection.

Matching is exact on kind, CPU count, RAM, disk size and network mode, not the shape's
label. Build the source profile's default shape too if default `new` should accelerate.
`--cpus`, `--mem`, `--disk` override `--shape`. Missing shapes take the ordinary cold
path. A selected corrupt/incompatible template **fails closed**: rebuild or use `--cold`.

## Versioning, retention and limits

Templates pin CPU/architecture, CH version, guest/boot-barrier fingerprint and paired
asset sizes; building records full SHA256s. Create does not rehash multi-GiB assets on
its critical path. Keep storage private and immutable; this is not protection against
a malicious host owner or arbitrary same-size disk corruption.

Versions are append-only, with **no automatic GC**. Keep all versions referenced by
VM/image backing files or their boot metadata. Do not move/delete them under existing
VMs. Rebuild after incompatible host/agent changes; older live VMs are not upgraded in
place. Normal user snapshots are not a replacement for template backups.

This remains experimental, not a completed security audit or hostile-tenant product.
Real host reboot/upgrade fault matrices, privileged TAP/COW lifecycle, hardware/CPU
migration, cold-cache/concurrent full-workload benchmarks and safe template GC remain
work. Existing CH limitations (including no VM autostart after host reboot) still apply.

## Reproduce validation

```bash
node --test test/fast.test.mjs test/browser-output.test.mjs
python3 -B -m unittest discover -s test/fast -p 'test_*.py' -v

# REAL VMs, empty disposable initialized profile ONLY. Requires both kinds of
# template for 2 CPU / 2048 MiB / 20 GiB (build with those explicit size flags).
BOXERY_CONF=/path/to/disposable/profile \
  node test/bench/fast-lifecycle.mjs --run --rounds 5
```

The real-VM test uses a fresh controller identity and removes its VMs, lease keys and
registration afterwards. It checks HTTPS/git, proxy authorization/revocation (without
issuing model inference), files/copy/edit, jobs, Chrome and screenshots, dummy grants,
guest reboot with a changed GRUB command line, headless refusal, forced cold create,
lease-preserving restart, disk-only fork with stale-job/key fencing, pool cleanup and
SIGKILL/interrupted-create recovery. JSONL timings are emitted on stdout.
