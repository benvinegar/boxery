// core/leases.mjs against a stub host: local records and keys, and the failure paths around them.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { registerHost } from "./fixtures/register-host.mjs";
import { LEASE_ID, hostTransport, hostCalls } from "./fixtures/host-transport.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "boxery-cleases-"));
const home = path.join(dir, "home");
registerHost(home);
hostTransport(dir, [home]);
mkdirSync(path.join(dir, "bin"));
writeFileSync(path.join(dir, "bin/ssh"), "#!/bin/sh\nexit 0\n");
chmodSync(path.join(dir, "bin/ssh"), 0o755);
process.env.PATH = `${path.join(dir, "bin")}:${process.env.PATH}`;
process.env.BOXERY_HOME = home;
const leases = await import("../core/leases.mjs");
const profile = await import("../core/profile.mjs");
const leasesDir = path.join(home, "leases");
const statMode = (/** @type {string} */ f) => statSync(f).mode & 0o777;
const readdirNames = (/** @type {string} */ d) => (existsSync(d) ? readdirSync(d) : []);
const calls = () => hostCalls(dir).map((l) => l.slice(l.indexOf(": ") + 2));

beforeEach(() => {
	rmSync(leasesDir, { recursive: true, force: true });
	rmSync(path.join(dir, "host.calls"), { force: true });
	chmodSync(home, 0o755);
});

test("acquire keeps a 0600 record, the key and an ssh_config entry; release removes them", async () => {
	const r = await leases.acquireLease({ ttl: 600, holder: "me@test" });
	assert.deepEqual([r.name, r.id, r.ttl, r.holder], ["pool-1", LEASE_ID, 600, "me@test"]);
	assert.equal(readFileSync(path.join(home, "ssh_config"), "utf8").match(/^Host pool-1\.boxery\n {2}IdentityFile "(.*)"$/m)?.[1], path.join(leasesDir, `${LEASE_ID}.key`));
	const record = path.join(leasesDir, `${LEASE_ID}.lease`);
	assert.equal(readFileSync(record, "utf8"), `name=pool-1\nid=${LEASE_ID}\nexpires=${r.expires}\nttl=600\nholder=me@test\n`);
	assert.equal(statMode(record), 0o600);
	assert.equal(statMode(leasesDir), 0o700);
	assert.deepEqual(leases.leaseRows(r.expires - 10), [{ name: "pool-1", lease_id: LEASE_ID, expires_at: r.expires, expires_in: 10, ttl: 600, holder: "me@test" }]);
	assert.equal(leases.findLease("pool-1")?.id, LEASE_ID);
	await leases.releaseLease("pool-1");
	assert.deepEqual(readdirNames(leasesDir), []);
	assert.doesNotMatch(readFileSync(path.join(home, "ssh_config"), "utf8"), /pool-1\.boxery/);
	assert.equal(calls().at(-1), `release ${LEASE_ID}`);
});

test("a lease the host granted but this machine can't record is released, not stranded", { skip: process.getuid?.() === 0 && "root ignores the read-only directory" }, async () => {
	mkdirSync(leasesDir, { mode: 0o700 });
	// ssh_config can't be replaced: the setup after the host's acquire fails.
	chmodSync(home, 0o555);
	try {
		await assert.rejects(leases.acquireLease({ ttl: 600 }), /leased pool-1 but could not set it up on this machine .*released it again/s);
	} finally { chmodSync(home, 0o755); }
	assert.deepEqual(calls().map((c) => c.split(" ")[0]), ["acquire", "release"]);
	assert.equal(calls()[1], `release ${LEASE_ID}`);
	assert.deepEqual(readdirNames(leasesDir), [], "no record, key or half-made key left");
});

test("a renew answered after a release doesn't bring the record back", async () => {
	await leases.acquireLease({ ttl: 600 });
	// The host answers renew only after a release (another process) has removed the record.
	const hostbin = path.join(dir, "grant-host"), orig = readFileSync(hostbin, "utf8");
	writeFileSync(hostbin, orig.replace("renew*) ", `renew*) rm -f ${JSON.stringify(path.join(leasesDir, `${LEASE_ID}.lease`))}; `));
	try {
		await assert.rejects(leases.renewLease("pool-1", 900), /was released meanwhile/);
	} finally { writeFileSync(hostbin, orig); }
	assert.ok(!existsSync(path.join(leasesDir, `${LEASE_ID}.lease`)));
});

test("renew: unknown lease and bad ttl are local errors; a host failure is marked fromHost", async () => {
	await assert.rejects(leases.renewLease("nope"), /no local lease for 'nope'/);
	await leases.acquireLease({ ttl: 600 });
	await assert.rejects(leases.renewLease("pool-1", "9x"), /--ttl must be a number/);
	writeFileSync(path.join(dir, "renew-fails"), "");
	try {
		await assert.rejects(leases.renewLease("pool-1"), (e) => /** @type {any} */ (e).fromHost === true && /lease expired/.test(/** @type {Error} */ (e).message));
	} finally { rmSync(path.join(dir, "renew-fails")); }
	assert.equal((await leases.renewLease(LEASE_ID)).ttl, 600, "ttl defaults to the acquired one");
});

