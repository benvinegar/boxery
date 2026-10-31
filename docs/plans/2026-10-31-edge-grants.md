# Plan: edge-injected grants (#2)

Status: v2, revised after the review below. Implemented in the same PR.

## Goal

Let a VM *use* an HTTP API credential (GitHub, npm, any bearer/basic/header token) without the
credential ever being in the VM. The VM gets a URL; the host proxy adds the secret on the way out.

## Research summary

| Tool | How to point it at a plain-HTTP base URL | Works? |
|---|---|---|
| git (https remotes) | `url.<edge>/github.com/.insteadOf https://github.com/` in an included gitconfig | ✅ remotes stay `https://github.com/…` |
| npm | `npm_config_registry=<edge>/registry.npmjs.org/`; default `replace-registry-host=npmjs` rewrites tarball URLs | ✅ |
| curl / scripts / SDKs | `$BOXERY_EDGE/<host>/<path>` | ✅ |
| pip (private index) | `PIP_INDEX_URL=<edge>/<host>/simple/` (manual) | ✅ manual |
| gh | `GH_HOST`/`api_host` need an https hostname; only `gh api http://…` accepts http | ❌ v1 (needs a local TLS + guest CA, deferred) |

exe.dev does the same thing (`github.int.exe.xyz`, HTTP-proxy integration with `--header`, `--readonly`) but owns
real TLS hostnames. Fly's tokenizer is the other prior art (sealed secrets + proxy injection).

## Design

### Where routes live: the host proxy
Same place as LLM credentials. Works with the laptop closed, one log, one auth path. Values are resolved
**on the controller** when grants are applied (e.g. `gh auth token` on the laptop) and pushed to the host over
ssh stdin into `$CONF/edge/NAME.json` (0600, like `proxy.env`). The host is already trusted with LLM keys.
They are never sent to the VM.

### Guest → proxy
Existing hop: guest `127.0.0.1:8088` → socat → host proxy. New route prefix:

```
http://127.0.0.1:8088/edge/<vm-token>/<host>/<path>  →  https://<host>/<path>   (+ granted headers)
```

The VM token goes in the path because git/npm can't be told to send an extra header for a base URL without
also exposing it to the upstream. The VM token is not a secret from the VM (it's already in `~/.boxery/token`);
the proxy redacts it from logs. `BOXERY_EDGE=http://127.0.0.1:8088/edge/<token>` is exported in the VM.

### Proxy rules (`/edge/…`)
- Authenticate the token (same `tokens.json` as LLM routes) → VM name; load `edge/NAME.json` per request
  (revoke is immediate, no restart).
- `<host>` must match `^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$` and be an exact key in the
  VM's routes; otherwise 403. Upstream is always `https://<host>` (no ports, no plain http; tests use an env
  override).
- Drop incoming `authorization`, `proxy-authorization`, `cookie` and every header the route sets; add the route's
  headers. Hop-by-hop headers stripped as today.
- `readonly` routes: allow GET/HEAD and `POST …/git-upload-pack` (git fetch/clone); everything else 403.
- Redirects are not followed. A `Location` pointing at a granted host is rewritten back into the edge URL;
  anything else is returned as-is (the client goes there directly, without credentials).
- Same per-VM concurrency and wall-time limits; body limit `BOXERY_PROXY_EDGE_MAX_BODY` (default 1 GiB, for
  git push).
- Log line: `vm EDGE METHOD host path status ms` (no token, no query string).

### Grant syntax (controller)
```bash
boxery grant demo github                                     # preset (below)
boxery grant demo http:registry.npmjs.org --cmd 'npm token get' # bearer by default
boxery grant demo http:api.example.com --auth header:X-Api-Key --cmd 'pass show example'
boxery grant demo http:git.example.com --auth basic:oauth2 --cmd '…' --readonly
boxery revoke demo http:api.example.com | github
```
- `--auth bearer|basic:USER|header:NAME` (default bearer); `--cmd` required (values only ever come from a command
  on the controller, run at apply time); `--readonly` optional.
- Store line: `http<TAB>host<TAB>auth;ro;cmd`.
- Preset `github` = `http:github.com --auth basic:x-access-token` + `http:api.github.com` (bearer), both
  `--cmd 'gh auth token'`. `github --readonly` passes through.

