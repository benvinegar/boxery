# MCP server

← [Docs](README.md)

`mcp/boxery-mcp.mjs` exposes the same `vm_*` tools as the [pi extension](pi-extension.md) to any MCP client: Claude Code, Cursor, opencode, pi, and others. It has no dependencies. It needs Node ≥ 20 and a configured controller (`boxery setup`). Both are built from one tool table, `core/boxery-tools.mjs`, so their tool names, descriptions and schemas match; MCP adds an optional `host` argument, the `hosts`/`host` actions of `vm_manage` and the `hosts` action of `vm_info`.

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

Register profiles with `boxery host add` and select the startup host with `--host NAME`. Every tool accepts optional `host`; `vm_manage {action:"hosts"}` lists profiles and `{action:"host",host:"NAME"}` changes the session host and clears its VM. An explicit other host never inherits the current VM name. Copy endpoints can use `HOST/VM:/path`.

See [Named hosts](hosts.md). MCP does not acquire or renew pool leases.

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
| Tool annotations | all | `vm_info`, `vm_read` and `vm_screenshot` are `readOnlyHint`, so clients that honor hints skip confirmation for them. File and lifecycle tools are `openWorldHint: false`. `vm_manage` keeps its lookup actions, but `vm_info` is the read-only way to list VMs, shapes, grants and snapshots. |
| Progress | all, when the request has `_meta.progressToken` | `notifications/progress` while a call runs: output lines from `vm_bash`, controller lines from `vm_manage` `new`/`fork`/`snap`/`revert`/`rm`, a "creating" line when `use` creates a VM, and an elapsed-time line every 5 s for quiet calls. At most one line per second. Over HTTP the response becomes an SSE stream when the client accepts `text/event-stream`; otherwise it stays JSON without progress. |
| Structured output | `2025-06-18`+ | `vm_jobs` and `vm_info` declare an `outputSchema` and return `structuredContent` next to the same text as before. Tools also get a top-level `title`. |
| Server description | `2025-11-25`+ | `serverInfo.description` and `websiteUrl`. |

## Background jobs

Use `vm_jobs` for long commands instead of holding a `vm_bash` call open:

```json
{"action":"start","command":"pnpm test","cwd":"app"}
{"action":"list"}
{"action":"logs","job":"job-a1b2c3D4E5F6","lines":200,"stripAnsi":true}
{"action":"wait","job":"job-a1b2c3D4E5F6","timeout":30}
```

Every call accepts optional `host` and `vm`, using the session selection by default. `start` accepts shell syntax like `vm_bash` and returns `{"id":"job-…"}`. Jobs run in detached tmux sessions and survive client disconnects. `cwd` defaults to `~/project` (home if absent); relative directories are below `~/project`.

`list` returns JSON records with `id`, `state`, `started_at` (Unix seconds) and `exit_code` (number or null). `wait` returns one such record; failed commands and `lost` jobs are tool errors. Timeout returns a still-running record with `timed_out:true`, not a tool error. Waiting defaults to 120 seconds (1–3600 allowed); cancellation and timeout only stop observation, never the job. `logs` returns a bounded tail (default 200 lines, at most 2000 lines/50KB), without following indefinitely. The guest caps the raw byte tail before selecting lines or stripping ANSI, so even a huge newline-free log transfers at most 50KB. A `[output truncated]` notice means that the raw byte cap or the decoded response-body cap clipped the snapshot; incomplete leading UTF-8 characters are dropped. Invalid UTF-8 may expand during decoding, so the response also keeps only a character-safe 50KB UTF-8 suffix (excluding the marker). Optional ANSI stripping requires Perl in the guest. Logs stay in the VM at `~/.boxery/jobs/ID.log`; commands may print secrets there. See [CLI jobs](cli.md#background-command-jobs) for lifecycle details.

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

## Testing

```bash
mcp/test-mcp.sh VM      # protocol test (stdio + HTTP) against a live VM
```
