// Guest OS definitions, by the name a VM's record holds (host/vm-records.mjs: os).
// Only linux exists; macOS is planned (docs/plans/2026-11-03-guest-os-seam.md, #155).
import * as linux from "./linux.mjs";

/** @typedef {typeof linux} GuestOs */

/** The OS of a VM without a record: every VM made before records existed. */
export const DEFAULT_OS = linux.name;
/** @type {Record<string, GuestOs>} */
const GUESTS = { [linux.name]: linux };

/** The definition for OS. @param {string} [os] default: DEFAULT_OS @returns {GuestOs} */
export function guestOs(os = DEFAULT_OS) {
	const g = GUESTS[os];
	if (!g) throw new Error(`unknown guest OS: ${os} (known: ${Object.keys(GUESTS).join(", ")})`);
	return g;
}
