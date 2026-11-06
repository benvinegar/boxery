# Named controller hosts

Every VM host the controller knows is a registered NAME. `boxery setup` registers one (see [Install](install.md)); the first host becomes the default. One controller/MCP server can reach several hosts. This adds routing, not a fleet scheduler or migration system. The existing [pool lease commands](pool.md) operate within the selected host profile. VM identity is **(host, VM name)**; `demo` on two hosts denotes two different machines.

## CLI

```bash
# setup registers (or reconfigures) a host named after its destination: local, or hornet here.
boxery setup local
boxery setup you@hornet --host-bin '~/.local/bin/boxery-host'
boxery setup you@10.0.0.5 --name lab  # --name when the destination doesn't make a name

# host add does the same without reconfiguring an existing host.
boxery host add laptop local --key ~/.ssh/id_ed25519.pub
boxery host add hornet you@hornet --host-bin '~/.local/bin/boxery-host'
# A second VM platform on a host that already runs one (here: exe.dev beside Lima on this Mac).
boxery host add exe local --backend exe
boxery --host exe build-base         # desktop base image, once (~3 min); headless VMs don't need it

boxery host ls                       # name, default marker, config directory, destination, backend, same-profile names
boxery host show hornet              # prints its config directory (not credentials)
boxery host use hornet               # atomic default selection
boxery --host laptop ls              # explicit selection overrides the default
boxery --host hornet new demo
boxery --host hornet desktop demo
boxery --host hornet grant demo ssh-agent
boxery host rm hornet                # forget registration only
```

Names use `[a-z][a-z0-9-]{0,30}`. Unknown/invalid explicit names fail closed, and with no `--host` and no default host nothing is routed anywhere. `--host NAME` must precede the command. Registration commands operate on the registry, not the selected host, and cannot be combined with `--host`.

`host add NAME DEST [--key PUBKEY] [--host-bin PATH] [--backend B | --profile P]` never overwrites a registration or existing managed profile directory. DEST is `local` or an SSH destination/SSH-config alias (option-like destinations and shell syntax are rejected). HOST_BIN is **one executable path**, not a command expression. Quote `~/...` to leave it for the remote host; on `local`, it refers to the controller's home. Spaces and apostrophes are supported. Paths used in generated configuration cannot contain newlines, carriage returns or tabs. Setup checks the executable and registers the public key before publishing the profile. Failed checks do not select or register a partial profile. A remote key registration that has already succeeded cannot be rolled back if a subsequent local write fails. The first host registered becomes the default; later ones don't change it.

`setup DEST [--name NAME] [--key PUBKEY] [--host-bin PATH] [--backend B | --profile P]` is `host add` with a derived name: `local`, or DEST's host part (`you@hornet.example.com` → `hornet`). If NAME is already registered, setup reconfigures that host in place (new key, executable or destination) instead. It does not take `--host`.

### Several backends on one machine

One VM host can run more than one backend (Lima and exe.dev on a Mac, libvirt and boat.dev on a Linux box). Each runs as its own **host profile**: its own state directory, proxy port, proxy and reaper services, lease store and VMs. `--backend B` creates one on DEST, named after the host alias, and registers it in one step:

```bash
boxery host add exe local --backend exe                 # this machine
boxery host add hornet-boat you@hornet --backend boat   # a remote host
boxery host add exe2 local --profile exe                # another alias for a profile that already exists
```

`--backend` runs `boxery-host --profile NAME init --backend B` on DEST. The profile lives in `~/.config/boxery-NAME` there; on its first init it gets the first free proxy port from 8089 and the services `boxery-proxy-NAME` and `boxery-reaper-NAME`, all recorded in its `host.env`. The controller profile stores `HOST_PROFILE=NAME` and passes `--profile NAME` on every call and in its ProxyCommand, so no wrapper script or environment variable is involved. Re-running is safe: init keeps an existing profile's port and settings, so after a failed setup (a backend check, say) fix the cause and run the same `host add` again.

Init refuses a new profile that would collide with an existing one on that machine: the same proxy port or service name, or the same backend with the same settings (both would manage the same VMs under two lease stores). Two profiles of one backend need their own namespace, such as `BOXERY_LIMA_PREFIX` or `BOXERY_EXE_DIR` and `BOXERY_EXE_PORT_BASE`. Backend settings and secrets that init reads from the environment (`BOAT_API_KEY`, `BOXERY_EXE_KEY`, …) reach it only for `local`: `BOAT_API_KEY=… boxery host add boat local --backend boat`. For a remote host, run init there, then register it:

```bash
ssh you@hornet 'BOAT_API_KEY=boat_… boxery-host --profile boat init --backend boat'
boxery host add hornet-boat you@hornet --profile boat
```

On the host, `boxery-host profiles` lists every profile (backend, port, service, directory) and `boxery-host --profile NAME COMMAND` runs a command in one. `boxery-host upgrade` re-runs init for all of them.

