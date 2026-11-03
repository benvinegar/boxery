// Thin CLI adapter. Approval is owned by controller/boxery, not this module.
import { readFileSync } from "node:fs";
import * as core from "../core/boxery-core.mjs";
import { grantPrompt, grantCommand, listGrants, addGrants, revokeGrants, applyGrants, grantsChanged, storedSpecs } from "../core/grants.mjs";
import { parseGrantArgs as parse } from "../core/grant-approval.mjs";
const [host, dir, action, vm, ...args] = process.argv.slice(2);
try {
	// Bash already selected and validated this directory (including pinned --profile-dir calls).
	const resolved = core.profileFromDirectory(host, dir);
	await core.withHost(resolved, async () => {
		let result;
		/** @returns {import('../core/boxery-core.mjs').GrantSpec[]} */
		const prepared = () => JSON.parse(readFileSync(0, "utf8"));
		switch (action) {
			case "unattended": {
				// Deliberately file-only and literal: no process.env fallback or shell evaluation.
				const lines = readFileSync(`${dir}/config`, "utf8").split("\n").filter((l) => /^\s*GRANT_CONFIRM=/.test(l));
				const last = lines.at(-1) ?? "";
				process.exitCode = /^\s*GRANT_CONFIRM=(?:off|'off'|"off")\s*(?:#.*)?$/.test(last) ? 0 : 1;
				return;
			}
			case "prepare": result = JSON.stringify(args[0] === "--copy-from" ? storedSpecs(args[1]) : parse(args)); break;
			case "prompt": result = prepared().map((g) => grantPrompt(vm, host, g, undefined)).join("\n\n"); break;
			case "command": result = prepared().map((g) => grantCommand("grant", vm, host, g)).join("\n"); break;
			case "grant": result = await addGrants(vm, prepared(), { interactiveCommands: true, commandStdin: 9 }); break;
			case "revoke": result = await revokeGrants(vm, args, { interactiveCommands: true }); break;
			case "list": result = JSON.stringify(listGrants(vm)); break;
			case "show": result = core.formatGrants(vm, listGrants(vm)); break;
			case "summary": result = listGrants(vm).map((g) => g.kind === "env" ? `env:${g.var}` : g.kind === "file" ? `file:${g.remote?.replace(/^\/home\/agent\//, "")}` : g.kind === "http" ? `http:${g.host}` : g.kind === "llm" ? `llm:${g.provider}` : g.kind).join(",") || "-"; break;
			case "apply": result = await applyGrants(vm, { interactiveCommands: true }); break;
			case "changed": result = await grantsChanged(vm, { interactiveCommands: true }); break;
			default: throw new Error(`unknown grant operation: ${action}`);
		}
		if (action === "apply" && args.includes("--quiet")) {
			for (const line of result.split("\n")) if (line.startsWith("boxery:")) console.error(line);
		} else console.log(result);
	});
} catch (e) {
	console.error(`boxery: ${/** @type {Error} */ (e).message}`);
	process.exitCode = 1;
}
