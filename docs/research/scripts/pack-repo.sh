#!/usr/bin/env bash
# Packs a Git checkout's tracked and untracked-but-not-ignored files into a tarball for a VM or image.
#
# usage: pack-repo.sh REPO_DIR OUT.tgz
#
# It leaves out node_modules, build output and anything else the repo ignores, so the guest installs
# its own platform's dependencies. On macOS it also keeps out the AppleDouble `._*` files and extended
# attributes that the system tar adds by default: a Linux guest sees those as extra source files, and
# a test runner then tries to load them as tests.
set -euo pipefail

if [ $# -ne 2 ]; then
  sed -n '4p' "$0" | sed 's/^# //' >&2
  exit 2
fi
repo=$1
out=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")

flags=""
if tar --version 2> /dev/null | grep -q bsdtar; then
  flags="--no-xattrs --no-mac-metadata"
fi

# shellcheck disable=SC2086 # $flags is a list of options, or empty
(cd "$repo" && git ls-files -co --exclude-standard -z | COPYFILE_DISABLE=1 tar $flags --null -T - -czf "$out")

if tar -tzf "$out" | grep -q '\(^\|/\)\._'; then
  echo "pack-repo.sh: $out still holds AppleDouble ._ files" >&2
  exit 1
fi
echo "$out: $(tar -tzf "$out" | wc -l | tr -d ' ') entries from $(git -C "$repo" rev-parse HEAD)"
