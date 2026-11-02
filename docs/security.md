# Security model

← [Docs](README.md)

boxery is built for **one trusted owner running untrusted-ish agents**: the agents are yours, but you don't want a confused or prompt-injected agent walking off with your credentials or wrecking your laptop. It's not built for hostile multi-tenant use.

## What a VM can and can't reach

| | |
|---|---|
| ✅ The internet | Through libvirt's NAT network (or Lima's user network) |
| ✅ LLM providers | Only through the host proxy, with a per-VM token |
| ✅ What you [grant](grants.md) | ssh-agent, env vars, files: only while granted |
| 🔒 `http:`/`github` grant secrets | never: the host proxy injects them per request; the VM can use but not read them |
| ❌ Your real LLM keys / OAuth tokens | They stay on the host |
| ❌ Your laptop | No inbound path. ssh goes laptop → host → VM. With Lima the laptop *is* the host: on macOS a guest reaches the Mac's loopback (`127.0.0.1`) only on the proxy port. See [limits](#known-limits). |
| ⚠️ The host's sshd | Reachable on the NAT network (keys required). See [limits](#known-limits). |

Inside the VM, everything listens on localhost: the desktop (noVNC on `127.0.0.1:6080`), Chrome's CDP port, and the proxy forwarder. You reach the desktop only through an ssh tunnel (`boxery desktop`).

