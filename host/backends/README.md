# boxery backends

`host/boxery-host` is backend-agnostic. It generates each VM's identity (cloud-config with ssh keys, LLM proxy token, pi/opencode config), manages tokens, leases and locks, waits for ssh, and runs the LLM proxy. A backend is a bash file sourced by it that implements the functions below.

## VMs

| Function | Contract |
|---|---|
| `backend_check` | verify dependencies (fail with `die`) |
| `backend_init` | one-time host setup (storage pools etc.) |
| `backend_proxy_services` | install host-side bridge services for the guest→proxy path; print unit names to enable (may print nothing) |
| `guest_proxy_upstream` | socat address the guest's `boxery-llm` service forwards 127.0.0.1:8088 to (e.g. `VSOCK-CONNECT:2:8088`, `TCP:192.168.5.2:8088`) |
| `backend_build_base` / `backend_has_base` | build / detect the golden desktop image (`image/base-user-data.yaml`) |
| `backend_exists NAME` | 0 if the VM exists |
| `backend_new NAME CPUS MEM_MIB DISK_GIB USERDATA [IMAGE]` | create + boot a VM from the base, or from IMAGE if given, and apply the cloud-config in USERDATA (see *Identity* below) |
| `backend_list` | lines `NAME<TAB>STATE<TAB>ADDR<TAB>DISK` (VMs only, never images; empty field = unknown); `boxery-host` turns these into the `ls --json` objects |
| `backend_ssh_endpoint NAME` / `backend_wait_endpoint NAME` | `HOST PORT` where the VM's sshd is reachable from the host (now / after waiting) |
| `backend_start/stop/rm NAME` | lifecycle. `rm` removes the VM, not its images (`boxery-host rm` does that) |
| `backend_size NAME` | `CPUS MEM_MIB DISK_GIB` as configured (not usage) |
| `backend_resize NAME CPUS MEM_MIB DISK_GIB` | optional; empty = keep. Apply the new size. It may stop NAME, but **must leave it running if it was** (also on failure) and stopped if it was. `boxery-host resize` holds the VM lock, refuses to shrink the disk, drops values that don't change anything, and waits for ssh afterwards. libvirt: `setvcpus`/`setmaxmem`/`setmem --config` + offline `vol-resize`; Lima: `limactl edit` on the stopped instance |

## Images: one primitive for snapshots, forks and pool resets

An **image** is an immutable copy of a VM's disk, named `VM@LABEL`. boxery-host builds everything on four functions:

| Function | Contract |
|---|---|
| `backend_capture NAME IMAGE` | copy NAME's current disk into a new image. **Must work while NAME is running** (it may stop it briefly, but must leave it in the state it found it). Must not die leaving a partial image |
| `backend_images` | lines `IMAGE<TAB>CREATED<TAB>SIZE` for every image |
| `backend_image_rm IMAGE` | delete an image. VMs made from it must keep working |
| `backend_reimage NAME IMAGE` | replace NAME's disk with a copy of IMAGE, **keeping NAME's identity** (endpoint, MAC, seed). Ends running |

| boxery operation | built from |
|---|---|
| `snap NAME LABEL` | `capture NAME NAME@LABEL` |
| `revert NAME LABEL` | `reimage NAME NAME@LABEL` |
| `new NAME --from IMAGE` | `new … IMAGE` |
| `fork SRC A B…` | `capture SRC SRC@fork-…`, then `new A … SRC@fork-…` (in parallel), then `image_rm` |
| `pool add NAME` / lease reset | `capture NAME NAME@boxery-clean` / `reimage NAME NAME@boxery-clean` |
| `rm NAME` | `rm NAME`, then `image_rm NAME@*` |

Rules every backend must follow:

- **Disk only.** Images never include RAM. Processes restart; runtime secrets that grants push to tmpfs are never captured.
- **Independent.** VMs made from an image, and images of those VMs, never depend on the source VM or image staying around. (libvirt pulls image data into the new overlay; Lima clones are full or copy-on-write copies.) This is what keeps fork-of-a-fork-of-a-fork cheap and lets snapshots be deleted in any order.
- **Cheap.** Captures and VMs from images should cost about as much disk as the data they change, not a full disk copy, where the platform allows it.
- **No locking needed.** boxery-host holds lifecycle resource locks through the complete workflow, including capture/reimage/rm, image readers, guest readiness and key installation. Backends don't need their own. See [lifecycle coordination](../../docs/lifecycle.md).

## Identity: what a VM made from an image must get

A VM made from an image starts with someone else's disk. boxery-host's cloud-config (`boxery_seed`) and post-boot checks take care of the guest side on every backend:

- new hostname, proxy token, pi/opencode config: cloud-config `write_files`/`runcmd`, as for any new VM
- **`authorized_keys` reset**: a per-instance `bootcmd` deletes it before sshd starts, then cloud-init writes this VM's keys. boxery-host then sets them again over ssh. A fork of a leased VM never accepts the lease holder's key
- **fresh machine-id**: per-instance `bootcmd`
- pushed grants (`/run/user/<uid>/boxery`) cleared. It's tmpfs, so it's normally gone already

The backend's job is the hypervisor side:

- a new MAC address, vsock CID, UUID and seed. Never reuse the source's
- a network identity that doesn't depend on the guest's machine-id. libvirt passes a network-config with `dhcp-identifier: mac`, so a fork never gets its source's DHCP lease
- if the backend can't deliver a cloud-init seed (Lima), apply USERDATA itself and regenerate the machine-id

## Crash recovery contract

The supervisor journals intent before side effects and stops an abandoned worker group before replay. Every backend also implements these **idempotent** helpers, including artifacts not visible in its ordinary inventory:

| Function | Contract |
|---|---|
| `backend_cleanup_new NAME` | Remove an incomplete VM and its partial disks/seed/staging instances, even if no domain/instance was fully registered. Does not remove unrelated images |
| `backend_cleanup_image IMAGE` | Remove a complete or partial image, including a clone killed before its image metadata was published; succeed if already absent |
| `backend_recover_capture NAME IMAGE ORIGINAL_STATE` | Cancel outstanding capture jobs, thaw/restore capture-related source state as needed, then remove the incomplete image. Never remove the source VM |

`backend_reimage` must be retryable after an interruption between destructive steps. libvirt tolerates a missing old disk; Lima resumes a staged replacement after the original instance was deleted. Return errors if cleanup cannot complete so the supervisor retains the journal/locks for retry. Inventory commands must distinguish a healthy empty result from an unavailable backend. Do not hide an inventory failure as an empty host.

These hooks complement process-group shutdown: submitted hypervisor jobs can survive the CLI that launched them. Real-hypervisor fault testing is still required in addition to fake-backend tests.

## Implementations

