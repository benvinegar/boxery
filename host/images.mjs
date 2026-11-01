// Images: immutable disk states named VM@LABEL (snapshots, the pool's clean state, fork sources).
// One backend primitive set: capture, list, remove, new-from-image and reimage (host/backends/README.md).
import { BackendError } from "./backend.mjs";

/** Put VM NAME back to its image NAME@LABEL. VMs from before images may still have a backend-internal
 * snapshot of that label (libvirt pool VMs added before images existed). */
export async function restoreVm(backend, name, label, options) {
	const image = `${name}@${label}`;
	if (await backend.imageExists(image, options)) return backend.call("backend_reimage", [name, image], options);
	if (await backend.has("backend_legacy_revert")) {
		try { return await backend.call("backend_legacy_revert", [name, label], options); }
		catch (e) { if (!(e instanceof BackendError)) throw e; }
	}
	throw new Error(`no snapshot ${label} for ${name}`);
}
