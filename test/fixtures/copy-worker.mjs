// One isolated agent process, so transfer memory measurements exclude fixture/tar processes.
import { copyTool, currentHost, parseLoc, withHost } from "../../core/boxery-core.mjs";
import { streamCopy } from "../../core/copy-stream.mjs";
import path from "node:path";
const [from, to, settings = "{}"] = process.argv.slice(2);
const options = JSON.parse(settings);
if (options.groupEperm) {
	const kill = process.kill.bind(process);
	process.kill = (pid, signal) => {
		if (pid < 0) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
		return kill(pid, signal);
	};
}
const ac = new AbortController();
process.on("message", (message) => {
	if (message === "abort") ac.abort();
	if (message === "inspect" && process.connected) /** @type {NonNullable<typeof process.send>} */ (process.send)({ handles: /** @type {any} */ (process)._getActiveHandles().map((h) => ({ type: h.constructor.name, pid: h.pid, exitCode: h.exitCode, signalCode: h.signalCode, destroyed: h.destroyed, readable: h.readable, writable: h.writable })) });
});
process.once("disconnect", () => ac.abort());
if (options.preabort) ac.abort();
let peakBuffers = process.memoryUsage().arrayBuffers;
const sample = () => { peakBuffers = Math.max(peakBuffers, process.memoryUsage().arrayBuffers); };
const timer = setInterval(sample, 5);
/** @type {any} */
let result;
try {
	const value = await withHost("alpha", () => {
		if (options.metadataTimeoutMs == null) return copyTool({ from, to }, { signal: ac.signal });
		// Exercise the identical transport with short injected deadlines, not 30-second sleeps.
		const endpoint = (spec) => {
			const loc = parseLoc(spec), host = loc.host ?? currentHost();
			return loc.vm ? { path: loc.path, vm: loc.vm, sshConf: host.sshConf, label: `${host.name}/${loc.vm}` }
				: { path: path.resolve(loc.path), label: "local" };
		};
		return streamCopy(endpoint(from), endpoint(to), { signal: ac.signal, metadataTimeoutMs: options.metadataTimeoutMs, cleanupTimeoutMs: options.cleanupTimeoutMs ?? 2000 }).then((bytes) => ({ bytes }));
	});
	result = { ok: true, ...value };
} catch (e) {
	result = { ok: false, error: e.message, name: e.name };
} finally {
	sample(); clearInterval(timer);
	result.peakBuffers = peakBuffers;
	result.maxRssKiB = process.resourceUsage().maxRSS;
	process.stdout.write(`${JSON.stringify(result)}\n`);
	if (process.connected) process.disconnect();
}
