// The controller's usage text (boxery help). Kept as text: tests match parts of it, and people read it.
export const USAGE = `boxery — remote desktop VMs for coding agents

setup user@host|local [--name NAME] [--key K.pub] [--host-bin PATH] [--profile P [--backend B]]
setup local --backend openshell [--gateway G] [--image OCI] [--policy PATH] [--provider P | --no-providers] [--yes]
                                configure a VM host (local = this machine) + register your ssh key;
                                  NAME defaults to local / the host part of user@host
--host NAME COMMAND             route a command to a host other than the default
host add NAME DEST [--key K.pub] [--host-bin PATH] [--backend B] [--profile P]
                                --backend B: create a new profile on DEST for backend B (own state,
                                  free proxy port, own services); --profile P: use an existing one
host add NAME --config-dir DIR   import existing config/ssh_config without setup
host ls [--json] | show NAME | use NAME | rm NAME
                                ls: where each host runs (local or ssh destination) and its backend
new NAME [--shape S] [--cpus N --mem MiB --disk GiB] [--headless] [--grant SPEC]... [--agent-forward]
                                --headless: no desktop (shell + agents only); needs no build-base
                                --headless --layers github-runner: a GitHub Actions runner VM
build-base                      build the host's desktop base image (one-time, ~3 min)
backends [--json]               backend support, requirements and capabilities (on selected host)
capabilities [--json | --check]  selected host's platform and conditional capability assessment
shapes [--json]                 VM sizes defined on the host (* = default; see docs/shapes.md)
ls [--json] [--refresh]         list VMs (with their shape, grants and guest software: GUEST is
                                  current, outdated or unknown; --refresh reads it from running VMs)
patch NAME|--all [--wait S]     update a VM's guest software to the host's image layers (security
                                  updates, browsers, agent CLIs; restarts it if they ask to). A pool
                                  VM must be free (--wait S for its lease to end); its clean image is
                                  captured again. Snapshots keep their old software
rm NAME                         destroy VM (revokes its LLM token)
start|stop NAME
resize NAME [--cpus N] [--mem MiB] [--disk GiB]
                                change a VM's size (restarts it if running; disk only grows)
fork SRC DST... [--grants] [--shape S]
                                copy a VM (running or not) into new VMs, ~10 s; each gets its own
                                identity and SRC's size (--grants: give the forks SRC's grants too)
snap NAME [SNAP] | snaps NAME [--json] | revert NAME SNAP | snap-rm NAME SNAP
new NAME --from NAME@SNAP       new VM from a snapshot (also: boxery images)
pin NAME [--from-guest]         re-pin a VM's ssh host key (VMs from before keys were pinned; see
                                  docs/security.md). --from-guest: trust what it answers once

ssh NAME [cmd...]               shell into VM (also: ssh NAME.boxery)
cp FROM TO                      copy a file or directory (recursive) between this machine and VMs,
                                  or VM to VM; same locations as vm_copy: local:PATH, NAME:PATH,
                                  HOST/NAME:PATH (VM paths relative to ~/project); bare PATH = local
run [--bg] NAME [--cwd DIR] CMD [ARG...]
                                run a command with exactly these args (like docker exec), in
                                  ~/project; a relative --cwd is under ~/project
                                --bg: run it as a background job (prints the job id)
jobs NAME [--json]              list background jobs (state, exit code, start time, command)
jobs NAME --prune [--older-than 7d]   delete finished jobs and their logs
logs NAME JOB [-f] [--strip-ansi] [--lines N] [--bytes N]
                                tail a job's output (last 200 lines); -f follows until it ends
wait NAME JOB [--timeout S] [--json]
                                wait; exits with the job's exit code (124 timed out, 125 lost)
kill NAME JOB [--grace S] [--json]
                                stop a job: SIGTERM, then SIGKILL after S seconds (default 5)
attach NAME [pi|opencode|shell] [session]
                                attach to a persistent tmux session running the agent
prompt NAME "task"              start a headless pi task in the background
sessions NAME [--json]          list tmux sessions
desktop NAME [--no-open]        open the XFCE desktop in your browser (noVNC over ssh)
forward NAME PORT [LOCAL]       forward a VM port to localhost
acquire [--ttl S] [--wait S]    lease a VM from the shared pool (prints NAME LEASE_ID)
renew NAME [--ttl S]            extend your lease;  release NAME   give it back (VM is reset)
leases [--json]                 your leases;  pool add|rm|ls (admin, on the host)
runners once [--repo OWNER/REPO | --org ORG] [--vms NAME,...] [--labels L,...] [--group ID]
                                local runner: one GitHub Actions job on a fresh pool VM, registered
                                  with your gh login; nothing is stored on the host. --repo
                                  defaults to this directory's repo (docs/github-runners.md)
runners status|start|stop|config|token   host runners: the host keeps runners waiting, with
                                  its own GitHub token (admin)
grant NAME SPEC... [--cmd CMD]  give a VM access to something on this machine:
                                  ssh-agent | env:VAR | file:LOCAL[=REMOTE]
                                  http:HOST --cmd CMD [--auth bearer|basic:USER|header:NAME] [--readonly]
                                  github [--readonly]   (http: grants never put the secret in the VM)
                                  llm:chatgpt|openai|anthropic|ollama   (LLM access; none without it)
revoke NAME SPEC...|all         take it away (pushed values are deleted from the VM)
grants NAME [apply | --json]    show grants / push them again
agent-forward NAME on|off       same as grant/revoke NAME ssh-agent
proxy-log [N]                   recent LLM + edge (http: grant) requests on the host
version [--json]                controller and host versions; warns when the host is behind
backend                         the host's VM backend (recorded for host ls / vm_info hosts)
upgrade-host [--check] [--ref REF] [--wait S]
                                update boxery on the host and restart its services (waits for
                                in-flight VM operations; rolls back if checks fail)

--json on ls, snaps, sessions, leases, grants, jobs, wait, kill prints JSON (fields: docs/cli.md)

`;

export const RUN_EXAMPLES = `run examples:
  boxery run demo pnpm test                       args are passed as-is: quotes, $, *, ; stay literal
  boxery run demo --cwd modem git log -1          runs in ~/project/modem
  boxery run demo bash -c 'ls ~ | wc -l; echo $HOME'   pipes, ~, $VAR and globs need bash -c
  not: boxery run demo 'make test'                one argument is one command name (fails with a hint)
`;
