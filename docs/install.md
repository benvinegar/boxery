# Install

← [Docs](README.md)

boxery has two halves:

- **The VM host** runs the VMs, the LLM credential proxy and the lease reaper. It can be a Linux box with KVM (recommended) or a Mac with Lima.
- **The controller** is the `boxery` CLI on your laptop. It's bash + ssh, and it's what the pi extension and the MCP server call.

They can be the same machine.

- [Linux host (libvirt/KVM)](#linux-host-libvirtkvm)
- [macOS host (Lima)](#macos-host-lima)
- [Linux host (Cloud Hypervisor, experimental)](#linux-host-cloud-hypervisor-experimental)
- [Laptop / controller](#laptop--controller)
- [LLM providers for in-VM agents](#llm-providers-for-in-vm-agents)
- [Verify](#verify)

## Linux host (libvirt/KVM)

**Requirements**

- KVM (`/dev/kvm` readable)
- libvirt on `qemu:///system`, with your user in the `libvirt` group
- `virt-install`, `qemu-img`, `cloud-localds` (from `cloud-image-utils`)
- `socat`, `jq`, `nc`, `openssl`
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
