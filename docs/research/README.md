# Research

← [Back to the docs](../README.md)

Measurements we've taken of real workloads in boxery VMs, compared with the alternatives. Each finding has a short write-up, the raw numbers as JSON, and everything needed to run it again.

## Findings

| Date | Finding | Answer |
|---|---|---|
| 2026-11-03 | [hunk's test suite: macOS vs boxery VMs vs Docker](2026-11-03-hunk-suite-vm-vs-macos/README.md) | Every Linux VM beat macOS (78–86 s against 112 s). A 2-CPU VM was within 6 s of an 8-CPU one. boxery's Lima VMs were 2–4 s faster than Docker at matched sizes. |

## How it's laid out

```
docs/research/
  README.md               this index: add a row for each finding
  METHODOLOGY.md          how we run a benchmark fairly, step by step
  results.schema.json     the shape every results.json follows
  scripts/                machine-info.sh, pack-repo.sh, time-runs.sh, summarize.mjs
  YYYY-MM-DD-short-slug/  one folder per finding, dated when the study finished (UTC)
    README.md             question, answer, results table, what we learned, caveats, how to rerun
    results.json          host, environments, every run (throw-outs marked), derived summary
    ...                   whatever it takes to rerun it: Dockerfile, patch, card script
```

A finding's `results.json` can be read without the prose. It records:

- what was measured: a public repo at a full commit SHA, the command, and any patch;
- the host: chip, cores, memory and OS;
- every environment, with its CPU and memory limits, where the repo lived and the tool versions;
- every run, with its wall, user and sys seconds and its test counts.

The `summary` is worked out from the valid runs by `scripts/summarize.mjs`, so it can't drift from them. Check every finding with:

```bash
for f in docs/research/*/results.json; do node docs/research/scripts/summarize.mjs "$f" || exit 1; done
```

## Adding a finding

1. Follow [METHODOLOGY.md](METHODOLOGY.md) to collect runs.
2. Make the folder and write `results.json` against [the schema](results.schema.json). Then run `summarize.mjs --write`.
3. Write the `README.md`: the question first, then a one-line answer, then the numbers. Say what surprised you, and list the caveats honestly.
4. Add a row to the table above.
5. Before committing, go through the methodology's privacy checklist. Commit numbers and versions, never raw logs, host names, user names or paths.

Findings are snapshots. If a later run changes a conclusion, add a new finding and link to it from the old one, rather than rewriting history.
