# GitHub Actions runners

← [Docs](README.md)

boxery can run your GitHub Actions jobs on its own VMs. Each job gets a pool VM that nothing has used since its last reset, and the VM is reset again as soon as the job ends. The runners are ephemeral self-hosted runners, registered with GitHub's just-in-time (JIT) runner API, one per job. There are two ways to run them:

- **Local runners**: `boxery runners once` registers one runner, for one job, while the command runs. Uses your `gh` login; nothing is stored on the host. The simplest way to try it.
- **Host runners**: `boxery runners start` turns on a service on the host that keeps runners waiting all the time, with a GitHub token of its own. The always-on option, for a team.

Both use the same runner VMs, and can share them.

**Use it for private repositories only.** On a public repository, a pull request from a fork can run its own code on self-hosted runners: on your hardware, in your network. See [Security](#security).

## Runner VMs

You need a boxery host with a pool ([pool](pool.md)) and a private repository or an organization. Make headless VMs with the runner layer, install what your jobs need, then add them to the pool. Their state at `pool add` is what every job starts from.

```bash
boxery new ci-1 --headless --layers github-runner   # Ubuntu 24.04 + dev tools + the pinned actions/runner
boxery run ci-1 sudo apt-get install -y PACKAGES    # whatever your jobs need, baked into the clean image
boxery fork ci-1 ci-2                               # more of the same (before pool add)
boxery pool add ci-1 && boxery pool add ci-2
```

The `github-runner` layer installs the [actions/runner](https://github.com/actions/runner) release pinned in [`image/layers/github-runner.sh`](../image/layers/github-runner.sh), checked against its pinned SHA-256, to `/opt/actions-runner`, with the runner's own `installdependencies.sh`. It registers nothing and holds no credential. It is not GitHub's hosted-runner image: the VM has boxery's dev tools (git, node 24, build tools, python3, jq, ripgrep) and whatever you add.

Every runner has the labels `self-hosted`, `linux`, its architecture (`x64` or `arm64`), `boxery`, and any you add with `--labels`. Labels match case-insensitively. Use them in a workflow:

```yaml
jobs:
  test:
    runs-on: [self-hosted, boxery]        # any subset of the runner's labels
    steps:
      - uses: actions/checkout@v4
      - run: make test
```

## Quick start: a local runner

Uses your `gh` login; nothing is stored on the host. You need the [GitHub CLI](https://cli.github.com), logged in (`gh auth login`), with admin rights on the repository: GitHub only lets admins register runners.

```bash
cd my-repo                 # a clone of the repository (or pass --repo OWNER/REPO)
boxery runners once        # one runner, one job; then it exits
```

```
==> local runner for acme/app, with your gh login (nothing is stored on the host)
==> ci-1 leased to github-runner-local until 2026-11-03T20:23:15.000Z
==> ci-1: registering runner boxery-local-ci-1-38cacb (labels self-hosted,linux,x64,boxery)
==> ci-1: runner boxery-local-ci-1-38cacb waiting for a job
==> ready: a job with runs-on: [self-hosted, boxery] gets it (Ctrl-C to stop)
==> boxery-local-ci-1-38cacb is running a job
==> ci-1: runner boxery-local-ci-1-38cacb finished
==> ci-1 reset → FREE
==> done: boxery-local-ci-1-38cacb ran its job; ci-1 is reset
```

Start the workflow (push, or `gh workflow run`) and the job runs on the VM. `once` exits 0 when the job is done, 130 after Ctrl-C, and 1 if the runner never got to run a job.

| Flag | Default | |
|---|---|---|
| `--repo OWNER/REPO` or `--org ORG` | this directory's repository (`gh repo view`) | Where the runner registers. For an organization, your gh login needs `admin:org`: `gh auth refresh -s admin:org` |
| `--vms NAME,…` | the host runners' `--vms` if configured, else any pool VM with the runner layer | The pool VMs it may lease |
| `--labels L,…` | none | Labels on top of `self-hosted,linux,ARCH,boxery` |
| `--group ID` | `1` (Default) | Runner group id (organizations) |

How it works: the host leases a free runner VM (holder `github-runner-local`) and tells your machine the runner's name and labels. Your machine asks GitHub for the JIT config with `gh api` (`POST …/actions/runners/generate-jitconfig`) and sends only that config to the host, on stdin (never a command line or a file), and the host starts the runner with it, as for host runners. While the runner waits, your machine sends a heartbeat and asks GitHub whether the runner has a job. When the job ends, or on Ctrl-C, or if anything fails, the runner is stopped, the registration deleted (`gh api -X DELETE`) and the lease released, so the VM is reset.

| What happens | What `once` does |
|---|---|
| `gh` missing or logged out | Says so and stops, before leasing anything |
| No free runner VM | Says which VMs are taken and by whom, and stops. Host runners keep their VMs while they run: `boxery runners stop`, or `--vms` with other pool VMs |
| GitHub refuses the registration | Shows GitHub's message (usually: not an admin of the repository); the VM is released |
| Ctrl-C | Stops the runner, deletes its registration, releases the VM. A second Ctrl-C leaves the rest to the host |
| `once` is killed, your machine sleeps, or its connection drops | The host stops the runner and releases the VM: at once when the connection closes, or after 2 minutes without a heartbeat. The registration stays, offline, until GitHub removes it (or you do, in Settings → Actions → Runners) |
| The host side dies | The lease expires within 5 minutes and the reaper resets the VM |

Local runners and host runners can share runner VMs. They lease with different holders (`github-runner-local`, `github-runner`) and name their runners differently (`boxery-local-VM-XXXXXX`, `PREFIX-VM-XXXXXX`), so the host's runner manager never adopts, releases or deregisters a local runner. `boxery runners status` lists local runners' leases too.

## Host runners

The host keeps runners waiting all the time: a service (the runner manager) with a GitHub token of its own, which never leaves the host.

```
GitHub ◄── REST API (token in runners.env) ── boxery-host runners run (host service)
  │                                                │ acquire --holder github-runner --only ci-1,ci-2 --json   (pool lease, renewed)
  │ one job                                        │ POST …/actions/runners/generate-jitconfig        (single-use config)
  ▼                                                ▼ ssh ci-1 boxery-runner start < JIT config
runner in ci-1 (agent user) ──── job ends, runner exits ──► release → reset to ci-1@boxery-clean ──► next runner
```

**1. A token.** Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) that can manage self-hosted runners:

| Runners for | Resource owner | Permission |
|---|---|---|
| one repository | the repository's owner; select only that repository | Repository permissions → **Administration: Read and write** |
| an organization | the organization | Organization permissions → **Self-hosted runners: Read and write** |

The token can create and delete runner registrations, and the Administration permission can change other repository settings too, so give it nothing else and keep its expiry short. A classic token works as well (`repo`, or `admin:org` for an organization), but grants far more.

**2. Configure, give it the token, start it.** From your machine (`boxery runners …` passes through to the host) or on the host (`boxery-host runners …`), with the [runner VMs](#runner-vms):

```bash
boxery runners config --repo OWNER/REPO --vms ci-1,ci-2           # or: --org ORG [--group ID]
boxery runners token < github-token.txt                           # first line of stdin; stored 0600 on the host
boxery runners start
boxery runners status
```

`status` shows the configuration, whether a token is set (never the token), the service and each leased runner VM with its runner and what it is doing. Runners appear in the repository's (or organization's) Settings → Actions → Runners as `PREFIX-VM-XXXXXX`. Workflows use them as above.

### Configuration

`boxery-host runners config` changes only the flags you give and saves `~/.config/boxery/runners.json`; with no flags it prints it. A running manager reads it when it starts: `runners stop && runners start` after a change.

| Flag | Default | |
|---|---|---|
| `--repo OWNER/REPO` or `--org ORG` | (required) | Where runners register. Setting one clears the other |
| `--vms NAME,…` | (required) | The pool VMs the manager may lease. It never takes any other pool VM, so agents can share the same pool |
| `--count N` | number of VMs | Runners kept waiting at once (at most one per VM) |
| `--labels L,…` | none | Labels on top of `self-hosted,linux,ARCH,boxery` |
| `--group ID` | `1` (Default) | Runner group id (organizations) |
| `--ttl S` | `1800` | Lease TTL; the manager renews at a third of it, so jobs may run for as long as they need |
| `--api URL` | `https://api.github.com` | GitHub Enterprise Server: `https://HOST/api/v3` |
| `--prefix P` | `boxery-HOSTNAME` (`-PROFILE`) | Runner name prefix. On start the manager deletes offline registrations with this prefix, so give each host (and profile) its own |

The token lives in `~/.config/boxery/runners.env` (`GITHUB_TOKEN=…`, mode `0600`; `init` creates a commented template). It is read for every request, so a new token needs no restart. The manager refuses a file other users can read.

### How it works

The manager (`boxery-host runners run`, the user service `boxery-runners`, or the launchd agent `dev.boxery-runners` on macOS; `runners start` turns it on) keeps `count` slots. Each slot:

1. leases a free VM from `--vms` (`boxery-host acquire --holder github-runner --only … --json`, the pool's own locks and fencing), and keeps renewing that lease;
2. checks the VM has the runner and hasn't run one (`boxery-runner status`);
3. asks GitHub for a JIT config (`POST /repos/OWNER/REPO/actions/runners/generate-jitconfig`, or `/orgs/ORG/…`, with the name, labels, runner group and work folder `_work`);
4. starts the runner as `agent` in the transient unit `boxery-runner.service`, with that config on ssh's stdin and self-update off (the image pins the version);
5. polls until the runner process exits: after its one job, or if it dies;
6. deletes the registration if it is still there (a JIT runner normally removes itself), and releases the lease: the pool resets the VM to `NAME@boxery-clean`. Then it starts over.

A runner that never gets a job just waits, and its lease is renewed. A job can run longer than the TTL. GitHub cancels a job whose runner disappears.

| What happens | What the manager does |
|---|---|
| No free runner VM | Waits: 5 s, doubling up to 60 s |
| GitHub API error | Keeps the clean VM, logs the status and message, retries after 10 s doubling to 5 min, or when the rate limit resets (`retry-after`, `x-ratelimit-reset`) |
| A VM without the runner layer | Releases it and doesn't lease it again (logs how to make runner VMs) |
| A VM that stops answering | After 8 polls (2 min), stops the runner, deletes its registration and releases the lease. If the reset fails the VM is `broken` ([pool](pool.md)) |
| A renewal fails | Retries; once the lease has expired, gives up on it (the reaper resets the VM) |
| The manager is restarted or killed | On start it finds its leases by holder: a VM whose runner still runs is adopted (the job goes on), others are released. Then it deletes offline, idle registrations with its prefix |
| `runners stop` | Idle runners are stopped, deregistered and released. A runner on a job keeps its VM: the next manager adopts it, or its lease expires and the reaper resets it |
| A restart (`systemctl --user restart boxery-runners`, or `boxery-host upgrade`, whose `init` restarts a running manager) | Every lease is left as it is; the new manager adopts the runners that still run, idle or busy, and releases the rest |
| Two managers on one profile | The second refuses to start (`runners.lock`) |

Logs: `journalctl --user -u boxery-runners` (macOS: `~/Library/Logs/boxery-runners.log`). They name VMs, runners, lease outcomes and API statuses, never the token or a JIT config.

## Updating the runner

The runner's version is pinned in the layer and self-update is off, so runner VMs keep the version they were made with. GitHub stops sending jobs to a runner that is too far behind (about 30 days after a newer release for runners that don't update themselves). To update: bump `VERSION` and both hashes in `image/layers/github-runner.sh` (each release's notes list the SHA-256 of every tarball), then make the VMs again:

```bash
boxery runners stop
boxery pool rm ci-1 && boxery rm ci-1 && boxery new ci-1 --headless --layers github-runner   # …and set it up
boxery pool add ci-1
boxery runners start
```

## Security

- **Private repositories only**, and organization runner groups that only private repositories can use. A job runs whatever the repository's workflows (and anyone who can change them) say, as root in the VM.
- Every job starts from the VM's clean image and the VM is reset after it, so one job can't see another's files, processes or credentials. Whatever you put in the VM before `pool add` is visible to every job: no credentials there.
- Jobs get a pool VM's normal network: the internet, but not the host, other VMs, your LAN or tailnet (on libvirt and Cloud Hypervisor; Lima's limits are in [security](security.md#known-limits)). They get no grants: no LLM access, no `http:`/`env:`/`file:` grants. Secrets come from GitHub (Actions secrets).
- Local runners store no GitHub credential anywhere: your machine registers the runner with your `gh` login and hands the host only the runner's JIT config. Host runners' token stays on the host. Either way, the only GitHub credential in a VM is the JIT config of its own runner, good for one job, and the reset removes it.

More in the [security model](security.md#github-actions-runners).

## Not covered

- Scaling beyond the VMs you list (no autoscaling, no VM creation per job), and runners on desktop VMs.
- GitHub's hosted-runner toolset: install what your jobs need into the runner VMs.
- Webhook-driven scaling: the manager keeps a fixed number of runners waiting instead of reacting to queued jobs.
- More than one job per `boxery runners once`: run it again (or in a loop) for the next job.
