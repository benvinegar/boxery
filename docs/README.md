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

## Reference

- **[Security model](security.md)**: the credential proxy, isolation, and threat model.
- **[Backends](../host/backends/README.md)**: libvirt, Lima, and the backend contract.
- **[Lifecycle recovery](lifecycle.md)**: operation locks, crash recovery, reconciliation and upgrade precautions.
- **[Host module boundaries](host-modules.md)**: Node lease policy, runtime adapters, state stores and shell backends.
- **[Architecture](../ARCHITECTURE.md)**: design notes, roadmap, failure modes.
- **[Migrating from agentvm](migrating-from-agentvm.md)**: upgrading an install from before the rename.
- **[Contributing](../CONTRIBUTING.md)**: test layers and CI.
