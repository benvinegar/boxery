// One isolated agent process, so transfer memory measurements exclude fixture/tar processes.
import { copyTool, withHost } from "../../core/boxery-core.mjs";
const [from, to, settings = "{}"] = process.argv.slice(2);
const options = JSON.parse(settings);
const ac = new AbortController();
process.on("message", (message) => { if (message === "abort") ac.abort(); });
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
