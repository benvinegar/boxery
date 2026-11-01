# MCP server

← [Docs](README.md)

`mcp/boxery-mcp.mjs` exposes the same 12 `vm_*` tools as the [pi extension](pi-extension.md) to any MCP client: Claude Code, Cursor, opencode, pi, and others. It has no dependencies. It needs Node ≥ 20 and a configured controller (`boxery setup`). The extension and the MCP server share `core/boxery-core.mjs`.

There are two ways to run it:

| | Runs on | Transport | Good for |
|---|---|---|---|
| **A. stdio** (recommended) | your laptop | stdin/stdout | Full features. Grants and `vm_copy local:` use your laptop. |
| **B. HTTP** | the VM host | Streamable HTTP over Tailscale | Nothing to install on clients |

## A. stdio on your laptop

The server runs locally and reaches VMs over the same ssh path as the CLI. Let the controller register it:

```bash
boxery mcp install claude --vm demo     # Claude Code (user scope)
boxery mcp install cursor --vm demo     # writes ~/.cursor/mcp.json (keeps your other servers)
boxery mcp install pi --vm demo         # or just use the pi extension
boxery mcp install json --vm demo       # print a config snippet for any other client
```

`install` uses absolute paths to `node` and `boxery-mcp.mjs`. MCP clients don't run arguments through a shell, so `~` isn't expanded, and GUI apps often don't see your shell's `PATH` or nvm. Before registering, `install` starts the server and checks `initialize` + `tools/list`. Run `boxery mcp check` to check it again at any time.

| Flag | |
|---|---|
| `--vm NAME` | Default VM for tools that don't pass `vm`. Omit it to let the agent pick with `vm_manage`. |
| `--scope` | `user` (default) or `project` for every client; Claude Code also has `local`. |
| `--name NAME` | Server name in the client (default `boxery`). |
| `--no-check` | Skip the startup check. |
| `boxery --host NAME mcp install …` | Pin the server to a [named host](hosts.md). Without it, the server follows `boxery host use`. |

A non-default `BOXERY_HOME` is passed to the server in its `env`. Re-run `install` after moving the checkout, upgrading with npm, or switching Node versions: the absolute paths change.

**Tools appear in the next session.** Claude Code only loads MCP servers at startup, so start a new session after installing; `claude mcp get boxery` should show *Connected*. In pi, run `/reload`.

Without the controller (any client, via npx):

```bash
claude mcp add boxery -- npx -y -p boxery-vm boxery-mcp --vm demo
```

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
