# Plan: backend-owned templates

Status: **v1 implemented on the experimental branch; draft review pending**, tracked by `TODO-6fa9e7db`.
Merge gate: integrate and revalidate against current master, particularly the newer LLM-grant,
SSH host-key pinning, VNC-authentication, strict type-checking and multi-host changes. Existing
validation below is from the older polling-PR baseline, not proof of compatibility with those changes.
Validation: 269 Node tests, full shell suite, backend-native status tests with mocked APIs, and a
real disposable libvirt create/snapshot/template-clone/deletion-safety smoke test passed.
Hosted providers were not live-tested for this change. Subsequent milestones below are not implemented.
Supersedes the earlier universal logical-base-release proposal in this file.

## Decision

Backends declare the templates they support. Operators can define additional named templates
for each backend in a host profile. A template name is local to that backend/profile, not a claim
that identically named environments on different providers contain identical bytes or packages.

Reuse the existing image layers, native base builders, disk-image contract and lifecycle coordinator.
Do not introduce a universal VM artifact, a new recipe language or a provider-neutral RAM snapshot.

```text
Selected host/profile
        |
Backend declarations + profile templates.json
        |
  Supported named templates
        |
  Explicit name resolution / readiness
        |
   +----+-------------------+------------------+
   |                        |                  |
 Lima                     exe.dev            CH / others
 native base,             native prepared     native bases,
 stock or disk clone      base or disk copy   stock or disk clones
   |                        |                  |
   |                        |           CH may privately use
   |                        |           a matching RAM cache
   +------------------------+------------------+
                            |
                 Existing identity / readiness
                 leases / grants / recovery
                            |
                       Boxery VM

User snapshots, forks and resets remain disk-only.
```

## Implement now: a complete, backward-compatible v1

- Backend-owned declaration files next to `host/backends/*.sh` enumerate built-ins.
  Existing desktop bases and on-demand headless creation remain native implementations.
  Do not advertise boat headless creation: its current stock path does not support it.
- A profile's `templates.json` contains definitions grouped by backend. Initially custom
  templates reference **existing Boxery disk images** (`VM@LABEL`), which already map to each
  provider's native snapshot/copy implementation. This deliberately does not support arbitrary
  external provider image IDs, Docker images, setup scripts or environment overrides yet.
- `templates [--json]` reports backend, name, kind, source and status. Supported/configured is
  distinct from ready. On-demand stock creation is explicit, not falsely called a prepared base.
  Ready means native source preflight succeeds, not that a full guest/security audit just ran.
- `new --template NAME` and `vm_manage {template: NAME}` select one declared name. Reject
  conflicting `--from`/`--headless` options. Unknown/missing templates fail without substitution.
- Resolve selected definitions to existing canonical creation arguments **before acquiring
  lifecycle resources**. Named disk images become `--from IMAGE`; their source VM is locked
  exactly like an ordinary image reader. A later alias edit cannot retarget an in-flight worker.
- The worker performs ordinary source existence, kind, identity and readiness checks under those
  locks. Selection does not create a second clone implementation or bypass lease/grant policy.
- Protect configured image references from normal image/authoring-VM deletion. Definitions are
  operator-managed configuration, not a transactional registry: concurrent manual edits and
  deletion are not made atomic by this first version. Runtime source checks remain mandatory.
- Add discovery to `vm_info`, CLI help/parity, examples and offline/fake-backed integration tests.
  Keep ordinary creation and public creation output unchanged when no template is selected.

### Example operator configuration (v1)

```json
{
  "version": 1,
  "backends": {
    "lima": { "dev": { "image": "golden@dev", "description": "Prepared dev tools" } },
    "exe": { "dev": { "image": "golden@dev" } },
    "cloud-hypervisor": { "dev": { "image": "golden@dev" } }
  }
}
```

Each reference is resolved in that backend/profile's own image inventory. There is no cross-provider
transfer. Use current `new`, `run` and `snap` commands to prepare the disk; keep the stopped authoring
VM/image while registered. Automated template builders and independent template-image ownership are
later work. Named user disk images do not become eligible for unrelated CH base RAM restoration.

## Current foundations and ownership

| Concern | Owner |
|---|---|
| Reusable OS/tool setup | Existing `image/layers/*.sh`; optional across different native starting images |
| Supported built-ins | Backend declaration, not a hard-coded universal list in the controller |
| Extra named definitions | Operator's selected host profile, grouped by backend |
| Base/image storage, native create/copy | Backend adapter and provider/hypervisor |
| Selection, validation and lifecycle locks | Shared host orchestration |
| Per-instance authorization/proxy credentials | Existing guest/bootstrap mechanisms, backend-specific where necessary |
| Optional RAM caching and compatibility | CH-private implementation, default-off |
| User snapshots and pool reset | Existing disk-only image primitive |

