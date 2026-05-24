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

# ── Agent-event hook subsystem (§7, COMPLETION_PLAN.md) ─────────────────────
#
# Each agent appends structured JSON events to:
#   /tmp/codehub/events/$CODEHUB_SESSION.jsonl
#
# CodeHub's `events.rs` tails that dir and emits `codehub://agent-event` to
# the frontend. The hook script reads the full agent-provided JSON on stdin and
# wraps it with the session tag + timestamp + event kind so the Rust parser only
# needs to decode our envelope, not reconstruct the agent-native shape.
#
# CODEHUB_SESSION is exported per-pane by `docker.rs::create_tmux_session` (via
# `tmux new-session -e CODEHUB_SESSION=<name>`) — verified to reach the hook
# process in the Phase-0 spike (§7.6).

# Create the events dir at image build time (also created at runtime by events.rs).
RUN mkdir -p /tmp/codehub/events && chmod 700 /tmp/codehub/events

# The hook append script: reads agent-provided JSON on stdin, emits one
# well-typed line to the session's event file. Installed at a fixed path so
# both the Claude hook config and the Codex notify config can reference it.
RUN cat > /usr/local/bin/codehub-hook <<'HOOK_EOF'
#!/usr/bin/env bash
# codehub-hook — append one event line to the session's JSONL file.
# Called by Claude Code hooks and Codex notify with event JSON on stdin.
#
# Arguments: $1 = event kind (the Claude hook event name, e.g. "Stop",
# "Notification", "PreToolUse" — set by the individual hook commands below
# so this script is reusable).
#
# Environment: CODEHUB_SESSION must be set (exported per-pane by CodeHub).

set -euo pipefail

EVENT_KIND="${1:-unknown}"
SESSION="${CODEHUB_SESSION:-}"

# If CodeHub didn't set the session, skip gracefully (non-CodeHub run).
if [ -z "$SESSION" ]; then
  exit 0
fi

EVENTS_DIR="/tmp/codehub/events"
mkdir -p "$EVENTS_DIR"
EVENTS_FILE="$EVENTS_DIR/$SESSION.jsonl"

# Read agent-provided JSON from stdin (may be empty for hook types that
# don't provide stdin — fall back to an empty object).
PAYLOAD_JSON="$(cat 2>/dev/null || echo '{}')"

# Build the envelope. `jq -c` writes compact JSON; --arg/-n guarantees
# correct escaping regardless of what's in the payload.
NOW_MS=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')

printf '%s\n' "$(
  jq -cn \
    --arg session "$SESSION" \
    --arg kind "$EVENT_KIND" \
    --argjson at "$NOW_MS" \
    --argjson payload "$PAYLOAD_JSON" \
    '{
      session: $session,
      kind: $kind,
      at: $at,
      message: ($payload.message // null),
      notification_type: ($payload.notification_type // null),
      tool_name: ($payload.tool_name // $payload.tool_use.name // null)
    }'
)" >> "$EVENTS_FILE"
HOOK_EOF
RUN chmod +x /usr/local/bin/codehub-hook

# ── Claude Code hook configuration ──────────────────────────────────────────
# Written to $CLAUDE_CONFIG_DIR/settings.json (merged at startup by Claude Code).
# The hook config keys are verified against Claude Code 2.1.150 (§7.6 spike):
#   hooks.<EventName>[].hooks[].{type:"command", command:"..."}
#
# Note: CLAUDE_CONFIG_DIR=/config/claude is volume-mounted from the host at
# runtime (lifecycle.rs bind-mounts the app-data config dir). The settings.json
# written here is the IMAGE DEFAULT; the host mount overrides it. We write to
# the image path so a fresh mount gets a sane default; CodeHub preserves any
# existing host-side settings.json rather than clobbering it.
#
# The hook commands are single-quoted shell commands referencing
# /usr/local/bin/codehub-hook with the event kind as the first argument.

RUN mkdir -p /config/claude && cat > /config/claude/settings.json <<'SETTINGS_EOF'
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/usr/local/bin/codehub-hook Stop"
          }
        ]
      }
    ],
    "StopFailure": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/usr/local/bin/codehub-hook StopFailure"
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/usr/local/bin/codehub-hook Notification"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/usr/local/bin/codehub-hook PreToolUse"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/usr/local/bin/codehub-hook PostToolUse"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/usr/local/bin/codehub-hook UserPromptSubmit"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/usr/local/bin/codehub-hook SessionStart"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/usr/local/bin/codehub-hook SessionEnd"
          }
        ]
      }
    ]
  }
}
SETTINGS_EOF

# ── Codex notify configuration ───────────────────────────────────────────────
# Codex reads notify config from $CODEX_CONFIG_DIR/config.toml (TOML format).
# The `notify` array specifies programs to run on turn-complete / approval events.
# Payload shape is not in public docs (§7.6 unverified) — the hook script reads
# stdin and emits what it can; unknown fields are omitted by jq (honesty contract).

RUN mkdir -p /config/codex && cat > /config/codex/config.toml <<'CODEX_EOF'
# CodeHub event capture — appends turn/approval events to the session event file.
# The notify program receives event JSON on stdin (shape TBD; §7.6).
notify = ["/usr/local/bin/codehub-hook Stop"]
CODEX_EOF

# Idle entrypoint — CodeHub spawns tmux sessions via docker exec
ENTRYPOINT ["tail", "-f", "/dev/null"]
