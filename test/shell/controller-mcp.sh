#!/usr/bin/env bash
# boxery mcp install/check: absolute paths, client argv, JSON merging, real server start. Offline.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="$ROOT/controller/boxery"
B=${BASH_UNDER_TEST:-bash}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export HOME="$tmp/home"
unset BOXERY_HOME BOXERY_HOST BOXERY_HOST_BIN
mkdir -p "$HOME" "$tmp/bin" "$tmp/work"
NODE=$(node -p process.execPath)
SERVER="$ROOT/mcp/boxery-mcp.mjs"
fail() { echo "FAIL: $*" >&2; exit 1; }
# Fake clients record their argv, one argument per line.
for c in claude pi; do
	printf '#!/bin/sh\n[ "$2" = remove ] && exit 0\nprintf "%%s\\n" "$@" >"%s/%s.argv"\n' "$tmp" "$c" >"$tmp/bin/$c"
	chmod +x "$tmp/bin/$c"
done
export PATH="$tmp/bin:$PATH"
cd "$tmp/work"
expect_argv() { # CLIENT EXPECTED-LINES...
	local f="$tmp/$1.argv"; shift
	[ "$(cat "$f")" = "$(printf '%s\n' "$@")" ] || { echo "got:"; cat "$f"; fail "argv mismatch"; } >&2
}

# check: really starts the server (initialize + tools/list), even before setup
out=$("$B" "$CLI" mcp check --vm demo 2>&1) || fail "check: $out"
case $out in *"ok: initialize + tools/list (12 tools)"*) ;; *) fail "check output: $out" ;; esac

# claude: user scope by default, absolute node + server, -- before the command
"$B" "$CLI" mcp install claude --vm demo --no-check >/dev/null 2>&1
expect_argv claude mcp add -s user boxery -- "$NODE" "$SERVER" --vm demo
"$B" "$CLI" mcp install claude --scope project --name bx --no-check >/dev/null 2>&1
expect_argv claude mcp add -s project bx -- "$NODE" "$SERVER"

# pi
"$B" "$CLI" mcp install pi --vm demo --no-check >/dev/null 2>&1
expect_argv pi mcp add boxery -- "$NODE" "$SERVER" --vm demo
"$B" "$CLI" mcp install pi --scope project --no-check >/dev/null 2>&1
expect_argv pi mcp add -l boxery -- "$NODE" "$SERVER"

# a non-default BOXERY_HOME is passed to the server through the client's env
mkdir -p "$tmp/alt"
BOXERY_HOME=$tmp/alt "$B" "$CLI" mcp install claude --no-check >/dev/null 2>&1
expect_argv claude mcp add -s user -e "BOXERY_HOME=$tmp/alt" boxery -- "$NODE" "$SERVER"

# json: valid, absolute, no ~; stdout is only the JSON
"$B" "$CLI" mcp install json --vm demo >"$tmp/out.json" 2>/dev/null
node -e '
	const c = require(process.argv[1]).mcpServers.boxery, [node, server] = process.argv.slice(2);
	if (c.command !== node || c.args.join(" ") !== `${server} --vm demo` || c.env) throw new Error(JSON.stringify(c));
' "$tmp/out.json" "$NODE" "$SERVER" || fail "json snippet"

# cursor: merges into an existing file, keeps other servers and keys, idempotent
mkdir -p "$HOME/.cursor"
echo '{"mcpServers":{"other":{"command":"x"}},"keep":1}' >"$HOME/.cursor/mcp.json"
"$B" "$CLI" mcp install cursor --vm demo --no-check >/dev/null 2>&1
"$B" "$CLI" mcp install cursor --vm demo --no-check >/dev/null 2>&1
node -e '
	const j = require(process.argv[1]);
	if (j.keep !== 1 || j.mcpServers.other.command !== "x" || Object.keys(j.mcpServers).length !== 2) throw new Error("lost keys");
	if (j.mcpServers.boxery.args.at(-1) !== "demo") throw new Error("bad entry");
' "$HOME/.cursor/mcp.json" || fail "cursor merge"
"$B" "$CLI" mcp install cursor --scope project --no-check >/dev/null 2>&1
[ -f "$tmp/work/.cursor/mcp.json" ] || fail "cursor project scope"
# invalid JSON is left alone
echo '{' >"$HOME/.cursor/mcp.json"
if "$B" "$CLI" mcp install cursor --no-check >/dev/null 2>&1; then fail "accepted invalid cursor JSON"; fi
[ "$(cat "$HOME/.cursor/mcp.json")" = '{' ] || fail "rewrote invalid cursor JSON"

# rejects bad input without touching clients
rm -f "$tmp/claude.argv"
for args in "install" "install nope" "install claude --vm Bad" "install claude --name a/b" "install claude --bogus" "frob"; do
	# shellcheck disable=SC2086 # word splitting intended
	if "$B" "$CLI" mcp $args >/dev/null 2>&1; then fail "accepted: mcp $args"; fi
done
[ ! -f "$tmp/claude.argv" ] || fail "client called on bad input"

# a failing server makes install fail before registering
mkdir -p "$tmp/broken/controller" "$tmp/broken/mcp"
cp "$CLI" "$tmp/broken/controller/boxery"
printf 'process.exit(3)\n' >"$tmp/broken/mcp/boxery-mcp.mjs"
if "$B" "$tmp/broken/controller/boxery" mcp install claude >/dev/null 2>&1; then fail "installed a broken server"; fi
[ ! -f "$tmp/claude.argv" ] || fail "registered a broken server"

# resolves through a symlinked controller (npm -g bin, ~/.local/bin)
ln -s "$CLI" "$tmp/bin/boxery"
"$B" "$tmp/bin/boxery" mcp install claude --no-check >/dev/null 2>&1
expect_argv claude mcp add -s user boxery -- "$NODE" "$SERVER"

echo 'PASS: mcp check/install for claude, pi, cursor, json; env, scopes, merge, validation, symlinks'
