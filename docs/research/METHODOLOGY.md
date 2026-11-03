# How we benchmark a test suite

← [Back to research](README.md)

These are the steps for timing one project's test suite on the bare host, in boxery VMs of each shape, and in Docker, so the numbers can be compared fairly. The [hunk finding](2026-11-03-hunk-suite-vm-vs-macos/README.md) used them. To run a different suite, change the repo, the command and the toolchain. The steps stay the same.

The scripts are in [`scripts/`](scripts/):

| Script | What it does |
|---|---|
| [`machine-info.sh`](scripts/machine-info.sh) | Prints the machine as JSON (model, chip, cores, memory, OS), with no host name, user name, serial or path. Run it on the host, and inside a guest to describe the guest. |
| [`pack-repo.sh`](scripts/pack-repo.sh) | Tars a checkout's files for a VM or image, without `node_modules`, ignored files or macOS `._*` files. |
| [`time-runs.sh`](scripts/time-runs.sh) | Runs a command N times under `/usr/bin/time -p` and appends one JSON line per run. `--counts bun` adds the pass/skip/fail totals. |
| [`summarize.mjs`](scripts/summarize.mjs) | Works out a finding's summary table from its valid runs, and checks that the stored one is current. |

## Rules for a fair comparison

- **One commit everywhere.** Record its full SHA. If an environment needs a patch to run cleanly, save the patch next to the results and mark which environments used it.
- **Same tool versions.** Use the same runtime, package manager and Git in every environment, or as close as the platforms allow, and record each one.
- **Same command and settings.** Pin anything the suite picks by itself. For example, hunk splits its tests into 2 shards on Linux but not on macOS, so we set `HUNK_TEST_SHARDS=2` on macOS too.
- **The repo lives on the guest's own disk.** Copy it into the VM or bake it into the image. A folder mounted from macOS is a separate measurement: in Docker it cost about 11 s on hunk's suite. Time it separately if it matters, and label it.
- **Match sizes, and check what the guest sees.** A boxery VM's CPUs and memory come from its shape. For Docker, use `--cpuset-cpus 0-N`, not `--cpus N`: `--cpus` only limits CPU time, so `nproc` still reports every CPU and runtimes size their thread pools to all of them. Docker Desktop's own VM caps the memory a container can have, so record that cap.
- **A quiet machine on mains power.** Close heavy apps. Note any other VMs that are running, and keep them the same for every run.
- **At least two runs per configuration.** Do more if two runs differ by more than about 5%. Keep the first run: we don't warm up, because the first run is what a developer sees too.
- **Compare test counts before you compare times.** A missing tool, a leaked user config or a file the suite didn't expect makes tests fail fast, and that makes a run look quicker. Every environment should pass, skip and fail the same tests. If one doesn't, find out why, fix it and run again. Keep the bad runs in the results, marked `valid: false`, with the reason.

## Steps

### 1. Record the host

```bash
docs/research/scripts/machine-info.sh
```

Also note the power source and the versions of everything involved: boxery, Lima or libvirt, Docker Desktop and its engine, and the suite's toolchain.

### 2. Get the checkout ready

Check out the commit, and apply the finding's patch if there is one. Before you trust any timings, run the suite once on the host and make sure the failures are ones you can explain.

Watch for two things that differ between a developer's Mac and a clean Linux guest:

- **User config.** A suite can read your real config dir, such as `~/.config/<tool>`, and pick up locally installed plugins. Point `XDG_CONFIG_HOME` and `XDG_STATE_HOME` at empty temporary dirs for the test process.
- **Symlinked temp dirs.** On macOS, `/var` links to `/private/var`, so tests that compare temp paths without resolving them fail only on the Mac.

Then pack the checkout:

```bash
docs/research/scripts/pack-repo.sh path/to/checkout repo-src.tgz
```

### 3. On the host

```bash
cd path/to/checkout
# pin anything the suite would otherwise choose per OS, here hunk's shard count
HUNK_TEST_SHARDS=2 path/to/boxery/docs/research/scripts/time-runs.sh --label metal --runs 2 \
  --out runs.jsonl --log-dir logs --counts bun -- bun run test
```

### 4. In boxery VMs, one shape at a time

Make one VM, set up its toolchain once, then resize it for each shape. Resizing keeps the disk, so you don't have to install everything again.

```bash
boxery new bench --shape small
boxery cp repo-src.tgz bench:repo-src.tgz
boxery cp docs/research/scripts bench:research
boxery run bench bash -c 'mkdir -p repo && tar xzf repo-src.tgz -C repo'
# install the toolchain at the versions you recorded, then:
boxery run bench --cwd repo bun install --frozen-lockfile

for shape in "small 2 4096" "standard 4 8192" "large 8 16384"; do
  set -- $shape
  boxery resize bench --cpus "$2" --mem "$3"
  boxery run bench --cwd repo ../research/time-runs.sh --label "vm-$1" --runs 2 \
    --out ../runs.jsonl --log-dir ../logs --counts bun -- bun run test
done
boxery run bench ../research/machine-info.sh
boxery cp bench:runs.jsonl vm-runs.jsonl
```

`boxery run` paths are relative to `~/project` in the VM. Use `boxery shapes` to see the shapes your host defines.

### 5. In Docker, at the same sizes

Write a Dockerfile that installs the same toolchain and adds the packed repo to the image (see [the hunk one](2026-11-03-hunk-suite-vm-vs-macos/Dockerfile)). Then:

```bash
docker build -t bench .
mkdir -p out
for size in "small 0-1 4g" "standard 0-3 8g" "large 0-7 16g"; do
  set -- $size
  docker run --rm --cpuset-cpus "$2" --memory "$3" \
    -v "$PWD/docs/research/scripts:/research:ro" -v "$PWD/out:/out" bench \
    /research/time-runs.sh --label "docker-$1" --runs 2 --out /out/runs.jsonl \
      --log-dir /out/logs --counts bun -- bun run test
done
```

If `--memory` asks for more than Docker Desktop's VM has, leave it off and record the VM's limit. Mounting the scripts and an output folder is fine, because only the repo has to live in the image.

### 6. Write up the results

Make a folder named `YYYY-MM-DD-short-slug` for the date the study finished, in UTC:

- `results.json`: follows [`results.schema.json`](results.schema.json). Put the host, every environment, and every run from the JSON lines in it, including the throw-outs with `valid: false` and a reason. Then fill in the summary:
  ```bash
  node docs/research/scripts/summarize.mjs docs/research/<id>/results.json --write
  ```
- `README.md`: the question, a short answer, the results table, what we learned, caveats, and how to run it again.
- Anything needed to run it again: the Dockerfile, the patch, provisioning notes.
- Optionally a chart or social card (`card.svg`), using numbers from `results.json` only.

Add a row for it to the table in [README.md](README.md).

### Privacy checklist

Before you commit, check that nothing contains:

- host names, user names, home paths or temp paths (`/Users/...`, `/var/folders/...`);
- serial numbers, hardware UUIDs, MAC or IP addresses;
- tokens, keys or private repo URLs;
- raw logs: they're full of paths. Keep them locally and commit only the JSON.

`machine-info.sh` and `time-runs.sh` print none of these, but a hand-written note can.
