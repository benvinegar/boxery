#!/bin/bash
# boxery layer 2/3, dev tools and agents: git, build tools, node 24, pi, opencode, ripgrep. Runs as root,
# idempotent. Keeps what the starting image already ships (exeuntu has most of it): a package is only
# installed when missing, node only when the one there can't run boxery's job helper (type stripping:
# 22.18+ / 23.6+), and an agent CLI only when the agent user can't run the one that's there.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# shellcheck source=/dev/null
. /usr/local/lib/boxery/layers/lib.sh

pkgs git jq ripgrep fd-find build-essential python3 python3-venv zip unzip ca-certificates gnupg curl

# git from the git-core PPA (Ubuntu Git Maintainers): Ubuntu keeps one git per release (24.04: 2.43), while
# laptops and CI runners track upstream, and agents shouldn't hit bugs only an old git has. Ubuntu only;
# the PPA's signing key (F911AB184317630C59970973E363C90F8F1B6217) is pinned here, not fetched.
codename=$(. /etc/os-release; [ "${ID:-}" = ubuntu ] && echo "${VERSION_CODENAME:-}" || true)
if [ -n "$codename" ]; then
	install -d -m 0755 /etc/apt/keyrings
	cat >/etc/apt/keyrings/git-core-ppa.asc <<'EOF'
-----BEGIN PGP PUBLIC KEY BLOCK-----

xsFNBGYo2OYBEADVRjI+o29u9izslaVr0Xqj8hpmo/2su/Iey1PgoS6A3hMxR4R4
eZ3u9dRh/gRHXNjxqRMfKj88G6ciqa/7ty8Vfc1eKl3z7yjL1pWOEzcGLKaSB8qd
MmsxCw31nFNEbzlymgK0+KPubQ5OrIzeSikpfDVGT4HLgO42ppGY+cVy2/bbNv6O
mmPXcw8gkxRCWFiGAO5jJYG1SyGbhr9Krbf6o+LDUJeDYPTQRMf702IYZ8Bp00ix
HyK2YOUNM14rr7092o2dw9GKxnJszF4cET+LxRddrREuB3sBlAZav/I0hZtQsKZ3
QTvpStf2MwIy8Ymj94+BsZaktP0d36wigGn8RWJHrhSVyjujS8YxWRWdjrLUI1ra
42pyIYZi39IXtsTM71rihQVrsEHbMQ7a5HGRK6eYyHVPrtsXXykNqhVPekLNiFWm
IekoSH1EwMsQv8y+k3nkCwTCkTHJaueB7awee0Zs5QBwbCm+qPyqCXoVDLEwdQOr
CHKAfNADtsFQsk/yiTC/+Lmtur/okp38VpJWXg8DphHFjd1KwqQ5E9qZi+tXs/JD
UXd93VBUdoGGaHK9fj/URxUBOVopGaOXGVYtGFWPn9q8MaNcrESZ48sXDfsVgUVD
RJ4puKLHjIUtDlCnMQO6lekIhEo4sxtbDnwIUmQp7B9l+U99u+uzBI96cQARAQAB
zShMYXVuY2hwYWQgUFBBIGZvciBVYnVudHUgR2l0IE1haW50YWluZXJzwsGOBBMB
CgA4FiEE+RGrGEMXYwxZlwlz42PJD48bYhcFAmYo2OYCGwMFCwkIBwIGFQoJCAsC
BBYCAwECHgECF4AACgkQ42PJD48bYhdwUQ//UFR3i/6zpizJMTA9mpz7hGC9IJV8
UDoWoaVgl+OR1Ldfz+jvr3K55LZyIMU1o6bbLqbEnoWa2VpRv2za/SCbPqo1igio
p97EJ2irGytFOhCDd+o3s0djfsXpA7jygAK6COnMx3ejnPhaBA194HbYDhp7KA5b
gZcqvYeRN1qk9QL99voFYeUWAPnqkLLrNuAcq9qTotmyYZQI61rdAH8P4odgMtU7
UiS4yLirkAiNCqT+TK07EXvaWSXcqZhgt1HmP+BZhrx/vLT4FlH52CCjamQWeFA2
mLKX/RSx/JTux1UDroX6L9JdUyMzOrLk22Zz9Tb3FK2ysHy72jRKmUv87ctIMcgD
u8BY3Mfe/Rw8vPMuBEaAsVfvWl7uYSt81dzjkxtt6ZvIFF5PBR2IhFJVosDbpSnk
g9/b22Ipjta3ULW8oOaNZjdcRNQ5StpApzZIUoZoP83ZWafwQoSrW7Rz3KvwYAdL
d3OAfuiW9i7YdLCkvaujBt6KA4tn56fcsp14FzLZrgcj+7XUpW4/yEJFHCCu5f2l
NWvN37suUTfzbMLZVS6rC1s3qrjOD+C3dvL/dCUlcTfrrsTcs/UnaVXFq0V6NLhA
ZZxOIVUedn7nGKbaecwTt6taIjpxj0jCBxWy6RcysIkv2xluRcl2UY+HapB8x1Dx
8giHUSvkXHr4c7I=
=uGON
-----END PGP PUBLIC KEY BLOCK-----
EOF
	cat >/etc/apt/sources.list.d/git-core-ppa.sources <<EOF
Types: deb
URIs: https://ppa.launchpadcontent.net/git-core/ppa/ubuntu
Suites: $codename
Components: main
Signed-By: /etc/apt/keyrings/git-core-ppa.asc
EOF
	apt-get update -qq && touch /run/boxery-apt-updated
	apt-get install -y -q --no-install-recommends git
fi
git --version

# What the agent user gets in a login shell, without anything from root's environment.
as_agent() { sudo -u agent -H env -i HOME=/home/agent PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin "$@"; }

# Node 24 LTS, unless the image's node will do. Probe the capability, not the version: background jobs
# (core/boxery-jobs.ts) run under Node's type stripping, which a node 22.0-22.17 or 23.0-23.5 can't do.
if ! as_agent node --experimental-strip-types --disable-warning=ExperimentalWarning --input-type=module-typescript -e '' >/dev/null 2>&1; then
	ARCH=$(dpkg --print-architecture)   # amd64 | arm64
	NODE_ARCH=$([ "$ARCH" = arm64 ] && echo arm64 || echo x64)
	NODE_TGZ=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | awk -v a="linux-$NODE_ARCH.tar.xz" '$2 ~ a"$"{print $2}')
	curl -fsSL "https://nodejs.org/dist/latest-v24.x/$NODE_TGZ" | tar -xJ -C /usr/local --strip-components=1
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
