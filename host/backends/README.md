# boxery backends

`host/boxery-host` is backend-agnostic. It generates each VM's identity (cloud-config with ssh keys, LLM proxy token, pi/opencode config), manages tokens, leases and locks, waits for ssh, and runs the LLM proxy. A backend is a bash file that implements the functions below.

The host (Node) runs one backend function per process: `host/backend.sh FUNCTION ARG…` sources the backend into a small prelude and calls that function, with arguments as argv. The prelude is everything a backend may use from the host: `die`, `log`, `need`, `wait_ssh NAME HOST [PORT]`, `vm_ssh_cmd NAME HOST PORT CMD…` (both check VM NAME's pinned host key), `profile_unit BASE` (the name for a host-wide unit in this profile: `BASE` for the default profile, `BASE-NAME` for profile NAME), and the variables `ROOT`, `CACHE`, `PROXY_PORT`, `PROXY_UNIT` (this profile's proxy unit) and `SSH_OPTS`. Its settings come from the environment and `$BOXERY_CONF/host.env`. Only functions named in this contract can be called. Because every call is a fresh process, a backend can't keep state in shell variables between calls; keep it on disk or in the hypervisor. `boxery-host connect` (the ssh ProxyCommand) also goes through `backend.sh`, without starting Node.

## VMs

| Function | Contract |
|---|---|
| `backend_check` | verify dependencies (fail with `die`) |
| `backend_init` | one-time host setup (storage pools etc.) |
| `backend_proxy_services` | install host-side bridge services for the guest→proxy path; print unit names to enable (may print nothing). Name each with `profile_unit` and order it `After=$PROXY_UNIT.service`: two profiles of one backend run side by side, each on its own proxy port |
| `guest_proxy_upstream` | socat address the guest's `boxery-llm` service forwards 127.0.0.1:8088 to (e.g. `VSOCK-CONNECT:2:8088`, `TCP:192.168.5.2:8088`) |
| `backend_build_base` / `backend_has_base` | build / detect the golden desktop image. The cloud-config to build it from is `$BASE_USERDATA` (`image/base-user-data.yaml` with the [layers](#image-layers-desktop-and-headless-vms) filled in) |
| `backend_exists NAME` | 0 if the VM exists |
| `backend_new NAME CPUS MEM_MIB DISK_GIB USERDATA [SOURCE]` | create + boot a VM and apply the cloud-config in USERDATA (see *Identity* below). SOURCE: empty = the desktop base; `VM@LABEL` = that image; `stock` = the backend's stock image, no base needed (headless VMs, see [layers](#image-layers-desktop-and-headless-vms)). `stock` has no `@`, so it is never an image name |
| `backend_list` | lines `NAME<TAB>STATE<TAB>SSH<TAB>DISK_BYTES<TAB>DISK_USED_BYTES[<TAB>TUNNEL]` (VMs only, never images; empty field = unknown). SSH: the VM's ssh endpoint as this host reaches it, always `HOST:PORT` (`192.168.122.50:22`, `127.0.0.1:60022`), empty unless the VM is running and reachable. DISK_BYTES: the disk's configured (virtual) size. DISK_USED_BYTES: what the VM's own disk takes on this host (allocated blocks; a shared base or backing image is not counted), empty if the backend can't know. TUNNEL only for backends that reach VMs through a tunnel: `up`, `connecting`, `down`. `boxery-host` turns these into the `ls --json` objects (sizes in GiB) |
| `backend_ssh_endpoint NAME` / `backend_wait_endpoint NAME` | `HOST PORT` where the VM's sshd is reachable from the host (now / after waiting) |
| `backend_endpoint_problem NAME` | optional, local checks only (it runs while `boxery-host` waits for ssh). Print nothing and return 0 when nothing is known to be wrong; else print what's wrong and the fix, and return 1 (may recover: `boxery-host` keeps waiting for ssh and adds the message to its timeout) or 2 (won't recover without the fix: it gives up at once). `boxery-host` asks after each failed ssh attempt in `new`, `start`, `resize`, `revert` and lease resets; the prelude's `wait_ssh` doesn't. exe: the VM's tunnel |
| `backend_start/stop/rm NAME` | lifecycle. `rm` removes the VM, not its images (`boxery-host rm` does that) |
| `backend_size NAME` | `CPUS MEM_MIB DISK_GIB` as configured (not usage). `ls` asks it once for a VM without a size record and records the answer |
| `backend_resize NAME CPUS MEM_MIB DISK_GIB` | optional; empty = keep. Apply the new size. It may stop NAME, but **must leave it running if it was** (also on failure) and stopped if it was. `boxery-host resize` holds the VM lock, refuses to shrink the disk, drops values that don't change anything, and waits for ssh afterwards. libvirt: `setvcpus`/`setmaxmem`/`setmem --config` + offline `vol-resize`; Lima: `limactl edit` on the stopped instance |

### Optional functions

boxery-host asks the backend which functions it defines (`host/backend.sh __functions`) and falls back when one of these is missing:

| Function | Without it |
|---|---|
| `backend_resize` | `resize` fails with "the BACKEND backend cannot resize VMs" |
| `backend_proxy_bind` | the LLM proxy listens on `127.0.0.1` (no backend overrides it today; for one whose guests reach the proxy over a host interface instead of vsock or a tunnel) |
| `backend_endpoint_problem` | waits for ssh report only a timeout, not why the VM can't be reached (remote backends: [`remote_endpoint_problem`](#remote-backends)) |
| `backend_host_key NAME` | the guest's live ed25519 ssh host key (`ssh-ed25519 AAAA…`), read through the hypervisor rather than the VM network. boxery-host pins it for a VM that has no record (made before keys were pinned, or `boxery pin`). libvirt: the qemu guest agent. Without it, only loopback endpoints (Lima, the remote backends' tunnels) are trusted for that, or `pin --from-guest` |
| `backend_platform_host_key NAME` | for platforms that give every machine its own host key and report it (boat): that key. boxery-host then seeds no key of its own and re-pins this one whenever it waits for ssh |

