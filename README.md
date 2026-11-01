<h1 align="center">boxery</h1>

<p align="center">
  <strong>More computers for your agents.</strong><br>
  Self-hosted Ubuntu desktop VMs that the coding agents on your laptop can drive: shell, files, a real browser, and the whole desktop.
</p>

<p align="center">
  <a href="https://github.com/benvinegar/boxery/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/benvinegar/boxery/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="Platforms" src="https://img.shields.io/badge/host-Linux%20(KVM)%20%7C%20macOS%20(Lima)-555">
</p>

<p align="center">
  <a href="docs/install.md">Install</a> ·
  <a href="docs/pi-extension.md">pi extension</a> ·
  <a href="docs/mcp.md">MCP server</a> ·
  <a href="docs/cli.md">CLI</a> ·
  <a href="docs/README.md">All docs</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/benvinegar/boxery/master/docs/computer-use.png" alt="A boxery VM's desktop: Chrome being driven by a laptop agent through vm_browser" width="760">
</p>

---

Your agent runs on your laptop, with your model login and your extensions. boxery gives it **`vm_*` tools** that act on full Linux desktop VMs on a machine you own. It can install things, run dev servers, click through UIs and use Chrome, all away from your laptop. You can also run agents *inside* the VMs, where they keep working while your laptop sleeps.

