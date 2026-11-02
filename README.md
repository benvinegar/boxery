<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/lockup-dark.svg">
    <img src="docs/brand/lockup-light.svg" alt="boxery" width="220">
  </picture>
</h1>

<p align="center">
  <strong>Dev environments your agents spin up themselves, on any provider (local, remote, and cloud).</strong>
</p>

<p align="center">
  <a href="docs/install.md#choosing-a-backend">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/works-with-dark.svg">
      <img src="docs/works-with-light.svg" alt="Works with Lima on macOS; libvirt and Cloud Hypervisor on Linux; exe.dev and boat.dev in the cloud" width="740">
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://github.com/modem-dev/boxery/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/modem-dev/boxery/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue">
  <a href="https://www.npmjs.com/package/boxery-vm"><img alt="npm" src="https://img.shields.io/npm/v/boxery-vm?logo=npm"></a>
  <a href="docs/install.md#choosing-a-backend"><img alt="OS: macOS | Linux" src="https://img.shields.io/badge/os-macOS%20%7C%20Linux-lightgrey"></a>
  <a href="docs/mcp.md"><img alt="MCP 2025-11-25" src="https://img.shields.io/badge/MCP-2025--11--25-6f42c1?logo=modelcontextprotocol&logoColor=white"></a>
</p>

<p align="center">
  <a href="docs/install.md">Install</a> ·
  <a href="docs/mcp.md">MCP server</a> ·
  <a href="docs/pi-extension.md">pi extension</a> ·
  <a href="docs/cli.md">CLI</a> ·
  <a href="host/backends/README.md">Backends</a> ·
  <a href="docs/README.md">All docs</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/hero-dark.svg">
    <img src="docs/hero-light.svg" alt="Coding agents on your machine (Claude Code, Codex, Cursor, opencode, pi) use boxery to spin up, fork and throw away VMs and run code, Chrome and desktops inside them: locally, on a remote box, or in the cloud" width="680">
  </picture>
</p>

<p align="center">
  <em><strong>Early-stage, experimental software.</strong> Expect rough edges and breaking changes between releases.</em>
</p>

---

Your agent keeps running where it already runs. boxery gives it **`vm_*` tools** for Ubuntu VMs, with a full desktop and a real Chrome or headless. It works with Claude Code, Codex, Cursor, opencode and any other MCP agent, and has a native [pi](https://pi.dev) extension.

## Why boxery

- **Disposable VMs on demand.** A full desktop VM in about 13 s on libvirt, or a [headless](docs/cli.md#lifecycle) one with no desktop at all. Snapshot in about 1 s, throw it away when done.
- **Fork a running VM.** Copy a VM mid-task into several, try three fixes in parallel, keep the one that works.
- **Real computer use.** Screenshots, clicks, typing and Playwright against Chrome, which you can watch live over noVNC.
- **Same tools everywhere.** Your Mac, a Linux server, or the cloud (exe.dev, boat.dev), even [all at once](docs/hosts.md).
- **Your credentials never enter a VM.** VMs get a revocable token, and the host swaps in your real key. A VM gets nothing by default, not even an LLM, until you [grant it](docs/grants.md).

## Quick start

Give this prompt to your agent:

```text
Read github.com/modem-dev/boxery and set up boxery on this machine.
Then spin up a VM with `boxery new demo` and open its desktop.
```

Or by hand, on a Mac:

```bash
brew install lima jq node
npm install -g boxery-vm
boxery-host init --backend lima && boxery-host build-base
boxery setup local
```

`build-base` builds the desktop image once (about 3 min); skip it if you only want headless VMs. On Linux or in the cloud, see the [install guide](docs/install.md#choosing-a-backend).

Then connect your agent:

```bash
npx add-mcp boxery-vm      # Claude Code, Codex, Cursor, VS Code, opencode, Zed, …
pi install npm:boxery-vm   # or the native pi extension
```

And ask: *"Clone my repo in a VM, start the dev server, and screenshot the homepage in Chrome."*

## What your agent gets

| Tools | |
|---|---|
| `vm_bash` `vm_read` `vm_write` `vm_edit` `vm_jobs` `vm_copy` | Shell, files and background jobs |
| `vm_screenshot` `vm_click` `vm_type` `vm_key` `vm_scroll` `vm_browser` | Computer use and Playwright on the desktop |
| `vm_manage` `vm_info` | Create, fork, snapshot, revert and remove VMs |
| `vm_grant` `vm_lease` | Request access, or lease a VM from a shared pool |

You can also drive VMs yourself with the [CLI](docs/cli.md): `boxery attach demo`, `boxery desktop demo`.

<p align="center">
  <img src="https://raw.githubusercontent.com/modem-dev/boxery/master/docs/computer-use.png" alt="A boxery VM's desktop: Chrome being driven by a laptop agent through vm_browser" width="760">
</p>

## How it works

Agents reach the **boxery host**, a machine you run, over ssh. The host holds your keys and drives the VMs, which are treated as untrusted. [Security model →](docs/security.md)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/host-dark.svg">
    <img src="docs/host-light.svg" alt="Coding agents on your machine reach the trusted boxery host over ssh. The host holds your real LLM keys and API tokens and runs the credential proxy, grants, leases and pool, and images and forks. It creates, forks and wipes untrusted VMs on Lima, libvirt, exe.dev or boat.dev, and each VM holds only a revocable token that the proxy swaps for your real key." width="680">
  </picture>
</p>

## Status

The exe.dev, boat.dev and Cloud Hypervisor backends are experimental. See the [roadmap](ARCHITECTURE.md#roadmap).

## Contributing

Bug reports and PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm run lint && npm test && npm run test:shell
```

## Sponsor

Sponsored by [Modem](https://modem.dev?utm_source=github&utm_medium=oss&utm_campaign=oss_boxery&utm_content=readme_footer).

<a href="https://modem.dev?utm_source=github&utm_medium=oss&utm_campaign=oss_boxery&utm_content=readme_footer">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://modem.dev/images/logo/svg/modem-combined-white.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://modem.dev/images/logo/svg/modem-combined-black.svg">
    <img src="https://modem.dev/images/logo/svg/modem-combined-black.svg" alt="Modem" width="220">
  </picture>
</a>

## License

[MIT](LICENSE) © Ben Vinegar