### Persisted settings

`boxery-host init` saves the backend's settings in `$BOXERY_CONF/host.env`, and later commands export the saved values that the environment doesn't set. The keys are listed in `HOST_ENV` in [host/config.mjs](../config.mjs) and in the matching `case` in [host/backend.sh](../backend.sh); a new backend adds its `BOXERY_<NAME>_*` keys to both. Never list secrets: host.env isn't private (boat keeps its API key in its own 0600 file).

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

## Image layers: desktop and headless VMs

What boxery adds to the starting image is in three layers, `image/layers/*.sh` (root shell scripts, idempotent), run in order by `boxery-provision` (`image/layers/provision.sh`):

| Layer | What | Notes |
|---|---|---|
| `plumbing` | the `agent` user + sudoers, `boxery-llm.service` (socat bridge to the host LLM proxy; keys stay on the host), sshd `MaxSessions`, core-dump sysctl, cloud-init default user, `/etc/profile.d/boxery.sh`, tmux config, `socat`, `qemu-guest-agent` | ~10 s |
| `devtools` | git (from the git-core PPA on Ubuntu), build tools, python3, jq, ripgrep, fd, node 24, `pi`, `opencode` | keeps what the image ships: a package only when missing (except git, upgraded from the PPA: Ubuntu 24.04's is 2.43), node only when the image's can't run the job helper (needs 22.18+), an agent CLI only when `agent` can't run the image's own (exeuntu's `pi` links into exedev's home, so it's replaced; see #30). ~30 s |
| `desktop` | XFCE on `:1`, TigerVNC (password required: `boxery-vnc-password`) + noVNC, Firefox, Chrome (Playwright Chromium on arm64) + its AppArmor profile, `playwright-core`, xdotool, ImageMagick, the agent's desktop user services | ~2 min; the only reason for a built base |

- **Desktop VMs** (the default) clone the base, which `build-base` makes by applying all three layers once.
- **Headless VMs** (`new --headless`) call `backend_new … stock`. boxery-host's USERDATA then also carries every layer file (as `write_files`), `/etc/boxery/provision` (`plumbing devtools`), a `users:` entry for `agent` (the stock image's default user isn't agent) and, as the first `runcmd` step, `boxery-provision`. Seeded backends (libvirt, cloud-hypervisor) get all of that from cloud-init. Backends that replay the cloud-config themselves (Lima, exe) must run `sudo /usr/local/sbin/boxery-provision` after writing the files. boxery-host waits for `/var/log/boxery-provision.ok` and shows `/var/log/boxery-provision.log` if it's missing.
- `boxery-provision` records the applied layers in `/etc/boxery/layers` and writes `/etc/boxery/headless` when `desktop` isn't one of them. The desktop tools (`vm_screenshot` … `vm_browser`, `boxery desktop`) check that file and refuse with a clear error. The host records each VM's kind in `$CONF/vm-kind/NAME` (no file = desktop) for `ls`.
- Images, snapshots and forks need nothing extra: they copy the disk, so a VM from a headless VM's image is headless and isn't provisioned again. A VM keeps its kind for life; `--headless` with a desktop image is refused.

Measured headless `new` (Lima vz on Apple Silicon, November 2026): 51 s from `limactl create` to ready (plumbing 10 s, devtools 30 s), versus ~13 s for a clone of the desktop base, and no `build-base`. Snapshot 10 s, fork 20 s, `new --from` 10 s, as for desktop VMs. That's fast enough that there is no cached headless base; if one is wanted later (CI fleets creating many VMs), it would be `build-base` with only `plumbing devtools`.

## Identity: what a VM made from an image must get

A VM made from an image starts with someone else's disk. boxery-host's cloud-config (`boxery_seed`) and post-boot checks take care of the guest side on every backend:

- new hostname, proxy token, pi/opencode config: cloud-config `write_files`/`runcmd`, as for any new VM
- **a new ssh host key** (`host/hostkeys.mjs`): `write_files` puts it in `/etc/ssh/boxery_host_ed25519_key` with an sshd drop-in (`05-boxery-hostkey.conf`) that makes it sshd's only host key, and boxery-host records the public half. Every ssh to the VM checks it. A backend that replays the cloud-config instead of seeding it must make sshd reload after writing the files (`remote_identity_script` restarts sshd when the user-data carries a key)
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
| `libvirt` | Linux + KVM | qcow2 overlays on a root volume: the base, or for headless VMs `boxery-stock.qcow2` (`BOXERY_STOCK_VOL`, the cloud image as downloaded, uploaded on the first headless `new`). An image has its VM's root; `build-base` only refuses while desktop VMs or images use the base. Images are `$PREFIX$IMAGE.qcow2`. Capture = shallow live `blockcopy` + `domfsfreeze` through the guest agent (no pause; a stopped VM is booted `--paused` for the copy). New-from-image = overlay on the image + `blockpull --base`, so every disk is one overlay deep on the base. Disks are attached with `discard=unmap`, so space the guest frees (Ubuntu mounts root with online discard; `fstrim` weekly) leaves the overlay instead of being copied into every image, fork and reimage made from it. Domains made before this get it from `init`, effective on their next cold start (stop + start, revert, lease reset). Guest isolation: every interface on `BOXERY_NET` references the nwfilter `boxery-guest-isolation` (no spoofing, DHCP/DNS only to the host, private ranges dropped; the cloud-hypervisor policy). `init` (re)defines the filter and adds it to existing domains; `new`, `start`, `reimage` and `resize` add it before booting, so older domains get it on their next cold start. `BOXERY_NET_ISOLATION=off` removes it the same way. Measured: capture ~1 s, fork into 2 running VMs ~17 s, 3 VMs with a 3 GiB working set ~23 s |
| `lima` | macOS (vz) or Linux (qemu) | Headless VMs are fresh instances of Lima's `ubuntu-24.04` template, not clones of the base. Images: stopped Lima instances `boxery-img.<hash>`, made with `limactl clone` (copy-on-write on APFS/btrfs). Lima only clones stopped instances, so capture stops a running VM briefly. Works on `vz`, unlike Lima's own snapshots. Lima maps the guest's gateway to the host's loopback, so on macOS every start runs under `sandbox-exec` with a profile that lets the host agent reach only the proxy and the instance's ssh port on `127.0.0.1` (pinned with `--ssh-port`; confined qemu instances use slirp's DNS, `--dns 192.168.5.3`). `BOXERY_LIMA_CONFINE=0` turns it off |
| `cloud-hypervisor` | Linux + KVM | **Experimental.** qcow2 overlays on the base, or for headless VMs on `$BOXERY_CH_DIR/stock.qcow2` (a copy of the cloud image); images are `$BOXERY_CH_DIR/images/IMAGE.qcow2`. Capture = guest `sync`, pause (v54 drains and flushes qcow2 metadata), reflink copy of the overlay, resume. New-from-image and reimage = reflink copy of the image. See [below](#cloud-hypervisor-experimental) |
| `exe` | anywhere with ssh ([exe.dev](https://exe.dev)) | **Experimental.** Headless VMs are new exeuntu VMs (`exe.dev new`), not copies of the base. Images: paused exe.dev VMs made with `cp` (a copy boots fresh from disk), named `PREFIXi-HASH`, with the image name in the exe.dev comment. Reimage = `cp` to a new exe.dev name, then `rm` the old one (names are never reused). See [below](#exe-experimental) |
| `boat` | anywhere with ssh ([boat.dev](https://boat.dev)) | **Experimental.** No headless VMs yet. Images: boat saved snapshots named `PREFIXi-HASH` (exact, independent disk copies of a running sandbox), the image name kept in `$BOXERY_BOAT_DIR/images/`. New-from-image = a sandbox `from` the snapshot. Reimage = a new sandbox from the image, then delete the old one. See [below](#boat-experimental) |
| `fake` | tests | directories |

### Writing a new backend

The image contract maps onto most VM platforms:

| Platform | capture | new from image | reimage |
|---|---|---|---|
| exe.dev (implemented: `exe`) | `cp NAME IMAGE-vm`, then `pause` it | `cp IMAGE-vm NAME` | `cp IMAGE-vm NAME-NEWGEN && rm NAME-OLDGEN` |
| boat.dev (implemented: `boat`) | `POST /saved-snapshots {sandboxId, name}` | `POST /sandboxes {from: name}` | new sandbox from the image, then `DELETE` the old one |
| Firecracker / Cloud Hypervisor | reflink-copy the rootfs (`cp --reflink`) | boot from a reflink copy | swap the rootfs file |
| ZFS / btrfs-backed anything | `zfs snapshot` + `zfs clone` | `zfs clone` | `zfs rollback` or re-clone |

Run `bash test/shell/host-images.sh` against the fake backend to see the behaviour every backend has to match.

### Remote backends

A backend whose VMs live on a hosted platform (exe.dev, boat.dev, and likely Daytona, #61) faces the same problems every time: the guest has no cloud-init, the host may be a laptop behind NAT, and boxery-host wants a stable `HOST PORT` for each VM's sshd. [`lib/remote.sh`](lib/remote.sh) solves them once:

- **One supervised tunnel per VM** (`remote_tunnel_write/start/stop/active/remove`): `ssh -N … -L 127.0.0.1:PORT:127.0.0.1:22 -R 127.0.0.1:GPORT:127.0.0.1:PROXY_PORT` as the platform's admin user, run by a systemd user unit (Linux) or a launchd agent (macOS). `-L` is the VM's endpoint (`remote_ssh_endpoint`, `remote_wait_endpoint`); `-R` carries the guest's `boxery-llm` back to the host's proxy, so `guest_proxy_upstream` is `TCP:127.0.0.1:GPORT`. The backend passes the ssh argv; the lib owns the supervisor.
- **Tunnel state** (`remote_tunnel_state`: `up`, `connecting`, `down`, local checks only): the `TUNNEL` column of `backend_list`, and `remote_endpoint_problem` / `remote_ssh_endpoint` / `remote_wait_endpoint` say why a VM can't be reached (its tunnel's last error, where the log is, the fix) instead of an ssh timeout. `REMOTE_PLATFORM` and `REMOTE_CHECK` fill in the messages.
- **Host ports** (`remote_alloc_slot`, `remote_port`, `remote_clear_stale_slot_lock`): slot S ↔ `REMOTE_PORT_BASE + S`, kept for the VM's life (also across reimages).
- **Identity without cloud-init** (`remote_identity_script USERDATA NAME BOOT_SCRIPT regen|keep`): replays `boxery_seed`'s user-data as one root script, replaces `authorized_keys`, makes a fresh machine-id, records the hostname for a boot unit to restore, and regenerates ssh host keys unless the platform pins its own (`keep`, boat).
- **The base build** (`remote_build_script POST_FN OK_MARKER`, `remote_build_wait`): the agent user, `$BASE_USERDATA` and the backend's post-build script, run detached in a builder VM and polled. `remote_post_agent_session`, `remote_post_boot_unit` and `remote_hostname_restore` are the post-build pieces most hosted images need.

A remote backend sets `REMOTE_DIR`, `REMOTE_SUPERVISOR`, `REMOTE_PORT_BASE`, `REMOTE_MAX_SLOT`, `REMOTE_PLATFORM`, `REMOTE_CHECK` and `REMOTE_TUNNEL_WAIT`, defines `remote_unit NAME`, and then only has to talk to its platform's API: create, copy, stop/start, list, delete. Two rules carry over from exe.dev:

- **Guest sshd lets `agent` in from loopback only.** The tunnel's `-L` end arrives from `127.0.0.1`, so the lease holder's key works through the host and nowhere else (exe.dev: `ListenAddress 127.0.0.1`; boat.dev, whose own sshd must stay public: `Match User agent Address *,!127.0.0.1,!::1` → `DenyUsers agent`).
- **Inventory never reports an unreachable API as an empty account**, and every listing is filtered to the backend's own prefix or labels: the account's other VMs are never touched.

Select a backend with `boxery-host init --backend NAME` (persisted in `$BOXERY_CONF/host.env`) or `BOXERY_BACKEND`. A second backend on the same host is a second profile: `boxery-host --profile NAME init --backend B` (or `boxery host add NAME DEST --backend B` from the controller) gives it `~/.config/boxery-NAME`, a free proxy port and its own services. Init refuses a new profile with the same backend and the same namespace settings as an existing one; a backend's namespace keys are listed in `NAMESPACE` in [host/setup.mjs](../setup.mjs) (add yours there).

## Guest contract

Ubuntu, user `agent` with passwordless sudo, sshd, `~/project`, `boxery-llm.service` reading `/etc/boxery/proxy-upstream`, and cloud-init (for per-instance `bootcmd`; exe and Lima replay it instead). Desktop VMs also have XFCE on `:1` with VNC/noVNC on localhost (VNC needs the password `boxery-vnc-password --new` sets and prints), xdotool + ImageMagick, a `google-chrome` binary and `/opt/boxery/node_modules/playwright-core`. The layers above provide all of it.

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

## exe (experimental)

Runs VMs on [exe.dev](https://exe.dev) instead of local KVM, so the host can be any machine with ssh (a Mac works). Everything goes through exe.dev's ssh API (`ssh exe.dev CMD --json`); the host needs an exe.dev account whose key ssh offers first, or `BOXERY_EXE_KEY`. Verified end to end on a Personal-plan account (November 2026): build, new, snapshots, revert, fork, `new --from`, stop/start, resize, rm.

```bash
ssh exe.dev whoami                  # must print your account, not "Please complete registration"
./host/boxery-host init --backend exe
./host/boxery-host build-base       # an exeuntu VM + image/base-user-data.yaml (~3 min), kept paused as the base (not needed for --headless)
```

| | |
|---|---|
| Names | exe.dev VM names are global, so every name starts with a per-host prefix (`BOXERY_EXE_PREFIX`, default `bx<6 hex>-`, generated by `init` into `$BOXERY_EXE_DIR/prefix`): `PREFIXvGEN-NAME` VMs, `PREFIXi-HASH` images, `PREFIXbase`, `PREFIXbuild`. GEN (6 hex) is new for every disk a VM gets (`new`, `revert`, pool resets), and the current name is kept in `$BOXERY_EXE_DIR/vms/NAME/vm`: exe.dev's edge keeps routing a deleted VM's name for minutes (`ssh` says "VM not found", `-R` forwards are refused), so VM names are never reused. The account's other VMs are never listed or touched |
| ssh | exe.dev's edge authenticates `ssh NAME.exe.xyz` with the **account's** keys and never uses the guest's sshd (exeuntu masks `ssh.service`). boxery's lease fencing needs the guest's own `authorized_keys`, so the build enables sshd on the guest's **loopback only** (`AllowUsers agent`, keys only), and each VM gets a supervised host-side tunnel: `ssh -N NAME.exe.xyz -L 127.0.0.1:PORT:127.0.0.1:22 -R 127.0.0.1:18088:127.0.0.1:PROXY_PORT`. The VM's endpoint is `127.0.0.1:PORT` (`BOXERY_EXE_PORT_BASE` + slot, default 22401…), as on Lima. Controllers and lease holders only ever reach the guest's sshd through it. The edge (account key → `exedev`, passwordless sudo) is the backend's admin channel for build, identity and `sync`, like host root on libvirt |
| Tunnels | systemd user unit `boxery-exe-PREFIXv-NAME.service` on Linux, launchd agent `dev.boxery-exe-PREFIXv-NAME` on macOS (`BOXERY_EXE_SUPERVISOR`); the label and port stay when the exe.dev name changes. Enabled while the VM runs, so they come back after a host reboot (exe.dev VMs keep running while the host is down). The supervisor restarts a dropped tunnel every 5 s (`ServerAliveInterval` 15 s × 4 notices a dead connection within a minute). `ls` reports each tunnel's state (local checks, no API call): `up` (supervised and its `-L` end accepts connections), `connecting` (supervised, not connected: host offline or just awake, exe.dev unreachable, VM paused outside boxery) or `down` (not supervised); a running VM whose tunnel isn't up shows that state in place of its address. `connect`, `ip`, and the waits in `new`/`start`/`revert`/`resize` (`BOXERY_EXE_TUNNEL_WAIT`, 120 s) fail with that state, the tunnel's last error, where its log is (`$BOXERY_EXE_DIR/vms/NAME/tunnel.log` on launchd, `journalctl --user -u UNIT` on systemd) and the fix, instead of an ssh timeout |
| Host availability | **Run the exe host on an always-on machine** and use laptops as controllers only. Each VM's tunnel carries both its ssh endpoint (`-L`) and its only route to the LLM proxy (`-R`), so while the host sleeps or is offline, agents lose their LLM mid-task and nobody can ssh in; the VMs themselves keep running and the tunnels reconnect once the host is back. On Linux, enable linger so the user units run without a login session. Moving LLM traffic off the host (exe.dev's HTTP-proxy integration with keys held at exe.dev) is discussed in [#42](https://github.com/modem-dev/boxery/issues/42); it would give up per-VM tokens and can't serve OAuth/subscription providers |
| Proxy | Guest `127.0.0.1:8088` → socat → guest `127.0.0.1:18088` (the tunnel's `-R` end, `BOXERY_EXE_GUEST_PORT`) → host `127.0.0.1:PROXY_PORT`. Credentials stay on the host. exe.dev's own HTTP-proxy integration can't be used instead: its target must be a public URL |
| Identity | exeuntu has no cloud-init, so like Lima the backend replays the cloud-config over the edge (`host/cloudconfig-sh.mjs` for `write_files`), **replaces** `authorized_keys`, and gives every VM a fresh machine-id, ssh host keys and hostname. exe.dev's init resets the hostname and `/etc/hosts` to the exe.dev name at every boot, so the base's `boxery-exe-boot.service` restores boxery's (from `/etc/boxery/hostname`) and grows `/` to the disk exe.dev gave the VM. A copy boots fresh from disk, so RAM and tmpfs grants never travel. The devtools layer keeps exeuntu's `opencode` and `pi` if the `agent` user can run them and replaces them otherwise (exeuntu's `pi` links into exedev's home); exeuntu's `claude` and `codex` stay |
| Lifecycle | exe.dev has no stop/start. `stop` clears pushed grants (`/run/user/*/boxery`) and `sync`s, then `pause`s the VM (RAM snapshot to disk, frees its CPU and memory); `start` = `resume` (also cold-boots a `stopped` VM). `resize` = exe.dev `resize`, then a `restart` of a running VM so the guest sees it. A paused VM stays paused, and its next `start` is a `restart` instead of a `resume` (a resumed VM keeps its old CPUs, memory and disk). `backend_size` reports the size recorded at create/resize (after capping); exe.dev's `ls` doesn't report sizes. `backend_list` reports that recorded disk size and no usage (exe.dev doesn't say what a disk holds). `ls` shows exe.dev's status (`running`, `paused`, `shut off` for `stopped`) |
| Sizes | The Personal plan has 2 vCPU / 4 GB **shared by all VMs**, so sizes are capped at `BOXERY_EXE_MAX_CPUS` (2) and `BOXERY_EXE_MAX_MEM` (4096 MiB); raise them on bigger plans. exe.dev doesn't refuse VMs beyond the shared total (it ran four 1-vCPU VMs on a 2-vCPU plan); they share the CPU. Disks only grow: `--disk` is passed when it's bigger than the source's (the base is 20 GB). Images and the base are paused, so they hold disk only |
| Images | `capture` = guest `sync` over the edge (a paused source was synced by `stop`), `cp VM PREFIXi-HASH --copy-tags=false` (~0.5 s; the copy boots from the disk as it is, unsynced writes included) (with the VMs' pool and egress policy: the image VM boots the agent's disk until it's paused), `comment` it `boxery-image:IMAGE:DISK_GB`, `pause` it. The source keeps running, untouched. A `cp` that dies before its comment is unlisted but still removed by `cleanup_image` (the name is a hash of the image name) |
| Headless | `new --headless` creates an exeuntu VM (`exe.dev new`), runs the plumbing + devtools layers and the base build's exe.dev specifics (loopback sshd, boot unit) over the edge, then the identity script. The devtools layer keeps exeuntu's node and build tools, upgrades git from the git-core PPA if exeuntu identifies as Ubuntu, and replaces only what `agent` can't run. With `BOXERY_EXE_EGRESS` set, egress is limited (`exe.dev egress VM …`) after the layers are installed, since they download packages. Live-tested (November 2026, Personal plan): headless `new` 42 s (plumbing 15 s, devtools 16 s: exeuntu's node 22 and `opencode` kept, `pi` installed), LLM bridge through the tunnel, snapshot 8 s, fork 19 s, rm. Not yet tested with `BOXERY_EXE_EGRESS` |
| Options | `BOXERY_EXE_EGRESS=integrations` cuts new VMs off the public internet (`cp --egress`); the `-R` tunnel and exe.dev integrations still work. `BOXERY_EXE_POOL` puts VMs in a Work-plan pool. Both, and the other `BOXERY_EXE_*` settings, are saved by `init` |
| Recovery | `cleanup_new` stops and removes the tunnel and deletes every `PREFIXv*-NAME` and the local state; `cleanup_image` deletes the image VM; `recover_capture` has no source state to restore. `reimage` copies to a new generation before deleting anything, then records it and deletes every other generation, so a retry leaves exactly one VM; `ls` ignores a generation that isn't the recorded one. Inventory (`ls --json`) fails if exe.dev is unreachable rather than reporting an empty account. A `cp` still running on exe.dev's side after its CLI was killed can land after cleanup: it shows up in `ls` (or `images`), and `boxery-host rm NAME` removes it |

Security notes:
- Anyone holding the exe.dev account's ssh key has root in every VM through the edge. Treat that key like host root; give boxery its own with `BOXERY_EXE_KEY` if you share the account. The backend's ssh never forwards the host's agent or X11 into a guest, whatever `~/.ssh/config` says.
- New exe.dev accounts attach an `llm` integration to every VM (`auto:all`). A guest could use it to reach the account's LLM credits at `https://llm.int.exe.xyz`, outside the boxery proxy and its `llm:` grants. So `new`, `start` and reimages (revert, pool resets) check each VM from the inside before it's usable: `llm.int.exe.xyz` must answer 403/404, and Reflection, if attached, must list no `llm`-type integration. A VM that can reach one is refused (a new or reimaged copy is removed; a started VM is paused again), and so is one that can't be checked. Fix it once per account: `ssh exe.dev integrations detach llm auto:all`, plus any `vm:`/`tag:` attachments `ssh exe.dev integrations list` shows.
- First connections trust exe.dev's host keys on first use (`$BOXERY_EXE_DIR/known_hosts`). exe.dev documents its fingerprint as `SHA256:JJOP/lwiBGOMilfONPWZCXUrfK154cnJFXcqlsi6lPo`.

Not verified yet:
- A `cp` still running after its CLI was killed (the recovery note above).
- Work-plan pools and `--egress=integrations`.
- Linux hosts (systemd user units); the live run used a Mac (launchd).

Not supported:
- No HTTPS (`POST /exec`) transport: its 30 s limit is too short for `cp`, `new` and the build, and the tunnels need ssh anyway.

## boat (experimental)

Runs VMs as [boat.dev](https://boat.dev) sandboxes: full Ubuntu 24.04 VMs (own kernel, systemd, Docker, `/dev/kvm`) driven through boat's REST API with `curl`. Like `exe`, the host can be any machine with ssh, a Mac included. Offline tests: `test/shell/host-boat-backend.sh` (a fake API). Verified on a real free-trial account (November 2026, macOS host): `init`, the base build (on boat's image, next to its own desktop on `:0`), identity, the launchd tunnel with ssh as `agent` through it (and refused on the public endpoint), the desktop on `:1` and screenshots, the LLM proxy through the `-R` end, `stop`/`start`, and `resize` onto a new machine (re-pinned, hostname restored). Everything that needs a saved snapshot is not, because the trial can't make one: saving the base, `new`, `snap`/`revert`, `fork`, `new --from`, pool resets.

```bash
BOAT_API_KEY=boat_… ./host/boxery-host init --backend boat   # key saved in $BOXERY_BOAT_DIR/api-key (0600), never in host.env
./host/boxery-host build-base                                # builder sandbox → saved snapshot PREFIXbase → builder deleted
```

| | |
|---|---|
| Account | A **paid** plan: images are saved snapshots, which the free trial refuses (`403 trial_saved_snapshots_not_allowed`), so on the trial `build-base` builds but can't save the base. The trial also refuses sandboxes without auto-stop: set `BOXERY_BOAT_TTL` (≤ 7200 s there) and a VM stops by itself that long after each create or start. Every image counts against the plan's saved snapshots (10 per $20), and each one beyond that costs $0.056 a day: the base, each `snap`, each pool VM's clean state, and a fork's image while the fork runs. `BOXERY_BOAT_ORG` bills an organization (`X-Boat-Org`) |
| Names | Sandboxes are named `PREFIXvm-NAME` (VMs) and `PREFIXbuild` (the builder), and found with `GET /sandboxes?namePrefix=PREFIX`. `PREFIX` is `BOXERY_BOAT_PREFIX`, default `bx<6 hex>-`, generated by `init`. Names rather than labels, because boat drops the labels of a sandbox created from a saved snapshot. A VM's current sandbox id (`bx_…`) is `$BOXERY_BOAT_DIR/vms/NAME/id`; it changes with every disk the VM gets (new, revert, pool reset). The account's other sandboxes are never listed or touched |
| Sandboxes | Created with `ttlSeconds: null` (no auto-stop; boat's default stops a sandbox after 1 h; `BOXERY_BOAT_TTL` sets one) and `noEnv: true`, so a VM gets none of the account's environment variables, secret files, logins or CLI token and can't act on the account. Credentials stay on the host, as with every backend |
| ssh | boat runs a real sshd as user `user` (passwordless sudo). The host's admin key (`$BOXERY_BOAT_DIR/id_ed25519`) is authorized through `POST /sandboxes/ID/sshkey`, which also answers the address (`machineIp`, or `sshEndpoint` when the machine has no IPv4) and the host key, pinned per VM in `vms/NAME/known_hosts` under `HostKeyAlias=ID`. Nothing is trusted on first use. Every resume puts the sandbox on a new machine (new address and host key), so `start` re-pins it and rewrites the tunnel. boat's sshd has to stay public, so the base adds `Match User agent Address *,!127.0.0.1,!::1` → `DenyUsers agent` (checked with `sshd -t` in the build) |
| Tunnels | [`lib/remote.sh`](#remote-backends): systemd unit `boxery-boat-PREFIXNAME.service` / launchd agent `dev.boxery-boat-PREFIXNAME`, host port `BOXERY_BOAT_PORT_BASE` + slot (default 22601…), guest port `BOXERY_BOAT_GUEST_PORT` (18088) for the proxy. `ls` shows each tunnel's state and the waits fail with its last error, as for exe (`BOXERY_BOAT_TUNNEL_WAIT`, 120 s). As with exe, run the host on an always-on machine: the tunnel is each VM's only route to the LLM proxy |
| Identity | No cloud-init, so the backend replays the cloud-config as root over ssh (`remote_identity_script`): keys replaced, fresh machine-id, hostname. boat's snapshots don't keep the hostname, so `boxery-boat-boot.service` restores it at every boot. The shared build deletes the ssh host keys, so boat's post-build makes new ones before `sshd -t` (boat's API reports the machine's live key, so pinning follows); per VM, boat's host keys are kept: they are unique per machine and pinned through the API. boat ships its own `pi` and `opencode`; the build removes their `/usr/local/bin` links so boxery's npm installs win ("deleted files stay deleted" across boat's snapshots) |
| Lifecycle | `stop` = `sync`, `POST /stop`, then wait for `archived`: boat saves the disk and removes the machine, so memory and tmpfs grants are gone as after a shutdown. **boat deletes a stopped sandbox's disk after 14 days**; `boxery snap` it to keep it. `start` = `POST /resume` (with `ttlSeconds: null`) |
| Sizes | boat has four fixed types: `small` 2 vCPU / 4 GB / 51 GB, `default` 4 / 8 / 51, `large` 8 / 16 / 111, `xlarge` 16 / 32 / 251. A VM gets the smallest type that fits its CPUs, memory and disk (boxery's `small`, `standard` and `large` shapes map one to one), capped at `BOXERY_BOAT_MAX_TYPE` (`large`; `xlarge` needs boat's $100 plan). `backend_size` reports the type's size. `backend_list` reports the type's disk and no usage. `resize` picks a type the same way (without `--disk`, a VM can move down a type: boat refuses with `type_too_small` when its data doesn't fit, and the VM stays as it was); a running VM is stopped and resumed with the new type, a stopped one gets it at its next start |
| Images | `capture` = guest `sync`, `POST /saved-snapshots` (`PREFIXi-HASH`; saved snapshot names are `[a-z0-9-]`), poll until `ready`. The image name and disk size are recorded in `$BOXERY_BOAT_DIR/images/` first, so an interrupted save is still found. The source keeps running. A saved snapshot is a full copy that outlives its sandbox, so images are independent. boat's automatic per-minute snapshots and `fork` aren't used: a fork of a running sandbox can miss its last minute of writes |
| Recovery | `cleanup_new` stops and removes the tunnel and deletes every sandbox with the VM's boat name; `cleanup_image` deletes the saved snapshot (saving or ready) and its record; `recover_capture` has no source state to restore. `reimage` creates the new sandbox before deleting anything, so a retry leaves exactly one; `ls` ignores a sandbox that isn't the recorded one. Inventory fails if boat's API is unreachable rather than reporting an empty account |
| API | `boat_api METHOD PATH [JSON [HEADER]]`: the key goes to curl through a config on a pipe, never the command line. Retries 429 `rate_limited` and 503 (`no_ready_machine`: nothing was created) on every method, and 5xx on GET/DELETE; creates send an `Idempotency-Key`. Deletes send `X-Ascii-Confirm-Delete` |

Not verified yet (needs a paid account):
- everything built on saved snapshots: saving the base, `new`, `snap`/`revert`, `fork`, `new --from`, pool resets, and the JSON of `GET /saved-snapshots/NAME` while saving
- saves of busy running VMs (boat: a write right after the save call can still land in it)
- a Linux host (systemd user units); the live run used a Mac (launchd)

Not supported:
- Headless VMs (`new --headless`): `backend_new … stock` refuses. boat's own image would work as the stock image (boat sandboxes ship Node, git and build tools); it needs the plumbing + devtools layers run over ssh, as exe does.
- boat's desktop streaming, public URLs, integrated agents, environments and AI credentials proxy. boxery uses its own desktop (noVNC through the tunnel) and LLM proxy.
