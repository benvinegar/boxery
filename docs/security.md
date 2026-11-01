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
| ❌ Your laptop | No inbound path. ssh goes laptop → host → VM. |
| ⚠️ The host's sshd | Reachable on the NAT network (keys required). See [limits](#known-limits). |

Inside the VM, everything listens on localhost: the desktop (noVNC on `127.0.0.1:6080`), Chrome's CDP port, and the proxy forwarder. You reach the desktop only through an ssh tunnel (`boxery desktop`).

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
2. In the guest, `boxery-llm.service` forwards `127.0.0.1:8088` to the host: over vsock (CID 2) on libvirt, or the user-net gateway on Lima. The host needs no listening port on the VM network.
3. On the host, `boxery-vsock.service` hands the connection to `boxery-proxy` on `127.0.0.1:8088`.
4. The proxy checks `<vm>:<secret>` against `~/.config/boxery/tokens.json`. It then strips the VM's auth and injects the real credential: the host pi's ChatGPT/Codex OAuth (refreshed automatically) or keys from `proxy.env`. Routes are allowlisted and size-limited. WebSocket upgrades are refused, so pi uses SSE.
5. `boxery rm` revokes the token. `boxery proxy-log` shows which VM called which provider.

## Known limits

- **Shared NAT network.** VMs share libvirt's `default` network. They can reach the internet and the host's sshd, but not the proxy port. For stricter isolation, give them a dedicated network with nwfilter rules (on the [roadmap](../ARCHITECTURE.md#roadmap)). The experimental [cloud-hypervisor backend](../host/backends/README.md#cloud-hypervisor-experimental) already isolates guests: one routed TAP per VM, and nftables drops guest→host, guest→guest and guest→private-range traffic.
- **Proxy spend.** A guest with root can read its own token and spend through the proxy. That's the same blast radius as handing it an API key, except the token is revocable per VM and logged. Per-VM budgets are planned.
- **Agents can ask for grants, not take them.** `vm_grant` adds a grant only after you approve a prompt that boxery shows and the agent can't answer. It can't ask for `http:` grants with a `--cmd`, key directories or boxery's own config ([Agents can ask](grants.md#agents-can-ask)). A client hook or setting that auto-accepts MCP elicitations would also auto-accept these.
- **HTTP MCP runs on the control plane.** `boxery-mcp --http` runs next to the credentials it protects, so its `vm_copy` refuses `local:` endpoints unless you start it with `--copy-root DIR`, which confines them to `DIR` and still refuses boxery's config, `~/.ssh`, `~/.gnupg` and `~/.pi` ([details](mcp.md#b-streamable-http-on-the-host-over-tailscale)). Anyone with the bearer token can drive every VM on that host; keep it on the tailnet behind `--allow-user`.
- **Pushed grants are readable.** `env:`/`file:` values (and the ssh-agent while connected) can be used or read by whatever runs in the VM. Grant dev-scoped credentials only, and prefer `http:` grants, whose values stay on the host.
- **One host.** No multi-host scheduling yet.

Found a security issue? Please report it privately through [GitHub security advisories](https://github.com/benvinegar/boxery/security/advisories/new) rather than a public issue.
