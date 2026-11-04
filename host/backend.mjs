// Hypervisor backends from Node. Every call runs `host/backend.sh FUNCTION ARG…` as its own process:
// argv only, never a shell string. It is never detached, so it stays in the caller's process group and
// the supervisor's crash fencing covers it (docs/lifecycle.md). The backend's diagnostics go to stderr.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
/** @import { Readable } from "node:stream" */

const SCRIPT = fileURLToPath(new URL("./backend.sh", import.meta.url));
const MAX_OUTPUT = 16 * 1024 * 1024;

/** @typedef {{ capture?: boolean, quiet?: boolean, extraEnv?: NodeJS.ProcessEnv }} CallOptions */
/** @typedef {{ host: string, port: string, name?: string }} Endpoint */
/** @typedef {{ fatal: boolean, message: string }} EndpointProblem */
/** @typedef {{ name: string, state: string, ssh: string, diskBytes: number | null, diskUsedBytes: number | null, tunnel: string }} BackendVm */
/** @typedef {{ image: string, created: string, size: string }} BackendImage */
/** @typedef {ReturnType<typeof createBackend>} Backend */

export class BackendError extends Error {
	/** @param {string} message @param {{ exitCode?: number, reported?: boolean }} [opts] */
	constructor(message, { exitCode = 1, reported = false } = {}) {
		super(message);
		this.exitCode = exitCode; this.reported = reported; // (not Object.assign: so the checker sees the fields)
	}
}

/** @param {string} field */
const byteCount = (field) => (/^\d+$/.test(field) ? Number(field) : null);
/** @param {string} text */
const tsv = (text) => text.split("\n").filter((l) => l.length > 0).map((l) => l.split("\t"));
// {host, port, name}: name is the VM, so guest ssh checks that VM's pinned host key (hostkeys.mjs).
/** @param {string} text @param {string} name @returns {Endpoint} */
const endpoint = (text, name) => {
	const ep = text.trim();
	const host = ep.slice(0, ep.lastIndexOf(" ")), port = ep.slice(ep.indexOf(" ") + 1);
	if (!host || !port) throw new BackendError(`backend returned no ssh endpoint ("${ep}")`);
	return { host, port, name };
};

// capture: collect stdout (metadata) and return it; otherwise the backend's stdout goes to our stderr,
// so it can never corrupt this command's own output. quiet: discard the backend's stderr too.
// extraEnv: variables for this call only (e.g. BASE_USERDATA for backend_build_base).
/**
 * @overload
 * @param {NodeJS.ProcessEnv} env @param {string} fn @param {Array<string | number>} args @param {CallOptions & { status: true }} options
 * @returns {Promise<{ code: number, out: string }>}
 */
/**
 * @overload
 * @param {NodeJS.ProcessEnv} env @param {string} fn @param {Array<string | number>} args @param {CallOptions & { status?: false }} [options]
 * @returns {Promise<string>}
 */
/** @param {NodeJS.ProcessEnv} env @param {string} fn @param {Array<string | number>} args @param {CallOptions & { status?: boolean }} [options] */
function run(env, fn, args, { capture = false, quiet = false, status = false, extraEnv } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(SCRIPT, [fn, ...args.map(String)], { env: extraEnv ? { ...env, ...extraEnv } : env, stdio: ["ignore", capture ? "pipe" : 2, quiet ? "ignore" : 2] });
		/** @type {Buffer[]} */
		const chunks = [];
		let bytes = 0;
		child.stdout?.on("data", (/** @type {Buffer} */ d) => {
			bytes += d.length;
			if (bytes > MAX_OUTPUT) child.kill();
			else chunks.push(d);
		});
		// A daemon the backend started (Lima's hostagent) may keep our stdout pipe open after the
		// backend exits; don't wait for it.
		child.on("exit", () => { if (child.stdout) setTimeout(() => /** @type {Readable} */ (child.stdout).destroy(), 1000).unref(); });
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (bytes > MAX_OUTPUT) return reject(new BackendError(`${fn}: backend output exceeded 16 MiB`));
			if (status) return resolve({ code: code ?? (signal ? 128 : 1), out: Buffer.concat(chunks).toString("utf8") });
			if (code !== 0) return reject(new BackendError(`${fn} failed`, { exitCode: code ?? (signal ? 128 : 1), reported: !quiet }));
			resolve(Buffer.concat(chunks).toString("utf8"));
		});
	});
}

