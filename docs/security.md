# Security model

← [Docs](README.md)

boxery is built for **one trusted owner running untrusted-ish agents**: the agents are yours, but you don't want a confused or prompt-injected agent walking off with your credentials or wrecking your laptop. It's not built for hostile multi-tenant use.

## What a VM can and can't reach

| | |
|---|---|
| ✅ The internet | Through libvirt's NAT network (or Lima's user network) |
| ✅ DNS and DHCP | From the host's network (libvirt's dnsmasq on the bridge address) |
| ✅ LLM providers | Only the ones you grant (`llm:chatgpt`, …), through the host proxy, with a per-VM token |
| ✅ What you [grant](grants.md) | ssh-agent, env vars, files: only while granted |
| 🔒 `http:`/`github` grant secrets | never: the host proxy injects them per request; the VM can use but not read them |
| ❌ Your real LLM keys / OAuth tokens | They stay on the host |
| ❌ Your laptop | No inbound path. ssh goes laptop → host → VM. With Lima the laptop *is* the host: on macOS a guest reaches the Mac's loopback (`127.0.0.1`) only on the proxy port. See [limits](#known-limits). |
| ❌ The host's sshd and other services | libvirt and Cloud Hypervisor guests can't open connections to the host: only DHCP and DNS reach it. Lima guests can reach the Mac's non-loopback addresses (see [limits](#known-limits)). |
| ❌ Other VMs | libvirt, Cloud Hypervisor: dropped on the host, and a guest can't take another's MAC or IP (ARP, IP and MAC spoofing are filtered) |
| ❌ Your LAN, Tailscale, cloud metadata | libvirt, Cloud Hypervisor: everything in `0/8`, `10/8`, `100.64/10` (CGNAT, Tailscale), `127/8`, `169.254/16` (link-local, `169.254.169.254`), `172.16/12`, `192.168/16` and `224/3` (multicast) is dropped, as is IPv6. Lima: see [limits](#known-limits) |

Inside the VM, everything listens on localhost: the desktop (noVNC on `127.0.0.1:6080`), Chrome's CDP port, and the proxy forwarder. You reach the desktop only through an ssh tunnel (`boxery desktop`).

The desktop also needs a password. websockify (noVNC) doesn't check the `Origin` header. While a `boxery desktop` tunnel is open, any process on your machine can reach it, and so can a web page in a browser that allows WebSockets to localhost. The VNC server therefore uses TigerVNC's `VncAuth` and never runs without a password. The password is 8 random letters and digits (VncAuth reads only 8 characters). It lives in `/run/user/UID/boxery-vnc/passwd`: tmpfs, mode `0600`, owned by the agent user, never on the VM's disk. `boxery-vnc.service` makes one before it starts the server, so a new VM is locked even if nobody opens its desktop. Each `boxery desktop` sets a new password and passes it to noVNC in the URL fragment, which isn't sent to the server or written to its logs ([details](cli.md#desktop-and-ports)). Computer use (`vm_screenshot`, `vm_click`, …, `vm_view`) talks to the X display directly over ssh, not to VNC, so the password doesn't affect it.

## VM host keys

Every ssh connection to a VM checks the VM's ssh host key: yours (`boxery ssh`, `run`, the agent tools, grant pushes, the ssh-agent forward) and the host's own (key and token installs, lease setup). boxery generates each VM's ed25519 host key on the host, puts it in the VM's seed (sshd presents only that key) and records the public half in `~/.config/boxery/host-keys/NAME`. Controllers fetch it from the host when they connect (`KnownHostsCommand … boxery-host known-hosts %H` in the generated `ssh_config`), and ssh runs with `StrictHostKeyChecking yes`. So a guest that answers on another VM's address gets nothing: not that VM's pushed grants, its ssh-agent forward or its proxy token.

- **A new identity gets a new key.** `new`, `fork` and `new --from` each get a fresh key. `revert` and pool resets keep the VM's own key, because its images carry it. `rm` removes the record.
- **boat.dev** VMs keep the platform's host key. boat reports it through its API, and boxery re-pins it whenever the VM may have moved to another machine (start, reimage).
- **Re-pinning.** A VM made before boxery pinned keys, or whose record was lost, is refused with "Host key verification failed". Re-pin it:

  ```bash
  boxery pin NAME                # reads the key through a channel the guest network can't spoof:
                                 # libvirt's guest agent, or Lima/exe/boat's loopback endpoint on the host
  boxery pin NAME --from-guest   # if that isn't available: trust what NAME's ssh endpoint answers, once
  ```

  `boxery start NAME` also pins such a VM automatically through those channels. `--from-guest` is the trust-on-first-use fallback: use it only when nothing else on the VM network could be impersonating NAME. With libvirt's guest isolation ([#69](https://github.com/modem-dev/boxery/issues/69)) no other guest can.
- **Older hosts.** A controller talking to a host from before this change keeps its old, unverified `ssh_config` and warns once a day until you run `boxery upgrade-host`. After that, the next command rewrites the config to verify keys.
- **Out of scope.** The hop from your laptop to the host is your own ssh to it and uses your `known_hosts`. exe.dev's and boat.dev's admin channels pin those platforms' keys separately ([backends](../host/backends/README.md)).

Guests run without swap, with core dumps disabled. Pushed grant files are `0400` and live on tmpfs.

## Credential proxy

VMs run agents that need LLM access, but they never get a real key. A VM gets no LLM access at all until you grant it a provider: `boxery grant VM llm:chatgpt` (or `llm:openai`, `llm:anthropic`, `llm:ollama`). See [Grants](grants.md).

```
VM: pi/opencode ──► 127.0.0.1:8088 ──vsock──► host: boxery-proxy ──► chatgpt.com / OpenAI / Anthropic / ollama
                    (per-VM token)                 checks token + llm: grant, swaps in real credential
```

1. `boxery-host new` writes the agent configs into the VM. They only say *where* to send requests; they don't grant anything:
   - `~/.pi/agent/models.json` overrides `openai-codex.baseUrl` with `http://127.0.0.1:8088/chatgpt/backend-api`. Its `apiKey` is an **unsigned fake JWT** whose payload carries `{"boxery":"<vm>:<secret>"}`. It has to be JWT-shaped because pi derives the ChatGPT account id from the JWT. Ollama models are listed too.
   - `~/.config/opencode/opencode.json` gets a `boxery` OpenAI-compatible provider pointing at `/ollama/v1`.
2. In the guest, `boxery-llm.service` forwards `127.0.0.1:8088` to the host: over vsock (CID 2) on libvirt, or the user-net gateway on Lima. The host needs no listening port on the VM network. Lima maps that gateway (`192.168.5.2`) to the host's loopback, so on macOS boxery starts each Lima instance under a sandbox that lets it reach only the proxy port there ([limits](#known-limits)).
3. On the host, `boxery-vsock.service` hands the connection to `boxery-proxy` on `127.0.0.1:8088`. A named host profile has its own pair on its own port (`boxery-vsock-NAME` → `boxery-proxy-NAME`).
4. The proxy checks `<vm>:<secret>` against `~/.config/boxery/tokens.json`, then checks that the VM holds an `llm:` grant for that provider (listed in `~/.config/boxery/edge/<vm>.json`, re-read on every request). No grant means 403, before any credential is attached. It then strips the VM's auth and injects the real credential: the host pi's ChatGPT/Codex OAuth (refreshed automatically) or keys from `proxy.env`. Routes are allowlisted and size-limited. WebSocket upgrades are refused, so pi uses SSE.
5. `boxery revoke VM llm:X` takes effect on the next request. `boxery rm` and pool lease resets revoke the token and all grants. `boxery proxy-log` shows which VM called which provider.

## GitHub Actions runners

`boxery-host runners` turns pool VMs into ephemeral self-hosted runners ([GitHub Actions runners](github-runners.md)). A workflow job runs arbitrary code from the repository, and from whoever can change its workflows, as root in the runner VM.

- **Private repositories only.** Never attach these runners to a public repository, or to an organization runner group that public repositories can use. On a public repository, a pull request from a fork can run its own workflow code on your runners, and so on your hardware and network. GitHub's own advice is the same: self-hosted runners are for private repositories.
- **One job per VM, then a reset.** Each runner is registered with a just-in-time config that takes exactly one job. When it exits, its lease is released and the pool resets the VM to `NAME@boxery-clean`, so a job can't leave anything behind for the next one: no files, processes, credentials or caches. A VM whose reset fails is quarantined (`broken`), as for any pool lease.
- **The same network as any pool VM, and no grants.** A job reaches the internet and nothing on the host, other VMs, your LAN or tailnet ([above](#what-a-vm-can-and-cant-reach); Lima's limits apply to Lima hosts). It has no LLM access and no `http:`/`env:`/`file:` grants: the runner manager grants nothing, and the VM's per-lease proxy token is useless without a grant. Secrets a job needs come from GitHub (Actions secrets), as on any runner.
- **The JIT config is the only GitHub credential in the guest.** The GitHub token (a fine-grained token that can manage runners: repository "Administration" or organization "Self-hosted runners", read and write) stays in `~/.config/boxery/runners.env` (`0600`; the manager refuses a file others can read). The manager sends it only in the `Authorization` header to the GitHub API it was configured with, and never logs it or a JIT config. The JIT config travels over ssh stdin (never a command line), sits on the guest's tmpfs until the runner reads it, and registers one runner for one job; the runner's own credentials then live on the VM's disk until the reset removes them. Anything in the guest can read the JIT config and, with it, impersonate that one runner, which can only take the job GitHub would have given it anyway.
- **The runner image is pinned.** The `github-runner` layer installs one actions/runner release, checked against its SHA-256 pinned in the layer, and the runner runs with self-update off: what runs is what the image was built with. Rebuild runner VMs after bumping the pin.
- **A job sees what the VM's clean image holds.** Whatever you install into a runner VM before `pool add` (tools, caches, repositories) is visible to every job. Put no credentials there.

## Known limits

- **Guest network isolation on libvirt.** VMs share libvirt's `default` NAT network (one bridge), and every guest's interface carries the nwfilter `boxery-guest-isolation`. libvirt applies it on the host whenever the domain starts, so root in the guest can't lift it, and it is part of the domain's configuration, so forks, reverts, lease resets and host reboots keep it. The guest's address is the one the host's DHCP server leased it (`CTRL_IP_LEARNING=dhcp`, answers only from the bridge address count); traffic from any other MAC or IP, and ARP claiming one, is dropped. To the host it may send DHCP and DNS only, and from outside it accepts replies and ssh from the host. The private ranges listed above are dropped, which is also what keeps guests apart (they share `192.168.122.0/24`). The policy is the [cloud-hypervisor backend's](../host/backends/README.md#cloud-hypervisor-experimental) (one routed TAP per VM and nftables), expressed as libvirt nwfilter rules, so it needs no root and no host firewall of boxery's own. What it doesn't cover:
  - **VMs made before this release** stay on the open network until their next cold start; `init` (and `upgrade`) adds the filter to their configuration, `boxery stop NAME && boxery start NAME` applies it.
  - **`BOXERY_NET_ISOLATION=off`** in `host.env` turns it off for VMs that must reach LAN services ([install](install.md#linux-host-libvirtkvm)). Their guests then reach the host's sshd and services on the bridge address, each other and every network the host routes to.
  - **Public addresses of the host itself** (a cloud VM's public IP) aren't in a blocked range, so a guest reaches services the host exposes there, as anyone on the internet can.
  - **DNS answers** come from the host's resolver. A guest can resolve internal names; it just can't connect to private addresses.
- **Lima guests and the host's loopback.** Lima NATs the guest's gateway, `192.168.5.2`, to the host's `127.0.0.1`. Left alone, that hands every guest each loopback service on the Mac: Ollama's admin API (`/api/pull`, `/api/delete`, bypassing the proxy's allowlist), the HTTP MCP server, dev databases ([#67](https://github.com/modem-dev/boxery/issues/67)). On macOS, boxery therefore starts every Lima instance under `sandbox-exec` with a Seatbelt profile. Lima's host agent, which carries the guest's network, and the qemu it spawns may then open loopback connections only to the proxy port and to the instance's own ssh port, which leads back to the guest's own sshd. Everything else on `127.0.0.1` (any 127/8 address, TCP and UDP) is refused. The Mac's kernel enforces it, so root in the guest can't lift it. What it doesn't cover:
  - **Services listening on the Mac's other addresses** (`0.0.0.0`, the LAN or Tailscale IP) stay reachable from guests, as from your LAN. Guest traffic leaves through the Mac's own routing, so guests also reach your LAN and tailnet.
  - **Instances started outside boxery** (a plain `limactl start boxery-NAME`) and VMs that were already running when you upgraded aren't confined. Restart them with `boxery stop NAME && boxery start NAME`.
  - **Lima on Linux** has no Seatbelt. Its guests still reach the host's loopback; use libvirt or Cloud Hypervisor there.
  - A host-side HTTP proxy or DNS resolver on `127.0.0.1` is out of reach for Lima guests too. Confined qemu instances use slirp's DNS forwarder (`192.168.5.3`) instead of Lima's host resolver, which listens on loopback.
- **Proxy spend.** A guest with root can read its own token and spend through every provider it's been granted. That's the same blast radius as handing it an API key, except the token is revocable per VM and logged. Per-VM budgets are planned.
- **Agents can ask for grants, not take them.** `vm_grant` adds a grant only after you approve a prompt that boxery shows and the agent can't answer. It can't ask for `http:` grants with a `--cmd`, files in `~/.ssh`, `~/.gnupg`, `~/.pi` or boxery's own config (the same set `vm_copy --copy-root` refuses), or `env:BOXERY_*` variables such as the HTTP MCP token ([Agents can ask](grants.md#agents-can-ask)). A requested file is stored by its real path, and an apply skips any granted file that has since been re-pointed through a symlink into one of those directories. A client hook or setting that auto-accepts MCP elicitations would also auto-accept these.
- **HTTP MCP runs on the control plane.** `boxery-mcp --http` runs next to the credentials it protects, so its `vm_copy` refuses `local:` endpoints unless you start it with `--copy-root DIR`, which confines them to `DIR` and still refuses boxery's config, `~/.ssh`, `~/.gnupg` and `~/.pi` ([details](mcp.md#b-streamable-http-on-the-host-over-tailscale)). Anyone with the bearer token can drive every VM on that host; keep it on the tailnet behind `--allow-user`.
- **Pushed grants are readable.** `env:`/`file:` values (and the ssh-agent while connected) can be used or read by whatever runs in the VM. Grant dev-scoped credentials only, and prefer `http:` grants, whose values stay on the host.
- **Desktops from older bases have no VNC password.** The password is part of the desktop base image. VMs made from a base built before it have an open VNC server, and so do their snapshots and images: while a `boxery desktop` tunnel is open, any local process or web page can drive that desktop, including its logged-in browser. `boxery desktop` warns when it opens one. Rebuild the base (`boxery build-base`) and create those VMs again ([details](cli.md#desktop-and-ports)).
- **Desktop password limits.** VncAuth is old (a DES challenge-response, 8 characters at most). It stops processes and pages on your machine that would guess, but not anything that can read your browser's history: the URL is saved there, and its password works until the next `boxery desktop` or a reboot of the VM replaces it. TigerVNC blocks an address for a while after 5 failed logins. Every login through the tunnel comes from `127.0.0.1`, so a local process that keeps guessing can also lock you out for a while.
- **Guest patches are as fresh as the VM.** Every VM gets the security updates available when its disk was made: the base build (desktop) or its first boot (headless) runs `apt-get full-upgrade`. After that, only Ubuntu's unattended-upgrades patches it, and a new kernel runs from the next restart. Snapshots, images and pool clean states keep what they were captured with. `boxery ls` marks a VM `outdated` when it was built from other image layers than the host's, more than 30 days ago, or when it waits for a reboot, and `unknown` when it predates build records ([details](cli.md#lifecycle)); `snaps` and `images` show the same for images. `boxery patch NAME` (or `--all`) runs the VM's layers again with the host's current files: the updates, a restart if they ask for one, and the software the layers install outside apt (`playwright-core` and its Chromium on arm64, node 24, the pi and opencode CLIs npm installed). For a pool VM it also captures the clean state again. What it doesn't cover:
  - **Snapshots and images** aren't patched. A VM made or reverted from one starts with its old software; patch it afterwards, or take the snapshot again.
  - **The desktop base** isn't patched: VMs cloned from it start with its software until patched. Rebuild it (`boxery build-base`) to make new desktops current.
  - **Staleness is a record, not a scan.** It says what boxery installed and when, read when the host last reached the VM (`ls --refresh` reads it again). Packages someone updated by hand aren't counted, and a VM that unattended-upgrades kept patched still shows its build's age.
  - **Kept software.** devtools keeps what the starting image ships: on exeuntu (exe.dev), `patch` leaves the image's own node, and an agent CLI that isn't npm's global install of its package, as they are (apt packages still update).
  - **The arm64 browser** is Playwright's Chromium build, which only changes when `playwright-core` releases a new one, and can lag Chrome's security fixes by weeks.
- **One host.** No multi-host scheduling yet.

Found a security issue? Please report it privately through [GitHub security advisories](https://github.com/modem-dev/boxery/security/advisories/new) rather than a public issue.
