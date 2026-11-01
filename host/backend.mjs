// Hypervisor backends from Node. Every call runs `host/backend.sh FUNCTION ARG…` as its own process:
// argv only, never a shell string. It is never detached, so it stays in the caller's process group and
// the supervisor's crash fencing covers it (docs/lifecycle.md). The backend's diagnostics go to stderr.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./backend.sh", import.meta.url));
const MAX_OUTPUT = 16 * 1024 * 1024;

export class BackendError extends Error {
	constructor(message, { exitCode = 1, reported = false } = {}) {
		super(message);
		Object.assign(this, { exitCode, reported });
	}
}

const tsv = (text) => text.split("\n").filter((l) => l.length > 0).map((l) => l.split("\t"));
const endpoint = (text) => {
	const ep = text.trim();
	const host = ep.slice(0, ep.lastIndexOf(" ")), port = ep.slice(ep.indexOf(" ") + 1);
	if (!host || !port) throw new BackendError(`backend returned no ssh endpoint ("${ep}")`);
	return { host, port };
};

// capture: collect stdout (metadata) and return it; otherwise the backend's stdout goes to our stderr,
// so it can never corrupt this command's own output. quiet: discard the backend's stderr too.
// extraEnv: variables for this call only (e.g. BASE_USERDATA for backend_build_base).
function run(env, fn, args, { capture = false, quiet = false, extraEnv } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(SCRIPT, [fn, ...args.map(String)], { env: extraEnv ? { ...env, ...extraEnv } : env, stdio: ["ignore", capture ? "pipe" : 2, quiet ? "ignore" : 2] });
		const chunks = [];
		let bytes = 0;
		child.stdout?.on("data", (d) => {
			bytes += d.length;
			if (bytes > MAX_OUTPUT) child.kill();
			else chunks.push(d);
		});
		// A daemon the backend started (Lima's hostagent) may keep our stdout pipe open after the
		// backend exits; don't wait for it.
		child.on("exit", () => { if (child.stdout) setTimeout(() => child.stdout.destroy(), 1000).unref(); });
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (bytes > MAX_OUTPUT) return reject(new BackendError(`${fn}: backend output exceeded 16 MiB`));
			if (code !== 0) return reject(new BackendError(`${fn} failed`, { exitCode: code ?? (signal ? 128 : 1), reported: !quiet }));
			resolve(Buffer.concat(chunks).toString("utf8"));
		});
	});
}

/** The backend selected by env (BOXERY_BACKEND, or host.env). See host/backends/README.md. */
export function createBackend(env = process.env) {
	let functions;
	const call = (fn, args = [], options) => run(env, fn, args, options);
	const meta = (fn, args = [], options) => run(env, fn, args, { ...options, capture: true });
	return {
		call,
		/** Optional contract functions (backend_resize, backend_legacy_*, …) vary by backend. */
		async has(fn) {
			functions ??= (await meta("__functions")).split("\n").filter(Boolean);
			return functions.includes(fn);
		},
		/** [{name, state, addr, disk}]; empty fields are "". Fails if the inventory is unavailable. */
		list: async (options) => tsv(await meta("backend_list", [], options)).map(([name, state = "", addr = "", disk = ""]) => ({ name, state, addr, disk })),
		/** [{image, created, size}] */
		images: async (options) => tsv(await meta("backend_images", [], options)).map(([image, created = "", size = ""]) => ({ image, created, size })),
		imageExists: async (image, options) => (await meta("backend_images", [], options)).split("\n").some((l) => l.split("\t")[0] === image),
		async exists(name) {
			try { await call("backend_exists", [name], { quiet: true }); return true; }
			catch (e) { if (e instanceof BackendError) return false; throw e; }
		},
		async hasBase() {
			try { await call("backend_has_base", [], { quiet: true }); return true; }
			catch (e) { if (e instanceof BackendError) return false; throw e; }
		},
		sshEndpoint: async (name, options) => endpoint(await meta("backend_ssh_endpoint", [name], options)),
		waitEndpoint: async (name, options) => endpoint(await meta("backend_wait_endpoint", [name], options)),
		/** [cpus, mem MiB, disk GiB] as configured */
		async size(name, options) {
			const sz = (await meta("backend_size", [name], options)).trim();
			if (!/^\d+ \d+ \d+$/.test(sz)) throw new BackendError(`backend_size returned "${sz}"`);
			return sz.split(" ").map(Number);
		},
		legacySnaps: async (name, options) => (await meta("backend_legacy_snaps", [name], options)).split("\n").filter(Boolean),
		guestProxyUpstream: async () => (await meta("guest_proxy_upstream")).trim(),
		/** image/layers as cloud-config write_files lines (the prelude's layer_files) */
		layerFiles: async () => (await meta("__layer_files")).split("\n").filter(Boolean),
	};
}
