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
boxery host add exe local --backend exe     # a second backend on that machine: own profile, proxy port, services
boxery host add exe2 local --profile exe    # an existing profile on that machine
boxery host add existing --config-dir "$HOME/.boxery-other"
boxery host ls [--json]                     # where each runs (local / ssh destination), backend, same-profile names
boxery host show hornet
boxery host use laptop
boxery --host hornet ls
boxery --host hornet acquire                # pool lease on that host
boxery host rm hornet                       # forget only; preserves VMs and profile data
```

See [Named hosts](hosts.md) for isolation, imports, precedence and safe removal. `--host NAME` precedes the command and also scopes grants and lease keys.

### Backend discovery

`boxery backends [--json]` lists backend platform support, requirements and capabilities.
`boxery capabilities [--json | --check]` assesses the selected **host**, not the controller.
Both are also available directly as `boxery-host` commands. Agents use
`vm_info {action:"capabilities"}`. See the [metadata contract](backends.md) for
supported versus tested configurations and conditional features. Setup checks
locally verifiable requirements before backend initialization; manual account and
privilege requirements are explained but remain unknown until verified.

### Lifecycle

```bash
boxery setup you@my-host                     # or: setup local   [--name NAME] [--key ~/.ssh/id_ed25519.pub]
boxery new demo                              # ~13 s   [--shape large] [--cpus N --mem MiB --disk GiB] [--grant SPEC]…
boxery new ci-1 --headless                   # no desktop, no build-base needed: ~50 s on Lima (see below)
boxery build-base                            # the host's desktop base image (one time, ~3 min)
boxery shapes [--json]                       # VM sizes the host offers (* = default); see Shapes
boxery ls [--json] [--refresh]               # VMs, with their shape, grants and guest software (GUEST)
boxery patch demo | --all [--wait S]         # update a VM's guest software to the host's image layers
boxery start demo | stop demo
boxery resize demo --cpus 8 --mem 16384      # [--disk GiB]; restarts a running VM
boxery rm demo                               # also revokes its LLM proxy token
boxery pin demo [--from-guest]               # re-pin demo's ssh host key (a VM from before keys were pinned)
```

**Headless VMs.** `new --headless` makes a VM without the desktop: shell, git (current, from the git-core PPA), build tools, node 24, pi, opencode and ripgrep, but no XFCE, VNC, browsers or computer use. It boots the backend's stock image (the Ubuntu 24.04 cloud image; exeuntu on exe.dev) and installs boxery's plumbing and dev-tools layers at first boot, so the host needs no `build-base`. That takes longer than cloning the built desktop base: about 50 s on Lima (vz, Apple Silicon), mostly the dev tools. Snapshots, forks and `new --from` of a headless VM are as fast as for desktop VMs and stay headless; a VM made from an image keeps its source's kind, and `--headless` with a desktop image is refused. `boxery desktop`, `vm_screenshot`/`vm_click`/`vm_type`/`vm_key`/`vm_scroll` and `vm_browser` refuse headless VMs with a clear error. `ls` shows the kind (KIND column, `desktop` in `--json`). The layers are in [`image/layers/`](../image/layers/); see [backends](../host/backends/README.md#image-layers-desktop-and-headless-vms). `--layers github-runner` adds an optional layer at first boot, the GitHub Actions runner ([GitHub Actions runners](github-runners.md)); only a headless VM takes `--layers`, since a desktop VM's layers come from its base and a VM made from an image has its source's.

**Host keys.** Every ssh to a VM checks its host key, which is pinned on the host when the VM is made ([security](security.md#vm-host-keys)). A VM made before that, or whose record was lost, fails with "Host key verification failed" until you run `boxery pin NAME`. That reads the key through the hypervisor (libvirt's guest agent) or the host's loopback endpoint (Lima, exe, boat). `--from-guest` instead trusts what the VM's ssh endpoint answers, once. `boxery start NAME` pins it automatically where it can.

**Outdated guest software.** A VM keeps the kernel and packages it was built with: nothing updates them after it is made. Every VM records what it was built with in `/etc/boxery/build-info` (date, kernel, a hash of boxery's image layers, and on desktops the Chrome/Chromium and `playwright-core` versions), and the host keeps a copy, read whenever it reaches the VM anyway (`new`, `fork`, `start`, `revert`, `patch`). `ls` shows the result in the GUEST column (`guest` in `--json`): `outdated` when the VM was built from other image layers than the host's current ones (the host was upgraded since), more than 30 days ago (`BOXERY_STALE_DAYS` in the host's `host.env` changes that), or when the guest asks for a reboot (`/var/run/reboot-required`, read when the host last reached it); `current` otherwise; `unknown` for a VM built before build records or never read. `ls` reads only the host's copy, so it stays fast; `ls --refresh` first reads each running VM's record over ssh. `ls` says which VMs are outdated and why on stderr.

`boxery patch NAME` updates a running VM in place: it copies the host's current image layers into the VM, runs the layers the VM has again (security updates and kernel with `apt-get full-upgrade`, and what the layers install outside apt: `playwright-core` and, on arm64, its Chromium; the pi and opencode CLIs; node 24), and restarts the VM if the updates ask to (its tmux sessions end; its grants are pushed again). It takes a few minutes, streams the layers' progress and logs everything to `/var/log/boxery-patch.log` in the VM. `--all` patches every running VM in turn, and says which it skipped (stopped VMs, pool VMs with a lease). A pool VM must be free: `patch` refuses one with a lease, or waits up to `--wait S` seconds for it to end; while it is patched no lease can start on it, and its clean image (`NAME@boxery-clean`) is captured again, so later leases start patched. **Snapshots and images are not patched**: `snaps` and `images` show their age and the guest software they hold, and a VM made or reverted from an outdated one is outdated until you patch it. A VM from a desktop base built before build records shows `unknown`; patching gives it a record. To patch the base itself, rebuild it (`boxery build-base`).

`resize` takes any of `--cpus`, `--mem` (MiB) and `--disk` (GiB), the same units as `new`. A running VM is stopped, resized and started again, so its tmux sessions end; its grants are pushed again afterwards. A stopped VM stays stopped. The disk can only grow, and the guest's root filesystem grows on the next boot. Values that are already the VM's current size are ignored, so a resize that changes nothing doesn't restart anything. Like other long-lived VM products (exe.dev, Daytona, EC2), it changes the VM in place; throwaway sandboxes such as E2B are recreated instead.

### Snapshots and forks

```bash
boxery fork demo try-a try-b                 # copy demo (running or not) into 2 new VMs, ~15–25 s   [--grants] [--shape S]
boxery snap demo before-refactor             # ~1 s, the VM keeps running
boxery snaps demo [--json]
boxery revert demo before-refactor           # VM keeps its name, address and token
boxery new demo2 --from demo@before-refactor # a new VM from a snapshot
boxery snap-rm demo before-refactor
boxery images                                # every snapshot on the host (with AGE and GUEST, like snaps)
```

A **fork** is a separate VM with the source's disk (files, installed packages, git state) but not its running processes, and with its own hostname, LLM proxy token, ssh keys and network identity. Forks don't depend on the source: removing either one is fine. Forks get the source's size (cpus, memory, disk) unless you pass `--shape` or size flags. Grants are per VM and aren't copied unless you pass `--grants`. That option revalidates the source grants and asks for each destination before creating anything; stale files or newly forbidden legacy grants must be revoked first (or omit `--grants`). A fork of a leased pool VM is an ordinary VM and never accepts the lease key.

Snapshots and forks are built on one backend primitive, the image (a copy of a VM's disk named `VM@LABEL`). They hold disk state only, never memory, so secrets pushed by grants (tmpfs) are never captured. `rm` removes a VM's snapshots too. How each backend implements images: [backends](../host/backends/README.md#images-one-primitive-for-snapshots-forks-and-pool-resets).

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

### Files

```bash
boxery cp ./repo.bundle demo:                # this machine → VM (~/project/repo.bundle)
boxery cp demo:dist ./dist                   # VM → here; directories copy recursively
boxery cp demo:out.zip hornet/worker:in.zip  # VM → VM, here across named hosts
boxery --host hornet cp local:notes.md ci-1:~/notes.md
```

`cp` is the `vm_copy` tool's own code, so it takes the same locations, `local:PATH`, `NAME:PATH` (a VM on the selected host) and `HOST/NAME:PATH`, and behaves the same way: streaming tar, staging, destination and cancellation rules are in [file transfers](copy.md). The one difference: the CLI has no current VM, so a bare path is on this machine, like `cp`/`scp` (`vm_copy` reads it as the current VM). A bare path that looks like a location with an invalid VM name (`Demo:x`) is refused instead of being written locally. Ctrl-C cancels and cleans up staging. `cp` runs on Node (≥ 20), which the npm package already needs.

`prompt` logs to `~/project/.boxery/task-*.log` in the VM. Attach to a task with `boxery attach demo pi task-…`.

### Background command jobs

For commands that take a while (a test suite, a build). The job runs in the VM, detached from your ssh connection, so a dropped connection or a sleeping laptop doesn't stop it, and its real exit code is kept.

```bash
job=$(boxery run --bg demo --cwd app pnpm test)   # prints just the job ID
boxery jobs demo [--json]                        # state, exit code, start time, command
boxery logs demo "$job" [-f] [--strip-ansi] [--lines 200] [--bytes N]
boxery wait demo "$job" [--timeout S] [--json]   # exits with the command's real status
boxery kill demo "$job" [--grace S] [--json]     # SIGTERM its process group, SIGKILL after S s (default 5)
boxery jobs demo --prune [--older-than 7d]       # delete finished jobs and their logs (default: all)
```

`run demo --bg …` also works.

- **The command** follows the same rules as foreground `run`: exact arguments, `--cwd`, and `bash -c '…'` for shell syntax. It runs in a login shell (profile and grants loaded) with no stdin, and stdout and stderr go to `~/.boxery/jobs/ID.log` in the VM.
- **States** are `running`, `exited` (any exit code, including failures) or `lost`. `lost` means the job stopped without recording an exit code: the VM restarted, or it was killed outside boxery. Closing or killing the job's tmux session doesn't stop it; use `kill`.
- **Left-over processes:** a job can exit while something it started keeps running (`server & tests`). It then shows as `exited+` in `boxery jobs` (`"leftover": true` in JSON); `kill` stops those processes, and `--prune` keeps the job until they're gone.
- **`wait`** exits with the job's exit code, `124` if `--timeout` passes first (the job keeps running) and `125` if the job is `lost`. Without `--timeout` it waits as long as the job runs. If the connection drops while waiting, it reconnects (within `--timeout`); a VM that can't be reached at all fails at once. boxery's own errors exit `1`, `2` (usage) or `3` (unknown job). A job can exit with any of these codes too, so scripts that need to tell them apart should use `--json` and read `state`, `exit_code` and `timed_out`.
- **`logs`** shows the last 200 lines by default; `-f` follows until the job ends. `--strip-ansi` removes colours and other terminal escapes as they stream, including in newline-free progress output. `--bytes N` clips each read to its last N bytes before lines are selected, with a notice on stderr when it does. A cut can start partway through a line or UTF-8 character.
- **`kill`** signals the job's process group, including whatever it left running after it exited. Processes that start their own group (`setsid`, daemons) aren't part of it.
- **No ssh agent in jobs:** a forwarded agent ([`ssh-agent` grant](grants.md)) only lasts as long as the ssh session that started the job, so `git push` over ssh fails in a job. Use an [`http:`/`github` grant](grants.md) (HTTPS) instead.
- **Storage:** logs and records stay in `~/.boxery/jobs/` until pruned or the VM is reset, and a fork gets a copy. They may contain secrets the command printed.

How it works: the job logic lives in `core/boxery-jobs.ts`, which the controller pipes over ssh on every call and the VM's Node runs with built-in type stripping (Node ≥ 22.18; every boxery image has it). Each job is kept alive by a small bash runner, `core/boxery-job-runner.sh`, sent along with `start`. Nothing is installed in the VM, so it always runs your controller's version. Agents get the same through the `vm_jobs` tool ([MCP](mcp.md#background-jobs), [pi](pi-extension.md)).

### Desktop and ports

```bash
boxery desktop demo                          # XFCE desktop in your browser (noVNC over ssh)
boxery forward demo 3000                     # localhost:3000 → the VM's dev server   [LOCAL_PORT]
```

`desktop` forwards a free local port (from 16080) to the VM's noVNC and opens it in your browser (`--no-open` only prints the URL). The VM's VNC server asks for a password. Each `desktop` session sets a new random one over ssh and puts it in the URL's fragment (`vnc.html?…#password=…`), which the browser never sends to the server, so it stays out of logs. It does land in the browser's history. A new session replaces the previous session's password for new logins; a tab that is already connected stays connected. If that tab is disconnected later, it fails to log back in and you run `boxery desktop` again. With the tunnel open, other processes on your machine, and web pages, can reach the noVNC port, but without the password they can't use the desktop.

