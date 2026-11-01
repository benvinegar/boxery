// host/seed.mjs: the cloud-config every new VM boots with (keys, proxy token, agent configs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudConfig, fakeJwt, opencodeConfig, piModels } from "../host/seed.mjs";

const cred = "v1:0123456789abcdef";
const payload = (text, file) => {
	const lines = text.split("\n");
	const i = lines.indexOf(`  - path: /home/agent/${file}`);
	assert.ok(i > 0, `${file} written`);
	return Buffer.from(lines[i + 5].replace("    content: ", ""), "base64").toString();
};

test("identity, keys and the backend's proxy upstream", () => {
	const text = cloudConfig({ name: "v1", keys: ["ssh-ed25519 AAAA host", 'ssh-ed25519 BBBB "quoted"'], upstream: "VSOCK-CONNECT:2:8088", cred });
	assert.ok(text.startsWith("#cloud-config\nhostname: v1\nfqdn: v1.boxery\nssh_pwauth: false\nssh_authorized_keys:\n"));
	assert.ok(text.includes('  - "ssh-ed25519 AAAA host"\n  - "ssh-ed25519 BBBB \\"quoted\\""\n'), "keys are JSON (valid YAML) strings");
	assert.ok(text.includes("  - path: /etc/boxery/proxy-upstream\n    content: VSOCK-CONNECT:2:8088\n"));
	assert.ok(text.includes("boxery-keys, sh, -c, 'rm -f /home/agent/.ssh/authorized_keys'"), "a fork starts without its source's keys");
	assert.equal(payload(text, ".boxery/token"), cred);
	assert.match(text, /\n    encoding: b64\n/);
	assert.ok(text.endsWith("git init -q'\"]\n"));
});

test("agent configs point at the guest-side proxy; Ollama only when it has tool models", () => {
	const plain = cloudConfig({ name: "v1", keys: [], upstream: "x", cred });
	const models = JSON.parse(payload(plain, ".pi/agent/models.json"));
	assert.deepEqual(Object.keys(models.providers), ["openai-codex"]);
	assert.equal(models.providers["openai-codex"].baseUrl, "http://127.0.0.1:8088/chatgpt/backend-api");
	assert.equal(JSON.parse(payload(plain, ".pi/agent/settings.json")).transport, "sse");
	assert.equal(JSON.parse(payload(plain, ".config/opencode/opencode.json")).model, undefined);
	const ollama = [{ id: "llama3:8b" }, { id: "qwen3-coder:latest" }];
	assert.equal(piModels(cred, ollama).providers.ollama.apiKey, cred);
	const oc = opencodeConfig(cred, ollama);
	assert.equal(oc.model, "boxery/qwen3-coder:latest");
	assert.deepEqual(oc.provider.boxery.models, { "llama3:8b": { name: "llama3:8b" }, "qwen3-coder:latest": { name: "qwen3-coder:latest" } });
	assert.equal(opencodeConfig(cred, [{ id: "a" }]).model, "boxery/a");
});

test("the Codex client gets an unsigned JWT that carries the VM's credential", () => {
	const [h, p, sig] = fakeJwt(cred).split(".");
	assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "none", typ: "JWT" });
	assert.equal(JSON.parse(Buffer.from(p, "base64url")).boxery, cred);
	assert.equal(sig, "boxery");
});
