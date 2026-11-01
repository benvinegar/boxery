# MCP server

← [Docs](README.md)

`mcp/boxery-mcp.mjs` exposes the same `vm_*` tools as the [pi extension](pi-extension.md) to any MCP client: Claude Code, Cursor, opencode, pi, and others. It has no dependencies. It needs Node ≥ 20 and a configured controller (`boxery setup`). Both are built from one tool table, `core/boxery-tools.mjs`, so their tool names, descriptions and schemas match; MCP adds an optional `host` argument, the `host`/`host_add`/`host_rm` actions of `vm_manage` and the `hosts` action of `vm_info`.

There are two ways to run it:

| | Runs on | Transport | Good for |
|---|---|---|---|
| **A. stdio** (recommended) | your laptop | stdin/stdout | Full features. Grants and `vm_copy local:` use your laptop. |
| **B. HTTP** | the VM host | Streamable HTTP over Tailscale | Nothing to install on clients |

## A. stdio on your laptop

The server runs locally and reaches VMs over the same ssh path as the CLI.

```bash
npx add-mcp boxery-vm
```

[add-mcp](https://github.com/neon-solutions/add-mcp) asks which agents to add it to (Claude Code, Cursor, Codex, VS Code, opencode, pi, Zed, and more) and writes each one's config. Useful flags: `-g` for all your projects, `-a claude-code` to pick a client, `--args --vm --args demo` for a default VM. Without a default VM the agent picks or creates one with `vm_manage`.

**Tools appear in the next session.** Claude Code loads MCP servers at startup, so start a new session (`claude mcp get boxery-vm` should show *Connected*). In pi, run `/reload`.

Or by hand, for any client:

```bash
claude mcp add boxery -- npx -y boxery-vm --vm demo
```

```json
{
  "mcpServers": {
    "boxery": { "command": "npx", "args": ["-y", "boxery-vm", "--vm", "demo"] }
  }
}
```

From a git checkout, use absolute paths (clients don't expand `~`): `"command": "node", "args": ["/abs/path/to/boxery/mcp/boxery-mcp.mjs"]`.

### Multiple hosts, one server

Register profiles with `boxery host add` and select the startup host with `--host NAME`. Every tool accepts optional `host`; `vm_info {action:"hosts"}` lists them with where each runs (`destination`: `local` or the ssh destination), its recorded `backend`, and `same_as` (other names registered for the same profile directory); and `vm_manage {action:"host",host:"NAME"}` changes the session host and clears its VM. An explicit other host never inherits the current VM name. Copy endpoints can use `HOST/VM:/path`.

`{action:"host_add", name:"exe", dest:"local", backend:"exe"}` registers a host, like `boxery host add exe local --backend exe`: with `backend` it first creates a separate profile for that VM platform on `dest` (its own state, proxy port and services); `profile` uses one that exists there; `buildBase:true` then builds its desktop image. `local` is the machine the server runs on. It uses the user's default ssh key, and doesn't select the host; it becomes the CLI default only when there is none. `{action:"host_rm", name:"exe"}` forgets a registration (never the CLI default; VMs, profile data and grants stay). `{action:"build-base"}` builds the call's host's desktop base image.

See [Named hosts](hosts.md). Pool leases (`vm_lease`) are held against the host the call targets.

## B. Streamable HTTP on the host, over Tailscale

```bash
# on the host
export BOXERY_MCP_TOKEN=$(openssl rand -hex 32)
boxery-mcp --http 127.0.0.1:8765 --allow-user you@example.com
tailscale serve --bg --https=8765 http://127.0.0.1:8765     # tailnet only. Never `tailscale funnel`.

# on a client
claude mcp add --transport http boxery https://my-host.<tailnet>.ts.net:8765/mcp \
  --header "Authorization: Bearer $BOXERY_MCP_TOKEN"
```

In this mode, "local" means **the machine running MCP**, not necessarily the selected VM host: `vm_copy local:…` copies to and from that server, and grants are read from its env, files and ssh agent.

## Protocol features

The server speaks MCP `2024-11-05` through `2025-11-25` and sends newer fields only to clients that negotiated them, so older clients see the same responses as before.

| Feature | Clients | What it does |
|---|---|---|
| Tool annotations | all | `vm_info`, `vm_read` and `vm_screenshot` are `readOnlyHint`, so clients that honor hints skip confirmation for them. File and lifecycle tools are `openWorldHint: false`. Lookups (VMs, shapes, grants, snapshots, images, versions, hosts) are on `vm_info`; `vm_manage` only changes things. |
| Progress | all, when the request has `_meta.progressToken` | `notifications/progress` while a call runs: output lines from `vm_bash`, controller lines from `vm_manage` `new`/`fork`/`snap`/`revert`/`rm`, a "creating" line when `use` creates a VM, and an elapsed-time line every 5 s for quiet calls. At most one line per second. Over HTTP the response becomes an SSE stream when the client accepts `text/event-stream`; otherwise it stays JSON without progress. |
| Structured output | `2025-06-18`+ | `vm_jobs` and `vm_info` declare an `outputSchema` and return `structuredContent` next to the same text as before. Tools also get a top-level `title`. |
| Server description | `2025-11-25`+ | `serverInfo.description` and `websiteUrl`. |
| Live desktop view | [MCP Apps](https://modelcontextprotocol.io/extensions/apps) clients | `vm_view` (see below). |

## Live desktop view

In clients that support [MCP Apps](https://modelcontextprotocol.io/extensions/apps) (the `io.modelcontextprotocol/ui` extension), the server adds `vm_view`. Ask the agent to show you a VM, and its desktop appears inside the chat:

- It refreshes about twice a second while it is on screen, and pauses when you scroll away, switch windows, or leave it alone for 10 minutes.
- **Take control** sends your clicks, scrolling and keys to the VM. Cmd/Ctrl+V types your local clipboard. On a Mac, Cmd shortcuts arrive as Ctrl.
- **Release control** tells the agent the desktop changed, so it takes a fresh screenshot before acting.
- **Fullscreen** appears when the client supports it.

The page is the `ui://boxery/desktop` resource ([`mcp/desktop-view.html`](../mcp/desktop-view.html)). It makes no network requests of its own. Each frame is a call to the app-only `vm_view_frame` tool, a JPEG about an eighth the size of a `vm_screenshot` PNG. Input goes through `vm_click`, `vm_type`, `vm_key` and `vm_scroll`, the same tools and coordinates the agent uses. So it works the same over stdio and HTTP, for local and remote hosts, and the client's usual approval rules apply to your input as well.

Clients that don't advertise MCP Apps don't see `vm_view`, and their tool list is unchanged. Start the server with `--ui` to offer it anyway, for a client that renders apps without advertising support. Outside a chat, `boxery desktop NAME` opens the full noVNC desktop in a browser.

## Background jobs

Use `vm_jobs` for long commands instead of holding a `vm_bash` call open:

```json
{"action":"start","command":"pnpm test","cwd":"app"}
{"action":"list"}
{"action":"logs","job":"job-20261101-120000-a1b2c3","lines":200,"stripAnsi":true}
{"action":"wait","job":"job-20261101-120000-a1b2c3","timeout":60}
{"action":"kill","job":"job-20261101-120000-a1b2c3"}
```

Every call accepts optional `host` and `vm`, using the session selection by default. These are the same jobs as `boxery run --bg` ([CLI](cli.md#background-command-jobs)).

- **`start`** takes a shell command line like `vm_bash`, and returns `{"id", "state", "cwd"}`. `cwd` defaults to `~/project` (home if it's missing); relative directories are below `~/project`.
- **`list`** returns the job records (fields as in [`boxery jobs --json`](cli.md#boxery-jobs-name---json), without `argv` and `log`).
- **`wait`** returns the record, plus `timed_out`, then the last `lines` (default 20) lines of output with escapes removed (in `structuredContent`: `output`). The text is the record's JSON on its first line, then `--- last N lines ---` and the output. A non-zero exit or a `lost` job is a tool error; a timeout isn't. `timeout` defaults to 60 seconds (0–600; 0 checks once), because many MCP clients give up on a tool call after a few minutes. For longer jobs, call `wait` again.
- **`logs`** returns a bounded tail: default 200 lines, at most 2000 lines and 50KB. The VM clips raw bytes before selecting lines or removing escapes, so even a huge log without newlines moves at most 50KB. `[output truncated]` means the tail was clipped. Incomplete leading UTF-8 characters are dropped, and invalid UTF-8 is cut to a 50KB character-safe suffix.
- **`kill`** sends SIGTERM to the job's process group, then SIGKILL after `grace` seconds (default 5). That includes processes a job left running after it exited (`leftover: true` in its record).
- **Cancelling** or timing out a call only stops observing, never the job. When the ssh connection closes cleanly (cancellation, Ctrl-C), the VM side of an abandoned `wait` exits within about 2 seconds. A connection that dies silently (a sleeping laptop, a dropped network) is only noticed when ssh's keepalive gives up.

## Pool leases

`vm_lease` leases VMs from the host's [shared pool](pool.md):

```json
{"action":"acquire","ttl":1800,"wait":60}
{"action":"list"}
{"action":"renew","ttl":3600}
{"action":"release"}
```

`acquire` waits up to `wait` seconds (default 60, at most 3600) for a free pool VM, leases it for `ttl` seconds (60–28800, default 1800) and makes it the current VM unless `use` is false. `renew` and `release` take `vm` (default: the current VM). A leased VM can't be removed with `vm_manage rm`.

Leases belong to the MCP session that acquired them. The server renews each one at a third of its TTL while the session is in use, meaning a call is running or one ran within the TTL. They're released when the session ends: stdin closes (stdio), the client sends `DELETE` (HTTP), or the server gets SIGINT/SIGTERM/SIGHUP. An HTTP client that disappears without `DELETE` stops renewing, and the host's reaper resets the VM when the lease expires. A release or expiry resets the VM to its clean image, so anything not copied out is lost. If a renewal fails (the lease expired, or the host rebooted), the lease is dropped and stops being the current VM.

## Atomic file edits

`vm_edit` (core/MCP, not pi's edit engine) sends one request to the Linux guest,
requiring Node (image: Node 24) and util-linux `flock`, not Python. One persistent
per-user lock at `~/.boxery-edit/edit.lock` covers reading the latest file,
exact-text matching and atomic replacement. Never unlink this lock while editors
may run. All cooperating edits serialize, including symlink/case aliases, and each
reads the latest file. A second edit fails if the first removes its required match;
otherwise it can apply normally, including disjoint edits that preserve both changes.
Raw files and UTF-8 results are bounded to 16 MiB (JSON requests: 48 MiB).

OS realpath follows and preserves symlinks. Stable before/after file stats (including
identity) and raw bytes, plus a final resolved-target/parent-identity check, reject
observed external changes. This is advisory, **not** a filesystem transaction:
noncooperating writers can race the final check/rename; intermediate symlink-chain
changes with the same final target and change-and-restore sequences may go unnoticed.
Concurrent directory relocation is unsupported and may leave staging in the old directory.

Replacement requires normal file read/write and directory write/search permissions
(root retains its usual bypass). Regular, singly linked files only; basic mode,
uid and gid are preserved or the edit fails. ACLs/xattrs/other metadata are not
preserved. Existing UTF-8 decode/exact-match semantics are unchanged.

A private adjacent staging file is fully written and flushed before rename; the
destination is never truncated. Normal failures and handled TERM/HUP/INT clean up
staging after pending I/O settles. SIGKILL/crashes may leave staging; power-loss
durability is not promised. Preaborted calls never start. Stopping SSH need not stop
the guest; cancellation/timeout or lost/malformed acknowledgement means **unknown
commit outcome**, not rollback: reread before retrying.

## Options

| Flag | |
|---|---|
| `--host NAME` | Registered startup host (otherwise the controller default). Each HTTP session keeps its own host and VM. |
| `--vm NAME` | Default VM. Without it, the model picks one with `vm_manage {action:"use"}`, and tools fail closed when no `vm` is given. |
| `--http ADDR:PORT` | Serve Streamable HTTP at `/mcp` instead of stdio. Each MCP session keeps its own current VM. |
| `--token-file PATH` | Bearer token from a file instead of `$BOXERY_MCP_TOKEN` |
| `--allow-user LOGIN` | Also require this `Tailscale-User-Login` header (set by `tailscale serve`). Loopback binds only. Can be repeated. |
| `--allow-origin ORIGIN` | Accept requests with this `Origin`. Foreign origins are rejected by default. |
| `--no-auth` | Skip the bearer token. **Local testing only.** |
| `--ui` | Offer `vm_view` even to clients that don't advertise MCP Apps support |

## Testing

```bash
mcp/test-mcp.sh VM      # protocol test (stdio + HTTP) against a live VM
```