VMs made from a desktop base built before this change have **no** VNC password. Neither do snapshots or images of those VMs. `boxery desktop` warns when it opens one of them. To fix it, rebuild the base with `boxery build-base` (or `boxery-host build-base` on the host) and create the VMs again. Backends refuse to rebuild the base while VMs or snapshots still depend on it, so remove those first. An older controller can't log in to a VM from a new base: noVNC asks for a password it doesn't have. Update the controller too.

Editors: once the `Include` line `setup` prints is in your `~/.ssh/config` ([Install](install.md#laptop--controller)), connect VS Code, Cursor or Zed via Remote-SSH to `demo.boxery`.

### Grants

```bash
boxery grant demo llm:PROVIDER | http:HOST --cmd CMD | github | ssh-agent | env:VAR [--cmd CMD] | file:LOCAL[=REMOTE]
boxery revoke demo SPEC… | all
boxery grants demo [apply | --json]
```

Adding access prompts on `/dev/tty`, defaults to No, and fails without a controlling terminal; stdin (including `yes | …`) cannot approve. This includes `agent-forward NAME on`, `new --grant` / `--agent-forward`, and `fork --grants`. Creation-time grants are validated and approved before creating VMs. Listing, applying existing grants, revoking, and `agent-forward NAME off` never prompt. Both CLI and agent tools enforce the same deny directories. Grant commands and grant-enriched inventory (`ls`) require Node on the controller. A grant lookup failure makes `ls --json` fail without emitting partial/malformed JSON.

Headless automation can put the literal line `GRANT_CONFIRM=off` in the selected host profile's `config`. **It disables CLI grant confirmation protection for that profile.** It is not an environment variable or flag and does not auto-approve MCP/pi dialogs. Confirmation is not a boundary against a local agent that can fake a terminal or call internals. See [Grants](grants.md#confirmation).

### Shared pool

```bash
boxery acquire [--ttl S] [--wait S]          # prints "NAME LEASE_ID"
boxery renew NAME [--ttl S]
boxery release NAME                          # VM is reset to its clean snapshot
boxery leases [--json]                       # your leases
boxery pool add|rm|ls                        # admin
boxery runners once [--repo O/R | --org ORG] [--vms NAME,…] [--labels L,…] [--group ID]
                                             # local runner: one GitHub Actions job on a fresh pool VM, with your gh login
boxery runners status|start|stop|config|token   # admin: host runners, the always-on runner service
```

See [Shared pool & leases](pool.md) and [GitHub Actions runners](github-runners.md).

### Misc

```bash
boxery proxy-log [N]                         # which VM called which LLM provider
boxery version [--json]                      # controller + host versions; warns when the host is behind
boxery backend                               # the host's VM backend; recorded for host ls / vm_info hosts
boxery upgrade-host [--check] [--ref REF]    # update boxery on the host (see Install → Upgrading)
```

## `boxery-host` (the VM host)

```
init [--backend libvirt|lima|cloud-hypervisor|exe|boat]
                                install proxy, vsock bridge, reaper services + backend setup, symlinks
--profile NAME COMMAND...       run in profile NAME (~/.config/boxery-NAME): a second backend on this host.
                                --profile NAME init --backend B creates it with a free proxy port and its own services
profiles [--json]               every profile on this host: name, backend, proxyPort, proxyUnit, conf
version [--json]                this install's version, commit and kind (git | npm)
upgrade [--check] [--ref REF] [--wait S] [--reinit]
                                update this install, re-run init for each profile using it, check, roll back on failure
                                (code and each profile's state, from $BOXERY_CONF/pre-upgrade/, kept after success)
build-base                      build the golden desktop image (one time; headless VMs don't need it)
add-key < key.pub               authorize a controller's ssh key for new VMs
new NAME [--shape S] [--cpus N --mem MiB --disk GiB] [--from IMAGE] [--headless [--layers github-runner]]
fork SRC DST... [--shape S] [--cpus N --mem MiB --disk GiB]
shapes [--json]                 VM sizes: built-ins + ~/.config/boxery/shapes.json (see Shapes)
ls [--json] [--refresh] | ip NAME | start NAME | stop NAME | rm NAME
patch NAME|--all [--wait S]     update a VM's guest software to this host's image layers (see Lifecycle)
snap NAME [SNAP] | snaps NAME [--json] | snap-rm NAME SNAP | revert NAME SNAP | images [--json]
connect NAME [PORT]             stdio to a VM port (ssh ProxyCommand)
known-hosts NAME                NAME's pinned ssh host key as one known_hosts line (ssh KnownHostsCommand; empty if none)
pin NAME [--from-guest]         re-pin running NAME's ssh host key; prints its SHA256 fingerprint
proxy-log [N]

pool add NAME | rm NAME [--force] | ls [--json]
acquire --holder H [--ttl S] [--wait S] [--only NAME,…] [--json]   (lease ssh pubkey on stdin; --only: one of these VMs)
renew LEASE [--ttl S] [--json] | release LEASE | reap | reconcile

runners config [--repo OWNER/REPO | --org ORG] [--vms NAME,…] [--count N] [--labels L,…] [--group ID] [--ttl S] [--api URL] [--prefix P]
                                configure GitHub Actions runners (saved in runners.json; no flags: print it)
runners token < FILE            store the GitHub token (first line of stdin) in runners.env, 0600
runners start | stop            turn the runner manager service on or off
runners status [--json]         configuration, whether a token is set (never its value), the service, the leased runner VMs
runners run                     the runner manager in the foreground (what the service runs)
```

`runners` is described in [GitHub Actions runners](github-runners.md); `boxery runners …` on your machine passes the same arguments (and stdin, for `token`) to the host, except `runners once`, which runs on your machine with its `gh` login and drives the host's internal `runners __once`.

`acquire` prints `NAME LEASE_ID EXPIRES` and `renew` prints `NAME EXPIRES`; with `--json`, both print `{"name","lease_id","expires_at"}` (expiry in unix seconds). The controller and the runner manager use `--json`, and fall back to the line for a host that predates it.

`reconcile` (also performed by `reap`) recovers abandoned lifecycle operations and checks inventory drift. Conflicting VM mutations are serialized through readiness/key installation, not just disk operations. See [Lifecycle coordination and recovery](lifecycle.md) for crash behavior, backend responsibilities and upgrade precautions.

## JSON output

Every listing command takes `--json` and prints one JSON value on stdout. Errors go to stderr with a non-zero exit status; nothing else is printed on stdout. Field names below are stable: new fields may be added, existing ones are not renamed or removed without a major version bump.

Conventions:

- Timestamps are Unix epoch seconds (numbers). Durations are seconds.
- A field that is unknown or does not apply is `null`, never `""` or `"-"`.
- Arrays are printed one element per line. That is still ordinary JSON; parse it as a whole.
- Empty lists print `[]`.

The controller (`boxery`) needs no `jq`; it builds JSON with `printf`. The host (`boxery-host`) builds it in Node.

### Controller (`boxery`, on your laptop)

#### `boxery ls --json`

VMs on the host, plus the grants this machine has given each one.

```json
[
{"name":"demo","state":"running","ssh_addr":"192.168.122.50:22","disk_size":40,"disk_used":2.1,"tunnel":null,"lease":null,"shape":"standard","cpus":4,"mem":8192,"desktop":true,"os":"linux","grants":[{"kind":"ssh-agent"}]},
{"name":"pool-1","state":"running","ssh_addr":"192.168.122.51:22","disk_size":80,"disk_used":1.8,"tunnel":null,"lease":{"state":"leased","holder":"ben@mac","expires_at":1793462400},"shape":"large","cpus":8,"mem":16384,"desktop":false,"os":"linux","grants":[]}
]
```

| Field | Type | |
|---|---|---|
| `name` | string | VM name |
| `state` | string \| null | backend state: `running`, `shut off`, … (as reported by libvirt/Lima; `paused` on exe.dev; `starting`/`stopping` on boat.dev) |
| `ssh_addr` | string \| null | the VM's ssh endpoint as the host reaches it, always `HOST:PORT` (`192.168.122.50:22` on libvirt and cloud-hypervisor, `127.0.0.1:PORT` on Lima and the tunnelled backends). `null` while the VM isn't running (or its tunnel isn't `up`). Agents don't connect to it directly; `boxery` reaches VMs through the host |
| `disk_size` | number \| null | the disk's configured size in GiB (what `--disk` set, or the size it was grown to) |
| `disk_used` | number \| null | GiB the VM's own disk takes on the host (allocated blocks, two decimals; a shared base image is not counted). `null` where the backend can't know (exe.dev, boat.dev) |
| `tunnel` | string \| null | exe.dev and boat.dev only: the host's ssh tunnel to the VM, which carries its ssh endpoint and LLM proxy: `up`, `connecting` (retrying; is the host online?) or `down` (`boxery-host start NAME`). `null` on other backends. A running VM shows `ssh_addr: null` while its tunnel isn't `up` |
| `lease` | object \| null | `null` for ordinary VMs; for pool VMs: `{state, holder, expires_at}`, `state` lowercase as in `pool ls` |
| `shape` | string \| null | shape the VM was created with; `custom` if size flags or `resize` changed it, or if it has no recorded size (made before shapes, or outside boxery: its size is read from the backend once and recorded); `null` only if the size can't be read |
| `cpus` | number \| null | vCPUs (`null` if unknown) |
| `mem` | number \| null | memory in MiB (`null` if unknown) |
| `desktop` | boolean | `false` for headless VMs (`new --headless`, or made from a headless VM's image); `true` otherwise, including VMs created before headless VMs existed |
| `os` | string | the guest OS: `linux` (the only one so far; VMs made before it was recorded are `linux` too). A VM made from an image or a fork has its source's |
| `guest` | object | the VM's guest software, from the host's build record (see [Outdated guest software](#lifecycle)): `status` (`current`, `outdated` or `unknown`), `reasons` (why: `layers changed`, `built N days ago`, `reboot required`, `no build record`, `not checked`), `built_at` (epoch seconds), `age_days`, `kernel` (the newest installed), `chrome` and `playwright_core` (desktops; `null` otherwise), `reboot_required`, `checked_at` (when the host last read it; `null` if never). Unknown fields are `null` |
| `grants` | array | this machine's grants for the VM, same objects as `grants --json` |

#### `boxery shapes --json`

VM sizes the host offers, after merging its `shapes.json` over the built-ins ([Shapes](shapes.md)).

```json
{"default":"standard","shapes":{"small":{"cpus":2,"mem":4096,"disk":20},"standard":{"cpus":4,"mem":8192,"disk":40},"large":{"cpus":8,"mem":16384,"disk":80}}}
```

| Field | Type | |
|---|---|---|
| `default` | string | shape used when `new` gets no `--shape` or size flags |
| `shapes` | object | shape name → `{cpus, mem (MiB), disk (GiB)}` |

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
| `llm` | `provider` (`chatgpt`, `openai`, `anthropic`, `ollama`) |
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

#### `boxery jobs NAME --json`

Background jobs in the VM (started by `run --bg` or `vm_jobs`), oldest first.

```json
[
{"id":"job-20261101-120000-a1b2c3","state":"exited","command":"pnpm test","argv":["pnpm","test"],"cwd":"/home/agent/project/app","started_at":1793460000,"ended_at":1793460371,"exit_code":1,"killed":false,"log":"/home/agent/.boxery/jobs/job-20261101-120000-a1b2c3.log"}
]
```

| Field | Type | |
|---|---|---|
| `id` | string | `job-` + the VM's local time + a random suffix. Scoped to the VM and host. |
| `state` | string | `running`, `exited` or `lost` |
| `command` | string | `argv` as a shell-quoted line, for display |
| `argv` | array | the arguments, exactly as given |
| `cwd` | string | absolute working directory |
| `started_at`, `ended_at` | number \| null | Unix epoch seconds. `ended_at` is `null` unless `exited`. |
| `exit_code` | number \| null | `null` unless `exited`. A signal shows as 128 + signal (143 = SIGTERM). |
| `killed` | boolean | stopped by `kill` |
| `leftover` | boolean | `exited`, but processes it started are still running (`kill` stops them) |
| `log` | string | log path in the VM |

`wait NAME JOB --json` prints one such object plus `timed_out` (boolean), whenever the VM answered (the exit status is as without `--json`). `kill NAME JOB --json` prints one object. `jobs NAME --prune --json` prints the removed IDs.

#### `boxery host ls --json`

Registered hosts, by name. Read from local profile files only: no host is contacted. The same fields as MCP `vm_info {action:"hosts"}` (which adds `current`).

```json
[
{"name":"hornet","dir":"/home/you/.boxery/profiles/hornet","default":false,"destination":"you@hornet","backend":"libvirt","same_as":[]},
{"name":"laptop","dir":"/home/you/.boxery/profiles/local","default":false,"destination":"local","backend":"lima","same_as":["local"]},
{"name":"local","dir":"/home/you/.boxery/profiles/local","default":true,"destination":"local","backend":"lima","same_as":["laptop"]}
]
```

| Field | Type | |
|---|---|---|
| `name` | string | host name for `--host` |
| `dir` | string | profile directory (`config`, `ssh_config`, grants, leases) |
| `default` | boolean | selected by `host use` (`default-host`; the first host registered starts as the default) |
| `destination` | string \| null | where its VM host runs: `local` (this machine) or the ssh destination (`user@host` or an ssh-config alias). `null` when not set up |
| `backend` | string \| null | `lima`, `libvirt`, `cloud-hypervisor`, `exe`, `boat`, … as recorded by `setup` or `boxery backend`; `null` if never recorded (an older profile: run `boxery --host NAME backend`; or a host that predates `boxery-host backend`) |
| `same_as` | string[] | other names whose profile is the same directory: the same host and VMs (e.g. a second name imported with `--config-dir` for an existing profile) |

#### `boxery snaps NAME --json`

Snapshots of a VM, passed through from `boxery-host snaps NAME --json`. `size` is `null` when the backend does not report it. `age_days` is days since it was taken; `guest` is the guest software it holds (its VM's build record when it was taken), the same object as in `ls --json` except that `reboot_required` is `null` (a VM made from an image boots fresh).

```json
[
{"name":"before-refactor","created":"2026-10-31T19:28:31","size":"173MiB","age_days":2,"guest":{"status":"current","reasons":[],"built_at":1793300000,"age_days":4,"kernel":"6.8.0-90-generic","chrome":"Google Chrome 141.0.7390.54","playwright_core":"1.57.0","reboot_required":null,"checked_at":1793460000}}
]
```

The text form is tab-separated: `NAME CREATED SIZE AGE GUEST` (`AGE` like `2d`).

### Host (`boxery-host`, on the VM host)

#### `boxery-host ls --json`

Same objects as `boxery ls --json` without `grants` (grants live on the controller): `name`, `state`, `ssh_addr`, `disk_size`, `disk_used`, `tunnel`, `lease`, `shape`, `cpus`, `mem`, `desktop`, `os`, `guest`. Built in one place from the backend's `backend_list` lines, the recorded VM sizes, the lease store and the build records (`--refresh`: read from running VMs first).

#### `boxery-host snaps NAME --json`

`[{"name", "created", "size", "age_days", "guest"}]`, from the backend's `backend_images` and the build records.

#### `boxery-host images --json`

`[{"image", "created", "size", "age_days", "guest"}]`: every image on the host (`VM@SNAP`), from the backend's `backend_images` and the build records; empty fields are `null`.

#### `boxery-host pool ls --json`

Every pool VM and its lease state.

```json
[
{"name":"pool-1","state":"leased","holder":"ben@mac","acquired_at":1793460600,"expires_at":1793462400,"expires_in":1800},
{"name":"pool-2","state":"free","holder":null,"acquired_at":null,"expires_at":null,"expires_in":null}
]
```

| Field | Type | |
|---|---|---|
| `state` | string | `free`, `acquiring`, `leased`, `resetting`, `broken` |
| `holder` | string \| null | who holds it |
| `acquired_at`, `expires_at` | number \| null | lease start / expiry |
| `expires_in` | number \| null | seconds left (only while `leased`; may be negative until the reaper runs) |

Run it on the host, or from the controller as `boxery pool ls --json`.

## Configuration

| Where | What |
|---|---|
| `~/.boxery/host-registry/HOST`, `~/.boxery/default-host` | Registered hosts and the default one ([Named hosts](hosts.md)) |
| `~/.boxery/profiles/HOST/config` | Controller: host, host binary path, identity |
| `~/.boxery/profiles/HOST/ssh_config` | Generated. `*.boxery` hosts via `ProxyCommand`. |
| `~/.boxery/profiles/HOST/grants/NAME` | Grant names and paths (never values) |
| `~/.boxery/profiles/HOST/leases/` | Your leases and their per-lease ssh keys |
| `~/.config/boxery/host.env` (host) | Backend and overrides (`BOXERY_BACKEND`, `BOXERY_LIMA_VMTYPE`, …) |
| `~/.config/boxery/proxy.env` (host) | Extra LLM provider keys (VMs still need an `llm:` grant to use them) |
| `~/.config/boxery/tokens.json` (host) | Per-VM proxy tokens (per lease on pool VMs) |
| `~/.config/boxery/leases.db` (host) | Lease state (SQLite) |
| `~/.config/boxery/build-info/` (host) | What each VM and image was built with (`NAME`, `NAME@SNAP`: JSON), for `ls`, `snaps` and `images` |
