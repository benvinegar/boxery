// Shared OpenShell namespace identity and the explicit-empty provider representation.
import { createHash } from "node:crypto";

export const OPENSHELL_NAMESPACE_LABEL = "boxery.dev/namespace";
/** Non-secret, label-safe identity. Exact matches prevent overlapping prefixes from sharing ownership.
 * @param {string} prefix */
export const openShellNamespace = (prefix) => createHash("sha256").update(prefix).digest("hex").slice(0, 32);

// Empty environment values otherwise mean "inherit saved settings" in both host config loaders.
export const OPENSHELL_NO_PROVIDERS = "[]";
/** @param {string | undefined} value @returns {string[]} */
export const openShellProviders = (value) => !value || value === OPENSHELL_NO_PROVIDERS ? [] : value.split(",").filter(Boolean);