The desktop also needs a password. websockify (noVNC) doesn't check the `Origin` header. While a `boxery desktop` tunnel is open, any process on your machine can reach it, and so can a web page in a browser that allows WebSockets to localhost. The VNC server therefore uses TigerVNC's `VncAuth` and never runs without a password. The password is 8 random letters and digits (VncAuth reads only 8 characters). It lives in `/run/user/UID/boxery-vnc/passwd`: tmpfs, mode `0600`, owned by the agent user, never on the VM's disk. `boxery-vnc.service` makes one before it starts the server, so a new VM is locked even if nobody opens its desktop. Each `boxery desktop` sets a new password and passes it to noVNC in the URL fragment, which isn't sent to the server or written to its logs ([details](cli.md#desktop-and-ports)). Computer use (`vm_screenshot`, `vm_click`, …, `vm_view`) talks to the X display directly over ssh, not to VNC, so the password doesn't affect it.

Guests run without swap, with core dumps disabled. Pushed grant files are `0400` and live on tmpfs.

## Credential proxy

VMs run agents that need LLM access, but they never get a real key.

```
VM: pi/opencode ──► 127.0.0.1:8088 ──vsock──► host: boxery-proxy ──► chatgpt.com / OpenAI / Anthropic / ollama
                    (per-VM token)                 checks token, swaps in real credential
```

1. `boxery-host new` writes the agent configs into the VM:
   - `~/.pi/agent/models.json` overrides `openai-codex.baseUrl` with `http://127.0.0.1:8088/chatgpt/backend-api`. Its `apiKey` is an **unsigned fake JWT** whose payload carries `{"boxery":"<vm>:<secret>"}`. It has to be JWT-shaped because pi derives the ChatGPT account id from the JWT. Ollama models are listed too.
   - `~/.config/opencode/opencode.json` gets a `boxery` OpenAI-compatible provider pointing at `/ollama/v1`.
2. In the guest, `boxery-llm.service` forwards `127.0.0.1:8088` to the host: over vsock (CID 2) on libvirt, or the user-net gateway on Lima. The host needs no listening port on the VM network. Lima maps that gateway (`192.168.5.2`) to the host's loopback, so on macOS boxery starts each Lima instance under a sandbox that lets it reach only the proxy port there ([limits](#known-limits)).
3. On the host, `boxery-vsock.service` hands the connection to `boxery-proxy` on `127.0.0.1:8088`.
4. The proxy checks `<vm>:<secret>` against `~/.config/boxery/tokens.json`. It then strips the VM's auth and injects the real credential: the host pi's ChatGPT/Codex OAuth (refreshed automatically) or keys from `proxy.env`. Routes are allowlisted and size-limited. WebSocket upgrades are refused, so pi uses SSE.
5. `boxery rm` revokes the token. `boxery proxy-log` shows which VM called which provider.

## Known limits

- **Shared NAT network.** VMs share libvirt's `default` network. They can reach the internet and the host's sshd, but not the proxy port. For stricter isolation, give them a dedicated network with nwfilter rules (on the [roadmap](../ARCHITECTURE.md#roadmap)). The experimental [cloud-hypervisor backend](../host/backends/README.md#cloud-hypervisor-experimental) already isolates guests: one routed TAP per VM, and nftables drops guest→host, guest→guest and guest→private-range traffic.
- **Lima guests and the host's loopback.** Lima NATs the guest's gateway, `192.168.5.2`, to the host's `127.0.0.1`. Left alone, that hands every guest each loopback service on the Mac: Ollama's admin API (`/api/pull`, `/api/delete`, bypassing the proxy's allowlist), the HTTP MCP server, dev databases ([#67](https://github.com/benvinegar/boxery/issues/67)). On macOS, boxery therefore starts every Lima instance under `sandbox-exec` with a Seatbelt profile. Lima's host agent, which carries the guest's network, and the qemu it spawns may then open loopback connections only to the proxy port and to the instance's own ssh port, which leads back to the guest's own sshd. Everything else on `127.0.0.1` (any 127/8 address, TCP and UDP) is refused. The Mac's kernel enforces it, so root in the guest can't lift it. What it doesn't cover:
  - **Services listening on the Mac's other addresses** (`0.0.0.0`, the LAN or Tailscale IP) stay reachable from guests, as from your LAN. Guest traffic leaves through the Mac's own routing, so guests also reach your LAN and tailnet.
  - **Instances started outside boxery** (a plain `limactl start boxery-NAME`) and VMs that were already running when you upgraded aren't confined. Restart them with `boxery stop NAME && boxery start NAME`.
  - **Lima on Linux** has no Seatbelt. Its guests still reach the host's loopback; use libvirt or Cloud Hypervisor there.
  - A host-side HTTP proxy or DNS resolver on `127.0.0.1` is out of reach for Lima guests too. Confined qemu instances use slirp's DNS forwarder (`192.168.5.3`) instead of Lima's host resolver, which listens on loopback.
- **Proxy spend.** A guest with root can read its own token and spend through the proxy. That's the same blast radius as handing it an API key, except the token is revocable per VM and logged. Per-VM budgets are planned.
- **Agents can ask for grants, not take them.** `vm_grant` adds a grant only after you approve a prompt that boxery shows and the agent can't answer. It can't ask for `http:` grants with a `--cmd`, files in `~/.ssh`, `~/.gnupg`, `~/.pi` or boxery's own config (the same set `vm_copy --copy-root` refuses), or `env:BOXERY_*` variables such as the HTTP MCP token ([Agents can ask](grants.md#agents-can-ask)). A requested file is stored by its real path, and an apply skips any granted file that has since been re-pointed through a symlink into one of those directories. A client hook or setting that auto-accepts MCP elicitations would also auto-accept these.
- **HTTP MCP runs on the control plane.** `boxery-mcp --http` runs next to the credentials it protects, so its `vm_copy` refuses `local:` endpoints unless you start it with `--copy-root DIR`, which confines them to `DIR` and still refuses boxery's config, `~/.ssh`, `~/.gnupg` and `~/.pi` ([details](mcp.md#b-streamable-http-on-the-host-over-tailscale)). Anyone with the bearer token can drive every VM on that host; keep it on the tailnet behind `--allow-user`.
- **Pushed grants are readable.** `env:`/`file:` values (and the ssh-agent while connected) can be used or read by whatever runs in the VM. Grant dev-scoped credentials only, and prefer `http:` grants, whose values stay on the host.
- **Desktops from older bases have no VNC password.** The password is part of the desktop base image. VMs made from a base built before it have an open VNC server, and so do their snapshots and images: while a `boxery desktop` tunnel is open, any local process or web page can drive that desktop, including its logged-in browser. `boxery desktop` warns when it opens one. Rebuild the base (`boxery build-base`) and create those VMs again ([details](cli.md#desktop-and-ports)).
- **Desktop password limits.** VncAuth is old (a DES challenge-response, 8 characters at most). It stops processes and pages on your machine that would guess, but not anything that can read your browser's history: the URL is saved there, and its password works until the next `boxery desktop` or a reboot of the VM replaces it. TigerVNC blocks an address for a while after 5 failed logins. Every login through the tunnel comes from `127.0.0.1`, so a local process that keeps guessing can also lock you out for a while.
- **One host.** No multi-host scheduling yet.

Found a security issue? Please report it privately through [GitHub security advisories](https://github.com/benvinegar/boxery/security/advisories/new) rather than a public issue.
