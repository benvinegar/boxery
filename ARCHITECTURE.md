# boxery architecture

Status: **built**: VMs, credential proxy, controller CLI, pi extension, MCP server, grants, and the shared pool with leases (see [docs/pool.md](docs/pool.md)). Profiles and the rest of "Planned" are design only, and some of the lease design below (gateway key, `--keep`, profiles) is not implemented yet. User-facing docs: [docs/](docs/README.md).

## Goals

1. Run many full Linux desktop VMs on one Linux host, controlled from laptops (macOS first, Linux too).
2. **Laptop agents drive the VMs.** The agent (pi, opencode) runs on the laptop with the laptop's credentials, and the VMs are its hands: shell, files, desktop. Agents running *inside* VMs are also supported, for delegation.
3. **Several laptop agents share one pool safely.** No two agents touch the same VM unless they mean to.
4. **App-agnostic.** Any app or setup (modem, a Rails app, a notebook repo, a plain desktop) is described by a *profile*. Expensive setup happens once, and VMs are reused and reset in seconds.
5. **Secrets go to as few places as possible.** No long-lived credentials inside VM images or snapshots.

Non-goals (for now): macOS/Windows guests, GPU passthrough, multi-host clustering, untrusted multi-tenant users.

## Big picture

```
┌──────────────── LAPTOP(S) ────────────────┐
│  pi / opencode  (the brain, laptop creds) │
│   + boxery pi extension (planned)        │
│      acquire / renew / release lease      │
│      route read/write/edit/bash into VM   │
│      vm_run / vm_prompt / vm_screenshot   │
│   boxery CLI (bash 3.2 + ssh)            │
│   browser (noVNC desktop)                 │
└───────────────┬───────────────────────────┘
                │ ssh (Tailscale recommended)
┌───────────────▼──────────────────────────────────────────────────────────┐
│ LINUX HOST                                                               │
│                                                                          │
│  boxery-host  ── sole authority: VMs, templates, pools, leases          │
│     state: ~/.config/boxery/{tokens.json, leases/, profiles/}           │
│                                                                          │
│  libvirt/KVM                                                             │
│   base image ─► profile templates ─► warm pool VMs (qcow2 overlays)      │
│                                                                          │
│   ┌──────────── VM ─────────────┐                                        │
│   │ Ubuntu 24.04 + XFCE         │                                        │
│   │ sshd (agent user)           │◄── ssh (ProxyCommand via host)         │
│   │ TigerVNC+noVNC @127.0.0.1   │◄── ssh -L (desktop)                    │
│   │ tmux: in-VM agents/app      │                                        │
│   │ socat 127.0.0.1:8088 ─vsock─┼──► boxery-proxy (per-VM token check,  │
│   └─────────────────────────────┘      swaps in real LLM creds)          │
└──────────────────────────────────────────────────────────────────────────┘
```

## Components

### Built (v0)

| Component | Where | What |
|---|---|---|
| `controller/boxery` | laptop | bash 3.2 CLI: `setup`, `new/ls/rm/start/stop`, `fork`, `snap/snaps/revert/snap-rm/images`, `ssh/run/attach/prompt/sessions`, `desktop/forward`, `proxy-log`. Writes `~/.boxery/ssh_config` (`*.boxery` → `ProxyCommand ssh host boxery-host connect %h %p`, ControlMaster). |
| `host/boxery-host` | host | backend-agnostic VM manager: `init`, `build-base`, `add-key`, VM lifecycle, **images** (snapshots, forks, pool clean state), leases, `connect` (nc to VM:22). Per-VM cloud-init seed (keys, token, agent configs, per-instance identity reset). |
| `image/layers/*.sh` | guest | boxery's additions to the starting image, in three layers: plumbing (agent user, LLM proxy bridge, sshd/sysctl/cloud-init/tmux config), devtools (git, build tools, Node 22, pi, opencode, ripgrep), desktop (XFCE, TigerVNC, noVNC, Firefox, Chrome, playwright-core). Headless VMs get the first two at first boot. |
| `image/base-user-data.yaml` | host | Golden desktop image build: the three layers, then clone preparation. |
| `proxy/boxery-proxy.mjs` | host | LLM proxy on 127.0.0.1:8088, also exposed on vsock:8088. Routes `/chatgpt` (Codex OAuth from host `~/.pi/agent/auth.json`, auto-refresh), `/openai`, `/anthropic`, `/ollama`. Per-VM bearer token. Refuses WebSocket, so clients use SSE. |
| `e2e.sh` | laptop | 10 checks: create, services, proxy, isolation, pi, opencode, background task, desktop tunnel, snapshot/revert, rm. ~34 s. |

