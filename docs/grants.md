# Grants

← [Docs](README.md)

By default a VM can't reach anything on your machine. A **grant** gives one VM access to one thing: your ssh-agent, an env var, or a file. You control grants from your machine, per VM. They're off by default.

```bash
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

## How it works

- **ssh-agent** turns on `ForwardAgent yes` for that VM only. Your private keys never leave your machine, but while you're connected, processes in the VM can ask your agent to sign.
- **env / file**: the local store (`~/.boxery/grants/NAME`) holds **names and paths only**. Values are read when grants are applied, then pushed over ssh into `/run/user/<uid>/boxery` in the VM. That's tmpfs, so values never touch the VM's disk and disappear on reboot.
  - Login and interactive shells source the env vars, and so does `vm_bash`.
  - Files are symlinked into place and added to `.git/info/exclude`.
- **Reconciled on every apply.** Grants are re-applied on `grant`, `revoke`, `new`, `start`, `revert`, `attach`, `ssh`, and when pi selects the VM. Each apply makes the VM match the current grants exactly, so revoked values are deleted.
- `boxery agent-forward NAME on|off` still works as an alias for `grant`/`revoke NAME ssh-agent`.

## What to grant

> [!WARNING]
> Whatever runs in the VM can read or copy anything you grant it. The agent has root there.

Grant **dev-scoped, revocable** credentials, such as a fine-grained GitHub token or a dev `.env`. Never grant production secrets. For keys that should never enter a VM, use the host-proxy pattern instead, the way LLM keys are handled ([Security](security.md#credential-proxy)).
