#!/bin/bash
# boxery layer 2/3, dev tools and agents: git, build tools, node 22, pi, opencode, ripgrep. Runs as root,
# idempotent. Keeps what the starting image already ships (exeuntu has most of it): a package is only
# installed when missing, node only when there's no node >= 22, and an agent CLI only when the agent
# user can't run the one that's there.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# shellcheck source=/dev/null
. /usr/local/lib/boxery/layers/lib.sh

pkgs git jq ripgrep fd-find build-essential python3 python3-venv zip unzip ca-certificates gnupg curl

# What the agent user gets in a login shell, without anything from root's environment.
as_agent() { sudo -u agent -H env -i HOME=/home/agent PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin "$@"; }

# Node 22 LTS
if ! v=$(as_agent node --version 2>/dev/null) || [ "$(echo "$v" | sed 's/^v\([0-9]*\).*/\1/')" -lt 22 ]; then
	ARCH=$(dpkg --print-architecture)   # amd64 | arm64
	NODE_ARCH=$([ "$ARCH" = arm64 ] && echo arm64 || echo x64)
	NODE_TGZ=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk -v a="linux-$NODE_ARCH.tar.xz" '$2 ~ a"$"{print $2}')
	curl -fsSL "https://nodejs.org/dist/latest-v22.x/$NODE_TGZ" | tar -xJ -C /usr/local --strip-components=1
fi
as_agent node --version

# Coding agents. exeuntu ships an opencode, and a pi that links into exedev's home (unusable by agent):
# npm won't overwrite either, so a CLI the agent can't run is removed first.
for pair in pi:@earendil-works/pi-coding-agent opencode:opencode-ai; do
	cmd=${pair%%:*} pkg=${pair#*:}
	as_agent "$cmd" --version >/dev/null 2>&1 && { echo "keeping the image's $cmd ($(command -v "$cmd"))"; continue; }
	rm -f "/usr/local/bin/$cmd"
	npm install -g "$pkg"
	as_agent "$cmd" --version >/dev/null 2>&1 || { echo "$cmd doesn't run after installing $pkg" >&2; exit 1; }
done