Measured (libvirt): new VM ~13 s; snapshot (capture) ~1 s on a running VM; revert ~9 s; fork of a running VM into 2 ~17 s, into 3 with a 3 GiB working set ~23 s; lease reset ~9 s.

#### Images: snapshots, forks and resets are one primitive

Every backend implements four operations (`host/backends/README.md`): **capture** a VM's disk into an immutable image `VM@LABEL` (while it runs), **list** and **remove** images, boot a **new** VM from an image, and **reimage** a VM from an image (keeping its identity). On top of that:

```
snap NAME L      = capture NAME → NAME@L                 revert NAME L  = reimage NAME ← NAME@L
fork SRC A B…    = capture SRC → SRC@fork-… → new A, B… from it (parallel) → drop the image
pool add NAME    = capture NAME → NAME@boxery-clean      lease reset    = reimage NAME ← NAME@boxery-clean
```

Images are disk-only (no RAM: no captured secrets, processes restart) and independent: libvirt pulls image data into each new overlay (`blockpull --base`), so every disk is one overlay deep on the base, however many generations of forks; images can be deleted in any order. A VM from an image gets a fresh identity: new MAC/CID/seed from the backend, and in the guest a per-instance `bootcmd` that wipes `authorized_keys` and machine-id before sshd starts (a fork of a leased VM never accepts the lease key), DHCP keyed by MAC, and new hostname, token and agent config. This replaced libvirt internal snapshots (which paused the guest, could capture RAM with secrets, and didn't exist on Lima vz) and maps directly onto platforms like exe.dev (`cp`) or ZFS/reflink. Pre-image internal snapshots stay usable as "legacy" snapshots.

| `core/boxery-core.mjs` | laptop/host | Shared, dependency-free implementation: ssh transport (`sshRun`, `execRemote` with remote process-group kill), path mapping, file/shell tools, `vm_copy`, computer use, browser (CDP), lifecycle helpers, `LeaseKeeper` (a session's pool leases: heartbeat renewal, release on session end), model guidance text. |
| `core/boxery-tools.mjs` | laptop/host | **The `vm_*` tool table**: name, description, JSON Schema and runner for every tool, plus `vm_manage`'s and `vm_lease`'s action logic over front-end session hooks. The MCP server and the pi extension are both built from it, so their tool surfaces cannot drift (`test/extension.test.mjs` checks pi against it). |
| `mcp/boxery-mcp.mjs` | laptop (stdio) or host (HTTP) | **MCP server (v0.5):** the same 13 `vm_*` tools as the pi extension (including `vm_jobs`, detached command jobs) for any MCP client. stdio (newline-delimited JSON-RPC, concurrent requests, cancellation) or Streamable HTTP at `/mcp` (POST JSON responses, `Mcp-Session-Id` sessions with their own current VM, bearer token required, optional Tailscale user allowlist via `Tailscale-User-Login`, Origin check). Exposed through `tailscale serve`, never funnel. |
| `mcp/desktop-view.html` | the MCP client (sandboxed iframe) | Live desktop view for MCP Apps clients, served as `ui://boxery/desktop` and rendered by `vm_view`. Polls `vm_view_frame` and sends input through `vm_click`/`vm_type`/`vm_key`/`vm_scroll` via the client; no network access of its own. |
| `extension/index.ts` | laptop | **pi extension (v0.5, on the shared core):** `--vm` applies at startup only; throwaway VMs are removed when their session ends (quit, /new, /resume, fork). **v0.3 design:** explicit `vm_bash/vm_read/vm_write/vm_edit` (pi's built-in tool engines with ssh-backed operations: same truncation, edit semantics and image handling), `vm_jobs` (detached tmux jobs), `vm_copy` (tar over ssh, local⇄VM⇄VM), computer use (`vm_screenshot` downscaled to 1280px with clicks scaled back, `vm_click/type/key/scroll` via xdotool on :1), `vm_browser` (Playwright `connectOverCDP` to Chrome on the desktop), `vm_manage`. Optional `vm` on every tool; current VM via `--vm`/`/vm use`, saved in the session. **Built-in tools are not overridden**: they stay local, so extensions that wrap them (e.g. a custom `bash`) don't conflict, and extensions that act on the local machine stay correct. VM-vs-local is explicit in tool names and the system prompt (guidance, not enforcement). |

### Named controller profiles

The controller also supports `host add/ls/show/use/rm` and leading `--host NAME`. The registry is under BOXERY_HOME: `host-registry/NAME` is a one-line absolute profile-directory pointer; `default-host` is the separately selected alias. Managed profiles live under `profiles/NAME`; the original root config is the reserved `legacy` profile. Imports are references, not copies of credentials. Forgetting a registration does not destroy remote state or revoke grants.

Core resolves a host to an immutable profile context and scopes calls with AsyncLocalStorage, routing SSH config and controller subprocess environments without process.env mutation. MCP sessions own a host+VM pair and snapshot it for each call; copies bind each endpoint separately. Default-host routing also applies to the existing pi extension, including desktop tunnels. Lease records, per-lease SSH keys and HTTP-grant edge markers stay within the selected profile. The pi extension's existing lease lifecycle uses its pinned host; MCP does not acquire leases. This is explicit multi-host routing, not multi-host clustering. Contract and migration: [docs/hosts.md](docs/hosts.md).

### Planned

#### 1. Leases (multi-laptop coordination)

The host is the only arbiter. Laptops never hold a lock; they hold a **lease**, a time-limited claim stored on the host.

State lives in **SQLite** (`~/.config/boxery/state.db`, WAL mode), not JSON files. Every mutation is a transaction with a **generation counter** per VM: an operation records its intent (e.g. `ACQUIRING gen=7`) *before* side effects and commits its result only if the generation is unchanged. So reaper/renew/release/reset races resolve to one winner, and a crash mid-operation leaves a row the reconciler can finish or roll back. On startup (and every reaper tick) a reconciler compares the DB with libvirt and storage and repairs drift (orphan volumes, VMs missing from the DB, VMs listed in the DB but missing in libvirt).

```
lease = { vm, profile, holder: "<laptop-host>/<pi-session-id>", lease_id: <random>,
          acquired_at, expires_at, keep: bool }
```

- `boxery acquire --profile P [--holder H] [--ttl 30m] [--wait 2m]` → `{vm, lease_id}`.
  Runs under `flock ~/.config/boxery/leases.lock`: pick the oldest FREE VM in P's pool, otherwise clone a new one if under `pool.max`, otherwise wait or fail.
- `boxery renew LEASE_ID` (heartbeat from the extension, about every ttl/3). An expired lease cannot be renewed. TTL is bounded (default 30m, max 8h). Deadlines use the host's monotonic clock and boot ID; after a host reboot every lease is treated as expired (conservative fencing).
- `boxery release LEASE_ID [--keep]`: default **reset** (reimage from the VM's `clean` image, back to FREE). `--keep` parks the VM, still dirty, under the holder's name so they can re-acquire it by name later.
- **Reaper** (systemd timer, about 1 min): expired lease → reset → FREE. Laptop sleep or a pi crash never strands a VM.
- **Guard, enforced at the host gateway, not by the client.** Laptops' keys get a **restricted** `authorized_keys` entry on the host (`command="boxery-host gateway",restrict,port-forwarding`), so a laptop can't bypass boxery-host. The gateway checks the lease on every `connect`/`run`/`snap`/`revert`/`rm`. Admin access uses a separate, unrestricted key.
- **Fencing on reassignment**: before a VM is reset or handed to a new holder, the host (a) rotates the VM's `agent` authorized_keys to a fresh **per-lease ssh keypair** (sent to the holder at acquire time), (b) kills guest sshd sessions (`loginctl terminate-user agent`), and (c) closes the host-side `connect` processes for that VM. Old ControlMasters and tunnels then die and cannot reconnect.
- **Pets vs pool**: a VM is either a *pool* VM (leased) or a *pet* (created by `new`, owned by an authenticated holder identity = the key's comment/fingerprint, not a caller-chosen string). The reaper never touches pets.
- **KEPT** VMs count against a per-holder quota (default 2) and expire after a retention window (default 7d). They're treated as secret-bearing, so their RAM state is discarded (shut down) when parked.
- States: `building → FREE ⇄ LEASED → (RESETTING) → FREE`; `LEASED → KEPT`; any → `BROKEN` (failed health or reset; excluded from the pool; reaped and rebuilt).

#### 2. Profiles (app-agnostic setup)

One directory per profile on the host: `profiles/<name>/profile.toml` plus scripts.

```toml
base    = "ubuntu-desktop"        # or another profile, so templates stack
cpus    = 4
memory  = "8G"
disk    = "60G"
pool    = { min = 2, max = 6 }
repo    = "git@github.com:org/app.git"
build   = "build.sh"              # slow, once per template. Host-side secrets allowed (registry tokens)
freshen = "freshen.sh"            # on acquire: checkout $BRANCH, install deps, migrate. Seconds
start   = "start.sh"              # on acquire, after secrets: launch dev server(s) in tmux
health  = "http://127.0.0.1:3000" # or tcp:port or a command
secrets = [".env"]                # pushed from the laptop on acquire (see Secrets)
snapshot = "cold"                 # "cold" (default: shut down, disk-only overlay) | "memory" (opt-in, per tested profile)
```

Lifecycle:

```
base image ──build.sh──► template "P" (shut down; read-only backing file)
template ──overlay──► pool VM ──boot, health──► snapshot "clean" ──► FREE
acquire: revert clean (if dirty) → freshen → push secrets → start → health → LEASED
release: revert clean → FREE
template rebuild: nightly, or when the profile's inputs hash changes; old pool VMs drain as leases end
```

Rule: **the `clean` snapshot never contains secrets.** Everything that needs secrets (the running app) starts after acquire.

**Templates are immutable and versioned** (`tpl-<profile>-<n>.qcow2`, plus a hash of the profile's inputs). A rebuild publishes a new version; existing overlays and snapshots keep pointing at the old file, which is only deleted once nothing in the backing chain references it. (v0's `build-base` now refuses to overwrite a base that VMs depend on.)

**Snapshot contract.** Default `cold`: the clean state is a powered-off disk overlay. Reset = destroy + recreate the overlay from the template version (~boot time, ~10–15 s), which is simple and always consistent. `memory` mode (internal qcow2 snapshot including RAM) is opt-in per profile after testing: on restore, the host steps the clock, restarts profile-declared services that hold external connections (`restart_on_restore = [...]`), then runs `health`. All of a VM's disks live in one qcow2, including Docker's `/var/lib/docker`, so snapshots stay consistent.

Example profiles: `plain` (just the desktop), `modem` (Docker, Node 24, pnpm, compose Postgres built from `docker/postgres`, migrated and seeded `modem_dev` + `modem_test`; start = `pnpm dev:dashboard`).

#### 3. Secrets: v0 built as **grants** (see README)

`boxery grant NAME ssh-agent | env:VAR [--cmd CMD] | file:LOCAL[=REMOTE]`. The controller stores names and paths only; values are read at apply time and pushed into the VM's `/run/user/<uid>/boxery` tmpfs, then reconciled on every apply (grant/revoke, new, start, revert, attach, ssh, pi selecting the VM). ssh-agent = per-VM `ForwardAgent`. This implements the "laptop pushes on acquire" row below for env vars and files. `http:HOST` / `github` grants (#2, plan in `docs/plans/2026-10-31-edge-grants.md`) generalize the LLM proxy: values are resolved on the controller and pushed to the host proxy, never into the VM; the guest reaches `127.0.0.1:8088/edge/<vm-token>/<host>/…` via git `insteadOf` / npm registry config. Still planned: leases calling it on acquire, the host-side 1Password fallback, and per-grant approval prompts.



| Kind | Where it lives | How it gets there |
|---|---|---|
| LLM credentials | host only | proxy; VMs hold a per-VM token (revoked on rm) |
| HTTP API tokens (GitHub, npm, …) | host proxy route file, per VM | `boxery grant VM http:HOST --cmd …` / `github`; injected per request at the edge; cleared on rm and lease reset |
| Build-time tokens (npm registry, container registry) | the build VM only, while it runs | the host injects short-lived/scoped tokens into a throwaway **builder** VM; the template is produced from a fresh export, not the builder's disk; build logs are not shell-traced. Prefer token-free paths (e.g. build the Postgres image from source) |
| App runtime secrets (`.env`) | VM tmpfs during a lease (best effort) | laptop pushes over ssh to `/run/user/<uid>/boxery/secrets/`; symlinked into the repo; gone on reset |
| Fallback (no laptop, e.g. cron jobs) | host | host fetches from 1Password (`op`, service account) and pushes the same way |

Snapshots taken while leased default to **disk-only**, so in-RAM secrets aren't captured.

**Honest exposure statement.** "tmpfs only" limits *accidental* persistence; it is not a guarantee. A leased VM's agent has root and can read, copy, log or exfiltrate any runtime secret, and app logs, Docker layers, shell history, agent transcripts (`cmd_prompt` logs) and core dumps can capture values. Mitigations: guest swap disabled and `kernel.core_pattern=|/bin/false` in the base image; pushed files are `0400`; resets destroy the overlay. The real control is **what** gets pushed: dev-only, scoped, rotatable credentials. Production secrets never go to VMs.

Per-VM proxy tokens are an acknowledged exception: they live in the VM's seed ISO, disk and snapshots, are scoped to the proxy, and are rotated on every reset (new token, old one revoked).

#### 4. pi extension (`boxery`): v0.3 built (explicit vm_* tools); leases/secrets integration planned

Design decision (v0.3): v0.2 *replaced* the built-in tools so they ran in the VM. It conflicted with other extensions that also register `bash` (pi allows one owner per tool name), and it couldn't redirect what other extensions do on the laptop anyway. v0.3 adds explicit `vm_*` tools and leaves the built-ins local. Trade-off: "project work goes to the VM" is guidance in the system prompt, not a guarantee. A future `--vm-strict` could hide the local mutating tools while a VM is current.

- `session_start` (opt-in flag `--vm <profile>` or `/vm acquire <profile>`): acquire a lease, push secrets from the laptop's cwd, swap built-in tools to ssh-backed operations (like `examples/extensions/ssh.ts`, using `~/.boxery/ssh_config`), show the VM in the footer.
- Heartbeat timer to renew. `session_shutdown` releases. `/vm release [--keep]`, `/vm local`, `/vm use <name>`.
- *(v0.2 design, superseded by explicit vm_* tools)* **Fail closed.** Routing covers every execution path: read/write/edit/bash, find/grep/ls, `!` user shell commands, and any extension that shells out. If the lease is lost or the VM is unreachable, tools **error**; they never silently run on the laptop. Paths are mapped explicitly (laptop cwd ↔ `/home/agent/project`). File transfer uses base64 over the ssh channel, not shell-interpolated strings.
- Tools: `vm_acquire`, `vm_release`, `vm_run`, `vm_prompt` (delegate to an in-VM pi; collect the log), `vm_screenshot` (`import -window root` on `DISPLAY=:1` → image result), `vm_desktop_url`.
- **Session-aware, with explicit semantics**: `session_shutdown` on reload or session switch = **detach** (lease kept, heartbeat paused, normal expiry). `/vm release` = **reset**. `/vm release --keep` = **park**. The session stores `{vm_uuid, template_version, lease_id, intent}`. On `/resume`, the host revalidates ownership and state, and if the workspace is gone the user is told and must explicitly acquire a fresh one. Forks don't inherit a lease (they start detached).

## Security model

- Trust boundary: VMs are **semi-trusted** (your own agents). The goal is limiting blast radius, not hostile multi-tenancy.
- VMs: own kernel (KVM), user `agent` with passwordless sudo inside the VM. No host credentials on disk. The proxy token is per VM and revocable.
- Network (v0): libvirt `default` NAT. VMs can reach the internet, the host's sshd and **any other host/LAN/Tailscale service the host can route to, plus other guests on the same bridge**. They cannot reach the proxy over IP; that path is vsock only. **Planned, before pooling:** a dedicated `boxery` network with nwfilter (`clean-traffic` anti-spoofing; drop guest→host except DHCP/DNS; drop guest→guest; drop RFC1918/CGNAT/Tailscale ranges; optional per-profile egress allowlist).
- Proxy scope: **allowlist** inference endpoints only (`POST …/responses`, `/v1/chat/completions`, `/v1/messages`, `GET /v1/models`); reject Ollama admin (`/api/pull`, `/api/delete`, …) and other account APIs. Bound body size, concurrency per VM, request duration, and daily spend per token. Respect stream backpressure. (v0 fix: malformed tokens no longer crash the proxy.)
- Residual: KVM/virtio device attack surface, vsock to host (only the proxy port listens), and DoS by resource exhaustion (mitigate with per-VM cgroup limits on CPU/IO).
- Desktop: VNC without a password, bound to the VM's localhost. Reachable only through an ssh tunnel.
- Laptops: authenticated by ssh keys on the host. `add-key` is for VMs created afterwards.

## Failure modes

| Failure | Handling |
|---|---|
| Laptop sleeps / pi crashes | lease expires → reaper resets the VM |
| Two agents acquire at the same time | `flock` around lease mutations |
| Reset fails / VM unhealthy | mark BROKEN, exclude from the pool, rebuild in the background |
| Stale ControlMaster after revert/stop | controller drops the master on lifecycle commands (done) |
| Guest clock frozen after revert | host steps the guest clock over ssh (done) |
| Host reboot | VMs autostart; leases persist on disk and expire normally |
| Template drift (lockfile/migrations) | `freshen` handles small drift; inputs-hash rebuild for large drift |

## Capacity (this host)

32 cores / 125 GB RAM / ~500 GB free. Rough guide: 8 GB per app VM → about 10 warm VMs leaving room for the host (ollama etc). Overlays start at about 150 MB and grow with use. Memory snapshots cost about the guest's RAM in disk space.

## Roadmap (re-ordered after review)

0. **Hardening of v0**: proxy allowlist + limits; isolated network + nwfilter; restricted host gateway key; versioned base images.
1. **State + leases**: SQLite state, generations, reconciler, reaper, per-lease ssh keys + fencing, bounded TTLs.
2. **Profiles**: `plain` (cold reset), then `modem`; memory snapshots only after a profile passes restore tests. Templates are images (`new --from`), so a profile's template = an image captured after `build.sh`.
3. **Secrets push** (tmpfs) + `env push`; builder VM for build-time tokens.
4. **pi extension**: fail-closed routing, detach/reset/keep semantics.
5. **Tests**: concurrent acquire, expiry under laptop sleep, crash mid-acquire, cross-VM and guest→host isolation, secret-retention checks after reset, test from a real Mac.

## Review log

- 2026-10-31: independent review (pi subagent, read-only), [docs/reviews/2026-10-31-architecture-review.md](docs/reviews/2026-10-31-architecture-review.md). All 13 findings accepted; the design changes are folded into the sections above. Two live v0 bugs fixed immediately: proxy crash on malformed token; `build-base` overwriting a backing file in use.
