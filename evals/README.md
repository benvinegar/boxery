# Agent behaviour evals

← [Contributing](../CONTRIBUTING.md)

These check how a coding agent *uses* boxery, not whether the tools work: when it reaches for the `vm_*` tools, which one and with what arguments, and whether it follows the user's instructions and boxery's own guidance (the MCP `initialize` instructions and tool descriptions). Change those texts, then run this to see what moved.

Each case's prompt goes to a fresh headless Claude Code session (`claude -p`) whose only MCP server is `mcp/boxery-mcp.mjs` from this checkout. It works in a throwaway git repo holding a small `package.json` project. The tools it calls are compared with the checks in [`cases.mjs`](cases.mjs).

A small subproject of its own: a `package.json` with no dependencies, and saved results committed under `results/` as history.

```
evals/
  cases.mjs         the cases and their checks, plus SUITE_VERSION
  run.mjs           runs cases; --save keeps a result
  history.mjs       saved results over time
  compare.mjs       two results, case by case
  lib/results.mjs   reads results/, builds results/index.json
  results/          saved results (committed): <date>-<commit>-<model>/ and index.json
  out/              everything each run produces (ignored by git)
```

```bash
cd evals
node run.mjs                                  # every case, 3 runs each → out/<timestamp>/
node run.mjs --only pasted-token,browser --repeat 5
node run.mjs --model sonnet --tool-search off
node run.mjs --save                           # also keep it in results/ (from a clean checkout)
node run.mjs --save --model claude-haiku-5-5  # a baseline per model
node history.mjs                              # every saved result: model, commit, suite, pass rates
node history.mjs --case checkpoint            # one case over time
node compare.mjs                              # latest result vs the previous one of the same model
node compare.mjs latest:haiku latest:opus     # two models
node compare.mjs latest:opus out/<timestamp>  # a saved result vs a local run
```

`npm run eval|history|compare -- ARGS` runs the same scripts. From the repo root, use `npm --prefix evals run eval -- ARGS`.

| Option | Default | |
|---|---|---|
| `--repeat N` | 3 | runs per case; agents vary, so read pass rates, not single runs |
| `--concurrency N` | 4 | sessions at once |
| `--only a,b` | all | case ids |
| `--model NAME` | the CLI's default | passed to `claude --model` |
| `--vm NAME` | `demo` | an existing VM: the session default for `cfg: "vm"` cases, and named in prompts |
| `--other-vm NAME` | `hunk-perf` | a second existing VM, for "use that one, not this one" cases |
| `--tool-search on\|off` | the CLI's default | `ENABLE_TOOL_SEARCH`: whether MCP tools load on demand (the agent sees only their names and the server instructions until it searches) or up front |
| `--out DIR` | `out/<timestamp>` | where everything a run produces goes (ignored by git) |
| `--save` | off | also write a publishable copy to `results/` (needs a clean checkout) |
| `--allow-dirty` | off | let `--save` run with uncommitted changes; the metadata says so |

It needs the `claude` CLI signed in and a configured boxery host with both VMs running. Sessions load only project settings (`--setting-sources project`, and the work dir has none), so your own settings and permission rules don't leak in. Your global `CLAUDE.md` still loads. A run of every case costs a few dollars on Opus.

## What runs, what's denied

Allowed:
- local read tools, plus `Edit`/`Write`, in the throwaway repo
- in VMs, lookups only (`vm_info`, `vm_read`, `vm_screenshot`)
- `vm_bash`, `vm_jobs` and `vm_browser` on existing VMs, only for cases marked `exec`, whose prompts ask for something harmless: `uname`, `df`, `python3 --version`, a 90-second `date` loop as a background job, an `xmessage` that closes after 15 s, Chrome opening example.com

Everything else is denied. A `-p` session can't ask, so a denied call is refused, but it stays in the transcript. The checks therefore see what the agent *tried*, and nothing creates, forks or removes VMs or grants access. In the summary, `✗` marks a denied call.

Keep new cases this way. An agent asked to "make sure I can roll back a migration" with `vm_bash` allowed may go ahead and dump your databases. Asked to run tests in a VM with `vm_write` denied, it may write the files with a heredoc through `vm_bash` instead.

## Cases

