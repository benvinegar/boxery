// Shared grant policy and operations. Front-ends own approval; this module never prompts.
import { realpathSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { q } from "./shell.mjs";
import { currentHost, registeredHosts, deniedDirs, isWithin, REMOTE_HOME } from "./boxery-core.mjs";
export { listGrants, addGrants, revokeGrants, applyGrants, grantsChanged, storedSpecs } from "./grant-operations.mjs";
/** Agent requests have the same validation, but cannot supply commands or arbitrary HTTP grants.
 * @param {GrantRequestArgs} [a] @param {{localCwd?: string}} [opts]
 */
export function parseGrantRequest(a, opts) { return parseGrantSpec(a, opts); }
/** @import { Grant, GrantSpec, GrantRequestArgs, HostProfile } from "./boxery-core.mjs" */
const quoteWord = (/** @type {string} */ s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : q(s));
/** Is real path `p` inside `dir`? `dir` is resolved too (macOS: /var → /private/var). */
const underDir = (/** @type {string} */ p, /** @type {string} */ dir) => {
	try {
		dir = realpathSync(dir);
	} catch {
		return false; // a directory that doesn't exist holds nothing
	}
	return p === dir || p.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
};

/**
 * Validate a requested grant and resolve it to the exact spec `boxery grant` will store.
 * → {kind, spec, readonly?, var?, local?, requested?, remote?}. LOCAL paths resolve against localCwd
 * (~ = home), then to the real path, which is what gets stored: every apply re-reads the file, and a
 * symlink left in the spec could be re-pointed after the user approved it. `requested` is the path
 * the agent named, when it differs.
 * @param {GrantRequestArgs & { cmd?: string, auth?: string }} [a] @param {{ localCwd?: string, cli?: boolean }} [opts] @returns {GrantSpec}
 */
export function parseGrantSpec({ spec, readonly, cmd, auth } = {}, { localCwd, cli = false } = {}) {
	const s = typeof spec === "string" ? spec.trim() : "";
	if ((readonly || auth) && s !== "github" && !(cli && s.startsWith("http:"))) throw new Error(cli ? "--auth/--readonly only apply to http: grants or github" : "readonly applies only to the github grant");
	if (cmd && /[\t\r\n]/.test(cmd)) throw new Error("--cmd must be a single line");
	if (cmd && !cli) throw new Error("only the user can supply --cmd");
	if (cmd && s !== "github" && !s.startsWith("http:") && !s.startsWith("env:")) throw new Error("--cmd only applies to env/http/github grants");
	if (s === "ssh-agent") return { kind: "ssh-agent", spec: s };
	if (s === "github") {
		if (auth) throw new Error("the github preset sets its own --auth");
		return { kind: "github", spec: s, readonly: !!readonly, ...(cmd ? { cmd } : {}) };
	}
	if (cli && s.startsWith("http:")) {
		const host = s.slice(5);
		if (host.length > 253 || !/^(?![.-])(?!.*\.\.)(?!.*\.$)[a-z0-9.-]+\.[a-z]{2,}$/.test(host) || host.endsWith("-")) throw new Error(`invalid host '${host}' (a DNS name; no scheme, port, path or IP)`);
		const a = auth ?? "bearer";
		if (!/^(bearer|basic:[A-Za-z0-9._@+-]+|header:[A-Za-z0-9-]+)$/.test(a) || /^header:(host|content-length|connection|transfer-encoding|te|upgrade|proxy-connection|keep-alive|trailer)$/i.test(a)) throw new Error(`invalid --auth '${a}'`);
		if (!cmd) throw new Error(`${s} needs --cmd CMD`);
		return { kind: "http", spec: s, host, cmd, auth: a, readonly: !!readonly };
	}
	const llm = /^llm:(chatgpt|openai|anthropic|ollama)$/.exec(s);
	if (llm) return { kind: "llm", spec: s, provider: llm[1] };
	if (s.startsWith("llm:")) throw new Error(`unknown LLM provider "${s.slice(4)}" (llm:chatgpt, llm:openai, llm:anthropic or llm:ollama)`);
	const env = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(s);
	// boxery's own settings, some of them its credentials (BOXERY_MCP_TOKEN drives every VM over HTTP MCP).
	if (env?.[1].startsWith("BOXERY_")) throw new Error(`$${env[1]} is boxery's own setting and can't be requested: BOXERY_* variables configure boxery, and some are its credentials`);
	if (env) return { kind: "env", spec: s, var: env[1], ...(cmd ? { cmd } : {}) };
	if (s.startsWith("http:")) throw new Error(`${s} needs a command, run on the user's machine, that prints the secret; only the user can add it (boxery grant VM ${s} --cmd '…'). For GitHub, request the github grant.`);
	if (!s.startsWith("file:")) throw new Error(`unknown grant "${s}" (llm:PROVIDER, ssh-agent, env:VAR, file:LOCAL[=REMOTE] or github)`);
	const rest = s.slice(5);
	const eq = rest.indexOf("=");
	const loc = eq < 0 ? rest : rest.slice(0, eq);
	if (!loc) throw new Error("usage: file:LOCAL[=REMOTE]");
	const local = path.resolve(localCwd ?? process.cwd(), loc.replace(/^~(?=\/|$)/, homedir()));
	let real, st;
	try {
		real = realpathSync(local);
		st = statSync(real);
	} catch {
		throw new Error(`no such local file: ${local}`);
	}
	if (!st.isFile()) throw new Error(`not a regular file: ${local}`);
	if (st.size > 1024 * 1024) throw new Error(`file grants are limited to 1 MiB: ${local}`);
	// Keys, boxery's own credentials (VM ssh keys, proxy tokens) and agent logins are never requestable.
	const shown = real === local ? local : `${local} (→ ${real})`;
	// Listed here too because registeredHosts() throws on a broken registry: refuse rather than miss a profile.
	const hit = deniedDirs([...registeredHosts().map((h) => h.dir), currentHost().dir]).find((d) => isWithin(real, d.dir));
	if (hit?.keys) throw new Error(`${shown} holds keys; request ssh-agent instead (the keys stay on the user's machine)`);
	if (hit) throw new Error(`${shown} is inside ${hit.dir} (boxery's own configuration or the user's credentials) and can't be granted`);
	// REMOTE is relative to REMOTE_HOME; accept ~/… and REMOTE_HOME/… spellings too.
	let remote = eq < 0 ? `project/${path.basename(local)}` : rest.slice(eq + 1).replace(/^~\//, "");
	if (remote.startsWith(`${REMOTE_HOME}/`)) remote = remote.slice(REMOTE_HOME.length + 1);
	if (!remote || remote.startsWith("/") || `/${remote}/`.includes("/../") || /[\t\n\r]/.test(remote + real)) throw new Error(`invalid remote path: ${remote || "(empty)"} (relative to ${REMOTE_HOME})`);
	return { kind: "file", spec: `file:${real}=${remote}`, local: real, ...(real === local ? {} : { requested: local }), remote };
}

/** ~/… for paths in the user's home: clients truncate long prompt lines. */
const tildePath = (/** @type {string | undefined} */ p) => (p && underDir(p, homedir()) ? `~${p.slice(realpathSync(homedir()).length)}` : p);

/** What the user is agreeing to, in their terms. The agent's reason comes last and is labelled as such. */
/** @param {string} vm @param {string} host @param {GrantSpec} g @param {unknown} reason */
export function grantPrompt(vm, host, g, reason = undefined) {
	const where = `VM "${vm}" on host "${host}"`;
	const what = {
		llm: [`llm:${g.provider}: the VM host's ${g.provider} credential, through its proxy.`, "The VM never holds the key, but its agents can spend on it (inference only) until you revoke it."],
		"ssh-agent": ["ssh-agent: your ssh agent is forwarded while you're connected.", "Processes in the VM can ask it to sign (git over ssh, ssh to other machines). Your keys stay on this machine."],
		env: [`env:${g.var}: ${g.cmd ? `the output of \`${g.cmd}\` on this machine` : `the value of $${g.var} on this machine (${hostname()})`}.`, "It is set in the VM's login shells, from memory (tmpfs). Anything running in the VM can read it."],
		file: [`file: ${tildePath(g.local)}`, ...(g.requested ? [`  (the agent asked for ${tildePath(g.requested)}, which leads here through a symlink)`] : []), `  → in the VM: ~/${g.remote}`, "Its contents are copied into the VM's memory (tmpfs, never its disk or snapshots). Anything running in the VM can read it."],
		http: [`http:${g.host}${g.readonly ? " (read-only)" : ""}: HTTPS access using ${g.auth}.`, `The secret comes from \`${g.cmd}\` on this machine. It stays on the VM host's proxy; the VM never holds it.`],
		github: [
			`github${g.readonly ? " (read-only)" : ""}: git over https and the GitHub API, as this machine's \`${g.cmd ?? "gh auth token"}\`.`,
			`The token stays on the VM host's proxy; the VM never holds it.${g.readonly ? " Only clone/fetch and GET requests are allowed." : " That includes git push and API writes."}`,
		],
	}[g.kind];
	const why = String(reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
	return [`Give ${where} access to:`, "", ...what, "", `Revoke any time: ${grantCommand("revoke", vm, host, g)}`, ...(why ? ["", `The agent's reason: "${why}"`] : [])].join("\n");
}

/** @param {"grant" | "revoke"} verb @param {string} vm @param {string} host @param {GrantSpec} g */
export function grantCommand(verb, vm, host, g) {
	const spec = verb === "revoke" && g.kind === "file" ? `file:${g.local}` : g.spec;
	return ["boxery", "--host", host, verb, vm, spec, ...(verb === "grant" ? [...(g.readonly ? ["--readonly"] : []), ...(g.cmd ? ["--cmd", g.cmd] : []), ...(g.auth ? ["--auth", g.auth] : [])] : [])].map(quoteWord).join(" ");
}

