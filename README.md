# boxery

**More computers for your agents.** Self-hosted Ubuntu desktop VMs (libvirt/KVM on Linux, or Lima on macOS) that the coding agents on your laptop drive through `vm_*` tools: shell, files, computer use and a real browser. Use the pi extension or the MCP server (Claude Code, Cursor, …). Agents can also run *inside* the VMs. Think self-hosted exe.dev.

> Formerly `agentvm`. Upgrading an existing install: see [Migrating from agentvm](#migrating-from-agentvm).

```
laptop (macOS/Linux)                    Linux host (KVM + libvirt)
 boxery ──ssh (tailscale)──► boxery-host ──► boxery-demo   Ubuntu 24.04 + XFCE
   │  attach / prompt / run                     ├ tmux: pi, opencode   (survive laptop sleep)
   │                                            ├ TigerVNC+noVNC on 127.0.0.1:6080
   └ browser ◄── ssh -L ────────────────────────┘ socat 127.0.0.1:8088 ─vsock─┐
                                                                             ▼
                                 boxery-proxy (127.0.0.1:8088) ── real creds ──► chatgpt.com / OpenAI / Anthropic / ollama
```

- **VMs**: qcow2 overlays on a golden image → a new desktop VM in ~13 s. Snapshot/revert in ~2 s.
- **Agents in the VM**: pi + opencode preinstalled, pre-configured to use the host proxy. Runs in tmux, so the work keeps going while your laptop is closed.
- **Credentials stay on the host**: each VM gets a random per-VM token. The proxy checks it and swaps in the real credential (your host pi's ChatGPT/Codex OAuth, or API keys in `proxy.env`). `rm` revokes the token. VMs reach the proxy over **vsock**, so the host doesn't need any listening port for them.
- **Laptop agents drive VMs**: the pi extension gives a laptop pi `vm_*` tools: shell, files, copy, computer use, and the browser.
- **Desktop**: XFCE over noVNC, bound to localhost inside the VM and reachable only through ssh. Agents' GUI apps (`DISPLAY=:1`, e.g. Firefox) appear there.
- **Controller is just bash 3.2 + ssh**: works on stock macOS.

## Host setup (Linux, one-time)

Needs: KVM, libvirt (`qemu:///system`, user in `libvirt` group), `virt-install`, `cloud-localds` (cloud-image-utils), `socat`, `jq`, `node` ≥ 20, `nc`. User systemd with linger is recommended so the proxy runs while you're logged out (`loginctl enable-linger`).

```bash
git clone git@github.com:benvinegar/boxery.git ~/Projects/boxery && cd ~/Projects/boxery
./host/boxery-host init          # storage pool, proxy + vsock user services, ~/.local/bin symlinks
./host/boxery-host build-base    # golden image: XFCE, VNC, Firefox, node 22, pi, opencode (~3 min)
pi   # then /login → ChatGPT, if you haven't already; the proxy reuses ~/.pi/agent/auth.json
```

Optional extra providers: `~/.config/boxery/proxy.env` (`OPENAI_API_KEY=…`, `ANTHROPIC_API_KEY=…`). Ollama on `127.0.0.1:11434` is auto-detected, and its tool-capable models are configured for both pi and opencode.

The laptop has to be able to `ssh you@host`: add its key to the host's `~/.ssh/authorized_keys`. Tailscale is the easy way to reach the host from anywhere.

## Controller setup (macOS or Linux)

```bash
git clone git@github.com:benvinegar/boxery.git ~/boxery && ln -s ~/boxery/controller/boxery /usr/local/bin/boxery   # or anywhere on PATH
boxery setup you@hornet          # checks ssh, registers your pubkey for new VMs, writes ~/.boxery/ssh_config
echo "Include ~/.boxery/ssh_config" | cat - ~/.ssh/config > /tmp/c && mv /tmp/c ~/.ssh/config   # optional: `ssh demo.boxery`, VS Code/Zed remote
```

## Drive VMs from pi on your laptop (the main workflow)

pi runs on your laptop (your model login, your extensions). It gets **explicit `vm_*` tools** for the VMs. The built-in `bash`/`read`/`write`/`edit` are left alone and keep acting on the laptop, so the agent can work on both sides, and other extensions that wrap built-in tools keep working.

```bash
pi install ~/boxery          # or: pi -e ~/boxery/extension/index.ts
pi --vm demo                  # current VM "demo" (created if missing)
pi --vm new                   # throwaway VM, deleted when pi quits
pi                            # no current VM; the agent can still create/use VMs with vm_manage
```

| Tool | |
|---|---|
| `vm_bash`, `vm_read`, `vm_write`, `vm_edit` | shell and files in the VM (`/home/agent/project`; same semantics as the built-ins) |
| `vm_copy` | files/dirs between `local:path`, `NAME:path`, or a bare path (= current VM) |
| `vm_screenshot`, `vm_click`, `vm_type`, `vm_key`, `vm_scroll` | computer use on the VM's XFCE desktop |
| `vm_browser` | Playwright code against Google Chrome on that desktop (watch with `/vm desktop`) |
| `vm_manage` | list · new · rm · snap · revert · use · none |

Every `vm_*` tool takes an optional `vm` (default: the current VM), so one agent can fan out across several VMs. The system prompt tells the model that project work happens in the VM through `vm_*` tools, and that built-ins are local. Commands: `/vm use NAME` · `/vm new` · `/vm off` · `/vm ls` · `/vm rm NAME` · `/vm desktop`. The current VM is saved in the session (`pi --continue`).

Leases (several laptop agents sharing a pool safely) are designed in ARCHITECTURE.md but not built yet. For now, give each pi its own VM.

## Use from any MCP client (Claude Code, Cursor, opencode, pi, …)

`mcp/boxery-mcp.mjs` exposes the same 12 `vm_*` tools over MCP. No dependencies: Node 18+ and the `boxery setup` config. The pi extension and the MCP server share `core/boxery-core.mjs`.

**A. stdio on your laptop** (recommended: full features). The server runs locally and reaches VMs over the same ssh path:

```bash
claude mcp add boxery -- node ~/boxery/mcp/boxery-mcp.mjs --vm demo     # Claude Code
pi mcp add boxery -- node ~/boxery/mcp/boxery-mcp.mjs --vm demo         # pi (or use the extension)
# Cursor / others: {"mcpServers":{"boxery":{"command":"node","args":["~/boxery/mcp/boxery-mcp.mjs","--vm","demo"]}}}
```

**B. Streamable HTTP on the host, over Tailscale** (no install on clients; groundwork for shared leases):

```bash
# on the host
export BOXERY_MCP_TOKEN=$(openssl rand -hex 32)
node mcp/boxery-mcp.mjs --http 127.0.0.1:8765 --allow-user you@example.com
tailscale serve --bg --https=8765 http://127.0.0.1:8765    # tailnet-only; never `tailscale funnel`
# on a client
claude mcp add --transport http boxery https://hornet.<tailnet>.ts.net:8765/mcp --header "Authorization: Bearer $BOXERY_MCP_TOKEN"
```

- Auth: a bearer token is required (`--no-auth` is for local testing only). `--allow-user` additionally checks the `Tailscale-User-Login` header that `tailscale serve` sets. Requests with a foreign `Origin` are rejected.
- In mode B, "local" means the **host**: `vm_copy local:…` copies to and from the host, and grants are read from the host's env, files and ssh agent.
- `--vm NAME` sets the default VM; otherwise the model picks one with `vm_manage {action:"use"}`. Without it, tools fail closed when no `vm` is given.

## CLI

```bash
boxery new demo                  # ~13 s
boxery attach demo               # pi in tmux (Ctrl-b d to detach; it keeps running)
boxery attach demo opencode
boxery attach demo shell
boxery prompt demo "fix the failing tests and commit"   # headless pi task in its own tmux session
boxery sessions demo
boxery desktop demo              # opens the XFCE desktop in your browser
boxery forward demo 3000         # localhost:3000 → the VM's dev server
boxery snap demo before-refactor && boxery revert demo before-refactor
boxery run demo 'git -C project log --oneline'
boxery proxy-log                 # which VM called which provider
boxery rm demo
```

VS Code / Cursor / Zed: once the `Include` line is in place, connect via Remote-SSH to `demo.boxery`.

### Grants: give a VM access to your SSH agent, env vars, and files

Off by default, per VM, controlled from your machine:

```bash
boxery grant demo ssh-agent                         # git over ssh (git@github.com:…) with your keys
boxery grant demo env:GH_TOKEN --cmd 'gh auth token' # value from a command…
boxery grant demo env:NPM_TOKEN                     # …or from your current environment
boxery grant demo file:.env                         # → /home/agent/project/.env
boxery grant demo file:~/.npmrc=.npmrc              # remote paths are relative to /home/agent
boxery grants demo                                  # list; `boxery ls` shows them too
boxery revoke demo env:GH_TOKEN                     # or: revoke demo all
boxery new web --grant ssh-agent --grant file:.env  # at creation
pi --vm demo --vm-grant ssh-agent,env:GH_TOKEN,file:.env
```

How it works:

- **ssh-agent**: `ForwardAgent yes` for that VM only. Your private keys never leave your machine, but processes in the VM can ask your agent to sign while you're connected.
- **env / file**: the local store (`~/.boxery/grants/NAME`) keeps **names and paths only**. Values are read when grants are applied, then pushed over ssh into `/run/user/<uid>/boxery` in the VM: tmpfs, so they're gone on reboot and never written to the VM's disk. Env vars are sourced by login and interactive shells (and `vm_bash`). Files are symlinked into place and added to `.git/info/exclude`.
- Grants are re-applied on `grant`/`revoke`, `new`, `start`, `revert`, `attach`, `ssh`, and when pi selects the VM. Each apply reconciles the VM to exactly the current grants, so revoked items are deleted.
- `boxery agent-forward NAME on|off` is kept as an alias for `grant/revoke NAME ssh-agent`.

Anything granted can be read or copied by whatever runs in the VM (an agent has root there). Grant **dev-scoped, revocable** credentials (a fine-grained GitHub token, dev `.env`), never production secrets. For keys that should never enter a VM, use the host proxy pattern (as for LLM keys).

## Backends

`boxery-host init --backend libvirt` (Linux/KVM, default) or `--backend lima` (macOS, or Linux). On a Mac, run the host on the same machine and point the controller at it with `boxery setup local`: Mac → Lima VMs, no second machine needed. Lima on Apple Silicon builds an arm64 image (Playwright's Chromium instead of Google Chrome); snapshots need `BOXERY_LIMA_VMTYPE=qemu`. Contract and details: [host/backends/README.md](host/backends/README.md).

## Migrating from agentvm

Existing VMs keep working: they were created as libvirt domains `avm-NAME` in pool `agentvm`, and carry `/opt/agentvm` and `agentvm-*` services inside. The renamed code accepts those through `host.env` compatibility keys:

```bash
systemctl --user disable --now agentvm-proxy agentvm-vsock
mv ~/.config/agentvm ~/.config/boxery && mv ~/.agentvm ~/.boxery && mv ~/.cache/agentvm ~/.cache/boxery
cat >> ~/.config/boxery/host.env <<'EOF2'
BOXERY_POOL=agentvm
BOXERY_POOL_DIR=/var/lib/libvirt/images/agentvm
BOXERY_BASE_VOL=agentvm-base.qcow2
BOXERY_DOMAIN_PREFIX=avm-
EOF2
sed -i 's/AGENTVM_/BOXERY_/; s/agentvm-proxy/boxery-proxy/' ~/.config/boxery/host.env
boxery-host init && boxery setup you@host      # new services, symlinks, ssh_config (*.boxery)
```

The LLM proxy still accepts tokens minted before the rename. Rebuild the base image (after removing old VMs) to get fully renamed guests.

## Test

```bash
npm run lint && npm test && npm run test:shell   # offline: lint, 31 unit tests, 66 shell tests (CI runs these + bash 3.2 + macOS)
mcp/test-mcp.sh VM                # MCP protocol test (stdio + http) against a VM
./e2e.sh                          # from the controller: create → pi → opencode → bg task → desktop → laptop-pi extension → grants → snapshot → rm
bash test/shell/controller-config.sh   # offline config test (no VM)
```

## How the credential proxy works

`boxery-host new` writes into the VM:

- `~/.pi/agent/models.json`: overrides `openai-codex.baseUrl` → `http://127.0.0.1:8088/chatgpt/backend-api`. Its `apiKey` is an **unsigned fake JWT** whose payload carries `{"boxery":"<vm>:<secret>"}` (pi derives the ChatGPT account id from the JWT, so it has to be JWT-shaped). Ollama models are also listed.
- `~/.config/opencode/opencode.json`: an `boxery` provider (OpenAI-compatible) → `/ollama/v1`.

In the guest, `boxery-llm.service` forwards `127.0.0.1:8088` to vsock CID 2 (the host). On the host, `boxery-vsock.service` forwards that to `boxery-proxy` on `127.0.0.1:8088`. The proxy checks `<vm>:<secret>` against `~/.config/boxery/tokens.json`, strips the VM's auth, and injects the real credential (refreshing the Codex OAuth token when needed). WebSocket upgrades are refused, so pi uses SSE (also set via `transport: "sse"`).

## Limits / next steps

- VMs share libvirt's `default` NAT network: they have internet, and can reach the host's sshd (but not the proxy port). For stricter isolation, give them a dedicated network with nwfilter rules.
- A guest with root could read its own token and spend through the proxy. That's the same blast radius as giving it an API key, but revocable per VM and logged.
- One host. Multi-host would mean a host field per VM in the controller, or moving to Incus clustering.
- Ideas: a pi extension that wraps `boxery new/prompt` so a local pi can fan out work to VMs; per-VM budgets in the proxy; RDP (xrdp) for a native macOS client.
