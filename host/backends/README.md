# boxery backends

`host/boxery-host` is backend-agnostic: it generates the per-VM identity (cloud-config with ssh keys, LLM proxy token, pi/opencode config), manages tokens, waits for ssh, and runs the LLM proxy. A backend is a bash file sourced by it that implements:

| Function | Contract |
|---|---|
| `backend_check` | verify dependencies (fail with `die`) |
| `backend_init` | one-time host setup (storage pools etc.) |
| `backend_proxy_services` | install host-side bridge services for the guest→proxy path; print unit names to enable (may print nothing) |
| `guest_proxy_upstream` | socat address the guest's `boxery-llm` service forwards 127.0.0.1:8088 to (e.g. `VSOCK-CONNECT:2:8088`, `TCP:192.168.5.2:8088`) |
| `backend_build_base` / `backend_has_base` | build / detect the golden desktop image (`image/base-user-data.yaml`) |
| `backend_exists NAME` | 0 if the VM exists |
| `backend_new NAME CPUS MEM_MIB DISK_GIB USERDATA` | create + boot a VM from the base and apply the cloud-config in USERDATA |
| `backend_list` | lines `NAME<TAB>STATE<TAB>ADDR<TAB>DISK` (empty field = unknown); `boxery-host` turns these into the `ls --json` objects |
| `backend_ssh_endpoint NAME` / `backend_wait_endpoint NAME` | `HOST PORT` where the VM's sshd is reachable from the host (now / after waiting) |
| `backend_start/stop/rm NAME` | lifecycle |
| `backend_snap/revert NAME SNAP`, `backend_snaps NAME` | snapshots (may `die` if unsupported); `backend_snaps` output is for humans |
| `backend_snap_names NAME` | snapshot names, one per line (feeds `snaps NAME --json`); fail if the VM does not exist |

Guest contract: Ubuntu, user `agent` with passwordless sudo, sshd, `~/project`, XFCE on `:1` with VNC/noVNC on localhost, xdotool + ImageMagick, a `google-chrome` binary and `/opt/boxery/node_modules/playwright-core`, and `boxery-llm.service` reading `/etc/boxery/proxy-upstream`. Building from `image/base-user-data.yaml` provides all of it.

| Backend | Platform | Notes |
|---|---|---|
| `libvirt` | Linux + KVM | qcow2 overlays on a base volume; vsock to the proxy; internal snapshots |
| `lima` | macOS (vz) or Linux (qemu) | clones of a built `boxery-base` instance; proxy via the user-net gateway; snapshots need `vmType: qemu` |
| `fake` | tests | directories, no VMs |

Select with `boxery-host init --backend NAME` (persisted in `$BOXERY_CONF/host.env`) or `BOXERY_BACKEND`.
