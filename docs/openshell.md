# OpenShell backend (experimental)

OpenShell is a **policy-enforced headless** option, not an unrestricted VM with sudo. Boxery supplies its shell, file and job tools; OpenShell supplies isolation, filesystem/network policy, credential providers and gateway authentication. Docker-backed sandboxes share their host kernel; select OpenShell's MicroVM driver when you require a VM boundary.

This is an experimental integration, validated end-to-end with OpenShell 0.1.7 on Linux using its Docker driver and an mTLS gateway. MicroVM, Podman, Kubernetes and macOS were not tested; their image/home-directory behavior can differ. This smoke test is not a security audit. Pin compatible CLI/gateway versions. OpenShell's pre-1.0 APIs can change.

## Setup

Install OpenShell and start a trusted gateway using [OpenShell's instructions](https://github.com/NVIDIA/OpenShell). Boxery leaves gateway binaries, TLS and services under OpenShell's management. Access to gateway operator credentials is effectively administrative access to its sandboxes; never put those credentials inside the workload.

Then run:

```bash
boxery setup local --backend openshell
boxery --host restricted new demo --headless
boxery --host restricted run demo node --version
```

Guided setup discovers an existing authenticated HTTPS gateway, builds the bundled image for a local Docker gateway, saves an offline starter policy, chooses a unique sandbox prefix, and registers the Boxery host `restricted`. No environment-variable setup or guest SSH key is required. It displays the plan for confirmation; use `--yes` for noninteractive setup. If several gateways exist, choose `--gateway NAME` rather than silently using the active gateway.

If the package-managed local gateway is running but not registered yet, add `--register-local`. This registers `https://127.0.0.1:17670` using OpenShell's existing TLS bundle; it does not generate certificates, start services, or disable verification. Missing dependencies and unavailable gateways produce installation/startup guidance.

Settings and the editable policy live in `~/.config/boxery-restricted/`. Repeating setup preserves the prefix, configured image and edited policy. Saved image references are used as existing images, not automatically rebuilt, even when their tag matches the bundled image. It refuses to repoint an initialized profile at another gateway/workspace/namespace; choose a new `--name` instead. `--name` also selects the host-side profile unless `--profile` is explicit.

Explicit choices:

```bash
boxery setup local --backend openshell --gateway work --name restricted \
  --workspace default --image registry.example/boxery:team \
  --policy "$PWD/team-policy.yaml" --provider work-github --yes
```

`--provider` is repeatable and selects existing providers only; setup never imports credentials. To clear saved attachments for **future** sandboxes, rerun with `--no-providers` (mutually exclusive with `--provider`). This does not detach providers from existing sandboxes; use OpenShell's provider detach commands for those. Providers can add network permissions, so review their effective policy. Use `--image` for remote/non-Docker gateways or when the gateway uses a different Docker engine/context. Automatic builds use the current local Docker engine and reject remote Docker contexts. Run `boxery setup local --backend openshell --help` for all options.

### Manual configuration / remote Boxery hosts

The original environment-variable setup remains available. Build the image in the engine used by the gateway (or push it to a registry accessible to that gateway):

```bash
docker build -t boxery-openshell:dev -f image/openshell/Dockerfile .

export BOXERY_OPENSHELL_GATEWAY=local
export BOXERY_OPENSHELL_WORKSPACE=default
export BOXERY_OPENSHELL_PREFIX=bx-restricted-
export BOXERY_OPENSHELL_IMAGE=boxery-openshell:dev
export BOXERY_OPENSHELL_POLICY="$PWD/image/openshell/policy.yaml"
# Optional: existing OpenShell providers, explicitly attached at creation.
# export BOXERY_OPENSHELL_PROVIDERS=github

boxery host add restricted local --backend openshell
boxery --host restricted new demo --headless
boxery --host restricted run demo bash -c 'id; node --version; git init -q; echo hello >hello.txt'
```

Each profile needs its own prefix. OpenShell 0.1.7 limits the **prefix plus VM name** to 19 characters; the adapter rejects longer names before creation. Every create also stamps an exact `boxery.dev/namespace` ownership label derived from the prefix. Inventory, lifecycle, cleanup and SSH verify both that label and the name in the selected gateway/workspace, so overlapping prefixes cannot claim each other's sandboxes. Unlabeled sandboxes from earlier development builds are not automatically adopted; inspect/manage them explicitly through OpenShell. These settings persist in the host profile; image and policy paths/references must be available on that host, not just the controller. Do not change a populated profile's gateway, workspace or prefix.

The image must provide UID 1000, `HOME=/home/agent`, writable `~/project`, Bash, Node >=22.18, Python 3, tar, coreutils, procps, `file`, git, tmux, util-linux (`setsid`) and `/etc/boxery/headless`. Our image includes these. Set `WORKDIR /home/agent`: the Docker driver derives `HOME` from `WORKDIR`, so using `/home/agent/project` would break Boxery's paths. The policy explicitly permits sandbox-local `/dev/pts` and `/dev/ptmx` for tmux jobs and interactive shells. Add project-specific system packages at image build time. No cloud-init, sudo, guest SSH server or Boxery provisioning layers are used. The canonical workload is `sleep infinity`; tools run through OpenShell's SSH gateway.

CPU and memory are requested through OpenShell; enforcement depends on its compute driver. Disk size is driver-managed: `--disk` and resize are unsupported, and Boxery reports unknown sizes rather than the requested shape as actual capacity.

## Credentials and policy

The example policy starts offline. Add only the network destinations and binaries your project needs, using [OpenShell policies](https://github.com/NVIDIA/OpenShell/tree/main/docs/how-it-works/policies). For example, a GitHub workflow needs approved git/HTTPS endpoints and an explicitly configured provider with a dev-scoped token. Select existing providers during setup with `--provider NAME`, through `BOXERY_OPENSHELL_PROVIDERS` for manual configuration, or attach them with OpenShell's own commands. Setup settings affect newly created sandboxes; changing them does not update existing sandboxes. Manual configuration can use `BOXERY_OPENSHELL_PROVIDERS='[]'` to persist an explicitly empty selection rather than inherit a saved list. Boxery does not auto-import local credentials.

Boxery `grant`, SSH-agent forwarding, its LLM proxy and pushed env/file grants are not supported. Keep the controlling agent outside the sandbox. Do not copy credentials into the sandbox to work around a policy denial. Provider attachments can add allowed network access; review the **effective** policy, not only the supplied YAML.

## Capabilities and trust

Supported: create (`--headless`), list, shell/files/copy, jobs, stop/start and remove. File persistence across stop/start follows the selected OpenShell driver. Delete is destructive.

Not supported: desktop/browser tools, snapshots, forks, `--from`, restore, resize, pools and leases. OpenShell's gateway authenticates SSH, and the guest's `authorized_keys` does not fence access. Consequently this backend must never participate in Boxery's lease pool.

The adapter bootstraps the sandbox's ed25519 host key **through the authenticated, named gateway relay**, then uses Boxery's existing strict host-key checks for tool traffic. It does not scan a guest-network address or disable checking on subsequent connections. Trust therefore rests on OpenShell's gateway authentication and transport as well as the host. No direct TCP guest endpoint is exposed.

## Live smoke checks

Run the repeatable core smoke test against a configured host using the bundled offline policy (and no default provider attachments). It creates and removes one disposable sandbox:

```bash
node test/openshell-smoke.mjs restricted
```

Verified on OpenShell 0.1.7, Linux x86_64, Docker 29.9.2, with mTLS and no TLS-verification bypass:

- Non-root identity, protected `/etc` writes denied, unapproved outbound HTTPS denied.
- Shared Bash, write/read/atomic-edit, bidirectional streaming copy, headless-tool refusal.
- Background jobs survive the initiating call and complete; files survive stop/start.
- Snapshots, forks, pools, Boxery grants and resizing refused; deletion confirmed through live inventory.
- A disposable local provider delivered only a placeholder to the workload, injected the synthetic token at the approved endpoint, returned HTTP 403 for an unapproved path, and revoked environment/access on detachment. No real user credentials were used.
- A read-only policy allowed git to clone `octocat/Hello-World`; an edit and Node test passed. Curl could not borrow git's permission. No public PR was created.

For other gateway versions/drivers and release qualification, also check:

1. Create a sandbox; verify `id -u` is nonzero, shell/files/copy and background jobs work through MCP or pi.
2. Verify `sudo`/root escalation is unavailable and an unapproved network request is denied.
3. Add a narrow policy/provider, clone a test repo, run tests, and create a disposable PR. Confirm the real token is not readable in the sandbox.
4. Stop/start and verify expected file persistence; delete and confirm the resource disappears.
5. Confirm `snap`, `fork`, pool membership, grants and desktop tools fail rather than silently weakening isolation.
6. Interrupt creation, then `reconcile`; check that only the selected namespace is cleaned up. An unavailable gateway must fail inventory, not report an empty host.

Offline checks: `node --test test/openshell.test.mjs test/openshell-setup.test.mjs`. These mocks alone do not establish kernel enforcement or gateway compatibility. The live runner tests the shared tools used by MCP and pi, not their client-specific UI. Provider rotation, multi-user authorization, MicroVM isolation and real-hypervisor crash recovery need separate qualification.
