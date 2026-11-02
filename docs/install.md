# Install

← [Docs](README.md)

boxery has two halves:

- **The VM host** runs the VMs, the LLM credential proxy and the lease reaper. It can be a Linux box with KVM (recommended), a Mac with Lima, or any machine with ssh driving VMs on exe.dev or boat.dev (both experimental).
- **The controller** is the `boxery` CLI on your laptop. It's bash + ssh, and it's what the pi extension and the MCP server call.

They can be the same machine.

- [Linux host (libvirt/KVM)](#linux-host-libvirtkvm)
- [macOS host (Lima)](#macos-host-lima)
- [Linux host (Cloud Hypervisor, experimental)](#linux-host-cloud-hypervisor-experimental)
- [exe.dev (experimental)](#exedev-experimental)
- [boat.dev (experimental)](#boatdev-experimental)
- [Laptop / controller](#laptop--controller)
- [LLM providers for in-VM agents](#llm-providers-for-in-vm-agents)
- [Verify](#verify)
- [Upgrading](#upgrading)

## Linux host (libvirt/KVM)

**Requirements**

- KVM (`/dev/kvm` readable)
- libvirt on `qemu:///system`, with your user in the `libvirt` group
- `virt-install`, `qemu-img`, `cloud-localds` (from `cloud-image-utils`)
- `socat`, `nc`
- Node ≥ 22.13 (the lease store uses `node:sqlite`)
- systemd user services. Turn on linger so the proxy and reaper keep running after you log out:

```bash
sudo loginctl enable-linger "$USER"
```

**Install**

```bash
npm install -g boxery-vm            # or: git clone https://github.com/benvinegar/boxery.git && use ./host/boxery-host
boxery-host init                 # storage pool, proxy + vsock + reaper user services, ~/.local/bin symlinks
boxery-host build-base           # golden image: XFCE, VNC, Chrome, Firefox, Node 24, pi, opencode (~3 min)
```

`init` symlinks `boxery-host` into `~/.local/bin`. The controller expects it there. The proxy and reaper services point at the installed package path and the node and tools found on your `PATH` at `init` time, so after switching Node versions with nvm/fnm re-run `boxery-host init`. To update boxery itself, see [Upgrading](#upgrading).

## macOS host (Lima)

No Linux box? Run the host on your Mac and point the controller at `local`. The laptop and the host are then the same machine.

```bash
brew install lima jq node
npm install -g boxery-vm
boxery-host init --backend lima
boxery-host build-base
boxery setup local
```

Lima maps the guest's gateway (`192.168.5.2`) to your Mac's `127.0.0.1`. boxery starts every Lima instance under `sandbox-exec` so that guests reach only the LLM proxy there, not Ollama's admin API, the HTTP MCP server or your dev databases. Services listening on the Mac's other addresses (`0.0.0.0`, LAN, Tailscale) stay reachable from guests, and VMs started outside boxery (`limactl start`) aren't confined: [security → known limits](security.md#known-limits).

Apple Silicon notes:

- The guest is arm64, so `vm_browser` uses Playwright's Chromium instead of Google Chrome. Google ships no Linux arm64 build.
- Lima's default `vz` VM type is fast, but it can't snapshot. Set `BOXERY_LIMA_VMTYPE=qemu` (before `init`) if you need `snap` and `revert`, or if you want to use the [shared pool](pool.md).

## Linux host (Cloud Hypervisor, experimental)

An alternative to libvirt on Linux: no libvirtd, and a routed TAP per VM with guest isolation in nftables (guests can't reach the host, each other or your LAN). It needs Cloud Hypervisor, a firmware file, nftables and passwordless sudo for network setup. Requirements and layout: [backends → cloud-hypervisor](../host/backends/README.md#cloud-hypervisor-experimental).

```bash
sudo setcap cap_net_admin+ep "$(command -v cloud-hypervisor)"
./host/boxery-host init --backend cloud-hypervisor
./host/boxery-host build-base
```

## exe.dev (experimental)

No KVM at all: run the VMs on [exe.dev](https://exe.dev) and the host (proxy, leases, tunnels) on any Linux box or Mac with ssh. You need an exe.dev account whose ssh key this machine offers first. If `ssh exe.dev whoami` says "Please complete registration", run `ssh exe.dev` in a terminal and enter your account's email to add the key.

```bash
ssh exe.dev whoami
npm install -g boxery-vm
boxery-host init --backend exe       # BOXERY_EXE_KEY=~/.ssh/id_exe to use a dedicated key
boxery-host build-base               # ~3 min on an exeuntu VM, then kept paused as the base
boxery setup local                   # or: boxery setup you@this-host
```

VM sizes are capped to the Personal plan (2 vCPU, 4 GB, shared by all your VMs); raise `BOXERY_EXE_MAX_CPUS` / `BOXERY_EXE_MAX_MEM` on bigger plans. `stop` pauses a VM. Layout, security notes and what's still unverified: [backends → exe](../host/backends/README.md#exe-experimental).

**Run the host on an always-on machine.** The VMs are in the cloud, but the host keeps one ssh tunnel per VM open to exe.dev, and that tunnel carries both the VM's ssh endpoint and the agents' only route to the LLM proxy. When the host sleeps or goes offline, every running agent loses its LLM in the middle of a task, and no controller can reach the VMs. The VMs keep running and the tunnels reconnect by themselves (within seconds) once the host is back. So put `boxery-host --backend exe` on a machine that stays up, such as a home server, a small Linux VPS or a desktop that doesn't sleep, and use your laptop as a controller only (`boxery setup you@that-host`). This keeps the security model: provider credentials stay on that machine and never enter a VM. On a Linux host, turn on linger (`sudo loginctl enable-linger "$USER"`, as above) so the tunnels, which are systemd user units, keep running when you're logged out. If you do run the host on a Mac, keep it awake while agents work (for example `caffeinate -s` on AC power).

`boxery-host ls` shows a running VM whose tunnel isn't connected as `tunnel connecting` (it is retrying) or `tunnel down` (it isn't running; `boxery-host start NAME` brings it back) in place of its address. Commands that need the VM say the same thing rather than waiting for ssh to time out.

## boat.dev (experimental)

Also no KVM: run the VMs as [boat.dev](https://boat.dev) sandboxes (full Ubuntu VMs) and the host on any Linux box or Mac with ssh. You need a **paid** boat plan: images (the base, snapshots, forks, the pool's clean states) are boat saved snapshots, which the free trial refuses. (The trial also requires auto-stop: `BOXERY_BOAT_TTL=7200`.) Create an API key in the boat dashboard.

```bash
npm install -g boxery-vm
BOAT_API_KEY=boat_… boxery-host init --backend boat   # saves the key in ~/.local/share/boxery/boat/api-key (0600)
boxery-host build-base                                # a builder sandbox, saved as the base, then deleted
boxery setup local                                    # or: boxery setup you@this-host
```

VM sizes are boat's four types: a VM gets the smallest that fits (`small` 2 vCPU/4 GB, `default` 4/8, `large` 8/16; `xlarge` with `BOXERY_BOAT_MAX_TYPE=xlarge` on the $100 plan). `stop` is a real stop, and boat keeps a stopped VM's disk for 14 days. Each VM is reached through an ssh tunnel the host keeps open, so the host must stay up. Saved snapshots beyond your plan's allowance cost $0.056 a day each. Layout and what's still unverified: [backends → boat](../host/backends/README.md#boat-experimental).

### A second backend on the same machine

Already running a host (say Lima) and want exe.dev or boat.dev VMs from the same machine? Add it as a second host profile from the controller. It gets its own state, proxy port and services, so it doesn't touch the first one:

```bash
boxery host add exe local --backend exe     # or: you@my-host
boxery --host exe build-base
boxery --host exe new demo
```

See [Named hosts → several backends on one machine](hosts.md#several-backends-on-one-machine).

Backend details: [host/backends/README.md](../host/backends/README.md).

## Laptop / controller

Needs only bash (3.2 is fine), ssh and a browser.

```bash
npm install -g boxery-vm            # or: git clone + ln -s ~/boxery/controller/boxery onto your PATH
boxery setup you@my-host                                    # or: boxery setup local
```

`setup` checks that ssh to the host works and registers your public key, which goes into VMs created from then on. It registers the host under a name (`local`, or the host part of `you@my-host`; pass `--name` to choose) and makes it the default if it's your first, writing its config to `~/.boxery/profiles/NAME/`. Running `setup` again for the same name reconfigures that host. To add more hosts, see [Named hosts](hosts.md). Your laptop must already be able to `ssh you@my-host`. [Tailscale](https://tailscale.com) is the easy way to reach the host from anywhere.

**Optional: plain `ssh` to VMs.** `setup` prints an `Include` line for your default host; add it to the **top** of `~/.ssh/config`. For a host named `local`:

```
Include ~/.boxery/profiles/local/ssh_config
```

After that, `ssh demo.boxery`, VS Code / Cursor Remote-SSH and Zed remote all work.

Next: hook up an agent with the [pi extension](pi-extension.md) or the [MCP server](mcp.md).

## LLM providers for in-VM agents

pi and opencode come preinstalled in every VM and are already pointed at the host's [credential proxy](security.md#credential-proxy). VMs never hold real keys. You only need these if you run agents **inside** VMs (`boxery attach`, `boxery prompt`). Laptop agents using `vm_*` tools use your laptop's own login.

| Provider | How |
|---|---|
| ChatGPT / Codex | Run `pi` on the host once and `/login`. The proxy reuses `~/.pi/agent/auth.json` and refreshes it. |
| OpenAI, Anthropic API | Put `OPENAI_API_KEY=…` / `ANTHROPIC_API_KEY=…` in `~/.config/boxery/proxy.env` |
| Ollama | Auto-detected on `127.0.0.1:11434`. Its tool-capable models are configured for pi and opencode. |

## Verify

```bash
boxery new demo          # ~13 s
boxery run demo uname -a
boxery desktop demo      # opens the XFCE desktop in your browser
boxery rm demo
```

To check everything at once, run `./e2e.sh` from the controller. It covers create, in-VM agents, proxy, desktop, extension, grants, leases, snapshots and rm.

## Upgrading

From the controller:

```bash
boxery version                      # controller and host versions; warns when the host is behind
boxery upgrade-host --check         # what would change, without changing it
boxery upgrade-host                 # or: boxery --host hornet upgrade-host
```

Or on the host itself: `boxery-host upgrade [--check]`.

`upgrade` works out how boxery is installed on the host and updates it in place:

- **git checkout** on a branch: `git pull --ff-only` from its upstream. It refuses a checkout with uncommitted changes or local commits. A detached checkout moves to the newest `v*` tag.
- **global npm install**: `npm install -g boxery-vm@latest`. It never downgrades unless you pass `--ref`.
- `--ref REF` pins a tag, branch or npm version, including an older one.

It then re-runs `init` for **every profile whose services run that install**. For example, it re-runs both the libvirt profile and a second Lima profile with its own `BOXERY_CONF`. Each profile keeps the node its services already use. Services that belong to other installs are listed and left alone.

Before changing anything, it waits for VM operations already in flight in each profile to finish, up to `--wait` seconds (600 by default). It exits with code 75 if they don't finish in time, and nothing changes. New operations wait behind the upgrade (see [lifecycle](lifecycle.md)).

After `init`, it checks every profile the way its services run. `boxery-host ls` must work with the reaper's `PATH`, and the LLM proxy must answer `/healthz`. If any check fails, the code goes back to the previous version and `init` runs again.

Hosts installed before `upgrade` existed need one manual update, on the host:

```bash
cd ~/boxery && git pull --ff-only    # or: npm update -g boxery-vm
boxery-host init                     # and boxery-host --profile NAME init (or BOXERY_CONF=… boxery-host init) for each extra profile
```

`upgrade-host` is a CLI command for you, not a `vm_*` tool. Agents can see version skew with `vm_info {action:"version"}`. They are told to pass the upgrade on to you rather than run it. An agent that could swap the code next to your credentials is a risk the read-only tools don't carry.
