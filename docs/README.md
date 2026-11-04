# boxery docs

← [Back to the README](../README.md)

## Get started

- **[Install](install.md)**: set up a VM host (Linux/KVM or macOS/Lima) and connect your laptop.

## Connect an agent

- **[pi extension](pi-extension.md)**: `pi --vm demo`, `/vm` commands, fan-out across VMs.
- **[MCP server](mcp.md)**: Claude Code, Cursor, opencode, and other MCP clients.
- **[CLI reference](cli.md)**: the `boxery` command on your laptop and `boxery-host` on the host.

## Features

- **[Named hosts](hosts.md)**: multiple VM hosts through one controller and MCP server.
- **[Shapes](shapes.md)**: named VM sizes (cpus, memory, disk), with defaults you can override per host.

- **[Grants](grants.md)**: give a VM your ssh-agent, env vars, or files.
- **[Shared pool & leases](pool.md)**: several agents share a pool of VMs safely.
- **[GitHub Actions runners](github-runners.md)**: ephemeral self-hosted runners, one job per freshly reset pool VM.
- **[File transfers](copy.md)**: streaming `vm_copy`, destination semantics and cancellation.

## Reference

- **[Security model](security.md)**: the credential proxy, isolation, and threat model.
- **[Backend support](backends.md)**: queryable platforms, validation, requirements and conditional capabilities.
- **[Backend implementations](../host/backends/README.md)**: libvirt, Lima, hosted runtimes and the backend contract.
- **[OpenShell (experimental)](openshell.md)**: policy-enforced headless sandboxes, capabilities and setup.
- **[Lifecycle recovery](lifecycle.md)**: operation locks, crash recovery, reconciliation and upgrade precautions.
- **[Host module boundaries](host-modules.md)**: Node lease policy, runtime adapters, state stores and shell backends.
- **[Architecture](../ARCHITECTURE.md)**: design notes, roadmap, failure modes.
- **[Brand assets](brand/README.md)**: logo mark, wordmark lockup, favicons and colors.
- **[Visual style guide](brand/style.md)**: palette, type, the isometric style, motion and words, for diagrams and video.
- **[Promo video](promo/README.md)**: the 30 s social video, as code, and how to render it.
- **[Research](research/README.md)**: measured workloads in boxery VMs against macOS and Docker, with the raw data and how to rerun them.
- **[Contributing](../CONTRIBUTING.md)**: test layers and CI.
