// edge-set payload parsing (host/pool.mjs): HTTP routes plus the VM's LLM grants.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEdge } from "../host/pool.mjs";

const route = { headers: { Authorization: "Bearer x" }, readonly: false };

test("wrapped form: hosts + llm (sorted, deduplicated)", () => {
	assert.deepEqual(parseEdge({ hosts: { "api.example.com": route }, llm: ["ollama", "chatgpt", "ollama"] }), { hosts: { "api.example.com": route }, llm: ["chatgpt", "ollama"] });
	assert.deepEqual(parseEdge({ llm: ["anthropic"] }), { hosts: {}, llm: ["anthropic"] });
	assert.deepEqual(parseEdge({ hosts: {} }), { hosts: {}, llm: [] });
});

test("bare host map (older controllers) grants no LLM access", () => {
	assert.deepEqual(parseEdge({ "api.example.com": route }), { hosts: { "api.example.com": route }, llm: [] });
	assert.deepEqual(parseEdge({}), { hosts: {}, llm: [] });
});

test("rejects unknown providers and malformed lists", () => {
	for (const bad of [
		{ llm: ["gemini"] },
		{ llm: "chatgpt" },
		{ llm: [1] },
		{ llm: ["chatgpt "] },
		{ hosts: { "1.2.3.4": route }, llm: [] },
		{ hosts: [], llm: [] },
		null,
		[],
		"x",
	]) assert.equal(parseEdge(bad), null, JSON.stringify(bad));
});
