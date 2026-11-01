# Install

← [Docs](README.md)

boxery has two halves:

- **The VM host** runs the VMs, the LLM credential proxy and the lease reaper. It can be a Linux box with KVM (recommended), a Mac with Lima, or any machine with ssh driving VMs on exe.dev (experimental).
- **The controller** is the `boxery` CLI on your laptop. It's bash + ssh, and it's what the pi extension and the MCP server call.

They can be the same machine.

- [Linux host (libvirt/KVM)](#linux-host-libvirtkvm)
- [macOS host (Lima)](#macos-host-lima)
- [Linux host (Cloud Hypervisor, experimental)](#linux-host-cloud-hypervisor-experimental)
- [exe.dev (experimental)](#exedev-experimental)
- [Laptop / controller](#laptop--controller)
- [LLM providers for in-VM agents](#llm-providers-for-in-vm-agents)
- [Verify](#verify)

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
boxery-host build-base           # golden image: XFCE, VNC, Chrome, Firefox, Node 22, pi, opencode (~3 min)
```

`init` symlinks `boxery-host` into `~/.local/bin`. The controller expects it there. The proxy and reaper services point at the installed package path, so after `npm update -g boxery-vm` (or switching Node versions with nvm/fnm) re-run `boxery-host init`.

## macOS host (Lima)

No Linux box? Run the host on your Mac and point the controller at `local`. The laptop and the host are then the same machine.

```bash
brew install lima jq node
npm install -g boxery-vm
boxery-host init --backend lima
boxery-host build-base
boxery setup local
```

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

Backend details: [host/backends/README.md](../host/backends/README.md).

## Laptop / controller

Needs only bash (3.2 is fine), ssh and a browser.

```bash
npm install -g boxery-vm            # or: git clone + ln -s ~/boxery/controller/boxery onto your PATH
boxery setup you@my-host                                    # or: boxery setup local
```

`setup` checks that ssh to the host works and registers your public key, which goes into VMs created from then on. It also writes `~/.boxery/ssh_config`. Your laptop must already be able to `ssh you@my-host`. [Tailscale](https://tailscale.com) is the easy way to reach the host from anywhere.

**Optional: plain `ssh` to VMs.** Add this line to the **top** of `~/.ssh/config`:

```
Include ~/.boxery/ssh_config
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