## Where each host runs

`boxery host ls` (and `--json`, and MCP `vm_info {action:"hosts"}`) says where each registered host runs, read from local profile files without contacting any host:

```text
NAME	DEFAULT	CONFIG_DIR	DESTINATION	BACKEND	SAME_AS
exe		/home/you/.boxery/profiles/exe	local	exe	-
hornet		/home/you/.boxery/profiles/hornet	you@hornet	libvirt	-
local	*	/home/you/.boxery/profiles/local	local	lima	-
```

* **DESTINATION** is the profile's `HOST`: `local` means the VM host is the machine running the controller (or the MCP server); otherwise it is the ssh destination or ssh-config alias. The CLI sources the trusted profile config to find it; MCP never executes it and parses only plain assignments (as `setup` writes them), so a computed value shows as unknown (`-` / `null`).
* **BACKEND** lives on the VM host (`host.env`), so it is not read live. `setup` and `host add` record it in the profile's `backend` file (one line of data); `boxery [--host NAME] backend` asks the host and refreshes the record. Profiles set up earlier, or hosts that predate `boxery-host backend`, show `-` / `null` until then.
* **SAME_AS** lists the other names registered for the same profile directory, for example after `host add laptop --config-dir ~/.boxery/profiles/local`: `local` and `laptop` are one host with the same VMs, not two.

## Importing two existing profiles

Import does **not** run setup, contact either host, copy credentials, regenerate SSH configuration or move grants:

```bash
# Two existing profile directories:
boxery host add laptop --config-dir "$HOME/.boxery-laptop"
boxery host add hornet --config-dir "$HOME/.boxery-hornet"
boxery host use laptop
boxery --host laptop ls
boxery --host hornet ls
boxery-mcp --host laptop --vm demo
```

Both `config` and `ssh_config` must already exist. Import records the canonical absolute directory. Each distinct host must have its own config directory, SSH control paths and grant store. Importing the same directory under two aliases does not create isolation or change the imported SSH config. Setting up the default host prints an SSH-config-quoted/escaped `Include` recommendation; other hosts get explicit host routing instead. Avoid including multiple profiles' `*.boxery` sections in your global SSH config: duplicate VM aliases are ambiguous there. Prefer `boxery --host NAME ssh demo`, or `ssh -F "$(boxery host show NAME)/ssh_config" demo.boxery`. For paths containing `%`, setup recommends `-F` instead of an Include because OpenSSH versions differ on percent expansion in Include.

## Layout and precedence

`BOXERY_HOME` is the registry root (default `~/.boxery`), not a host:

```text
$BOXERY_HOME/
  host-registry/NAME                # exactly one absolute profile directory + newline
  default-host                      # exactly one registered NAME + newline; absent = no host selected
  profiles/NAME/                    # profiles provisioned by setup / host add NAME DEST
    config, ssh_config, grants/, leases/
```

A profile directory can be anywhere, including `BOXERY_HOME` itself (an imported pre-registry setup); only the registry decides which hosts exist.

Registry metadata must be readable regular files, not symlinks (including dangling symlinks), with exactly one NUL-free newline-terminated line. An absent `default-host` means no host is selected; malformed or unreadable metadata is an error in both CLI and core. `host use` refuses to replace/reset malformed selection metadata rather than removing unexpected data. Registry files contain data, never shell code. Profile `config` files remain trusted user-owned shell files. Do not import untrusted directories. Registry mutations use a short-lived `host-registry/.lock` file; default changes use atomic rename. After a killed writer, remove a stale `.lock` only after verifying no registry writer is running. Long profile paths can exceed OpenSSH's platform-specific Unix control-socket path limit; use a shorter BOXERY_HOME when needed.

* CLI: leading `--host NAME` > `default-host`; otherwise the command fails. `host add` sets the default only when there is none. The destination and host executable come only from the profile's `config` (no `BOXERY_HOST` / `BOXERY_HOST_BIN` overrides); use `--host-bin` when provisioning.
* MCP: explicit tool `host` > session host, initially startup `--host` > registry default; with neither, startup fails. No new ambient BOXERY_HOST alias selector is introduced. `--vm` > existing `BOXERY_VM` sets the startup VM, bound to that initial host.
* pi: `--vm-host NAME` > registry default, resolved on first use and then kept for the session; a changed CLI default doesn't redirect it. Every `vm_*` tool accepts optional `host`, and `vm_manage {action:"host"}` or `/vm host NAME` switches the session's host. Saved VM entries record host identity: `pi --continue` resumes on that host, and doesn't follow a name that now points at another profile ([pi extension](pi-extension.md#hosts)).

MCP snapshots the resolved profile directory for each call, including nested operations and abort/timeout cleanup. HTTP sessions have independent host+VM state. Changing the CLI default does not retarget existing MCP sessions. Forgetting/replacing a registration does not revoke already-resolved sessions: restart those clients when retiring a host. Explicit names are always looked up afresh and unknown names fail.

