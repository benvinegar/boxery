// Policy tests need no SQLite, shell, or VM. Effects are injected and their order is asserted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LeaseWorkflows } from "../host/lease-workflows.mjs";

function fixture() {
	const events = [], logs = [];
	let clock = 100;
	const state = { row: { name: "p1", gen: 2, epoch: "epoch", state: "RESETTING", lease_id: "l-one" } };
	const note = (kind, ...args) => events.push([kind, ...args]);
	const store = {
		get: (name) => { note("get", name); return state.row; },
		claim: (...args) => { note("claim", ...args); return { name: "p1", gen: 1, epoch: "epoch", lease_id: "l-one", expires_at: 600 }; },
		commit: (...args) => { note("commit", ...args); return true; },
		find: (id) => { note("find", id); return state.row; },
		beginReset: (id) => { note("begin-reset", id); return { name: "p1", gen: 2, epoch: "epoch" }; },
		finish: (...args) => { note("finish", ...args); return true; },
		candidates: () => { note("candidates"); return [{ name: "p1", gen: 1, epoch: "epoch" }]; },
		due: (...args) => { note("due", ...args); return [{ name: "p1", gen: 2, epoch: "epoch", reason: "expired" }]; },
	};
	const backend = Object.fromEntries(["revokeToken", "issueToken", "clearEdge", "restore", "waitReady", "stepClock", "setKeys"].map((kind) => [kind, async (...args) => note(kind, ...args)]));
	const journal = {
		intent: async (...args) => { note("intent", ...args); return "intent-id"; },
		done: async (id) => note("done", id),
	};
	const flows = new LeaseWorkflows({
		store, backend, journal,
		lock: async (...args) => note("lock", ...args),
		reclaim: async () => note("reclaim"), now: () => clock,
		sleep: async (ms) => { note("sleep", ms); clock += ms / 1000; },
		log: (message) => logs.push(message),
	});
	return { flows, state, events, logs, store, backend, journal, kinds: () => events.map((e) => e[0]) };
}

test("reset journals, revokes the lease's token and grants first, and commits only after readiness and management keys", async () => {
	const f = fixture();
	await f.flows.reset("p1", "2", "epoch");
	assert.deepEqual(f.events, [
		["get", "p1"], ["intent", "reset", ["p1", "2", "epoch"]], ["revokeToken", "p1"], ["clearEdge", "p1"],
		["restore", "p1", "boxery-clean"], ["waitReady", "p1"], ["stepClock", "p1"], ["setKeys", "p1"],
		["finish", "p1", "2", "FREE"], ["done", "intent-id"],
	]);
	assert.match(f.logs[0], /reset → FREE/);
});

for (const kind of ["restore", "waitReady", "stepClock", "setKeys"]) {
	test(`${kind} failure quarantines the VM instead of publishing FREE`, async () => {
		const f = fixture();
		f.backend[kind] = async () => { f.events.push([kind]); throw new Error("guest failure"); };
		await f.flows.reset("p1", 2, "epoch");
		assert.deepEqual(f.events.at(-2), ["finish", "p1", 2, "BROKEN"]);
		assert.deepEqual(f.events.at(-1), ["done", "intent-id"]);
		assert.match(f.logs[0], /BROKEN/);
		if (kind === "restore") assert.ok(!f.kinds().includes("waitReady"));
	});
}

test("stale generation, state or incarnation has no journal or guest effects", async () => {
	for (const change of [{ gen: 3 }, { epoch: "replacement" }, { state: "LEASED" }]) {
		const f = fixture(); Object.assign(f.state.row, change);
		await f.flows.reset("p1", 2, "epoch");
		assert.deepEqual(f.kinds(), ["get"]);
		assert.match(f.logs[0], /stale reset skipped/);
	}
});

test("store failures are not mistaken for stale observations", async () => {
	const f = fixture();
	f.store.get = () => { throw new Error("database unavailable"); };
	await assert.rejects(f.flows.reset("p1", 2, "epoch"), /database unavailable/);
	assert.deepEqual(f.events, []);
});

test("a failed state commit leaves the recovery intent intact", async () => {
	const f = fixture(); f.store.finish = () => false;
	await assert.rejects(f.flows.reset("p1", 2, "epoch"), /reset commit failed/);
	assert.ok(f.kinds().includes("intent"));
	assert.ok(!f.kinds().includes("done"));
});

