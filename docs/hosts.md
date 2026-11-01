# Named controller hosts

One controller/MCP server can reach several explicitly registered VM hosts. This adds routing, not a fleet scheduler or migration system. The existing [pool lease commands](pool.md) operate within the selected host profile. VM identity is **(host, VM name)**; `demo` on two hosts denotes two different machines.

## CLI

```bash
# Provision a new controller profile; registers your public key for future new VMs.
boxery host add laptop local --key ~/.ssh/id_ed25519.pub
boxery host add hornet you@hornet --host-bin '~/.local/bin/boxery-host'

boxery host ls                       # name, default marker, config directory, destination, backend, same-profile names
boxery host show hornet              # prints its config directory (not credentials)
boxery host use hornet               # atomic default selection
boxery --host laptop ls              # explicit selection overrides the default
boxery --host hornet new demo
boxery --host hornet desktop demo
boxery --host hornet grant demo ssh-agent
boxery host use legacy               # reset to the original root profile
boxery host rm hornet                # forget registration only
```

Names use `[a-z][a-z0-9-]{0,30}`. `legacy` is reserved for the original root profile. Unknown/invalid explicit names fail closed. `--host NAME` must precede the command. Registration commands operate on the registry, not the selected host, and cannot be combined with `--host`.

`host add NAME DEST [--key PUBKEY] [--host-bin PATH]` never overwrites a registration or existing managed profile directory. DEST is `local` or an SSH destination/SSH-config alias (option-like destinations and shell syntax are rejected). HOST_BIN is **one executable path**, not a command expression. Quote `~/...` to leave it for the remote host; on `local`, it refers to the controller's home. Spaces and apostrophes are supported. Paths used in generated configuration cannot contain newlines, carriage returns or tabs. Setup checks the executable and registers the public key before publishing the profile. Failed checks do not select or register a partial profile. A remote key registration that has already succeeded cannot be rolled back if a subsequent local write fails.

## Where each host runs

`boxery host ls` (and `--json`, and MCP `vm_info {action:"hosts"}`) says where each registered host runs, read from local profile files without contacting any host:

```text
NAME	DEFAULT	CONFIG_DIR	DESTINATION	BACKEND	SAME_AS
legacy		/home/you/.boxery	local	lima	laptop
hornet		/home/you/.boxery/profiles/hornet	you@hornet	libvirt	-
laptop	*	/home/you/.boxery	local	lima	legacy
```

* **DESTINATION** is the profile's `HOST`: `local` means the VM host is the machine running the controller (or the MCP server); otherwise it is the ssh destination or ssh-config alias. `legacy` honors `BOXERY_HOST`, as routing does. The CLI sources the trusted profile config to find it; MCP never executes it and parses only plain assignments (as `setup` writes them), so a computed value shows as unknown (`-` / `null`).
* **BACKEND** lives on the VM host (`host.env`), so it is not read live. `setup` and `host add` record it in the profile's `backend` file (one line of data); `boxery [--host NAME] backend` asks the host and refreshes the record. Profiles set up earlier, or hosts that predate `boxery-host backend`, show `-` / `null` until then.
* **SAME_AS** lists the other names whose profile is the same directory. `legacy` is the unnamed root profile (`$BOXERY_HOME`, normally `~/.boxery`), used when no `default-host` is set; after `host add laptop --config-dir ~/.boxery`, `legacy` and `laptop` are one host with the same VMs, not two.

## Importing two existing profiles

Import does **not** run setup, contact either host, copy credentials, regenerate SSH configuration or move grants:

```bash
# Original local controller and a separately configured remote controller:
boxery host add laptop --config-dir "$HOME/.boxery"
boxery host add hornet --config-dir "$HOME/.boxery-hornet"
boxery host use laptop
boxery --host laptop ls
boxery --host hornet ls
boxery-mcp --host laptop --vm demo
```

Both `config` and `ssh_config` must already exist. Import records the canonical absolute directory. Each distinct host must have its own config directory, SSH control paths and grant store. Importing the same directory under two aliases does not create isolation or change the imported SSH config. Legacy setup prints an SSH-config-quoted/escaped `Include` recommendation; named setup instead recommends explicit host routing. Avoid including multiple profiles' `*.boxery` sections in your global SSH config: duplicate VM aliases are ambiguous there. Prefer `boxery --host NAME ssh demo`, or `ssh -F "$(boxery host show NAME)/ssh_config" demo.boxery`. Legacy setup quotes its optional global Include recommendation; for paths containing `%`, it recommends `-F` instead because OpenSSH versions differ on percent expansion in Include.

## Layout and precedence

`BOXERY_HOME` is the registry root (default `~/.boxery`), not an implicit host name:

```text
$BOXERY_HOME/
  config, ssh_config, grants/, leases/  # original legacy profile, unchanged
  host-registry/NAME                # exactly one absolute profile directory + newline
  default-host                      # exactly one registered NAME + newline; absent = legacy
  profiles/NAME/                    # profiles provisioned by host add NAME DEST
    config, ssh_config, grants/, leases/
```

