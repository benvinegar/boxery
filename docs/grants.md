# Grants

← [Docs](README.md)

By default a VM can't reach anything on your machine. A **grant** gives one VM access to one thing: an HTTPS API, your ssh-agent, an env var, or a file. You control grants from your machine, per VM. They're off by default.

```bash
boxery grant demo github                              # git clone/push + GitHub API over https; the token never enters the VM
boxery grant demo github --readonly                   # …clone/fetch and API reads only
boxery grant demo http:registry.npmjs.org --cmd 'npm token get'                 # any HTTPS API (bearer by default)
boxery grant demo http:api.example.com --auth header:X-Api-Key --cmd 'pass show example'
boxery grant demo ssh-agent                           # git over ssh (git@github.com:…) with your keys
boxery grant demo env:GH_TOKEN --cmd 'gh auth token'  # value from a command…
boxery grant demo env:NPM_TOKEN                       # …or from your current environment
boxery grant demo file:.env                           # → /home/agent/project/.env
boxery grant demo file:~/.npmrc=.npmrc                # remote paths are relative to /home/agent
boxery grants demo                                    # list (boxery ls shows them too)
boxery revoke demo env:GH_TOKEN                       # or: revoke demo all
```

You can also grant at creation time, or from pi:

```bash
boxery new web --grant ssh-agent --grant file:.env
pi --vm demo --vm-grant ssh-agent,env:GH_TOKEN,file:.env
/vm grant env:GH_TOKEN                                # inside pi, for the current VM
```

## Agents can ask

An agent can't grant itself anything, but it can ask. When work in a VM fails for lack of access (`pnpm install` gets a 401, git wants credentials), the `vm_grant` tool asks you in a prompt:

```text
Give VM "demo" on host "hornet" access to:

file: /Users/you/Library/Preferences/pnpm/auth.ini → /home/agent/.config/pnpm/auth.ini
Its contents are copied into the VM's memory (tmpfs, never its disk or snapshots). Anything running in the VM can read it.

Revoke any time: boxery --host hornet revoke demo file:/Users/you/Library/Preferences/pnpm/auth.ini

The agent's reason: "pnpm install got a 401 from the registry"
```

If you allow it, the tool runs `boxery grant` for you, which applies the grant the same way. If you decline, nothing changes, and the agent is told not to ask again.

- **The prompt comes from boxery, not the agent.** In MCP clients it's an [elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation), and in pi it's a confirm dialog. Neither is a tool call the agent can answer. A client that can't show one (no form elicitation, a plain-JSON HTTP call, pi in print mode) gets no prompt: the agent gets the exact `boxery grant …` command to pass on to you.
- **Agents can request `github` (optionally `readonly`), `ssh-agent`, `env:VAR` and `file:LOCAL[=REMOTE]`.** They can't request `http:` grants or `--cmd`, since those run a command on your machine. They also can't request files under `~/.ssh`, `~/.gnupg` or boxery's own config directories. An `env:VAR` request needs `VAR` set where boxery runs.
- One prompt at a time per session. Something already granted is reported without a prompt.
- The agent's reason is shown last and labelled as the agent's. Judge the request by the lines above it.

This is the way to get credentials into a VM on another [host](hosts.md). Grants belong to a host profile, so a VM on `hornet` starts with none of your local VMs' grants. Agents are told never to copy credentials in with `vm_copy` or `vm_write`, because a copy lands on the VM's disk and in its snapshots.

## How it works

- **http:HOST and github (edge-injected).** The secret never enters the VM.
  - When grants are applied, `--cmd` runs on your machine (`gh auth token` for `github`). The resulting header goes to the host proxy, in `~/.config/boxery/edge/NAME.json` (mode 0600). The VM only gets a URL, `$BOXERY_EDGE/<host>/…`, which carries its per-VM proxy token.
  - The proxy checks the token and allows only granted hosts, over HTTPS (no IPs or ports). It strips the VM's own auth headers and cookies, adds the credential, and logs the call (`boxery proxy-log`). Redirects are never followed with credentials attached.
  - **git**: an included gitconfig in tmpfs maps `https://HOST/` to the edge. Plain `git clone https://github.com/you/private` works, and remotes stay `https://github.com/…`.
  - **npm**: `npm_config_registry` points at the edge when `registry.npmjs.org` is granted.
  - **Anything else**: `curl "$BOXERY_EDGE/api.github.com/user"`.
  - `--readonly` allows GET/HEAD and git fetch only. `--auth` is `bearer` (default), `basic:USER`, or `header:NAME`.
  - Revoking takes effect on the next request. `rm` and pool lease resets clear the routes.
  - Not covered yet: the `gh` CLI only talks to `https://` hosts. Use `gh api http://…` or `curl` against `$BOXERY_EDGE`, or an `env:GH_TOKEN` grant.
- **ssh-agent** turns on `ForwardAgent yes` for that VM only. Your private keys never leave your machine, but while you're connected, processes in the VM can ask your agent to sign. Background jobs (`boxery run --bg`, `vm_jobs`) outlive the connection, so they run without the agent; use an `http:`/`github` grant for git in jobs.
- **env / file**: the local store (`~/.boxery/grants/NAME`) holds **names and paths only**. Values are read when grants are applied, then pushed over ssh into `/run/user/<uid>/boxery` in the VM. That's tmpfs, so values never touch the VM's disk and disappear on reboot.
  - Login and interactive shells source the env vars, and so does `vm_bash`.
  - Files are symlinked into place and added to `.git/info/exclude`.
- **Reconciled on every apply.** Grants are re-applied on `grant`, `revoke`, `new`, `start`, `revert`, `attach`, `ssh`, and when pi selects the VM. Each apply makes the VM match the current grants exactly, so revoked values are deleted.
- `boxery agent-forward NAME on|off` still works as an alias for `grant`/`revoke NAME ssh-agent`.

## What to grant

> [!WARNING]
> Whatever runs in the VM can read or copy anything you grant it. The agent has root there.

Grant **dev-scoped, revocable** credentials, such as a fine-grained GitHub token or a dev `.env`. Never grant production secrets. For HTTP APIs, prefer `http:`/`github` grants: the VM can *use* the credential while the grant lasts, but never *holds* it. That's the same pattern as LLM keys ([Security](security.md#credential-proxy)). APIs can still echo request headers back in a response, so only grant APIs you trust.