test("an edge cleanup failure leaves the intent and never begins restore", async () => {
	const f = fixture(); f.backend.clearEdge = async () => { throw new Error("permission denied"); };
	await assert.rejects(f.flows.reset("p1", 2, "epoch"), /permission denied/);
	assert.deepEqual(f.kinds(), ["get", "intent", "revokeToken"]);
});

test("a token revocation failure leaves the intent and touches neither grants nor the guest", async () => {
	const f = fixture(); f.backend.revokeToken = async () => { throw new Error("tokens.json unwritable"); };
	await assert.rejects(f.flows.reset("p1", 2, "epoch"), /unwritable/);
	assert.deepEqual(f.kinds(), ["get", "intent"]);
});

test("install validates ownership, journals, issues the lease's token, installs the key, then commits", async () => {
	const f = fixture(); f.state.row.state = "ACQUIRING";
	await f.flows.install("p1", 2, "epoch", "public key");
	assert.deepEqual(f.events, [
		["get", "p1"], ["intent", "acquire", ["p1", "2", "epoch"]], ["issueToken", "p1", "l-one"],
		["setKeys", "p1", "public key"], ["commit", "p1", 2], ["done", "intent-id"],
	]);
});

test("failed/fenced installation retains its intent for reset", async () => {
	for (const failure of ["token", "keys", "commit"]) {
		const f = fixture(); f.state.row.state = "ACQUIRING";
		if (failure === "token") f.backend.issueToken = async () => { throw new Error("guest unreachable"); };
		else if (failure === "keys") f.backend.setKeys = async () => { throw new Error("keys failed"); };
		else f.store.commit = () => false;
		await assert.rejects(f.flows.install("p1", 2, "epoch", "public key"));
		assert.ok(!f.kinds().includes("done"));
		if (failure === "token") assert.ok(!f.kinds().includes("setKeys"), "the holder's key waits for the token");
	}
});

test("acquire claims before locking and returns its original structured result", async () => {
	const f = fixture();
	const result = await f.flows.acquire({ holder: "alice", pubkey: "public key" });
	assert.deepEqual(f.events, [
		["claim", "alice", 1800, "public key"],
		["lock", "p1", "_lease_acquire", ["p1", 1, "epoch", "public key"]],
	]);
	assert.equal(result.lease_id, "l-one");
});

test("pool exhaustion reclaims once, tolerates reclaim failure, and retains exit code 4", async () => {
	const f = fixture(); f.store.claim = () => null;
	f.flows.reclaim = async () => { f.events.push(["reclaim"]); throw new Error("reaper unavailable"); };
	await assert.rejects(f.flows.acquire({ holder: "alice", pubkey: "key" }), (e) => e.exitCode === 4 && /pool exhausted/.test(e.message));
	assert.deepEqual(f.kinds(), ["reclaim"]);
});

test("wait retries use the injected clock and sleep without holding a VM lock", async () => {
	const f = fixture(); let attempts = 0;
	f.store.claim = () => ++attempts < 3 ? null : { name: "p1", gen: 1, epoch: "epoch", expires_at: 600 };
	await f.flows.acquire({ holder: "alice", pubkey: "key", wait: 4 });
	assert.deepEqual(f.kinds(), ["reclaim", "sleep", "lock"]);
});

test("release observes a name only for routing; its held-lock entry revalidates the lease", async () => {
	const f = fixture();
	await f.flows.release("l-one");
	assert.deepEqual(f.events, [["find", "l-one"], ["lock", "p1", "_lease_release", ["l-one"]]]);
	f.events.length = 0;
	f.store.beginReset = () => { throw new Error("lease was already released"); };
	await assert.rejects(f.flows.releaseHeld("l-one"), /already released/);
	assert.deepEqual(f.events, []);
});

test("reaper snapshots candidates, locks per VM, and rechecks before effects", async () => {
	const f = fixture();
	await f.flows.reapCandidates();
	assert.deepEqual(f.events, [["candidates"], ["lock", "p1", "_reap_candidate", ["p1", 1, "epoch"]]]);
	f.events.length = 0; f.store.due = (...args) => { f.events.push(["due", ...args]); return []; };
	await f.flows.reapHeld("p1", 1, "epoch");
	assert.deepEqual(f.events, [["due", "p1", 1, "epoch"]]);
});
