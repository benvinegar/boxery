// The Linux guest: what's inside every boxery VM today (Ubuntu with cloud-init and systemd; image/layers/).
// Facts about the guest that the host (host/) and the agent machine (core/) both rely on live here, so a
// second guest OS has one place to say how it differs (docs/plans/2026-11-03-guest-os-seam.md).
// No imports: core/ and host/ both load it, and the host never depends on core/.

export const name = "linux";
/** The agent user's home; ~ in tool paths. */
export const home = "/home/agent";
/** Where agent tools start (cwd of vm_bash, base of relative paths). */
export const project = `${home}/project`;
/** boxery's guest-side records: proxy-upstream, provision, layers, headless, build-info. */
export const configDir = "/etc/boxery";
/** Grants pushed into the VM (tmpfs: never in an image), as a shell expression for the agent user. */
export const grantsDir = '/run/user/$(id -u)/boxery';
