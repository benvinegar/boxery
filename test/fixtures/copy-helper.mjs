// Fault-only helpers. Some deliberately escape a transport group or close all its descriptors.
import { appendFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
const [mode, script = ""] = process.argv.slice(2);
const pgid = Number(spawnSync("ps", ["-p", String(process.pid), "-o", "pgid="], { encoding: "utf8" }).stdout.trim());
const note = (kind) => appendFileSync(/** @type {string} */ (process.env.COPY_LOG), JSON.stringify({ kind, pid: process.pid, pgid, endpoint: process.env.COPY_ENDPOINT ?? "local" }) + "\n");
if (mode === "orphan") {
	process.on("SIGTERM", () => note("orphan-term"));
	setInterval(() => {}, 1000);
	note("orphan");
	/** @type {NonNullable<typeof process.send>} */ (process.send)("ready"); process.disconnect();
} else if (mode === "late-prepare") {
	note("late-prepare");
	await new Promise((resolve) => setTimeout(resolve, 1500));
	const child = spawn("bash", ["-c", script], { stdio: "ignore" });
	child.on("close", (code) => { note("late-prepare-finished"); process.exitCode = code ?? 1; });
} else {
	note("metadata-holder");
	setInterval(() => {}, 1000);
}