exe.dev currently prepares a base VM and uses native `cp`; boat prepares a saved base snapshot.
Lima/libvirt/CH have their own native base artifacts. We extend those mechanisms rather than require
providers to consume our disk or RAM format. Provider-owned host keys/management channels must not be
blindly replaced with CH's vsock/key-rotation protocol.

## Delivery checklist

### 1. Revise architecture and track execution

- [x] Replace the logical-universal-release-first plan with backend-owned definitions.
- [x] Track implementation and acceptance checks in a todo.
- [x] Update the diagram/architecture roadmap without marking future work as already built.

### 2. Implement declarations and configuration

- [x] Driver declarations for libvirt, Lima, CH, exe, boat and the test backend.
- [x] Strict, bounded configuration validation; reserved built-ins cannot be silently overridden.
- [x] Kind is inherited from a selected disk image, not asserted by a misleading alias.
- [x] Unsupported backend/template combinations fail explicitly.

### 3. Implement discovery and explicit selection

- [x] Native readiness distinguishes ready, missing, on-demand and not-yet-ready.
- [x] Provider outages/invalid inventory are errors, never missing catalogs or hidden rebuilds.
- [x] Host/controller `templates [--json]`, `new --template`, `vm_info templates`, `vm_manage template`.
- [x] Selection canonicalized before supervision; existing resource locks and worker checks retained.
- [x] Configured image references protected from normal deletion; no new automatic GC.

### 4. Test and document

- [x] Definition schema, backend isolation, conflicting/unknown selectors and error states.
- [x] CLI/tool parity and image-source lifecycle locking; changing config cannot retarget a worker.
- [x] Real host CLI against a disposable fake-backed profile: define, list, select, create, delete safety.
- [x] Offline backend contract tests; existing Node, shell and lint regressions.
- [x] User documentation with supported-vs-ready meaning, setup examples and current limitations.
- [x] Report live hosted-provider validation as untested unless actually exercised.

## Subsequent work (separate milestones, not claimed by v1)

Tracked separately by `TODO-03e89f17`.

1. **Native source schemas.** Let each adapter validate additional provider-native sources (e.g.
   provider image, saved snapshot ID, disk path, Lima definition) where documented APIs support them.
   Keep references scoped to the owning host/account. Do not accept arbitrary host paths or provider
   IDs from agent calls without an operator-defined template.
2. **Recipe-driven preparation.** Extend existing `build-base`/shared layers to prepare named targets,
   including headless where supported. Reuse the existing application-profile plan rather than
   invent a competing build-script DSL. Import/preparation must establish the guest contract.
3. **Versioned publication and ownership.** Durable build/publication intent, immutable candidates,
   atomic active-reference updates, failed-build rollback and explicit backing dependencies. Today
   `build-base` is administrative and outside normal lifecycle locking; existing per-VM locks do not
   magically provide build coordination. Independent template images should not require a retained
   authoring VM. No automatic GC until dependency/rollback rules are tested.
4. **Rehome the CH experiment.** Its prepared disk/RAM pair becomes an optional cache behind a named
   CH template. Pin exact paired disk, recipe/guest barrier, CPU/resources, hypervisor, firmware and
   network mode. Never pair user disk snapshots with unrelated base RAM. Retain `--cold` as bypass
   of Boxery acceleration, without claiming control over opaque provider internals.
5. **Real-backend conformance and rollout.** Test supported targets on actual providers/hypervisors;
   document different network policies, resource mappings and billing. Measure full readiness and
   subsequent first use, warm/cold storage, concurrent load and RAM costs. Privileged TAP/COW and
   host reboot/upgrade matrices remain requirements for the corresponding CH claims.

## Safety and acceptance gates

- Existing defaults, VMs, base artifacts, CLI output and shared network configuration stay unchanged.
- Every selected source follows existing identity/token/key/grant/readiness checks; no alias grants
  authority to inherited credentials. Disk templates can contain persisted user data: operator
  registration is not secret sanitization or a trust certificate.
- Images/forks/resets never capture live user RAM. Distinct template names are not security boundaries.
- Backend/API failure cannot masquerade as an empty list, a missing template or successful readiness.
- Backends unsupported by a template fail clearly; equal names do not imply equal software or policy.
- Tests use disposable profiles. Hosted tests require explicit opt-in, credentials and a cost budget.

Related: [backend API](../../host/backends/README.md), [lifecycle/recovery](../lifecycle.md),
[application profiles](2026-11-01-profiles-and-lease-extensions.md),
[CH experiment and measured limits](../../host/fast/README.md).
