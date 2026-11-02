// Print a root shell script that writes a cloud-config's write_files (path/owner/permissions/encoding/
// content). For backends that can't hand the guest a cloud-init seed (Lima, exe.dev) and replay ours
// over ssh instead. A minimal reader for the cloud-configs boxery generates, not a YAML parser.
// Usage: node cloudconfig-sh.mjs USER-DATA > files.sh
import fs from "node:fs";

const yaml = fs.readFileSync(process.argv[2], "utf8");
/** @typedef {{ path: string, content: string, encoding?: string, permissions?: string, owner?: string, [key: string]: string | undefined }} WriteFile */
/** @type {WriteFile[]} */
const files = []; let cur = /** @type {WriteFile | null} */ (null), inContent = false, indent = 0;
let section = "";
for (const line of yaml.split("\n")) {
	if (/^[a-z_]+:/.test(line)) { section = line.split(":")[0]; if (cur) { files.push(cur); cur = null; } inContent = false; continue; }
	if (section !== "write_files") continue;
	const m = line.match(/^  - path: (.*)$/);
	if (m) { if (cur) files.push(cur); cur = { path: m[1].trim(), content: "" }; inContent = false; continue; }
	if (!cur) continue;
	if (inContent) {
		if (line.trim() === "") { cur.content += "\n"; continue; }
		const ind = /** @type {RegExpMatchArray} */ (line.match(/^ */))[0].length;
		if (ind >= indent) { cur.content += line.slice(indent) + "\n"; continue; }
		inContent = false;
	}
	const kv = line.match(/^    ([a-z]+): ?(.*)$/);
	if (kv) {
		if (kv[1] === "content" && kv[2].trim() === "|") { inContent = true; indent = 6; continue; }
		cur[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1");
	}
}
if (cur) files.push(cur);
let sh = "set -e\n";
for (const f of files) {
	const data = f.encoding === "b64" ? f.content.trim() : Buffer.from(f.content).toString("base64");
	sh += `mkdir -p "$(dirname ${JSON.stringify(f.path)})"; echo ${data.replace(/\s/g, "")} | base64 -d > ${JSON.stringify(f.path)}\n`;
	if (f.permissions) sh += `chmod ${f.permissions} ${JSON.stringify(f.path)}\n`;
	if (f.owner) sh += `chown ${f.owner} ${JSON.stringify(f.path)} 2>/dev/null || true\n`;
}
process.stdout.write(sh);
