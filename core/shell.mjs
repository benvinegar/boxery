// Quote one literal argument for the remote POSIX shell (OpenSSH joins command argv).
export const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
