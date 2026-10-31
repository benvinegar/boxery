# CLI reference

← [Docs](README.md)

- [`boxery`](#boxery-your-laptop) runs on your laptop (bash 3.2 + ssh).
- [`boxery-host`](#boxery-host-the-vm-host) runs on the VM host. You'll rarely call it directly.

## `boxery` (your laptop)

### Lifecycle

```bash
boxery setup you@my-host                     # or: setup local   [--key ~/.ssh/id_ed25519.pub]
boxery new demo                              # ~13 s   [--cpus 4 --mem 8192 --disk 40] [--grant SPEC]…
boxery ls                                    # VMs, with their grants
boxery start demo | stop demo
boxery rm demo                               # also revokes its LLM proxy token
```

### Snapshots

```bash
boxery snap demo before-refactor             # ~2 s
boxery snaps demo
boxery revert demo before-refactor
```

### Shell and in-VM agents

```bash
boxery ssh demo [cmd…]                       # interactive shell (or: ssh demo.boxery)
boxery run demo 'git -C project log --oneline'
boxery attach demo                           # pi in tmux. Ctrl-b d detaches; it keeps running.
boxery attach demo opencode                  # or: shell
boxery prompt demo "fix the failing tests and commit"   # headless pi task in its own tmux session
boxery sessions demo                         # list tmux sessions
```

`prompt` logs to `~/project/.boxery/task-*.log` in the VM. Attach to a task with `boxery attach demo pi task-…`.

### Desktop and ports

```bash
boxery desktop demo                          # XFCE desktop in your browser (noVNC over ssh)
boxery forward demo 3000                     # localhost:3000 → the VM's dev server   [LOCAL_PORT]
```

Editors: once the `Include ~/.boxery/ssh_config` line is in your `~/.ssh/config` ([Install](install.md#laptop--controller)), connect VS Code, Cursor or Zed via Remote-SSH to `demo.boxery`.

### Grants

```bash
boxery grant demo ssh-agent | env:VAR [--cmd CMD] | file:LOCAL[=REMOTE]
boxery revoke demo SPEC… | all
boxery grants demo [apply]
```

See [Grants](grants.md).

### Shared pool

```bash
boxery acquire [--ttl S] [--wait S]          # prints "NAME LEASE_ID"
boxery renew NAME [--ttl S]
boxery release NAME                          # VM is reset to its clean snapshot
boxery leases                                # your leases
boxery pool add|rm|ls                        # admin
```

See [Shared pool & leases](pool.md).

### Misc

```bash
boxery proxy-log [N]                         # which VM called which LLM provider
```

## `boxery-host` (the VM host)

```
init [--backend libvirt|lima]   install proxy, vsock bridge, reaper services + backend setup, symlinks
build-base                      build the golden desktop image (one time)
add-key < key.pub               authorize a controller's ssh key for new VMs
new NAME [--cpus N --mem MiB --disk GiB]
ls | ip NAME | start NAME | stop NAME | rm NAME
snap NAME [SNAP] | snaps NAME | revert NAME SNAP
connect NAME [PORT]             stdio to a VM port (ssh ProxyCommand)
proxy-log [N]

pool add NAME | rm NAME [--force] | ls
acquire --holder H [--ttl S] [--wait S]    (lease ssh pubkey on stdin)
renew LEASE [--ttl S] | release LEASE | reap
```

## Configuration

| Where | What |
|---|---|
| `~/.boxery/config` | Controller: host, host binary path, identity |
| `~/.boxery/ssh_config` | Generated. `*.boxery` hosts via `ProxyCommand`. |
| `~/.boxery/grants/NAME` | Grant names and paths (never values) |
| `~/.boxery/leases/` | Your leases and their per-lease ssh keys |
| `~/.config/boxery/host.env` (host) | Backend and overrides (`BOXERY_BACKEND`, `BOXERY_LIMA_VMTYPE`, …) |
| `~/.config/boxery/proxy.env` (host) | Extra LLM provider keys |
| `~/.config/boxery/tokens.json` (host) | Per-VM proxy tokens |
| `~/.config/boxery/leases.db` (host) | Lease state (SQLite) |
