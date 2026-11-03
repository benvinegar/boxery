#!/bin/bash
# boxery layer github-runner (optional: boxery new NAME --headless --layers github-runner). The GitHub
# Actions runner in /opt/actions-runner, owned by agent, plus boxery-runner, which the host's runner
# manager (host/runners.mjs, `boxery-host runners`) drives over ssh. Runs as root, idempotent.
# It registers nothing: each lease of the VM gets a single-use just-in-time config from the host, and no
# GitHub credential is ever part of the image (docs/github-runners.md).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# shellcheck source=/dev/null
. /usr/local/lib/boxery/layers/lib.sh

# Pinned: the image is the source of truth, and the runner runs with self-update off. Bump VERSION and
# both hashes together, from the release notes of https://github.com/actions/runner/releases (they list
# each tarball's SHA-256). GitHub stops sending jobs to a runner some time after a newer release, so a
# runner VM's clean image needs rebuilding with a newer pin now and then.
VERSION=2.338.2
case $(dpkg --print-architecture) in
amd64) ARCH=x64 SHA256=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40 ;;
arm64) ARCH=arm64 SHA256=670adb2f268fe21dcbb58b3db0e0aa9d5b3bddfe2c651481336e561ff86de945 ;;
*) echo "github-runner: GitHub publishes no runner for $(dpkg --print-architecture)" >&2; exit 1 ;;
esac
D=/opt/actions-runner

pkgs curl ca-certificates tar gzip
if [ "$(cat "$D/.boxery-version" 2>/dev/null || true)" != "$VERSION-$ARCH" ]; then
	# Download, check the pinned hash, then unpack: never unpack an unchecked tarball.
	DL=$(mktemp -d)
	TGZ=actions-runner-linux-$ARCH-$VERSION.tar.gz
	curl -fsSL --retry 3 -o "$DL/$TGZ" "https://github.com/actions/runner/releases/download/v$VERSION/$TGZ"
	echo "$SHA256  $DL/$TGZ" | sha256sum -c --quiet - || { echo "github-runner: $TGZ failed its checksum" >&2; exit 1; }
	rm -rf "$D"
	install -d -m 0755 "$D"
	tar -xzf "$DL/$TGZ" -C "$D"
	rm -rf "$DL"
	echo "$VERSION-$ARCH" >"$D/.boxery-version"
	chown -R agent:agent "$D"   # the runner writes its config, logs and _work next to itself
fi
# The runner's own list of system libraries (ICU, Kerberos, …), installed with apt.
apt_update_once
"$D/bin/installdependencies.sh"

# boxery-runner: start the runner once, report on it, stop it. The JIT config arrives on stdin and is kept
# on tmpfs (/run) until the runner reads it; the runner then writes its own credentials into $D, which
# the lease's reset removes with the rest of the disk.
cat >/usr/local/sbin/boxery-runner <<'EOF'
#!/bin/bash
# boxery-runner start|status|stop: one ephemeral GitHub Actions runner in this VM (layer github-runner),
# driven by the host's runner manager over ssh as agent. start reads a just-in-time config on stdin and
# starts the runner as agent in the transient unit boxery-runner.service, so it outlives the ssh session.
#   status exits 0 while it runs, 1 once it has exited, 2 if none was started (/run is a tmpfs: a reboot forgets)
set -euo pipefail
D=/opt/actions-runner S=/run/boxery-runner U=boxery-runner
case ${1:-} in
start)
	[ -x "$D/run.sh" ] || { echo "boxery-runner: no runner in $D" >&2; exit 3; }
	[ ! -e "$S/started" ] || { echo "boxery-runner: this VM already ran a runner (it is single-use: reset the VM)" >&2; exit 4; }
	sudo install -d -m 0700 -o agent -g agent "$S"
	(umask 077 && cat >"$S/jitconfig")
	[ -s "$S/jitconfig" ] || { rm -f "$S/jitconfig"; echo "boxery-runner: no config on stdin" >&2; exit 2; }
	touch "$S/started"
	sudo systemd-run --quiet --unit="$U" --uid=agent --gid=agent --working-directory="$D" \
		--setenv=HOME=/home/agent --setenv=USER=agent /usr/local/sbin/boxery-runner __run ;;
__run)
	jit=$(cat "$S/jitconfig")
	rm -f "$S/jitconfig"
	rc=0
	"$D/run.sh" --jitconfig "$jit" || rc=$?
	echo "$rc" >"$S/exit"
	exit "$rc" ;;
status)
	[ ! -e "$S/exit" ] || exit 1
	! systemctl is-active --quiet "$U" || exit 0
	[ ! -e "$S/started" ] || exit 1   # gone without an exit code: killed
	exit 2 ;;
stop) sudo systemctl stop "$U" 2>/dev/null || true ;;
*) echo "usage: boxery-runner start|status|stop" >&2; exit 64 ;;
esac
EOF
chmod 0755 /usr/local/sbin/boxery-runner
echo "github-runner: actions/runner $VERSION ($ARCH) in $D"
