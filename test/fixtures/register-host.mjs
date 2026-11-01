// Test helper: register DIR as host NAME in the registry at HOME (BOXERY_HOME), and make it the
// default when none is set. DIR gets a stub config and ssh_config if it has none.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export function registerHost(home, name = "test", dir = home) {
	mkdirSync(path.join(home, "host-registry"), { recursive: true });
	mkdirSync(dir, { recursive: true });
	if (!existsSync(path.join(dir, "config"))) writeFileSync(path.join(dir, "config"), "# test controller config\n");
	if (!existsSync(path.join(dir, "ssh_config"))) writeFileSync(path.join(dir, "ssh_config"), "# test\n");
	writeFileSync(path.join(home, "host-registry", name), `${dir}\n`);
	if (!existsSync(path.join(home, "default-host"))) writeFileSync(path.join(home, "default-host"), `${name}\n`);
}
