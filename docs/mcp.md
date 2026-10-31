# MCP server

← [Docs](README.md)

`mcp/boxery-mcp.mjs` exposes the same 12 `vm_*` tools as the [pi extension](pi-extension.md) to any MCP client: Claude Code, Cursor, opencode, pi, and others. It has no dependencies. It needs Node ≥ 18 and a configured controller (`boxery setup`). The extension and the MCP server share `core/boxery-core.mjs`.

There are two ways to run it:

| | Runs on | Transport | Good for |
|---|---|---|---|
| **A. stdio** (recommended) | your laptop | stdin/stdout | Full features. Grants and `vm_copy local:` use your laptop. |
| **B. HTTP** | the VM host | Streamable HTTP over Tailscale | Nothing to install on clients |

## A. stdio on your laptop

The server runs locally and reaches VMs over the same ssh path as the CLI.

```bash
# Claude Code
claude mcp add boxery -- node ~/boxery/mcp/boxery-mcp.mjs --vm demo

# pi (or just use the extension)
pi mcp add boxery -- node ~/boxery/mcp/boxery-mcp.mjs --vm demo
```

Cursor and other clients that use a JSON config:

```json
{
  "mcpServers": {
    "boxery": {
      "command": "node",
      "args": ["/Users/you/boxery/mcp/boxery-mcp.mjs", "--vm", "demo"]
    }
  }
}
```

## B. Streamable HTTP on the host, over Tailscale

```bash
# on the host
export BOXERY_MCP_TOKEN=$(openssl rand -hex 32)
node mcp/boxery-mcp.mjs --http 127.0.0.1:8765 --allow-user you@example.com
tailscale serve --bg --https=8765 http://127.0.0.1:8765     # tailnet only. Never `tailscale funnel`.

# on a client
claude mcp add --transport http boxery https://my-host.<tailnet>.ts.net:8765/mcp \
  --header "Authorization: Bearer $BOXERY_MCP_TOKEN"
```

In this mode, "local" means **the host**: `vm_copy local:…` copies to and from the host, and grants are read from the host's env, files and ssh agent.

## Options

| Flag | |
|---|---|
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