### Apply
`grants_apply` already runs on grant/revoke/new/start/revert/attach/ssh/pi. It gains one step **before** the
guest script: build `{host: {headers: {...}, readonly}}` from http grants (running each `--cmd` once per
distinct command) and send it to `boxery-host edge-set NAME` on stdin (empty object = clear). Then the guest
script writes, in tmpfs `/run/user/<uid>/boxery/`:
- `env.sh`: `BOXERY_EDGE`, and `npm_config_registry` if `registry.npmjs.org` is granted
- `gitconfig`: one `insteadOf` per granted host; `~/.gitconfig` gets a one-time `[include] path=…` (a missing
  include is ignored by git, so revoke/reboot is clean)

### Lifecycle
- `boxery-host rm NAME` deletes `edge/NAME.json`.
- Lease reset deletes it (the next holder must not inherit the previous holder's routes); controller `release`
  forgets the grants file for that VM.
- `boxery grants NAME` lists `http:host (bearer, from: gh auth token)`; `boxery ls` summary shows `http:host`.

## Out of scope (follow-ups)
- `gh` CLI support (needs in-guest TLS with a boxery CA — revisit with #4 egress).
- Per-path allowlists beyond `--readonly`; token minting (short-lived tokens from a vaulted one).
- Default-deny egress (#4) — this feature is what makes that usable.

## Test plan
- **proxy unit** (fake https-less upstream via `BOXERY_EDGE_UPSTREAM=http://127.0.0.1:PORT`): header injected;
  incoming auth replaced; VM token not forwarded; another VM's token can't use the route; ungranted host 403;
  malformed host 400/403; readonly allows GET + upload-pack, blocks POST/PUT; Location rewrite only for granted
  hosts; route file change takes effect without restart; token absent from logs; CR/LF in header values refused
  at `edge-set`.
- **host shell**: `edge-set` validation (bad host, bad header name, CR/LF, non-JSON) and file mode 0600; `rm`
  and lease reset delete routes.
- **controller shell**: spec parsing/validation, preset expansion, store/revoke, apply sends the right JSON to the
  host (stub), values never appear in the guest apply script, release forgets grants.
- **live (hornet)**: `grant chk github`; in the VM `git ls-remote https://github.com/benvinegar/boxery` (private)
  works; `curl $BOXERY_EDGE/api.github.com/user` → benvinegar; grep the VM's disk + tmpfs + env for the token →
  nothing; revoke → both fail with 403; e2e section added.

---

## Review (of plan v1) and what changed

1. **Token in the URL path ends up in places.** git can store remote URLs in `.git/config`; with `insteadOf` the
   *remote* stays `https://github.com/…`, so only the tmpfs include holds the edge URL. npm writes the registry
   into `package-lock.json` `resolved` fields? → npm writes the *tarball URL as resolved*; with
   `replace-registry-host` it records the original `registry.npmjs.org` URL, but with a custom registry npm can
   record the custom URL in new lockfiles. **Change:** document it; the token is per-VM and revoked on `rm`, and
   lockfile URLs only work from inside that VM anyway. Also redact in proxy logs (done in plan).
2. **v1 had the proxy follow redirects** (fetch default) → credentials could be sent to the redirect target.
   **Change:** `redirect: "manual"` (already used for LLM routes) + Location rewrite only for granted hosts.
3. **v1 allowed `http:HOST:PORT` and plain-http upstreams.** SSRF surface into the host's network
   (e.g. `http:127.0.0.1:11434`). **Change:** https only, hostnames only (no IP literals, no ports); tests use an
   env override that the service unit never sets.
4. **v1 let `--value` be passed on the command line** → ends up in shell history and `ps`. **Change:** `--cmd`
   only.
5. **Lease handover:** v1 forgot that pool VMs change hands. **Change:** reset clears edge routes; release
   forgets grants locally.
6. **Body limit:** LLM limit (32 MiB) would break `git push` of real repos. **Change:** separate edge limit.
7. **Header names from users** could set `host` / hop-by-hop headers. **Change:** `header:NAME` must match
   `^[A-Za-z0-9-]+$` and not be host/content-length/connection/transfer-encoding; values must not contain CR/LF.
8. **Same cmd run twice** for the github preset (two hosts) → `gh auth token` runs twice per apply; harmless but
   slow. **Change:** cache per distinct command within one apply.
9. **Response echo:** an upstream that reflects request headers (httpbin) would show the secret to the VM.
   Inherent to header injection (exe.dev has the same property). **Change:** documented; grant only to APIs you
   trust.