Registry metadata must be readable regular files, not symlinks (including dangling symlinks), with exactly one NUL-free newline-terminated line. Only an absent `default-host` means legacy fallback; malformed or unreadable metadata is an error in both CLI and core. `host use` refuses to replace/reset malformed selection metadata rather than removing unexpected data. Registry files contain data, never shell code. Profile `config` files remain trusted user-owned shell files. Do not import untrusted directories. Registry mutations use a short-lived `host-registry/.lock` directory; default changes use atomic rename (reset uses unlink). After a killed writer, remove a stale `.lock` only after verifying no registry writer is running. Long profile paths can exceed OpenSSH's platform-specific Unix control-socket path limit; use a shorter BOXERY_HOME when needed.

* CLI: leading `--host NAME` > `default-host` > legacy root. `--host legacy` explicitly bypasses a named default. `setup` configures the selected profile; `host add` never changes the default.
* Legacy root continues to honor `BOXERY_HOST` / `BOXERY_HOST_BIN` overrides. Named profiles ignore those ambient overrides; new managed profiles start with their own HOST_BIN default. Use `--host-bin` when provisioning them.
* MCP: explicit tool `host` > session host, initially startup `--host` > registry default > legacy. No new ambient BOXERY_HOST alias selector is introduced. `--vm` > existing `BOXERY_VM` sets the startup VM, bound to that initial host.
* Existing pi extension tool/flag APIs are unchanged. Its implicit host is pinned on first transport use for the process; desktop tunnels and core transport use the same profile. Restart pi to adopt a changed CLI default. Saved VM entries include host identity; entries from another host are not automatically adopted.

MCP snapshots the resolved profile directory for each call, including nested operations and abort/timeout cleanup. HTTP sessions have independent host+VM state. Changing the CLI default does not retarget existing MCP sessions. Forgetting/replacing a registration does not revoke already-resolved sessions: restart those clients when retiring a host. Explicit names are always looked up afresh and unknown names fail.

## MCP tools

Every `vm_*` tool accepts optional `host`. For example:

```json
{"host":"hornet","vm":"demo","command":"hostname"}
```

`vm_info {"action":"hosts"}` lists the hosts with the same fields as `boxery host ls --json` plus `current` (this session's host; text output marks it `*`), see [Where each host runs](#where-each-host-runs). `vm_manage` adds session selection `{"action":"host","host":"hornet"}`. Host selection clears the current VM, even when selecting the same host. `use` and `new` with `use:true` select both host and VM after success. `rm` clears the current VM only when both its host and name match. An explicit other host without an explicit VM never inherits the current VM's name. `vm_manage` cannot register hosts, change the persistent CLI default, add credentials or grant access.

Selection mutations complete in completion order; concurrent ordinary tool calls keep the host+VM snapshot they started with. Screenshot scaling is keyed by profile directory and VM name.

### Copy locations and “local”

`vm_copy` accepts:

* `HOST/VM:/path`: explicitly registered host and VM, independently for each endpoint;
* `VM:/path`: VM on the call's selected host;
* a bare path: current VM on that host (or the optional explicit `vm`);
* `local:/path`: **the machine running MCP**, not the selected VM host. On a Mac stdio server this means the Mac; on an HTTP server elsewhere it means that server machine.

VM-relative paths start at `/home/agent/project`; `~` means `/home/agent`. Local relative paths start at the server's working directory; local `~` means the server user's home. Unknown hosts in `HOST/VM:` are errors, not literal paths or fallback targets. A relative path containing `/` before a colon is interpreted as an explicit host/VM endpoint; use an absolute VM path to disambiguate a literal filename of that shape.

```json
{"from":"laptop/demo:build/output","to":"hornet/demo:incoming"}
{"from":"hornet/demo:logs.txt","to":"local:./logs.txt"}
```

Copies are streaming tar transfers through the server, not direct host-to-host connections. Each endpoint stays bound to its resolved SSH profile throughout the transfer and cleanup. Agent memory is bounded by stream buffers rather than archive size; local macOS uploads omit AppleDouble metadata. See [file transfers](copy.md) for staging, destination semantics and cancellation limits.

## Removal safety and leases

`host rm NAME` refuses the selected persistent default: first select another host or `host use legacy`. It removes **only** the registration pointer. Profile files, grants, SSH connections, host authorization and remote VMs remain. To revoke access, do so explicitly before forgetting the registration; to destroy a VM, use `boxery --host NAME rm VM`. Forgotten managed data must be explicitly imported to reuse it, not silently overwritten by another provisioning operation.

The CLI's existing pool commands are host-scoped: `boxery --host hornet acquire`, `renew`, `release` and `leases` use that profile's lease records and throwaway SSH keys. HTTP-grant records and edge-route markers are also profile-local. The pi extension's `--vm pool` uses its pinned host and retains automatic renewal/release. `vm_lease` (pi and MCP) holds each lease against the host it was acquired from, and renews and releases it there.

Registering a host neither obtains a lease nor authorizes access to existing guests; leases come only from `vm_lease {action:"acquire"}` (or the CLI/pi equivalents). Observe the host's own pool/lease and credential policies; do not treat `use` (which may create a missing VM) as lease acquisition or take over an existing shared VM. There is no cross-host scheduling, automatic migration or credential distribution here.