test("leaseReply reads a current host's JSON and an older host's line", () => {
	const exp = { name: "pool-1", lease_id: LEASE_ID, expires_at: 1793462400 };
	assert.deepEqual(leases.leaseReply(JSON.stringify(exp), true), exp);
	assert.deepEqual(leases.leaseReply(`pool-1 ${LEASE_ID} 1793462400`, false), exp);
	assert.deepEqual(leases.leaseReply("pool-1 1793462400", false), { ...exp, lease_id: null });
	for (const bad of ["", "{", '{"name":"Bad","lease_id":"l-x","expires_at":1}', `{"name":"pool-1","lease_id":"${LEASE_ID}","expires_at":"1"}`]) assert.equal(leases.leaseReply(bad, true), null, bad);
	assert.equal(leases.leaseReply("nonsense", false), null);
});

test("a host that predates --json gets the old commands, and its line is read", async () => {
	const hostbin = path.join(dir, "grant-host"), orig = readFileSync(hostbin, "utf8");
	writeFileSync(hostbin, orig.replace("help) echo '  renew LEASE [--ttl S] [--json] | release LEASE';", "help) echo '  renew LEASE [--ttl S] | release LEASE';"));
	rmSync(path.join(home, "host-lease-json"), { force: true });
	try {
		const r = await leases.acquireLease({ ttl: 600 });
		assert.equal(r.id, LEASE_ID);
		assert.equal((await leases.renewLease("pool-1", 900)).expires, 9999999999);
		assert.ok(calls().filter((c) => /^(acquire|renew) /.test(c)).every((c) => !c.includes("--json")), calls().join("\n"));
		await leases.releaseLease("pool-1");
	} finally { writeFileSync(hostbin, orig); }
	assert.ok(!existsSync(path.join(home, "host-lease-json")), "not remembered for an older host");
	profile.forgetHostFeatures(); // (in a real process: asked again after 10 minutes)
	await leases.acquireLease({ ttl: 600 });
	assert.match(calls().filter((c) => c.startsWith("acquire ")).at(-1) ?? "", / --json$/);
	assert.ok(existsSync(path.join(home, "host-lease-json")), "remembered once the host supports it");
});

test("a host that stops understanding --json (downgraded, or HOST changed) is asked again, without it", async () => {
	profile.forgetHostFeatures();
	await leases.acquireLease({ ttl: 600 }); // remembers host-lease-json
	assert.ok(existsSync(path.join(home, "host-lease-json")));
	const hostbin = path.join(dir, "grant-host"), orig = readFileSync(hostbin, "utf8");
	// An older host: no --json in help, and it rejects the flag before doing anything (as parseOptions does).
	writeFileSync(hostbin, orig.replace("help) echo '  renew LEASE [--ttl S] [--json] | release LEASE';", "help) echo '  renew LEASE [--ttl S] | release LEASE';")
		.replace('json=; for a; do [ "$a" != --json ] || json=1; done', 'for a; do [ "$a" != --json ] || { echo "boxery-host: unknown flag --json" >&2; exit 1; }; done; json='));
	try {
		assert.equal((await leases.renewLease("pool-1", 900)).expires, 9999999999);
		assert.ok(!existsSync(path.join(home, "host-lease-json")), "the marker is forgotten");
		const renews = calls().filter((c) => c.startsWith("renew "));
		assert.deepEqual(renews.slice(-2).map((c) => c.endsWith("--json")), [true, false], renews.join("\n"));
		await leases.releaseLease("pool-1");
	} finally { writeFileSync(hostbin, orig); }
});

test("a --json failure while the host can't be reached keeps --json (no answer is not a downgrade)", async () => {
	profile.forgetHostFeatures();
	await leases.acquireLease({ ttl: 600 });
	const hostbin = path.join(dir, "grant-host"), orig = readFileSync(hostbin, "utf8");
	writeFileSync(hostbin, "#!/bin/sh\necho 'ssh: connect to host: Connection refused' >&2; exit 255\n"); // unreachable
	try {
		await assert.rejects(leases.renewLease("pool-1", 900), /Connection refused/);
		assert.ok(existsSync(path.join(home, "host-lease-json")), "the marker stays");
	} finally { writeFileSync(hostbin, orig); }
	assert.match(String((await leases.renewLease("pool-1", 900)).expires), /^9999999999$/);
	assert.match(calls().filter((c) => c.startsWith("renew ")).at(-1) ?? "", / --json$/);
	await leases.releaseLease("pool-1");
});
