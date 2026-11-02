# boxery architecture

This file describes the system **as built** (v0.7). Designs that aren't implemented are listed under [Roadmap](#roadmap) and live in [docs/plans/](docs/plans/). User-facing docs: [docs/](docs/README.md). Module-level detail: [host modules](docs/host-modules.md), [lifecycle and recovery](docs/lifecycle.md), [backend contract](host/backends/README.md).

## Goals

1. **Laptop agents drive VMs.** The agent (Claude Code, Codex, Cursor, pi, …) runs where it already runs, with its own model login. The VMs are its hands: shell, files, Chrome and a whole desktop. Agents running *inside* VMs are supported too, for delegation.
2. **Any host.** The same tools on a Mac (Lima), a Linux KVM box (libvirt, Cloud Hypervisor) or the cloud (exe.dev). One controller or MCP server can route to several hosts.
3. **Secrets go to as few places as possible.** LLM and HTTP API credentials stay on the control plane. VMs get revocable per-VM tokens. Images never carry RAM.
4. **Cheap, disposable state.** Snapshots, forks and pool resets are one disk-image primitive, fast enough to throw VMs away freely.
5. **Several agents can share a pool** with exclusive, expiring leases.

Non-goals (for now): macOS/Windows guests, GPU passthrough, scheduling across hosts, hostile multi-tenant users.

## Trust model

One trusted owner runs agents that are *semi-trusted*: they're yours, but they may be confused or prompt-injected. boxery limits what a VM, and the code running in it, can reach. It isn't a boundary between mutually distrustful people who share a host account. Detail: [docs/security.md](docs/security.md).

