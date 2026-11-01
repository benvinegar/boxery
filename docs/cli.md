# CLI reference

← [Docs](README.md)

- [`boxery`](#boxery-your-laptop) runs on your laptop (bash 3.2 + ssh).
- [`boxery-host`](#boxery-host-the-vm-host) runs on the VM host. You'll rarely call it directly.
- [JSON output](#json-output): `--json` on every listing command, for scripts and agents.

## `boxery` (your laptop)

### Named hosts

```bash
boxery host add laptop local
boxery host add hornet you@hornet
boxery host add existing --config-dir "$HOME/.boxery-other"
boxery host ls
boxery host show hornet
boxery host use laptop
boxery --host hornet ls
boxery --host hornet acquire                # pool lease on that host
boxery host use legacy                      # original root profile
boxery host rm hornet                       # forget only; preserves VMs and profile data
```

See [Named hosts](hosts.md) for isolation, imports, precedence and safe removal. `--host NAME` precedes the command and also scopes grants and lease keys.

### Lifecycle

```bash
boxery setup you@my-host                     # or: setup local   [--key ~/.ssh/id_ed25519.pub]
boxery new demo                              # ~13 s   [--cpus 4 --mem 8192 --disk 40] [--grant SPEC]…
boxery ls [--json]                           # VMs, with their grants
boxery start demo | stop demo
boxery rm demo                               # also revokes its LLM proxy token
```

### Snapshots and forks

```bash
boxery fork demo try-a try-b                 # copy demo (running or not) into 2 new VMs, ~15–25 s   [--grants]
boxery snap demo before-refactor             # ~1 s, the VM keeps running
boxery snaps demo [--json]
boxery revert demo before-refactor           # VM keeps its name, address and token
boxery new demo2 --from demo@before-refactor # a new VM from a snapshot
boxery snap-rm demo before-refactor
boxery images                                # every snapshot on the host
```

A **fork** is a separate VM with the source's disk (files, installed packages, git state) but not its running processes, and with its own hostname, LLM proxy token, ssh keys and network identity. Forks don't depend on the source: removing either one is fine. Grants are per VM and aren't copied unless you pass `--grants`. A fork of a leased pool VM is an ordinary VM and never accepts the lease key.

Snapshots and forks are built on one backend primitive, the image (a copy of a VM's disk named `VM@LABEL`). They hold disk state only, never memory, so secrets pushed by grants (tmpfs) are never captured. `rm` removes a VM's snapshots too. Snapshots made by boxery versions before images are still listed (marked legacy) and can be reverted or deleted. How each backend implements images: [backends](../host/backends/README.md#images-one-primitive-for-snapshots-forks-and-pool-resets).

### Shell and in-VM agents

```bash
boxery ssh demo [cmd…]                       # interactive shell (or: ssh demo.boxery)
boxery run demo git log --oneline -5         # exact argv, like docker exec; runs in ~/project
boxery run demo --cwd app pnpm test          # in ~/project/app
boxery run demo bash -c 'make test 2>&1 | tail'   # a shell line: bash -c
boxery attach demo                           # pi in tmux. Ctrl-b d detaches; it keeps running.
boxery attach demo opencode                  # or: shell
boxery prompt demo "fix the failing tests and commit"   # headless pi task in its own tmux session
boxery sessions demo [--json]                # list tmux sessions
```

`run` works like `docker exec` / `kubectl exec`: the command gets exactly the arguments you pass, and nothing in them (quotes, `$`, `~`, globs, `;`) is re-parsed in the VM. For pipes, `&&`, `~` or `$VAR`, run a shell explicitly with `bash -c '…'` (how `run` used to treat every command). A whole command line passed as one argument (`boxery run demo 'make test'`) is looked up as a single command name and fails with a hint. An argument that is `~`, starts with `~/` or contains `$VAR`/`${…}` reaches the command literally and exits 0, so `run` adds a note on stderr pointing at `bash -c` (not when the command is a shell or an interpreter such as awk, perl or jq, whose code uses `$`). Like the `vm_bash` tool, `run` starts in `~/project` (home if there is none), and a relative `--cwd DIR` is under `~/project`; `~/` expands in the VM and absolute paths are used as is. `--` ends `run`'s own options. The exit code is the command's. `ssh NAME cmd…` keeps plain ssh semantics.

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
boxery grants demo [apply | --json]
```

See [Grants](grants.md).

### Shared pool

```bash
boxery acquire [--ttl S] [--wait S]          # prints "NAME LEASE_ID"
boxery renew NAME [--ttl S]
boxery release NAME                          # VM is reset to its clean snapshot
boxery leases [--json]                       # your leases
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
new NAME [--cpus N --mem MiB --disk GiB] [--from IMAGE]
fork SRC DST... [--cpus N --mem MiB --disk GiB]
ls [--json] | ip NAME | start NAME | stop NAME | rm NAME
snap NAME [SNAP] | snaps NAME [--json] | snap-rm NAME SNAP | revert NAME SNAP | images
connect NAME [PORT]             stdio to a VM port (ssh ProxyCommand)
proxy-log [N]

pool add NAME | rm NAME [--force] | ls [--json]
acquire --holder H [--ttl S] [--wait S]    (lease ssh pubkey on stdin)
renew LEASE [--ttl S] | release LEASE | reap | reconcile
```

`reconcile` (also performed by `reap`) recovers abandoned lifecycle operations and checks inventory drift. Conflicting VM mutations are serialized through readiness/key installation, not just disk operations. See [Lifecycle coordination and recovery](lifecycle.md) for crash behavior, backend responsibilities and upgrade precautions.

## JSON output

Every listing command takes `--json` and prints one JSON value on stdout. Errors go to stderr with a non-zero exit status; nothing else is printed on stdout. Field names below are stable: new fields may be added, existing ones are not renamed or removed without a major version bump.

Conventions:

- Timestamps are Unix epoch seconds (numbers). Durations are seconds.
- A field that is unknown or does not apply is `null`, never `""` or `"-"`.
- Arrays are printed one element per line. That is still ordinary JSON; parse it as a whole.
- Empty lists print `[]`.

The controller (`boxery`) needs no `jq`; it builds JSON with `printf`. The host (`boxery-host`) uses `jq`, which it already requires.

### Controller (`boxery`, on your laptop)

#### `boxery ls --json`

VMs on the host, plus the grants this machine has given each one.

```json
[
{"name":"demo","state":"running","addr":"192.168.122.50","disk":"2.1GiB","lease":null,"grants":[{"kind":"ssh-agent"}]},
{"name":"pool-1","state":"running","addr":"192.168.122.51","disk":"1.8GiB","lease":{"state":"LEASED","holder":"ben@mac","expires_at":1793462400},"grants":[]}
]
```

| Field | Type | |
|---|---|---|
| `name` | string | VM name |
| `state` | string \| null | backend state: `running`, `shut off`, … (as reported by libvirt/Lima) |
| `addr` | string \| null | address the host reaches the VM at (`IP` for libvirt, `127.0.0.1:PORT` for Lima) |
| `disk` | string \| null | disk usage, human readable (e.g. `2.1GiB`) |
| `lease` | object \| null | `null` for ordinary VMs; for pool VMs: `{state, holder, expires_at}` (see `pool ls`) |
| `grants` | array | this machine's grants for the VM, same objects as `grants --json` |

#### `boxery grants NAME --json`

Local grant records (names and paths only; values are never stored or printed).

```json
[
{"kind":"ssh-agent"},
{"kind":"env","var":"GITHUB_TOKEN","cmd":"gh auth token"},
{"kind":"file","local":"/Users/ben/app/.env","remote":"/home/agent/project/.env"}
]
```

| `kind` | Fields |
|---|---|
| `ssh-agent` | (none) |
| `env` | `var` (string), `cmd` (string \| null: command that produces the value; `null` = read from the local environment) |
| `file` | `local` (absolute local path), `remote` (absolute path in the VM) |
| `http` | `host`, `auth` (`bearer`, `basic:USER`, `header:NAME`), `readonly` (boolean), `cmd` (command that produces the secret) |

#### `boxery leases --json`

Leases held by this machine (from `~/.boxery/leases`).

```json
[
{"name":"pool-1","lease_id":"l-0123456789abcdef0123456789abcdef","expires_at":1793462400,"expires_in":1712,"ttl":1800,"holder":"ben@mac"}
]
```

| Field | Type | |
|---|---|---|
| `name` | string | leased VM |
| `lease_id` | string | `l-` + 32 hex |
| `expires_at` | number | last known expiry (updated by `renew`) |
| `expires_in` | number | seconds left, `0` once expired |
| `ttl` | number \| null | TTL used for renewals |
| `holder` | string \| null | holder name sent to the host |

#### `boxery sessions NAME --json`

tmux sessions in the VM (agents started by `attach` / `prompt`).

```json
[
{"name":"pi","windows":1,"created":1793460000,"attached":true},
{"name":"task-20261031-120000","windows":1,"created":1793460100,"attached":false}
]
```

#### `boxery snaps NAME --json`

Snapshots of a VM, passed through from `boxery-host snaps NAME --json`. `created` and `size` are `null` for legacy snapshots.

```json
[
{"name":"before-refactor","created":"2026-10-31T19:28:31","size":"173MiB","legacy":false}
]
```

### Host (`boxery-host`, on the VM host)

#### `boxery-host ls --json`

Same objects as `boxery ls --json` without `grants` (grants live on the controller): `name`, `state`, `addr`, `disk`, `lease`. Built in one place from the backend's `backend_list` lines and the lease store.

#### `boxery-host snaps NAME --json`

`[{"name", "created", "size", "legacy"}]`, from the backend's `backend_images` (and `backend_legacy_snaps`).

#### `boxery-host pool ls --json`

Every pool VM and its lease state.

```json
[
{"name":"pool-1","state":"LEASED","holder":"ben@mac","acquired_at":1793460600,"expires_at":1793462400,"expires_in":1800},
{"name":"pool-2","state":"FREE","holder":null,"acquired_at":null,"expires_at":null,"expires_in":null}
]
```

| Field | Type | |
|---|---|---|
| `state` | string | `FREE`, `ACQUIRING`, `LEASED`, `RESETTING`, `BROKEN` |
| `holder` | string \| null | who holds it |
| `acquired_at`, `expires_at` | number \| null | lease start / expiry |
| `expires_in` | number \| null | seconds left (only while `LEASED`; may be negative until the reaper runs) |

Run it on the host, or from the controller as `boxery pool ls --json`.

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
