# GitHub Actions runners

← [Docs](README.md)

boxery can run your GitHub Actions jobs on its own VMs. Each job gets a pool VM that nothing has used since its last reset, and the VM is reset again as soon as the job ends. The host keeps a few ephemeral self-hosted runners waiting, registered with GitHub's just-in-time (JIT) runner API, and the GitHub token that registers them never leaves the host.

**Use it for private repositories only.** On a public repository, a pull request from a fork can run its own code on self-hosted runners: on your hardware, in your network. See [Security](#security).

```
GitHub ◄── REST API (token in runners.env) ── boxery-host runners run (host service)
  │                                                │ acquire --holder github-runner --only ci-1,ci-2   (pool lease, renewed)
  │ one job                                        │ POST …/actions/runners/generate-jitconfig        (single-use config)
  ▼                                                ▼ ssh ci-1 boxery-runner start < JIT config
runner in ci-1 (agent user) ──── job ends, runner exits ──► release → reset to ci-1@boxery-clean ──► next runner
```

## Set up

You need a boxery host with a pool ([pool](pool.md)) and a private repository or an organization.

**1. A token.** Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) that can manage self-hosted runners:

| Runners for | Resource owner | Permission |
|---|---|---|
| one repository | the repository's owner; select only that repository | Repository permissions → **Administration: Read and write** |
| an organization | the organization | Organization permissions → **Self-hosted runners: Read and write** |

The token can create and delete runner registrations, and the Administration permission can change other repository settings too, so give it nothing else and keep its expiry short. A classic token works as well (`repo`, or `admin:org` for an organization), but grants far more.

**2. Runner VMs.** Make headless VMs with the runner layer, install what your jobs need, then add them to the pool. Their state at `pool add` is what every job starts from.

```bash
boxery new ci-1 --headless --layers github-runner   # Ubuntu 24.04 + dev tools + the pinned actions/runner
boxery run ci-1 sudo apt-get install -y PACKAGES    # whatever your jobs need, baked into the clean image
boxery fork ci-1 ci-2                               # more of the same (before pool add)
boxery pool add ci-1 && boxery pool add ci-2
```

The `github-runner` layer installs the [actions/runner](https://github.com/actions/runner) release pinned in [`image/layers/github-runner.sh`](../image/layers/github-runner.sh), checked against its pinned SHA-256, to `/opt/actions-runner`, with the runner's own `installdependencies.sh`. It registers nothing and holds no credential. It is not GitHub's hosted-runner image: the VM has boxery's dev tools (git, node 24, build tools, python3, jq, ripgrep) and whatever you add.

**3. Configure, give it the token, start it.** From your laptop (`boxery runners …` passes through to the host) or on the host (`boxery-host runners …`):

```bash
boxery runners config --repo OWNER/REPO --vms ci-1,ci-2           # or: --org ORG [--group ID]
boxery runners token < github-token.txt                           # first line of stdin; stored 0600 on the host
boxery runners start
boxery runners status
```

`status` shows the configuration, whether a token is set (never the token), the service and each leased runner VM with its runner and what it is doing. Runners appear in the repository's (or organization's) Settings → Actions → Runners as `PREFIX-VM-XXXXXX`.

**4. Use them in a workflow.**

```yaml
jobs:
  test:
    runs-on: [self-hosted, boxery]        # any subset of the runner's labels
    steps:
      - uses: actions/checkout@v4
      - run: make test
```

Every runner has the labels `self-hosted`, `linux`, its architecture (`x64` or `arm64`), `boxery`, and any you configure with `--labels`. Labels match case-insensitively.

## Configuration

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

## How it works

The manager (`boxery-host runners run`, the user service `boxery-runners`, or the launchd agent `dev.boxery-runners` on macOS; `runners start` turns it on) keeps `count` slots. Each slot:

1. leases a free VM from `--vms` (`boxery-host acquire --holder github-runner --only …`, the pool's own locks and fencing), and keeps renewing that lease;
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

### Updating the runner

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
- The GitHub token stays on the host. The only GitHub credential in a VM is the JIT config of its own runner, good for one job, and the reset removes it.

More in the [security model](security.md#github-actions-runners).

## Not covered

- Scaling beyond the VMs you list (no autoscaling, no VM creation per job), and runners on desktop VMs.
- GitHub's hosted-runner toolset: install what your jobs need into the runner VMs.
- Webhook-driven scaling: the manager keeps a fixed number of runners waiting instead of reacting to queued jobs.