| Principal | Trusted with |
|---|---|
| Control plane (the host running `boxery-host` and `boxery-proxy`) | Everything: LLM credentials, HTTP grant secrets, every VM's token, the management ssh key |
| A laptop with ssh access to the host | Effectively the control plane (a full shell on it; see [#71](https://github.com/benvinegar/boxery/issues/71)) |
| An agent using `vm_*` tools | The VMs it can name on the hosts its controller is set up for. It can't create grants |
| Code inside a VM | Root in that VM, its own proxy token, and the grants given to that VM |

## System map

```
LAPTOP (or wherever the agent runs)
  Claude Code · Codex · Cursor ──stdio──► mcp/boxery-mcp.mjs ─┐
  pi ───────────────────────────────────► extension/index.ts ─┤ both built from core/boxery-tools.mjs
                                                              │ (one tool table: names, schemas, runners)
                                   core/boxery-core.mjs ◄─────┘ ssh transport, files, copy, computer use,
                                         │                      CDP browser, LeaseKeeper, host profiles
                                         ├─ ssh NAME.boxery (ControlMaster) ─────────────────────┐
                                         └─ runs controller/boxery (Bash 3.2) for lifecycle,     │
                                            grants, leases; it writes each host's ssh_config     │
                                                   │ ssh user@host  boxery-host …                │
CONTROL PLANE (Linux or macOS; may be the laptop itself)   │                                     │
  host/boxery-host (Bash entry) ─┬─ connect NAME ──► host/backend.sh __connect ──► nc VM 22 ◄────┘
                                 └─ everything else ──► host/boxery-host.mjs (Node ≥ 22.13)
        supervisor (holds resource locks) ──► __worker (own process group, fd-3 gate)
           vms.mjs · images.mjs · pool.mjs · seed.mjs · guest.mjs
             └─► host/backend.sh FUNCTION ARG… ──► host/backends/{libvirt,lima,cloud-hypervisor,exe}.sh
        state: ~/.config/boxery/  leases.db (SQLite) · tokens.json · edge/ · authorized_keys · mgmt key
        reaper (systemd timer / launchd agent, every minute): recovery + lease expiry
  proxy/boxery-proxy.mjs on 127.0.0.1:8088
        /chatgpt /openai /anthropic /ollama   allowlisted inference for VMs with an llm: grant; the real credential is injected
        /edge/<token>/<host>/…                HTTP grants; granted headers are injected
                     ▲ libvirt, CH: vsock · Lima: user-net gateway · exe: ssh -R tunnel
VM (Ubuntu 24.04; XFCE desktop unless --headless)
  user agent (passwordless sudo) · sshd · socat 127.0.0.1:8088 → proxy · tmux jobs
  desktop on :1, noVNC 127.0.0.1:6080 (VNC password), Chrome CDP 127.0.0.1:9222 · grants on tmpfs /run/user/UID/boxery
```

## Components

| Component | Runs on | Role |
|---|---|---|
| `core/boxery-tools.mjs` | agent machine (or host, for HTTP MCP) | **The `vm_*` tool table**: name, description, JSON Schema and runner for every tool, plus `vm_manage`/`vm_info`/`vm_lease` action logic (hosts included) over front-end session hooks, and `runTool()`, which resolves each call's host and VM. MCP and pi are both built from it and run tools through it, so they can't drift (`test/frontends.test.mjs`: a tool only one front-end has must say why). `test/parity.test.mjs` maps every tool and action to its `boxery` command (or why it has none) and every command back, so the CLI can't silently fall behind either |
| `core/boxery-core.mjs`, `core/copy-stream.mjs`, `core/atomic-edit.mjs`, `core/shell.mjs` | same | Transport and tool implementation: `sshRun`/`execRemote` (remote process-group kill on cancel), path mapping, read/write/edit (atomic, detects concurrent changes), streaming tar `vm_copy` (local⇄VM⇄VM, across hosts), computer use via xdotool, Playwright over CDP, `LeaseKeeper`, host-profile resolution with `AsyncLocalStorage` |
| `core/boxery-jobs.ts`, `core/boxery-job-runner.sh` | piped into the VM per call | Background jobs (`run --bg`, `jobs`, `logs`, `wait`, `kill`; `vm_jobs`). The helper is erasable TypeScript run by the VM's Node (type stripping, ≥ 22.18), never installed, so a VM always runs the caller's version; it answers in JSON. The runner is plain bash, sent with each start: it runs the command in its own process group, independent of tmux, and records the real exit code. |
| `mcp/boxery-mcp.mjs` | agent machine (stdio) or host (HTTP) | MCP server. stdio, or Streamable HTTP at `/mcp` (bearer token required, optional Tailscale user allowlist, Origin check; meant for `tailscale serve`, never funnel). Sessions keep their own host and VM. `vm_view` + `mcp/desktop-view.html` give MCP Apps clients a live desktop |
| `extension/index.ts` | agent machine | pi extension: explicit `vm_*` tools next to pi's built-ins (which stay local), `--vm NAME/new/pool`, `--vm-host`, `/vm` commands, throwaway VMs and leases tied to the pi session |
| `controller/boxery` | agent machine | Bash 3.2 CLI: `setup`, host profiles (`host add/use/…`), lifecycle, snapshots and forks, `ssh/run/attach/prompt/jobs`, `cp` (runs `vm_copy` through `controller/cp.mjs`), `desktop/forward`, grants, client-side lease files. Generates each host profile's `ssh_config`: `*.boxery` → `ProxyCommand ssh HOST boxery-host connect %h %p`, ControlMaster, per-lease identities, per-VM `ForwardAgent` |
| `host/boxery-host` + `host/*.mjs` | control plane | Backend-agnostic VM manager. Bash entry point; `connect` stays in Bash so the ProxyCommand never pays Node startup; everything else is Node. Ownership per module: [host-modules.md](docs/host-modules.md) |
| `host/backends/*.sh` | control plane | Hypervisor effects only, one allowlisted function per process, arguments as argv ([contract](host/backends/README.md)). libvirt and Lima are stable; Cloud Hypervisor and exe.dev are experimental |
| `proxy/boxery-proxy.mjs` | control plane | Credential proxy: checks the per-VM token, applies per-route method/path allowlists, body/concurrency/time limits, injects the real credential, refuses WebSocket upgrades (clients use SSE) |
| `image/layers/*.sh`, `image/base-user-data.yaml` | guest | What boxery adds to Ubuntu: `plumbing` (agent user, proxy bridge, sshd/sysctl/tmux), `devtools` (git from the git-core PPA, Node 24, pi, opencode, …), `desktop` (XFCE, TigerVNC/noVNC, Chrome, Playwright). Desktop VMs clone a base built once with all three; headless VMs apply the first two at first boot |

## Deployment shapes

| Shape | Agent + MCP | Control plane | VMs |
|---|---|---|---|
| Mac, all local | laptop (stdio) | the same laptop (`boxery setup local`) | Lima on the laptop |
| Laptop + KVM box | laptop (stdio) | Linux box over ssh (Tailscale recommended) | libvirt or Cloud Hypervisor on that box |
| Remote MCP | any MCP client over HTTPS | the host runs `boxery-mcp --http` behind `tailscale serve` | that host's backend |
| Cloud | laptop (stdio) | the laptop or any always-on box | exe.dev, reached through supervised ssh tunnels |
| Several hosts | one MCP server / controller | each registered with `boxery host add` | per host ([hosts.md](docs/hosts.md)) |

In HTTP mode "local" means the machine running MCP: grant values come from that server, and `vm_copy local:…` is refused unless `--copy-root DIR` confines it to one directory there ([MCP server](docs/mcp.md#b-streamable-http-on-the-host-over-tailscale)).

## How a tool call flows

- **File and shell tools** (`vm_bash`, `vm_read`, `vm_edit`, `vm_jobs`, computer use, `vm_browser`): core → `ssh -F PROFILE/ssh_config NAME.boxery 'bash -c …'`. The first connection runs the ProxyCommand (`ssh HOST boxery-host connect NAME` → `backend_ssh_endpoint` → `nc`); later calls reuse the ControlMaster. Node and the Bash controller aren't involved.
- **Lifecycle** (`vm_manage`, `vm_info`, `vm_lease`): core → `controller/boxery …` → `ssh HOST boxery-host COMMAND …` → Node supervisor → worker → backend functions and guest ssh. Output is `--json` where the front ends parse it ([cli.md](docs/cli.md)).
- **Inference from inside a VM**: pi/opencode → `127.0.0.1:8088` (socat) → vsock/TCP/tunnel → `boxery-proxy` → provider.

## State

| Where | What | Notes |
|---|---|---|
| `~/.boxery/` (controller) | `host-registry/`, `default-host`, and per host `profiles/NAME/`: `config`, `ssh_config`, `grants/` (names and paths only, never values), `leases/` (lease records + per-lease ssh keys), ControlMaster sockets | Per host profile; every host is registered by name |
| `~/.config/boxery/` (host) | `leases.db`: resource locks, operations and intent journal, pool leases | SQLite, short `BEGIN IMMEDIATE` transactions; schema version in `user_version` |
| | `host-keys/NAME` (each VM's pinned ssh host key, one known_hosts line) | Written with the seed, removed by `rm`; read by `boxery-host known-hosts` |
| | `tokens.json` (VM → proxy secret; a leased pool VM's carries its lease id), `edge/NAME.json` (HTTP grant headers, stamped with the lease on a pool VM), `proxy.env` (API keys) | `0600`; updated via temp file + rename |
| | `authorized_keys` (laptop keys for new VMs), `mgmt_ed25519` (host → every VM), `host.env`, `vm-kind/`, `work/OP/` (seeds, removed after the operation) | |
| | `pre-upgrade/`: `leases.db`, `tokens.json`, `edge/`, `vm-shapes/`, `vm-kind/` as they were before the last `upgrade` | Restored if the upgrade rolls back; kept for recovery by hand ([install](docs/install.md#upgrading)) |
| Hypervisor | VMs, images (`VM@LABEL`), seeds | Owned by the backend |
| Guest | `~/.boxery/token`, agent configs, `/run/user/UID/boxery/` (pushed grants, tmpfs) | Token rotates on every new VM and every lease; grants are gone on reset or reboot |

## Images: snapshots, forks and resets are one primitive

Every backend implements four operations: **capture** a VM's disk into an immutable image `VM@LABEL` (while it runs), **list** and **remove** images, boot a **new** VM from an image, and **reimage** a VM from an image while keeping its identity.

```
snap NAME L      = capture NAME → NAME@L                 revert NAME L  = reimage NAME ← NAME@L
fork SRC A B…    = capture SRC → SRC@fork-… → new A, B… from it (parallel) → drop the image
pool add NAME    = capture NAME → NAME@boxery-clean      lease reset    = reimage NAME ← NAME@boxery-clean
```

Images are **disk-only** (no RAM, so no captured in-memory secrets; processes restart) and **independent**: libvirt pulls image data into each new overlay (`blockpull --base`), so every disk is one overlay deep on the base however many generations of forks there are, and images can be deleted in any order. Lima clones are copy-on-write on APFS/btrfs, and exe.dev uses its own `cp`.

Measured on libvirt: new VM ~13 s; snapshot ~1 s on a running VM; revert ~9 s; fork into 2 ~17 s, into 3 with a 3 GiB working set ~23 s; lease reset ~9 s. Lima vz: headless `new` ~51 s without a base, snapshot ~10 s, fork ~20 s.

**Identity.** A VM made from an image starts with someone else's disk, so it gets a fresh identity. The backend gives it a new MAC, vsock CID, UUID and seed. The guest gets a new hostname, token, agent config and ssh host key, and per-instance `bootcmd` steps wipe `authorized_keys` and the machine-id before sshd starts, so a fork of a leased VM never accepts the lease key. The host then sets the keys again over ssh.

**Host keys** ([#70](https://github.com/benvinegar/boxery/issues/70)). `host/hostkeys.mjs`: every seed carries a new ed25519 host key made on the host. sshd presents only that key, and the public half is recorded in `host-keys/NAME`. All ssh to VMs uses `StrictHostKeyChecking yes` with `HostKeyAlias NAME.boxery`. The host's own ssh (`guest.mjs`, `backend.sh`) reads the record directly. A controller's generated `ssh_config` asks the host for it through `KnownHostsCommand boxery-host known-hosts %H`, so there's no local copy to go stale. An image carries its VM's key, so revert and resets keep the record. boat VMs pin the platform-reported key instead (`backend_platform_host_key`). A VM without a record is pinned only through a channel the guest network can't spoof: the hypervisor (`backend_host_key`, libvirt's guest agent) or a loopback endpoint. Otherwise `boxery pin NAME --from-guest` trusts it once.

## Lifecycle coordination and recovery

Every mutating command runs under a supervisor in the `boxery-host` process that received it. The supervisor takes per-VM resource locks in SQLite (no transaction spans a boot or a disk copy, so unrelated VMs make progress concurrently) and runs the work in a separate process group, which waits on an fd-3 gate until its identity is committed. Workers record **intents** before side effects and clear them once the work is complete. When a supervisor dies, a successor (the next conflicting command, `reconcile`, or the minute reaper) kills the abandoned group, waits for it to exit, and replays its intents: it finishes or rolls back creates, captures, forks, removals, reverts and resets. Inventory drift (VMs missing from the hypervisor, tokens or edge routes for VMs that no longer exist) is repaired, and unfamiliar VMs or images are left alone.

This covers process crashes, not power loss or a hostile administrator. Full contract: [docs/lifecycle.md](docs/lifecycle.md). Tests: `test/operations.test.mjs` kills real supervisors against the fake backend.

## Leases

The shared pool lets several agents share VMs without collisions ([pool.md](docs/pool.md)). The host is the only arbiter; laptops hold a lease, a time-limited claim stored on the host.

```
FREE ──acquire──▶ ACQUIRING ──▶ LEASED ──release / expiry / reboot──▶ RESETTING ──▶ FREE
                                                                          └──fail──▶ BROKEN
```

- **Claims** are SQLite transactions with a per-VM **generation** and a pool **epoch** (bumped when a VM leaves and rejoins the pool), so reaper, renew, release and reset races resolve to one winner, and a stale callback can't act on a newer lease.
- **TTL** from 60 s to 8 h (default 30 min). An expired lease can't be renewed. Deadlines are tied to the host's boot ID: after a reboot every lease is void and reset.
- **Keys.** Each lease gets a fresh ssh keypair. A pool VM's `authorized_keys` holds only the host key and the current holder's key. Release or expiry reimages the VM from `@boxery-clean`, which drops the key and anything the holder installed, and existing agent ssh sessions are ended.
- **Proxy tokens.** A pool VM has no valid proxy token while it is free. Acquire writes a new one into the guest (token file and agent configs) before the holder's key goes in, and binds it to the lease id in `tokens.json`. Reset revokes it first, before clearing grants or reimaging, so a token the holder copied stops working when the lease ends. Edge routes on a pool VM are stamped with the lease id; the proxy honours them only with that lease's token, and `edge-set --lease` refuses a holder whose lease has moved on.
- **Holders** are caller-chosen labels. The pi extension and MCP keep their leases with `LeaseKeeper`: renewed at a third of the TTL while the session is in use, released when the session ends (pi: whenever the lease stops being the current VM; MCP: stdin closes, HTTP `DELETE`, or a signal). An abandoned HTTP session stops renewing, and the reaper resets the VM.
- **Pets vs pool.** VMs made with `new` are pets and the reaper never touches them. `pool add` turns a pet into a pool VM; `pool rm` turns it back.

**What fencing is not:** it keeps cooperating clients apart. A laptop with ordinary ssh access to the host can use the host's management key to reach any VM, leased or not. Enforcing leases needs a restricted host gateway ([#71](https://github.com/benvinegar/boxery/issues/71), [plan](docs/plans/2026-11-01-profiles-and-lease-extensions.md#1-host-gateway-lease-enforcement)).

## Secrets

| Kind | Where it lives | How it gets there |
|---|---|---|
| LLM credentials | control plane only | `boxery-proxy`. A pet holds a per-VM token, minted at creation and revoked on `rm`; a pool VM holds one per lease. A VM can use only the providers it's granted (`boxery grant NAME llm:PROVIDER`, listed in `edge/NAME.json`; on a pool VM, bound to the lease). No grant, no LLM access |
| HTTP API tokens (GitHub, npm, …) | control plane, `edge/NAME.json` | `boxery grant NAME http:HOST --cmd …` / `github`. Values are resolved on the controller, pushed to the host, and injected per request at `/edge/`. The guest reaches them via git `insteadOf` and npm registry config. On a pool VM, bound to the lease. Cleared on `rm` and lease reset |
| `env:` / `file:` grants | VM tmpfs (`/run/user/UID/boxery`, files `0400`) | Pushed by the controller over ssh and reconciled on grant/revoke, new, start, revert, attach, ssh, and when pi selects the VM |
| ssh agent | the laptop | Per-VM `ForwardAgent` while connected |

Agents can list grants but never create them ([grants.md](docs/grants.md)).

**Honest exposure statement.** "tmpfs only" limits *accidental* persistence; it isn't a guarantee. An agent in a VM has root and can read, copy, log or send out any pushed value, and app logs, Docker layers, shell history and agent transcripts (`boxery prompt` logs) can capture values. Mitigations: guests run without swap, with `kernel.core_pattern=|/bin/false`; pushed files are `0400`; resets destroy the disk. The real control is **what** you grant: dev-scoped, rotatable credentials, and `http:` grants (whose values never enter the VM) wherever possible. Production secrets never go to VMs.

Per-VM proxy tokens are an acknowledged exception. They live in the VM's seed, disk and images, and are scoped to the proxy. A new token is minted for every new VM, forks included, and revoked on `rm`. A pool VM's token is minted per lease and revoked when the lease ends, so the clean image and any copy a holder made carry only dead tokens. A pet's token still lasts as long as the VM.

## Network

| Backend | Guest → proxy | Isolation today |
|---|---|---|
| libvirt | socat → vsock CID 2 → host `boxery-vsock.service` → `127.0.0.1:8088` | libvirt `default` NAT, with the nwfilter `boxery-guest-isolation` on every guest interface (in the domain XML, so it survives forks, reverts, resets and reboots): no MAC/IP/ARP spoofing (DHCP-snooped address), only DHCP/DNS to the host, private ranges dropped (host, other guests, LAN, Tailscale, metadata), IPv6 dropped. `BOXERY_NET_ISOLATION=off` turns it off |
| Cloud Hypervisor | vsock, as libvirt | One routed TAP per VM; nftables drops guest→host, guest→guest, spoofed sources and private ranges |
| Lima | TCP to the user-net gateway `192.168.5.2`, which maps to the **host's loopback** | Lima's user network. On macOS each instance runs under a Seatbelt profile (`sandbox-exec`): on the host's `127.0.0.1` its guest reaches only the proxy and its own ssh port. Services on the Mac's other addresses, and the LAN, stay reachable; Lima on Linux is unconfined ([#67](https://github.com/benvinegar/boxery/issues/67)) |
| exe.dev | per-VM `ssh -R 127.0.0.1:18088:127.0.0.1:PORT` tunnel from the host | exe.dev's network; only the proxy port is forwarded back |

Inside the VM, everything listens on localhost (noVNC, CDP, the proxy bridge). The desktop is reached only through an ssh tunnel (`boxery desktop`), and its VNC server needs a password: random, on tmpfs, new for each `boxery desktop` session, handed to noVNC in the URL fragment ([security](docs/security.md#what-a-vm-can-and-cant-reach)). Desktop VMs from a base built before that have none until the base is rebuilt. Every ssh to a VM checks its pinned host key (below). A default-deny egress mode is proposed in [#4](https://github.com/benvinegar/boxery/issues/4).

## Failure modes

| Failure | Handling |
|---|---|
| Laptop sleeps / agent crashes | The lease stops renewing and expires; the reaper resets the VM |
| Two agents acquire at the same time | SQLite claim transaction; one wins, the other gets the next free VM or waits |
| `boxery-host` killed mid-operation | Its worker group is killed and its intents replayed by the next conflicting command, `reconcile` or the reaper |
| Reset fails / VM unhealthy after reset | Marked `BROKEN`, excluded from claims, shown in `pool ls`; repaired by `pool rm` + `pool add` |
| Host reboot | Leases are void (boot ID) and reset; pets keep running if the backend autostarts them |
| VM deleted outside boxery | Inventory drift check: pool VM → `BROKEN`, token and edge routes revoked |
| Stale ControlMaster after revert/stop/rm | The controller drops the master on lifecycle commands (only on the laptop that ran them) |
| Guest clock frozen after revert | The host steps the guest clock over ssh (best effort) |
| `build-base` while VMs depend on the base | libvirt refuses; versioned templates are planned |

## Capacity and scale

boxery is one control plane per host, and scale is bounded by the hypervisor: CPU, RAM and disk. For example, a 32-core / 125 GB host fits about 10 warm 8 GB app VMs with room left for the host. Overlays start at about 150 MB and grow with use. On libvirt, space the guest frees is returned to the host (discard), so it isn't copied into snapshots and forks either.

Nothing in boxery's own state limits that: lock transactions are short, the proxy reads `tokens.json` per request, and each tool call reuses a ControlMaster. The cost to watch is per-call latency on lifecycle commands, which cross Node → Bash controller → ssh → Bash → Node ([#74](https://github.com/benvinegar/boxery/issues/74)). Named hosts route calls to hosts you pick; nothing schedules VMs across hosts.

## Roadmap

1. **Hardening** of what exists: Lima on Linux and Lima guests' reach to the Mac's non-loopback addresses ([#67](https://github.com/benvinegar/boxery/issues/67)), confining HTTP-MCP `local:` copies ([#68](https://github.com/benvinegar/boxery/issues/68)), proxy header and token hardening ([#73](https://github.com/benvinegar/boxery/issues/73)), HTTP MCP bounds and argument validation ([#21](https://github.com/benvinegar/boxery/issues/21), [#72](https://github.com/benvinegar/boxery/issues/72)), scoped MCP tokens ([#3](https://github.com/benvinegar/boxery/issues/3)), default-deny egress ([#4](https://github.com/benvinegar/boxery/issues/4)), per-VM proxy budgets.
2. **Lease enforcement:** the restricted host gateway and authenticated holders ([#71](https://github.com/benvinegar/boxery/issues/71)). First decide the pool's shape ([#75](https://github.com/benvinegar/boxery/issues/75)).
3. **Profiles** (app-agnostic setup on top of images), `--keep`, detach/resume semantics for pi, versioned templates, builder VMs for build-time tokens: [plan](docs/plans/2026-11-01-profiles-and-lease-extensions.md).
4. **Simplification:** move the controller into Node ([#74](https://github.com/benvinegar/boxery/issues/74)), align the Node requirement ([#77](https://github.com/benvinegar/boxery/issues/77)).
5. **Backends:** exe.dev polish ([#37](https://github.com/benvinegar/boxery/issues/37)–[#42](https://github.com/benvinegar/boxery/issues/42), [#54](https://github.com/benvinegar/boxery/issues/54)), boat.dev ([#60](https://github.com/benvinegar/boxery/issues/60)), Daytona ([#61](https://github.com/benvinegar/boxery/issues/61)).
6. **Tests** that need real hypervisors: guest→host and cross-VM isolation (checked by hand on libvirt, [#69](https://github.com/benvinegar/boxery/issues/69); not automated), expiry under laptop sleep, secret retention after reset, a run from a real Mac.

## Design decisions

- **Explicit `vm_*` tools, not overridden built-ins.** An earlier pi extension replaced `bash`/`read`/`write`/`edit` so they ran in the VM. That conflicted with other extensions that register those tools, and it couldn't redirect what other extensions do locally anyway. Built-ins stay local now, and "project work goes to the VM" is guidance in the system prompt, not enforcement.
- **Images instead of hypervisor snapshots.** libvirt internal snapshots paused the guest, could capture RAM with secrets, and didn't exist on Lima vz. Disk images map onto every platform (qcow2 overlays, APFS clones, exe.dev `cp`, ZFS/reflink). Pre-image internal snapshots remain usable as "legacy" snapshots.
- **SQLite, not lock files.** Leases, resource locks and the intent journal share one store with short transactions. A crash leaves a row that recovery can finish or roll back ([#17](https://github.com/benvinegar/boxery/issues/17)).
- **Host in Node, backends in Bash.** Policy, locking and recovery moved to Node modules with injected dependencies so they can be tested directly ([#18](https://github.com/benvinegar/boxery/issues/18), [plan](docs/plans/2026-11-01-host-orchestration-in-node.md)). Backends stay small Bash files around hypervisor CLIs.
- **Unsigned fake JWT as the Codex token.** The Codex client derives an account id from a JWT, so a VM gets an `alg: none` JWT whose payload carries `name:secret`. The proxy never treats it as a signed credential.

## Review log

- 2026-10-31: independent review (pi subagent, read-only), [docs/reviews/2026-10-31-architecture-review.md](docs/reviews/2026-10-31-architecture-review.md). All 13 findings accepted. Since fixed: proxy allowlist and limits, proxy crash on malformed tokens, SQLite leases with generations and boot-ID fencing, per-lease keys, `build-base` refusing to overwrite a base in use, honest secret-exposure text. Still open: host gateway (#71), default-deny egress (#4), versioned templates, builder VMs.
- 2026-11-01: architecture review (Claude Code). Findings filed as [#67](https://github.com/benvinegar/boxery/issues/67)–[#78](https://github.com/benvinegar/boxery/issues/78). This file rewritten to describe only the built system ([#22](https://github.com/benvinegar/boxery/issues/22)).
