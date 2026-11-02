{
  "id": "6fa9e7db",
  "title": "Backend-owned templates: revise architecture and implement discovery/selection",
  "tags": [],
  "status": "closed",
  "created_at": "2026-11-02T13:55:09.484Z"
}

## Completed: backend-owned templates v1
- [x] Revised docs/plans/2026-11-02-portable-bases-and-fast-create.md; replaced universal-release-first proposal with backend/profile-owned definitions. Updated architecture roadmap and existing live diagram.
- [x] Driver declaration files for libvirt, Lima, Cloud Hypervisor, exe, boat and fake. Boat does not advertise stock headless support.
- [x] Strict profile templates.json grouped by backend; named existing Boxery disk images; inherited kind; no arbitrary scripts/paths/env overrides or transient lifecycle images.
- [x] Native source status protocol: explicit ready/missing/on-demand/unready text; API and malformed-inventory errors fail rather than masquerading as absence.
- [x] Host/controller templates [--json], new --template, vm_info templates and vm_manage template. Unknown/missing/conflicting selections rejected.
- [x] Canonical image binding BEFORE supervision; unchanged --from source-image locks and worker validation. Defaults and existing native creation unchanged.
- [x] Normal referenced-image/source-VM deletion refused until definitions removed. No automatic GC.
- [x] CLI/tool parity, docs/templates.md, examples and package-file verification.

## Validation
- npm test: 269 passed, zero failures/skips.
- npm run test:shell: complete suite passed.
- npm run lint and git diff --check passed.
- Actual adapter status functions tested with mocked native APIs for all six drivers.
- Real local libvirt smoke test passed: native base discovery, snapshot registration, named clone, fresh machine IDs, independent disk writes and deletion protection. Unique private VM prefix/config; VMs/images and management-key copies cleaned up. No init/base/network changes.
- CLI and shared tool-core integration exercised against real host orchestration with fake backend.
- No live hosted-provider validation claimed. Existing checkout has no tsc for typecheck.

## Scope / follow-up
Implementation is local and uncommitted on experiment/ram-templates, preserving pre-existing RAM experiment changes. V1 custom definitions reference existing Boxery disk images; direct arbitrary provider-native imports, automated named builders/versioned publication/ownership, and CH builder rehoming remain open under TODO-03e89f17. User defaults unchanged.

Final follow-through: made boat saved-snapshot inventory schema strict so malformed successful HTTP replies cannot masquerade as empty/missing named-image inventory. Re-ran targeted template/adapter/parity tests (19), complete boat shell tests (116), lint and doc-link checks successfully after that fix. Package dry-run includes all six declarations, host/templates.mjs and docs/templates.md.