## MCP tools

Every `vm_*` tool accepts optional `host`. For example:

```json
{"host":"hornet","vm":"demo","command":"hostname"}
```

`vm_info {"action":"hosts"}` lists the hosts with the same fields as `boxery host ls --json` plus `current` (this session's host; text output marks it `*`), see [Where each host runs](#where-each-host-runs). `vm_manage` adds session selection `{"action":"host","host":"hornet"}` and registration `{"action":"host_add","name":"exe","dest":"local","backend":"exe"}` and `{"action":"host_rm","name":"exe"}` (see below). Host selection clears the current VM, even when selecting the same host. `use` and `new` with `use:true` select both host and VM after success. `rm` clears the current VM only when both its host and name match. An explicit other host without an explicit VM never inherits the current VM's name. `host_add` does what `boxery host add NAME DEST` does (the same code, in the server's process) with optional `backend` or `profile`, and `buildBase:true` then runs `build-base` on the new host. Nothing can ask anything there (ssh runs in batch mode: the host must already be reachable without a prompt), and setup's output is the answer. It uses your default ssh key and host executable: there is no `key`, `host-bin` or `config-dir` (those name files on the server's machine, and an imported config is shell code). It becomes the CLI default only when there is none, and doesn't select the new host for the session; follow it with `{"action":"host","host":"exe"}`. `host_rm` does what `boxery host rm NAME` does: it forgets the registration only and refuses the CLI default (see [removal safety](#removal-safety-and-leases)); sessions already using that host keep it until they select another. `{"action":"build-base"}` builds the call's host's desktop base image, like `boxery build-base`; the backends refuse while VMs or snapshots depend on the current base. `vm_manage` cannot change the persistent CLI default, upgrade a host, add credentials or grant access. `vm_grant` can *ask* the user for a grant on any host; they approve it in a prompt ([Agents can ask](grants.md#agents-can-ask)).

Selection mutations complete in completion order; concurrent ordinary tool calls keep the host+VM snapshot they started with. Screenshot scaling is keyed by profile directory and VM name.

### Copy locations and “local”

`vm_copy` accepts:

* `HOST/VM:/path`: explicitly registered host and VM, independently for each endpoint;
* `VM:/path`: VM on the call's selected host;
* a bare path: current VM on that host (or the optional explicit `vm`);
* `local:/path`: **the machine running MCP**, not the selected VM host. On a Mac stdio server this means the Mac; on an HTTP server elsewhere it means that server machine, and is refused unless the server runs with `--copy-root DIR` ([MCP server](mcp.md#b-streamable-http-on-the-host-over-tailscale)).

VM-relative paths start at `/home/agent/project`; `~` means `/home/agent`. Local relative paths start at the server's working directory; local `~` means the server user's home. Unknown hosts in `HOST/VM:` are errors, not literal paths or fallback targets. A relative path containing `/` before a colon is interpreted as an explicit host/VM endpoint; use an absolute VM path to disambiguate a literal filename of that shape.

```json
{"from":"laptop/demo:build/output","to":"hornet/demo:incoming"}
{"from":"hornet/demo:logs.txt","to":"local:./logs.txt"}
```

Copies are streaming tar transfers through the server, not direct host-to-host connections. Each endpoint stays bound to its resolved SSH profile throughout the transfer and cleanup. Agent memory is bounded by stream buffers rather than archive size; local macOS uploads omit AppleDouble metadata. See [file transfers](copy.md) for staging, destination semantics and cancellation limits.

## Removal safety and leases

`host rm NAME` refuses the default host: first select another with `host use`. It removes **only** the registration pointer. Profile files, grants, SSH connections, host authorization and remote VMs remain. To revoke access, do so explicitly before forgetting the registration; to destroy a VM, use `boxery --host NAME rm VM`. Forgotten managed data must be explicitly imported to reuse it, not silently overwritten by another provisioning operation.

The CLI's existing pool commands are host-scoped: `boxery --host hornet acquire`, `renew`, `release` and `leases` use that profile's lease records and throwaway SSH keys. HTTP-grant records and edge-route markers are also profile-local. The pi extension's `--vm pool` uses the session's host and retains automatic renewal/release. `vm_lease` (pi and MCP) holds each lease against the host it was acquired from, and renews and releases it there.

Registering a host neither obtains a lease nor authorizes access to existing guests; leases come only from `vm_lease {action:"acquire"}` (or the CLI/pi equivalents). Observe the host's own pool/lease and credential policies; do not treat `use` (which may create a missing VM) as lease acquisition or take over an existing shared VM. There is no cross-host scheduling, automatic migration or credential distribution here: grants are per host profile, and a VM on a new host gets them from `boxery --host NAME grant` or an approved `vm_grant` request.