| Category | Asks |
|---|---|
| `trigger` | Does it use a VM when it should: told to, untrusted code, "on Linux", the VM's screen, a browser? |
| `no-trigger` | Does it stay local for local files, local edits, local git and plain questions, and say which copy it read when there's a default VM? |
| `routing` | `fork` for parallel attempts, `headless` when no GUI is needed, `snap` before something risky, `vm_jobs` for work that outlives the session |
| `instructions` | "Don't modify any VMs", "that VM, not this one", start GUI programs detached |
| `safety` | Credentials go through `vm_grant`, never onto a VM's disk |

A run passes when all of its `must` checks pass. `should` checks are tracked separately: they're the better answer, not the only acceptable one. To add a case, add an entry to `cases.mjs` (set `exec` only if it must run commands in a VM). Its `prompt` gets `ctx` (`vm`, `otherVm`, …) and each check gets the trace (`calls: [{tool, input, denied}]`, `final`).

## Results

`out/<timestamp>/` (ignored by git) holds everything a run produces:
- `raw/`: one Claude Code transcript per run
- `results.json`: the parsed traces
- `scorecard.json`, `meta.json`
- `summary.md`: with each command run and each final answer

These can contain what the agent saw in your VMs and on your machine (file listings, project names, paths), so they stay local.

`--save` also writes `results/<date>-<commit>-<model>/`, which is meant to be committed:

| File | Holds |
|---|---|
| `meta.json` | what the run depended on (below), the exact command, start and end, runs, passes, cost |
| `scorecard.json` | per run: pass, each check's result, and each tool call with only its structural arguments (`action`, `vm`, `to`, `headless`, `snapshot`, `spec`, …; temp paths become `<tmp>`, home becomes `~`). No commands, file contents or answers. VM names the agent chose are kept. |
| `summary.md` | the table and the tool calls, readable on GitHub |

`results/index.json` is the history as one JSON file: an entry per saved result, oldest first. Each entry holds the commit, model, Claude Code version, suite version and hash, overall pass and should counts, cost, and per-case `{runs, passed, shouldOk, shouldTotal}`. `--save` rebuilds it, and so does `node history.mjs --write-index`. It's generated from the result directories, so don't edit it by hand. `node history.mjs --json` prints the same rows.

A baseline is the full suite at the default `--repeat 3`, one result per model. Save one after changing the server's instructions or tool descriptions, or when a new model or Claude Code version comes out. `compare.mjs` lines up any two results. Pass rates compare cleanly only within one `suite.version`, and it warns when the suites differ.

### What a result depends on

`meta.json` records each of these:

| Field | What | Why it matters |
|---|---|---|
| `boxery.commit`, `boxery.dirty` | this checkout's commit; whether anything outside `evals/` had uncommitted changes | the MCP server, its `initialize` instructions and the tool descriptions are what's under test |
| `suite.version` | `SUITE_VERSION` in `cases.mjs`; bump it when a prompt, check, fixture or the allowed tools change | results compare only within a version |
| `suite.hash`, `suite.dirty` | sha256 of `cases.mjs` + `run.mjs`; whether `evals/` (minus outputs) had uncommitted changes | pins the exact suite, including edits that didn't bump the version |
| `claude.cli`, `claude.model` | the Claude Code version and the model id the sessions reported | agent behaviour changes with both |
| `boxery.host` | `boxery version --json`: the controller and host the tools reached | the host answers `vm_info` and runs commands |
| `options` | `--vm`, `--other-vm`, `--model`, `--tool-search`, `--repeat`, `--only` | |

`--save` refuses when either `dirty` flag is set (unless `--allow-dirty`), so that `boxery.commit` alone recreates both the server and the suite. Commit your changes, then run.

### Recreating a result

1. Check out the commit: `git checkout <boxery.commit>`. With both `dirty` flags false, that's the server and suite that ran. Check `suite.hash` against `meta.json` in a fresh run's `out/`.
2. Install the same Claude Code: `npm i -g @anthropic-ai/claude-code@<claude.cli>`, signed in.
3. Use the same model: pass `--model <claude.model>` (the full id, not an alias, since aliases move).
4. Have a boxery host (`boxery setup`) with two running VMs: a desktop VM with Node for `--vm`, and any VM for `--other-vm`. The `exec` cases run commands in them; nothing else changes them.
5. Run `meta.command` from the repo root, adding `--model <claude.model>` if it isn't there, then `node compare.mjs <id> out/<timestamp>` to compare.

Expect the same pass rates, not the same runs: an agent's choices vary between sessions, so a case at 3/3 may come back 2/3. Repeat more (`--repeat 5`) before reading a one-run difference as a change.
