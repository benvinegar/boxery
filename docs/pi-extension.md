# pi extension

← [Docs](README.md)

The main way to use boxery: [pi](https://pi.dev) runs on your laptop with your model login and your extensions, and gets explicit `vm_*` tools for the VMs.

pi's built-in `bash`/`read`/`write`/`edit` are **left alone** and keep working on your laptop. The agent can work on both sides, and other extensions that wrap the built-ins keep working.

## Install

```bash
pi install ~/boxery              # or, for one session: pi -e ~/boxery/extension/index.ts
```

Requires a configured controller (`boxery setup …`, see [Install](install.md)).

## Pick a VM

```bash
pi --vm demo                     # current VM "demo" (created if missing)
pi --vm new                      # throwaway VM, deleted when the session ends
pi --vm pool                     # lease a VM from the shared pool (see pool.md)
pi --vm pool --vm-ttl 3600       # lease length in seconds; renewed automatically while pi runs
pi --vm demo --vm-grant ssh-agent,env:GH_TOKEN,file:.env
pi                               # no current VM; the agent can still create one with vm_manage
```

The current VM is saved in the session, so `pi --continue` picks it back up. Throwaway VMs and leases belong to their pi process. They're given back as soon as they stop being current: when you quit, `/new`, `/resume`, fork, or switch VMs.

## Tools

| Tool | |
|---|---|
| `vm_bash`, `vm_read`, `vm_write`, `vm_edit` | Shell and files in the VM. Same engines as the built-ins, with the same truncation, edit semantics and image handling. Relative paths resolve to `/home/agent/project`. |
| `vm_copy` | Files and directories between `local:path`, `NAME:path`, or a bare path (= current VM). Works VM to VM too. |
| `vm_screenshot` | Screenshot of the XFCE desktop, downscaled to 1280 px (clicks are scaled back) |
| `vm_click`, `vm_type`, `vm_key`, `vm_scroll` | Computer use via xdotool on `:1` |
| `vm_browser` | Playwright code against Chrome on the desktop over CDP. Watch it live with `/vm desktop`. |
| `vm_manage` | `list` · `new` · `rm` · `snap` · `revert` · `use` · `none` · `grants` |

Every tool takes an optional `vm` argument (default: the current VM), so one agent can **fan out** across several VMs at once. The system prompt tells the model that project work happens in the VM through `vm_*` tools, and that built-ins act locally.

## Commands

| Command | |
|---|---|
| `/vm` | Show the current VM |
| `/vm use NAME` | Switch to NAME (created if missing) |
| `/vm new [NAME]` | New VM. Without a name, it's a throwaway. |
| `/vm pool` | Lease a VM from the shared pool |
| `/vm off` | No current VM (releases a lease, removes a throwaway) |
| `/vm ls` · `/vm rm NAME` | List / remove VMs |
| `/vm desktop [NAME]` | Open the desktop in your browser |
| `/vm grant SPEC…` · `/vm revoke SPEC…` · `/vm grants` | Manage [grants](grants.md) for the current VM |

## Tips

- **Watch the agent work:** `/vm desktop` opens noVNC in your browser. `vm_browser` drives the same Chrome you see.
- **Checkpoints:** ask the agent to `vm_manage snap` before something risky, then `revert` if it goes wrong. A snapshot takes about 2 s.
- **Long jobs:** to keep a task running after your laptop sleeps, start an in-VM agent with `boxery prompt NAME "…"` ([CLI](cli.md)).