| Backend | Platform | Images |
|---|---|---|
| `libvirt` | Linux + KVM | qcow2 overlays on the base volume (`$PREFIX$IMAGE.qcow2`). Capture = shallow live `blockcopy` + `domfsfreeze` through the guest agent (no pause; a stopped VM is booted `--paused` for the copy). New-from-image = overlay on the image + `blockpull --base`, so every disk is one overlay deep on the base. Measured: capture ~1 s, fork into 2 running VMs ~17 s, 3 VMs with a 3 GiB working set ~23 s |
| `lima` | macOS (vz) or Linux (qemu) | stopped Lima instances `boxery-img.<hash>`, made with `limactl clone` (copy-on-write on APFS/btrfs). Lima only clones stopped instances, so capture stops a running VM briefly. Works on `vz`, unlike Lima's own snapshots |
| `cloud-hypervisor` | Linux + KVM | **Experimental.** qcow2 overlays on the base (`$BOXERY_CH_DIR/images/IMAGE.qcow2`). Capture = guest `sync`, pause (v54 drains and flushes qcow2 metadata), reflink copy of the overlay, resume. New-from-image and reimage = reflink copy of the image. See [below](#cloud-hypervisor-experimental) |
| `fake` | tests | directories |

VMs created before images existed may still have backend-internal snapshots. libvirt and Lima implement the optional `backend_legacy_snaps/revert/snap_rm NAME [SNAP]` so these stay listed, revertable and deletable, and pool VMs with an internal `boxery-clean` snapshot keep resetting. `reimage` refuses to run while legacy snapshots exist (libvirt can't delete a disk that has internal snapshots), and says which ones.

### Writing a new backend (e.g. exe.dev)

The image contract maps onto most VM platforms:

| Platform | capture | new from image | reimage |
|---|---|---|---|
| exe.dev | `cp NAME IMAGE-vm` (≈1 s; image = a stopped VM) | `cp IMAGE-vm NAME` | `rm NAME && cp IMAGE-vm NAME` (if names can be reused at once) |
| Firecracker / Cloud Hypervisor | reflink-copy the rootfs (`cp --reflink`) | boot from a reflink copy | swap the rootfs file |
| ZFS / btrfs-backed anything | `zfs snapshot` + `zfs clone` | `zfs clone` | `zfs rollback` or re-clone |

Run `bash test/shell/host-images.sh` against the fake backend to see the behaviour every backend has to match.

Select a backend with `boxery-host init --backend NAME` (persisted in `$BOXERY_CONF/host.env`) or `BOXERY_BACKEND`.

## Guest contract

Ubuntu, user `agent` with passwordless sudo, sshd, `~/project`, XFCE on `:1` with VNC/noVNC on localhost, xdotool + ImageMagick, a `google-chrome` binary and `/opt/boxery/node_modules/playwright-core`, `boxery-llm.service` reading `/etc/boxery/proxy-upstream`, and cloud-init (for per-instance `bootcmd`). Building from `image/base-user-data.yaml` provides all of it.

## cloud-hypervisor (experimental)

Runs VMs with [Cloud Hypervisor](https://www.cloudhypervisor.org/) directly, without libvirt. Tested end to end with Cloud Hypervisor v54 on arm64 (Ubuntu 24.04 in a nested-virtualization Lima VM). Not yet tested on an x86 host.

**Requirements:**
- `cloud-hypervisor` and `ch-remote` **v54 or newer**. Older versions can't open qcow2 overlays (no `backing_files`), and their `pause()` doesn't flush qcow2 metadata, so a capture could copy a stale disk.
- Firmware: `CLOUDHV.fd` (x86) or `CLOUDHV_EFI.fd` (arm64) from the cloud-hypervisor/edk2 releases, or `hypervisor-fw` from rust-hypervisor-firmware, at `BOXERY_CH_FIRMWARE` (default `~/.local/share/boxery/ch/firmware`).
- `qemu-img`, `cloud-localds`, `iproute2`, `nftables`, `socat`, read/write `/dev/kvm`.
- Passwordless `sudo` for network setup (`BOXERY_CH_SUDO`, default `sudo -n`; `""` when running as root), and `cap_net_admin` on the VMM so it can open its TAPs.

```bash
sudo setcap cap_net_admin+ep "$(command -v cloud-hypervisor)"
./host/boxery-host init --backend cloud-hypervisor
./host/boxery-host build-base
```

| | |
|---|---|
| Storage | `$BOXERY_CH_DIR` (default `~/.local/share/boxery/ch`): `base.qcow2`, `images/IMAGE.qcow2`, and `vms/NAME/{disk.qcow2, seed.iso, launch.sh, slot, serial.log}` |
| Process | `boxery-ch-NAME.service` (systemd user unit) runs `launch.sh`. `stop` presses the ACPI power button; `rm` and `reimage` stop the unit |
| Network | VM slot S: TAP `bxchS`, host `10.77.S.1`, guest `10.77.S.2`, MAC `52:54:00:77:…:S`, all static from the seed's network-config. A VM made from an image gets a new slot. `BOXERY_CH_NET` changes `10.77`; DNS is `BOXERY_CH_DNS` (default `1.1.1.1 9.9.9.9`) |
| Isolation | nftables table `inet boxery_ch`, replaced atomically on every `start`/`new`. Guests can't reach the host, each other, RFC1918, CGNAT/Tailscale, link-local or IPv6, and can't spoof source addresses (strict reverse-path check). Everything else is NATed out. The host can still ssh in |
| Proxy | Guest → `VSOCK-CONNECT:2:8088` → `vms/NAME/vsock.sock_8088` (symlink) → `proxy.sock` served by `boxery-ch-vsock.service` → `127.0.0.1:8088` |
| Recovery | `cleanup_new` stops and removes the unit, deletes the TAP and the VM directory (and a dead holder's slot lock); `cleanup_image` removes an image and its `.part`; `recover_capture` resumes a VM a dead capture left paused. `reimage` stages the new disk as `disk.qcow2.new` and renames it, so a retry after a crash is safe. Inventory fails if the systemd user manager is unreachable rather than reporting every VM stopped |
| Images | An image is a copy of a VM's overlay, so it depends only on the base. Capturing a running VM: guest `sync` over ssh, pause, `cp --reflink=auto` (instant on XFS/btrfs, a full copy of the overlay elsewhere), resume. There's no guest agent to freeze filesystems, so captures are crash-consistent after the sync. Measured on arm64 (4 GiB guests): capture ~1 s, revert or pool reset ~20 s (a reboot), `new --from` ~22 s, fork into 2 VMs ~25 s |

Known gaps:
- VMs don't autostart after a host reboot (`start` recreates TAPs and rules).
- Other firewalls with a FORWARD drop policy block guest traffic: Docker (allow `bxch*` in `DOCKER-USER`), ufw (`DEFAULT_FORWARD_POLICY`), firewalld.
- `net.ipv4.ip_forward=1` is host-wide, so the host also routes between its other interfaces.
