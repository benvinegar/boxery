# Backend-owned templates

Templates are **named creation sources on a particular host/backend**. Backends declare their
built-ins; operators can register additional names for prepared Boxery disk images.
There is no universal disk/RAM format and no cross-provider transfer behind a shared name.
The new commands require an updated controller and host; older hosts report unsupported commands
rather than substituting another creation path.

```sh
boxery templates
boxery templates --json
boxery new work --template desktop
boxery new ci --template headless       # where this backend supports it
```

For another host: `boxery --host NAME templates`. Agent tools expose the same interface:

```json
{"action":"templates"}
```

Use that with `vm_info`; create with `vm_manage`:

```json
{"action":"new","vm":"work","template":"dev"}
```

## Supported versus ready

`templates --json` returns `{backend, templates: [...]}`. Each entry has `name`, `kind`, `source`,
`origin`, `supported`, `ready` and `status`; registered images also have `image` and `description`.

| Status | Meaning | Explicit selection |
|---|---|---|
| `ready` | Native source preflight succeeded | Allowed |
| `missing` | Declared source is absent | Fails; no substitution |
| `on-demand` | Supported stock path installs/provisions on creation; not a prepared environment | Allowed; may be slow |
| `unready` | Native source exists but is not ready, e.g. a provider build is pending | Fails; retry after preparation |

`ready` does **not** mean a guest boot, full software/security audit or benchmark just ran.
Provider errors and invalid inventory are errors, not `missing`. Kind is unknown (`null`) for
missing registered images. Equal names do not imply equal software, performance or network policy.

Current backend declarations:

| Backend | Built-ins |
|---|---|
| libvirt, Lima, Cloud Hypervisor, exe.dev | `desktop` (existing native base), `headless` (stock/on-demand) |
| boat.dev | `desktop` only; its current stock/headless creation path is unsupported |

Run the existing `boxery build-base` to prepare a missing desktop base. The old `new` and
`new --headless` behavior is unchanged when no template is selected. `--template` cannot be
combined with `--from` or `--headless`; resource/shape flags and `--cold` can still be used.
An unknown or unavailable selected name never silently falls back to another environment.

## Define templates per backend

On the **host**, put `templates.json` in the selected profile's `BOXERY_CONF` (default
`~/.config/boxery`; named profiles use `~/.config/boxery-NAME`). This is not the laptop
controller's configuration directory unless it is also the host.

```json
{
  "version": 1,
  "backends": {
    "lima": {
      "dev": { "image": "golden@dev", "description": "Project development tools" }
    },
    "cloud-hypervisor": {
      "dev": { "image": "golden@dev" }
    },
    "exe": {
      "dev": { "image": "golden@dev" }
    },
    "boat": {
      "desktop-tools": { "image": "golden@tools" }
    }
  }
}
```

The backend keys are `libvirt`, `lima`, `cloud-hypervisor`, `exe` and `boat`. Only the active
backend's definitions are selected. Every image reference belongs to that profile's own
inventory; these examples do not copy a Lima image to exe.dev.

Names use `[a-z][a-z0-9-]{0,30}`. Backend built-in names cannot be overridden. Version 1 custom
definitions accept only `image` and optional `description`: no arbitrary commands, host paths,
provider IDs or environment overrides. The `image` is the existing `VM@LABEL` disk-image reference,
not a Docker/OCI image name. Kind is inherited from the image's VM metadata, not the alias name.
Pool `boxery-clean` and temporary `fork-*` image labels cannot be registered as templates.

### Prepare a custom source

On the selected backend, using existing commands:

```sh
boxery new golden --template desktop    # requires its existing native base
boxery run golden 'sudo apt-get update && sudo apt-get install -y ripgrep'
boxery snap golden dev
boxery stop golden
# Register golden@dev as dev in the host profile's templates.json above.
boxery templates
boxery new project-a --template dev
boxery new project-b --template dev
```

Use a clean, trusted authoring VM. Disk images can contain persisted workspace data and secrets;
registration is not sanitization or a trust certificate. New machines still run Boxery's normal
identity/credential checks. Images, forks and resets remain disk-only; tmpfs grants are not captured.

V1 retains the stopped authoring VM and image. Normal `snap-rm golden dev` and `rm golden` refuse
while this backend has a definition referencing its image. Remove/repoint the definition first
when deliberately retiring it; already-created independent clones keep their existing behavior.
Independent template ownership without an authoring VM and automated named builders are future work.

## Consistency and backend behavior

Selection resolves to ordinary backend creation arguments **before lifecycle locking**. Image
aliases bind `--from VM@LABEL`, so the existing source-image locks and worker-side checks apply.
Editing an alias later cannot retarget an in-flight worker. No template-specific clone/lease path
bypasses normal authorization, tokens, grants, recovery or readiness.

Definitions are operator-managed files, not a transactional registration API. Write them atomically
and coordinate edits with source retirement. A manual edit racing deletion can still create a missing
reference; runtime checks fail rather than substituting a base. Built-in bases retain their existing
build/publication semantics, not immutable-version guarantees introduced by this feature.

Existing CH RAM acceleration stays backend-private/default-off. A built-in base may use its matching
cache; a named **disk image** always uses the existing disk-only `--from` path, never unrelated base
RAM. Keep [CH's network/RAM trade-offs](../host/fast/README.md) separate from template names.

## Backend authors

Declare built-ins in `host/backends/NAME.templates.json`:

```json
{
  "version": 1,
  "imageTemplates": true,
  "builtins": {
    "desktop": { "kind": "desktop", "source": "base" },
    "headless": { "kind": "headless", "source": "stock" }
  }
}
```

V1 built-in sources are existing desktop `base` and headless `stock`; omit unsupported entries.
`imageTemplates` opts into named aliases of the backend's existing disk-image primitive. A driver
without a declaration advertises no templates; its ordinary creation API is unchanged.

Implement `backend_template_status base|stock`. On success emit exactly one of `ready`, `missing`,
`on-demand`, `unready` and exit 0. Any inability to inspect the source must exit nonzero. Never encode
normal states as exit codes that could be confused with shell/API failures. Do not create artifacts,
download an image, rebuild a base or change shared networking during this read-only preflight.

Future: adapter-validated direct native imports (provider images/snapshots, Lima definitions, disks),
named recipe-driven preparation, versioned publication and durable build recovery. See the
[implementation plan](plans/2026-11-02-portable-bases-and-fast-create.md).

## Validation

- `node --test test/templates.test.mjs test/templates-backends.test.mjs`: schema, isolation,
  missing/outage states, canonical source locking, CLI/tool selection, deletion safety and native
  adapter functions with mocked APIs. These do not claim live hosted-provider conformance.
- `node test/bench/template-lifecycle.mjs --run`: opt-in **real local libvirt** smoke test using an
  existing desktop base read-only, a private state directory and unique VM prefix. Exercises named
  discovery, snapshot registration/creation, fresh identity, private writes and deletion protection;
  removes its VMs, images and copied management keys. It does not run init or change shared networks.
