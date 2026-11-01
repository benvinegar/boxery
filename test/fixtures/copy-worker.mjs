// One isolated agent process, so transfer memory measurements exclude fixture/tar processes.
import { copyTool, withHost } from "../../core/boxery-core.mjs";
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
	if (message === "inspect" && process.connected) process.send({ handles: process._getActiveHandles().map((h) => ({ type: h.constructor.name, pid: h.pid, exitCode: h.exitCode, signalCode: h.signalCode, destroyed: h.destroyed, readable: h.readable, writable: h.writable })) });
});
process.once("disconnect", () => ac.abort());
if (options.preabort) ac.abort();
let peakBuffers = process.memoryUsage().arrayBuffers;
const sample = () => { peakBuffers = Math.max(peakBuffers, process.memoryUsage().arrayBuffers); };
const timer = setInterval(sample, 5);
let result;
try {
	const value = await withHost("alpha", () => copyTool({ from, to }, { signal: ac.signal }));
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
