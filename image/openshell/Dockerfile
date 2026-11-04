# Build with the engine used by your OpenShell gateway:
# docker build -t boxery-openshell:dev -f image/openshell/Dockerfile .
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl file git jq openssh-client procps python3 ripgrep tar tmux util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && userdel node && useradd --uid 1000 --create-home --shell /bin/bash agent \
    && mkdir -p /home/agent/project /etc/boxery \
    && touch /etc/boxery/headless \
    && chown -R agent:agent /home/agent
ENV HOME=/home/agent
USER agent
# OpenShell's Docker driver uses WORKDIR as HOME. Keep Boxery's home/project layout.
WORKDIR /home/agent
CMD ["sleep", "infinity"]