/** The backend selected by env (BOXERY_BACKEND, or host.env). See host/backends/README.md. */
export function createBackend(env = process.env) {
	// Reuse the host launcher's selected Node even in non-interactive SSH sessions without it on PATH.
	env = { ...env, BOXERY_NODE: process.execPath };
	/** @type {string[] | undefined} */
	let functions;
	/** @param {string} fn @param {Array<string | number>} [args] @param {CallOptions} [options] */
	const call = (fn, args = [], options) => run(env, fn, args, options);
	/** @param {string} fn @param {Array<string | number>} [args] @param {CallOptions} [options] */
	const meta = (fn, args = [], options) => run(env, fn, args, { ...options, capture: true });
	return {
		call,
		/** Optional contract functions (backend_resize, backend_endpoint_problem, …) vary by backend. @param {string} fn */
		async has(fn) {
			functions ??= (await meta("__functions")).split("\n").filter(Boolean);
			return functions.includes(fn);
		},
		/** [{name, state, ssh, diskBytes, diskUsedBytes, tunnel}]: ssh is "HOST:PORT"; empty string fields
		 *  are "" and unknown sizes null (tunnel: only backends that reach VMs through one, see
		 *  backend_list). Fails if the inventory is unavailable. @param {CallOptions} [options] @returns {Promise<BackendVm[]>} */
		list: async (options) => tsv(await meta("backend_list", [], options)).map(([name, state = "", ssh = "", disk = "", used = "", tunnel = ""]) =>
			({ name, state, ssh, diskBytes: byteCount(disk), diskUsedBytes: byteCount(used), tunnel })),
		/** [{image, created, size}] @param {CallOptions} [options] @returns {Promise<BackendImage[]>} */
		images: async (options) => tsv(await meta("backend_images", [], options)).map(([image, created = "", size = ""]) => ({ image, created, size })),
		/** @param {string} image @param {CallOptions} [options] */
		imageExists: async (image, options) => (await meta("backend_images", [], options)).split("\n").some((l) => l.split("\t")[0] === image),
		/** @param {string} name */
		async exists(name) {
			try { await call("backend_exists", [name], { quiet: true }); return true; }
			catch (e) { if (e instanceof BackendError && e.exitCode === 1) return false; throw e; }
		},
		/** Whether the desktop base is built. backend_has_base exits 1 for "not built"; any other failure
		 *  means it couldn't tell (e.g. limactl isn't on PATH), and its stderr has said why. */
		async hasBase() {
			const { code } = await run(env, "backend_has_base", [], { status: true });
			if (code === 0) return true;
			if (code === 1) return false;
			throw new BackendError("backend_has_base failed", { exitCode: code, reported: true });
		},
		/** @param {string} name @param {CallOptions} [options] */
		sshEndpoint: async (name, options) => endpoint(await meta("backend_ssh_endpoint", [name], options), name),
		/** @param {string} name @param {CallOptions} [options] */
		waitEndpoint: async (name, options) => endpoint(await meta("backend_wait_endpoint", [name], options), name),
		/** Why NAME's endpoint can't be reached (optional backend_endpoint_problem; local checks only):
		 *  null when nothing is known to be wrong, else {fatal, message}. fatal: it won't recover without the fix.
		 *  Advisory: if the check itself can't run, nothing is known (the caller keeps waiting as before).
		 *  @param {string} name @returns {Promise<EndpointProblem | null>} */
		async endpointProblem(name) {
			try {
				if (!await this.has("backend_endpoint_problem")) return null;
				const { code, out } = await run(env, "backend_endpoint_problem", [name], { capture: true, quiet: true, status: true });
				return code === 0 ? null : { fatal: code === 2, message: out.trim() };
			} catch { return null; }
		},
		/** [cpus, mem MiB, disk GiB] as configured @param {string} name @param {CallOptions} [options] */
		async size(name, options) {
			const sz = (await meta("backend_size", [name], options)).trim();
			if (!/^\d+ \d+ \d+$/.test(sz)) throw new BackendError(`backend_size returned "${sz}"`);
			return sz.split(" ").map(Number);
		},
		guestProxyUpstream: async () => (await meta("guest_proxy_upstream")).trim(),
		/** image/layers as cloud-config write_files lines (the prelude's layer_files) */
		layerFiles: async () => (await meta("__layer_files")).split("\n").filter(Boolean),
	};
}
