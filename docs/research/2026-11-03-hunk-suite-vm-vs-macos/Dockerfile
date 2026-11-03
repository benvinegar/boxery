# The Docker environment for this finding. It mirrors the boxery Lima VM: Ubuntu 24.04, Git from
# the git-core PPA, Node 24 (with npm) and Bun 1.4.3, with the hunk checkout baked into the image
# rather than mounted from macOS.
#
# Build it next to a hunk-src.tgz made with ../scripts/pack-repo.sh (see README.md here):
#   docker build -t hunk-perf .
# then time it at a VM's size, e.g. 4 CPUs and 8 GB:
#   docker run --rm --cpuset-cpus 0-3 --memory 8g hunk-perf bash -c '/usr/bin/time -p bun run test'
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends software-properties-common ca-certificates gpg-agent time curl wget file \
 && add-apt-repository -y ppa:git-core/ppa && apt-get update && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node:24-bookworm-slim /usr/local/ /usr/local/
COPY --from=oven/bun:1.4.3 /usr/local/bin/bun /usr/local/bin/bun
RUN useradd -m tester
USER tester
RUN git config --global user.name tester && git config --global user.email tester@example.com && git config --global init.defaultBranch main
WORKDIR /home/tester/hunk
ADD --chown=tester hunk-src.tgz /home/tester/hunk/
RUN bun install --frozen-lockfile
