# agentvm

Full Ubuntu desktop VMs on a Linux box, driven from your laptop, with coding agents (pi, opencode) running *inside* them. Think self-hosted exe.dev.

```
laptop (macOS/Linux)                    Linux host (KVM + libvirt)
 agentvm ──ssh (tailscale)──► agentvm-host ──► avm-demo   Ubuntu 24.04 + XFCE
   │  attach / prompt / run                     ├ tmux: pi, opencode   (survive laptop sleep)
   │                                            ├ TigerVNC+noVNC on 127.0.0.1:6080
   └ browser ◄── ssh -L ────────────────────────┘ socat 127.0.0.1:8088 ─vsock─┐
                                                                             ▼
                                 agentvm-proxy (127.0.0.1:8088) ── real creds ──► chatgpt.com / OpenAI / Anthropic / ollama
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
git clone git@github.com:benvinegar/agentvm.git ~/Projects/agentvm && cd ~/Projects/agentvm
./host/agentvm-host init          # storage pool, proxy + vsock user services, ~/.local/bin symlinks
./host/agentvm-host build-base    # golden image: XFCE, VNC, Firefox, node 22, pi, opencode (~3 min)
pi   # then /login → ChatGPT, if you haven't already; the proxy reuses ~/.pi/agent/auth.json
```

Optional extra providers: `~/.config/agentvm/proxy.env` (`OPENAI_API_KEY=…`, `ANTHROPIC_API_KEY=…`). Ollama on `127.0.0.1:11434` is auto-detected, and its tool-capable models are configured for both pi and opencode.

The laptop has to be able to `ssh you@host`: add its key to the host's `~/.ssh/authorized_keys`. Tailscale is the easy way to reach the host from anywhere.

## Controller setup (macOS or Linux)

```bash
git clone git@github.com:benvinegar/agentvm.git ~/agentvm && ln -s ~/agentvm/controller/agentvm /usr/local/bin/agentvm   # or anywhere on PATH
agentvm setup you@hornet          # checks ssh, registers your pubkey for new VMs, writes ~/.agentvm/ssh_config
echo "Include ~/.agentvm/ssh_config" | cat - ~/.ssh/config > /tmp/c && mv /tmp/c ~/.ssh/config   # optional: `ssh demo.avm`, VS Code/Zed remote
```

## Drive VMs from pi on your laptop (the main workflow)

pi runs on your laptop (your model login, your extensions). It gets **explicit `vm_*` tools** for the VMs. The built-in `bash`/`read`/`write`/`edit` are left alone and keep acting on the laptop, so the agent can work on both sides, and other extensions that wrap built-in tools keep working.

```bash
pi install ~/agentvm          # or: pi -e ~/agentvm/extension/index.ts
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

## CLI

```bash
agentvm new demo                  # ~13 s
agentvm attach demo               # pi in tmux (Ctrl-b d to detach; it keeps running)
agentvm attach demo opencode
agentvm attach demo shell
agentvm prompt demo "fix the failing tests and commit"   # headless pi task in its own tmux session
agentvm sessions demo
agentvm desktop demo              # opens the XFCE desktop in your browser
agentvm forward demo 3000         # localhost:3000 → the VM's dev server
agentvm snap demo before-refactor && agentvm revert demo before-refactor
agentvm run demo 'git -C project log --oneline'
agentvm proxy-log                 # which VM called which provider
agentvm rm demo
```

VS Code / Cursor / Zed: once the `Include` line is in place, connect via Remote-SSH to `demo.avm`.

### GitHub authentication via your local SSH agent

Forwarding is off by default. For a trusted VM, opt in with:

```bash
agentvm agent-forward demo on
# When no VM commands are running, close the old shared connection:
ssh -F ~/.agentvm/ssh_config -O exit demo.avm
agentvm run demo 'ssh-add -l'
```

The next connection forwards your loaded local SSH agent, including for `vm_bash`.
Use an SSH Git remote (`git@github.com:OWNER/REPO.git`); your key must be registered
with GitHub. Verify GitHub's host fingerprint on first connection. Private keys
are not copied, but VM processes can request authentication while connected.
Forwarding persists across `agentvm setup`; disable with `agentvm agent-forward demo off`
and close the shared connection again. Existing separate SSH connections must also
be closed. Git commit name/email are configured separately. Detached tmux jobs
may retain a stale agent socket after reconnecting and need restarting.

## Test

```bash
./e2e.sh      # from the controller: create → pi → opencode → bg task → desktop → laptop-pi extension → snapshot → rm (13 checks)
```

## How the credential proxy works

`agentvm-host new` writes into the VM:

- `~/.pi/agent/models.json`: overrides `openai-codex.baseUrl` → `http://127.0.0.1:8088/chatgpt/backend-api`. Its `apiKey` is an **unsigned fake JWT** whose payload carries `{"avm":"<vm>:<secret>"}` (pi derives the ChatGPT account id from the JWT, so it has to be JWT-shaped). Ollama models are also listed.
- `~/.config/opencode/opencode.json`: an `agentvm` provider (OpenAI-compatible) → `/ollama/v1`.

In the guest, `agentvm-llm.service` forwards `127.0.0.1:8088` to vsock CID 2 (the host). On the host, `agentvm-vsock.service` forwards that to `agentvm-proxy` on `127.0.0.1:8088`. The proxy checks `<vm>:<secret>` against `~/.config/agentvm/tokens.json`, strips the VM's auth, and injects the real credential (refreshing the Codex OAuth token when needed). WebSocket upgrades are refused, so pi uses SSE (also set via `transport: "sse"`).

## Limits / next steps

- VMs share libvirt's `default` NAT network: they have internet, and can reach the host's sshd (but not the proxy port). For stricter isolation, give them a dedicated network with nwfilter rules.
- A guest with root could read its own token and spend through the proxy. That's the same blast radius as giving it an API key, but revocable per VM and logged.
- One host. Multi-host would mean a host field per VM in the controller, or moving to Incus clustering.
- Ideas: a pi extension that wraps `agentvm new/prompt` so a local pi can fan out work to VMs; per-VM budgets in the proxy; RDP (xrdp) for a native macOS client.
