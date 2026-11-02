// Host lease policy. No process, filesystem, environment, shell, or SQLite imports.
// Store methods are synchronous transactions; side effects, locks, journal, clock and logging
// are injected so ordering and failure behavior can be tested without a hypervisor or subprocess.
/** @import { Claim, DueReset, ResetTicket } from "./boxery-leases.mjs" */

// Generations arrive as numbers from the store and as strings from argv (held-lock entry points).
/** @typedef {number | string} Gen */
/**
 * Synchronous state transactions (boxery-leases.mjs bound to a database); only the fields policy reads.
 * @typedef {{
 *   get(name: string): { name: string, gen: number, epoch: string, state: string, lease_id: string | null } | null,
 *   find(leaseId: string): { name: string } | null,
 *   claim(holder: string, ttl: number, pubkey: string): Claim | null,
 *   commit(name: string, gen: Gen): boolean,
 *   beginReset(leaseId: string): ResetTicket,
 *   finish(name: string, gen: Gen, state: "FREE" | "BROKEN"): boolean,
 *   candidates(): ResetTicket[],
 *   due(name: string, gen: Gen, epoch: string): DueReset[],
 * }} LeaseStore
 */
/**
 * Asynchronous backend/guest effects.
 * @typedef {{
 *   clearEdge(name: string): Promise<unknown>,
 *   issueToken(name: string, leaseId: string): Promise<unknown>,
 *   revokeToken(name: string): Promise<unknown>,
 *   restore(name: string, label: string): Promise<unknown>,
 *   waitReady(name: string): Promise<unknown>,
 *   stepClock(name: string): Promise<unknown>,
 *   setKeys(name: string, pubkey?: string): Promise<unknown>,
 * }} LeaseBackend
 */
/** Intent journal: record before effects, complete after a committed outcome.
 *  @typedef {{ intent(kind: string, data: string[]): string | Promise<string>, done(id: string): unknown }} LeaseJournal */
/** Run CALLBACK ARGV through the supervisor with VM NAME locked.
 *  @typedef {(name: string, callback: string, argv: Array<string | number>) => Promise<unknown>} LeaseLock */
/** @typedef {{ store: LeaseStore, backend: LeaseBackend, journal: LeaseJournal, lock: LeaseLock, reclaim: () => Promise<unknown>,
 *    now: () => number, sleep: (ms: number) => Promise<unknown>, log: (message: string) => unknown }} LeaseDeps */

export class LeaseWorkflows {
	/** @param {LeaseDeps} deps */
	constructor({ store, backend, journal, lock, reclaim, now, sleep, log }) {
		// Plain assignments (not Object.assign) so the checker sees the fields.
		this.store = store; this.backend = backend; this.journal = journal; this.lock = lock;
		this.reclaim = reclaim; this.now = now; this.sleep = sleep; this.log = log;
	}

	/** The row if it is still at this generation, incarnation and state, else null.
	 *  @param {string} name @param {Gen} gen @param {string} epoch @param {string} state */
	matches(name, gen, epoch, state) {
		const row = this.store.get(name); // storage errors propagate; they are not "stale"
		return row?.gen === Number(gen) && row.epoch === epoch && row.state === state ? row : null;
	}

	/** @param {{ holder: string, ttl?: number, wait?: number, pubkey: string }} opts */
	async acquire({ holder, ttl = 1800, wait = 0, pubkey }) {
		const deadline = this.now() + wait;
		let reaped = false, claim;
		for (;;) {
			claim = this.store.claim(holder, ttl, pubkey);
			if (claim) break;
			if (!reaped) {
				reaped = true;
				// As before, a failed opportunistic reap does not conceal pool exhaustion.
				await this.reclaim().catch(() => {});
				continue;
			}
			if (this.now() >= deadline) {
				throw Object.assign(new Error("pool exhausted (no FREE VM)"), { exitCode: 4 });
			}
			await this.sleep(2000);
		}
		await this.lock(claim.name, "_lease_acquire", [claim.name, claim.gen, claim.epoch, pubkey]);
		this.log(`${claim.name} leased to ${holder} until ${new Date(claim.expires_at * 1000).toISOString()}`);
		return claim;
	}

	// Held-lock entry points. The runtime validates lock ownership before calling these.
	/** @param {string} name @param {Gen} gen @param {string} epoch @param {string} pubkey */
	async install(name, gen, epoch, pubkey) {
		const row = this.matches(name, gen, epoch, "ACQUIRING");
		if (!row) throw new Error(`lease on ${name} changed while waiting for its lock`);
		const action = await this.journal.intent("acquire", [name, String(gen), epoch]);
		// A proxy token of this lease's own, in place before the holder's key can log in.
		await this.backend.issueToken(name, /** @type {string} */ (row.lease_id)); // an ACQUIRING row has its lease id
		await this.backend.setKeys(name, pubkey);
		if (!this.store.commit(name, gen)) throw new Error(`lease on ${name} was fenced`);
		await this.journal.done(action);
	}

	/** @param {string} leaseId */
	async release(leaseId) {
		const row = this.store.find(leaseId);
		if (!row) throw new Error("unknown or inactive lease");
		await this.lock(row.name, "_lease_release", [leaseId]);
	}

	/** @param {string} leaseId */
	async releaseHeld(leaseId) {
		// Look up again after locking: a release cannot act on an old pre-lock observation.
		const row = this.store.beginReset(leaseId);
		await this.reset(row.name, row.gen, row.epoch);
	}

	/** @param {string} name @param {Gen} gen @param {string} epoch */
	async reset(name, gen, epoch) {
		if (!this.matches(name, gen, epoch, "RESETTING")) {
			this.log(`${name}: stale reset skipped`);
			return;
		}
		const action = await this.journal.intent("reset", [name, String(gen), epoch]);
		// The lease's proxy token and grants end first: nothing the holder copied works past this point.
		await this.backend.revokeToken(name);
		await this.backend.clearEdge(name);
		let healthy = false;
		try {
			await this.backend.restore(name, "boxery-clean");
			await this.backend.waitReady(name);
			await this.backend.stepClock(name);
			await this.backend.setKeys(name);
			healthy = true;
		} catch {
			// Backend/guest failures quarantine the VM. A failed DB commit below is different:
			// leave its durable intent intact so a successor can retry under the original locks.
		}
		const state = healthy ? "FREE" : "BROKEN";
		if (!this.store.finish(name, gen, state)) throw new Error(`${name}: reset commit failed`);
		this.log(healthy
			? `${name} reset → FREE`
			: `${name} reset FAILED → BROKEN (fix it, then: boxery-host pool rm ${name} && boxery-host pool add ${name})`);
		await this.journal.done(action);
	}

	async reapCandidates() {
		for (const row of this.store.candidates()) {
			await this.lock(row.name, "_reap_candidate", [row.name, row.gen, row.epoch]);
		}
	}

	/** @param {string} name @param {Gen} gen @param {string} epoch */
	async reapHeld(name, gen, epoch) {
		const [row] = this.store.due(name, gen, epoch); // rechecks deadline as well as generation/epoch
		if (!row) return;
		this.log(`reaping ${name} (${row.reason})`);
		await this.reset(name, row.gen, row.epoch);
	}
}
