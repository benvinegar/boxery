// Quote one literal argument for the remote POSIX shell (OpenSSH joins command argv).
export const q = (/** @type {unknown} */ s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
