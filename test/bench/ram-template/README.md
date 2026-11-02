# Experimental RAM templates

**A local benchmark, not a Boxery backend or a production sandbox.** It starts new Cloud Hypervisor processes from a clean booted desktop's RAM + disk snapshot, and compares eager copy / lazy copy-on-write restore against a cold boot of the same guest. No waiting pool VM is reused.

Results and production gaps: [`docs/reviews/2026-11-01-ram-templates.md`](../../../docs/reviews/2026-11-01-ram-templates.md). Raw JSONL is in [`results/`](results/).

## Requirements

- x86_64 Linux, accessible `/dev/kvm`, Python 3.11+, Node, `qemu-img`, `virsh`, SSH.
- An initialized **libvirt** Boxery host with a trusted existing Ubuntu desktop base and management key.
- ~12 GiB free during preparation, ~8 GiB afterward. Every clone uses a small private qcow2 overlay but workloads may grow it.
- No sudo is required beyond whatever access already lets you manage the configured libvirt host. Experimental VMs have **no virtual network interface**; management uses Cloud Hypervisor's private Unix-socket/vsock bridge.

## Run

Choose a **new directory outside the repo**, preferably on disk (not tmpfs) for file-cache experiments:

```sh
WORK="$HOME/.cache/boxery-ram-experiment"

# Builds/removes one isolated libvirt guest, downloads verified v54.0 binaries,
# boots a CH source guest, waits for the blank browser to settle, pauses it,
# saves RAM/device state, then stops it permanently. Does not change shared base/network.
python test/bench/ram-template/prepare.py --work-dir "$WORK"

# Each trial includes creating its private disk overlay, new VMM process,
# fresh experimental credentials/entropy, shell command, noVNC + Chrome CDP
# checks, and (separately timed) actual rendered browser screenshot.
python test/bench/ram-template/bench.py --work-dir "$WORK" \
  --rounds 5 --modes cold copy copyonwrite > warm.jsonl

# Advisory eviction of ONLY this experiment's RAM template and base disk from
# file cache, before each trial. Not a global cold-disk/cache guarantee.
python test/bench/ram-template/bench.py --work-dir "$WORK" \
  --rounds 5 --modes cold copy copyonwrite --evict-template-cache > evicted.jsonl

# Optional simultaneous clone burst; readiness probes do not render 8 frames.
python test/bench/ram-template/bench.py --work-dir "$WORK" \
  --rounds 1 --modes copyonwrite --no-screenshot --burst 8 > burst.jsonl

# No VM privileges needed for host-side unit checks:
python -m unittest discover -s test/bench/ram-template -p 'test_*.py' -v
```

Timing fields are cumulative milliseconds from before private-overlay creation. `agent_ms` means the agent answers; `assign_ms` includes entropy/identity/credential assignment; `ready_ms` includes a real agent-user shell command and successful noVNC/CDP requests. `frame_ms` additionally creates a browser tab, renders clone-specific content, captures a PNG through CDP, and saves it on the host. The frame phase includes starting a Node CDP client inside the guest.

The benchmark alternates modes, stops each VMM in `finally`, and checks two simultaneous clones for writable-disk separation, credential rejection, fresh machine-ID files/random samples, and expected duplicated `boot_id`. It also verifies that the RAM template hash is unchanged and records whether COW RAM is actually mapped from the template file. `copyonwrite-no-thp` and `ondemand` are optional modes; the latter needs userfaultfd permissions and fails rather than silently substituting eager copy.

## Safety and limitations

- Only use **trusted, locally built** snapshot/configuration files. Snapshot state is not an untrusted import format.
- `guest-agent.py` is a **root experimental control service**, accessible through the private host Unix socket. It is not a reviewed authentication service. Do not expose it publicly or install it on a real VM.
- **Never run `prepare-guest.sh` on the host or a useful VM.** The preparation script runs it only inside its disposable builder; it disables SSH/cloud-init and removes credentials in that guest.
- Source disk + RAM are captured consistently while paused. The source **never resumes**. Keep both immutable and available for all clones; never truncate/change a RAM template while clones map it.
- No internet/LAN, production lease/token/grant flow, controller transport, or arbitrary untrusted workload is tested. CDP renders a local page.
- Updating `/etc/machine-id` is not equivalent to refreshing cached systemd/D-Bus/application identity. Kernel `boot_id` remains duplicated. Fresh kernel entropy does not repair application-cached RNG state. The agent fences commands, **not every already-running service**. These are explicit blockers before production use.
- Chrome's stale singleton locks are cleared on cold startup. The builder waits 5 s after initial readiness before capture; early snapshots were measurably less stable. This is a template-build cost, not a per-clone cost.
- Clone directories and screenshots remain for inspection after processes stop. Preparation removes its libvirt builder and copied management private key. If builder cleanup fails, it retains its private journal and prints its location.
- Remove the work directory only after all VMM processes using it have stopped. No running VMM should survive a normal benchmark exit; inspect `pgrep -af cloud-hypervisor` if interrupted externally.

Cloud Hypervisor binaries are pinned to [v54.0](https://github.com/cloud-hypervisor/cloud-hypervisor/releases/tag/v54.0). Their expected SHA-256 values in `prepare.py` match the official release asset digests. Binaries, RAM snapshots, disks and screenshots are not checked in.