Think of it as a self-hosted [exe.dev](https://exe.dev) that you can point at any box with KVM, or at your Mac.

## Why boxery

- **Fast, disposable desktops.** A new Ubuntu 24.04 + XFCE VM in about 13 s, built from a golden image. Snapshots take about a second, without pausing the VM. Tasks that need no GUI can use `boxery new NAME --headless`: no desktop, and no image build needed. [Headless VMs →](docs/cli.md#lifecycle)
- **Fork a running VM.** Copy a VM, mid-task, into several independent VMs in 15–25 s, so an agent can try three fixes in parallel and keep the one that works. [Snapshots & forks →](docs/cli.md#snapshots-and-forks)
- **Real computer use.** Screenshots, clicks, typing, and Playwright against Chrome on the VM's desktop. You can watch it all in your browser over noVNC.
- **Works with your agent.** A native [pi](https://pi.dev) extension, plus an MCP server for Claude Code, Cursor, opencode and other MCP clients.
- **Credentials stay home.** VMs never see your LLM keys. Each VM gets a revocable token, and a host-side proxy swaps in the real credential.
- **Grant access deliberately.** Each VM gets only what you grant it: specific HTTPS APIs (GitHub, npm, …) with the token injected by the host so it never enters the VM, your ssh-agent, specific env vars or files. Grants are off by default.
- **Share a pool safely.** Several agents can lease VMs from a shared pool with exclusive, expiring leases. A VM is wiped back to a clean image when its lease ends.
- **Several hosts, one MCP server.** Route tools to named hosts with separate SSH configs, grants and lease keys. [Named hosts →](docs/hosts.md)
- **No daemon on your laptop.** The controller is bash 3.2 + ssh, so it runs on stock macOS.

## Quick start

On a **Linux host** with KVM and libvirt ([full requirements](docs/install.md#linux-host-libvirtkvm)):

```bash
npm install -g boxery-vm
boxery-host init                 # storage pool, LLM proxy, lease reaper, ~/.local/bin symlinks
boxery-host build-base           # golden desktop image (~3 min, one time; skip it if you only want --headless VMs)
```

On **your laptop**:

```bash
npm install -g boxery-vm            # the boxery CLI + boxery-mcp
boxery setup you@my-host         # checks ssh, registers your key

pi install npm:boxery-vm            # the pi extension
pi --vm demo                     # pi with a VM named "demo" (created if missing)
```

Then ask: *"Clone my repo in the VM, start the dev server, and screenshot the homepage in Chrome."*

> **Only have a Mac?** Run the host on the Mac itself with Lima: `boxery-host init --backend lima` and `boxery setup local`. See [Install → macOS](docs/install.md#macos-host-lima).

## Use it from

<table>
<tr>
<td width="33%" valign="top">

**pi** (built in)

```bash
pi --vm demo
pi --vm new    # throwaway
pi --vm pool   # lease one
```

[pi extension →](docs/pi-extension.md)

</td>
<td width="33%" valign="top">

**Claude Code, Cursor, …**

```bash
npx add-mcp boxery-vm
```

[MCP server →](docs/mcp.md)

</td>
<td width="33%" valign="top">

**Your terminal**

```bash
boxery attach demo
boxery prompt demo "fix the tests"
boxery desktop demo
```

[CLI reference →](docs/cli.md)

</td>
</tr>
</table>

Every integration exposes the same tools:

| Tool | What it does |
|---|---|
| `vm_bash` `vm_read` `vm_write` `vm_edit` | Shell and files in the VM, with the same semantics as pi's built-ins |
| `vm_copy` | Copy between your machine and VMs, or from one VM to another |
| `vm_screenshot` `vm_click` `vm_type` `vm_key` `vm_scroll` | Computer use on the XFCE desktop |
| `vm_browser` | Playwright code against Chrome on that desktop |
| `vm_manage` | Create, fork, remove, start/stop, resize, snapshot, revert, and switch VMs |
| `vm_info` | Read-only: list VMs, shapes, grants and snapshots |
| `vm_lease` | Lease a VM from the shared pool; renewed while the session runs, released when it ends |
| `vm_view` | MCP Apps clients only: a live view of the desktop in the chat, which you can take control of ([details](docs/mcp.md#live-desktop-view)) |

Every tool takes an optional `vm`, so one agent can fan work out across several VMs. MCP tools also accept `host` to route across [named hosts](docs/hosts.md) from one server.

## How it works

```
  your laptop                        VM host  (Linux + KVM, or a Mac with Lima)
 ┌───────────────────┐     ssh      ┌──────────────────────────────────────────────┐
 │ pi / Claude Code  │─────────────►│ boxery-host ──► VM  Ubuntu 24.04 + XFCE      │
 │   vm_* tools      │  (tailscale) │                  ├ Chrome, Firefox, noVNC    │
 │ boxery CLI        │              │                  ├ pi + opencode in tmux     │
 │ browser ◄─────────┼─── noVNC ────┤                  └ LLM calls ─vsock─┐        │
 └───────────────────┘              │                                     ▼        │
                                    │ boxery-proxy: per-VM token → real creds ──►  │
                                    │               OpenAI · Anthropic · ollama    │
                                    └──────────────────────────────────────────────┘
```

Everything goes over ssh. VMs are reached as `NAME.boxery` through the host, so `ssh demo.boxery`, VS Code Remote-SSH and Zed work too. More detail: [credential proxy](docs/security.md#credential-proxy) · [architecture](ARCHITECTURE.md) · [backends](host/backends/README.md).

## Documentation

| | |
|---|---|
| [Install](docs/install.md) | Linux host, macOS host, laptop setup, LLM providers |
| [pi extension](docs/pi-extension.md) | `--vm`, `/vm` commands, tools, fan-out |
| [MCP server](docs/mcp.md) | stdio on your laptop, or Streamable HTTP over Tailscale |
| [CLI reference](docs/cli.md) | Every `boxery` and `boxery-host` command, and their `--json` output |
| [Grants](docs/grants.md) | Give a VM GitHub/HTTPS APIs (secret stays on the host), your ssh-agent, env vars, or files |
| [Named hosts](docs/hosts.md) | Multiple hosts, one controller and MCP server |
| [Shared pool & leases](docs/pool.md) | Several agents, one pool of VMs, no collisions |
| [Security model](docs/security.md) | Credential proxy, isolation, what a VM can and can't reach |
| [Backends](host/backends/README.md) | libvirt, Lima, and the backend contract |
| [Architecture](ARCHITECTURE.md) | Design, roadmap, and failure modes |
| [Migrating from agentvm](docs/migrating-from-agentvm.md) | Upgrading an install from before the rename |

## Status

boxery is young and moves fast. It's used daily on a single host, and CI covers the controller on Linux and macOS (bash 3.2). Expect rough edges. The [roadmap](ARCHITECTURE.md#roadmap-re-ordered-after-review) lists what's next: profiles, network isolation, per-VM budgets.

## Contributing

Bug reports and PRs are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the test layers. Most of them run offline:

```bash
npm run lint && npm test && npm run test:shell
```

## License

[MIT](LICENSE) © Ben Vinegar
