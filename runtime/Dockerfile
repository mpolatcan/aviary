FROM node:20-slim

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    tmux \
    ripgrep \
    ca-certificates \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Claude Code (native binary)
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/root/.local/bin:${PATH}"

# OpenAI Codex
RUN npm install -g @openai/codex

# Google Antigravity — install URL unverified; toggle on once confirmed.
# RUN curl -fsSL https://antigravity.google/cli/install.sh | bash

# Persistent tmux socket location
ENV TMUX_TMPDIR=/tmp/codehub
RUN mkdir -p /tmp/codehub && chmod 700 /tmp/codehub

# Themed status bar matching CodeHub's palette (replaces tmux's default green).
# Loaded on tmux server start from $HOME/.tmux.conf.
COPY tmux.conf /root/.tmux.conf

# Declare this container a recognized sandbox so Claude Code's YOLO mode
# (--dangerously-skip-permissions) runs as root instead of refusing. CodeHub also
# injects this per-pane via `tmux new-session -e`, so the running container does
# not need a rebuild; this keeps a freshly built image correct on its own.
ENV IS_SANDBOX=1

# CodeHub writes config + workspace via volume mounts
ENV CLAUDE_CONFIG_DIR=/config/claude
ENV CODEX_CONFIG_DIR=/config/codex
ENV ANTIGRAVITY_CONFIG_DIR=/config/antigravity

WORKDIR /workspace

# Idle entrypoint — CodeHub spawns tmux sessions via docker exec
ENTRYPOINT ["tail", "-f", "/dev/null"]
