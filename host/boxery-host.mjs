// boxery-host in Node. host/boxery-host (Bash) execs this file; the supervisor starts it as the worker.
// The host keeps its state in node:sqlite, so check for it before loading anything that needs it.
try {
	await import("node:sqlite");
} catch {
	process.stderr.write(`boxery-host: node ${process.version} lacks node:sqlite; need Node >= 22.13\n`);
	process.exit(1);
}
await import("./cli.mjs");
