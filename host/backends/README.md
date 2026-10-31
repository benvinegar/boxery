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
- **No locking needed.** boxery-host holds a per-VM lock around capture/reimage/rm. Backends don't need their own.

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

## Implementations

| Backend | Platform | Images |
|---|---|---|
| `libvirt` | Linux + KVM | qcow2 overlays on the base volume (`$PREFIX$IMAGE.qcow2`). Capture = shallow live `blockcopy` + `domfsfreeze` through the guest agent (no pause; a stopped VM is booted `--paused` for the copy). New-from-image = overlay on the image + `blockpull --base`, so every disk is one overlay deep on the base. Measured: capture ~1 s, fork into 2 running VMs ~17 s, 3 VMs with a 3 GiB working set ~23 s |
| `lima` | macOS (vz) or Linux (qemu) | stopped Lima instances `boxery-img.<hash>`, made with `limactl clone` (copy-on-write on APFS/btrfs). Lima only clones stopped instances, so capture stops a running VM briefly. Works on `vz`, unlike Lima's own snapshots |
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
