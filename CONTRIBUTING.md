# Contributing / testing

| Layer | Command | Needs |
|---|---|---|
| Lint (shellcheck + node syntax) | `npm run lint` | shellcheck, node |
| Unit tests: core helpers, LLM proxy (real process vs fake upstream), MCP server stdio + HTTP (fake VM via an `ssh` stub) | `npm test` | node ≥ 20 |
| Shell tests: host dispatcher against the `fake` backend, controller local mode + grants, injection/concurrency regressions | `npm run test:shell` | bash, jq, openssl |
| Same under macOS's bash 3.2 | `docker run --rm -v "$PWD":/src:ro bash:3.2 bash -c 'apk add -q openssh-client jq coreutils openssl; cp -r /src /w && cd /w && bash test/shell/run.sh'` | docker |
| MCP protocol against a live VM | `mcp/test-mcp.sh VM` | a VM |
| End-to-end (create VM → agents → proxy → extension → MCP → grants → snapshots → rm) | `./e2e.sh` | a configured host (libvirt or Lima) |

CI (`.github/workflows/ci.yml`) runs lint, unit tests on Node 20/22/24, shell tests, bash 3.2, and a real macOS runner on every push and PR. `e2e.sh` needs KVM or Lima, so it runs manually (or on a self-hosted runner).

Backends live in `host/backends/<name>.sh` and implement the contract in `host/backends/README.md`; `fake.sh` is the test double.
