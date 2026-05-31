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

# GitHub CLI (gh) — powers "Sign in with GitHub": `gh auth login --web` runs in a
# login container's tmux session (user completes the device code in their
# browser) and the token is captured via `gh auth token`. Official apt repo;
# arch resolved at build time so the image stays multi-arch.
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
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
# CODEX_HOME is the real Codex var (auth.json + config.toml live under it). Pin it
# to the persistent /config mount so OAuth login + config survive container
# recreate. CODEX_CONFIG_DIR is a no-op for Codex (kept for back-compat).
ENV CODEX_HOME=/config/codex
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

# $2 carries the Notification SUBTYPE for Claude (permission_prompt / idle_prompt),
# routed by the settings matcher — Claude's Notification stdin does NOT reliably
# carry a `notification_type` field, so the matcher passes it explicitly here.
# Only honored for Notification (Codex's legacy `notify` appends its own JSON as a
# trailing arg, which must not be mistaken for a subtype).
NOTIF_TYPE=""
if [ "$EVENT_KIND" = "Notification" ]; then
  NOTIF_TYPE="${2:-}"
fi

# Codex's `notify` passes its event JSON as a trailing argv arg ($2). Pull the
# thread-id (= the rollout/conversation uuid) so CodeHub can locate THIS session's
# rollout file for per-pane token/turn telemetry. Guarded to argv that parses as a
# JSON OBJECT carrying the field, so Claude's Notification subtype string (also $2,
# a bareword like "idle_prompt") is never misread.
CODEX_THREAD=""
if [ -n "${2:-}" ] && printf '%s' "${2:-}" | jq -e 'objects | has("thread-id")' >/dev/null 2>&1; then
  CODEX_THREAD="$(printf '%s' "$2" | jq -r '."thread-id" // empty' 2>/dev/null || true)"
fi

# If CodeHub didn't set the session, skip gracefully (non-CodeHub run).
if [ -z "$SESSION" ]; then
  exit 0
fi

EVENTS_DIR="/tmp/codehub/events"
mkdir -p "$EVENTS_DIR"
EVENTS_FILE="$EVENTS_DIR/$SESSION.jsonl"

# Read agent-provided JSON from stdin. Empty (e.g. Codex's legacy `notify` nulls
# stdin and passes its payload as a trailing argv arg) or non-JSON stdin must not
# break the envelope build — fall back to an empty object. `jq -e .` exits 0 on
# EMPTY input, so the `-z` guard is required in addition to the validity check.
PAYLOAD_JSON="$(cat 2>/dev/null)"
if [ -z "$PAYLOAD_JSON" ] || ! printf '%s' "$PAYLOAD_JSON" | jq -e . >/dev/null 2>&1; then
  PAYLOAD_JSON='{}'
fi

# Build the envelope. `jq -c` writes compact JSON; --arg/-n guarantees
# correct escaping regardless of what's in the payload.
NOW_MS=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')

printf '%s\n' "$(
  jq -cn \
    --arg session "$SESSION" \
    --arg kind "$EVENT_KIND" \
    --arg nt "$NOTIF_TYPE" \
    --arg thread "$CODEX_THREAD" \
    --argjson at "$NOW_MS" \
    --argjson payload "$PAYLOAD_JSON" \
    '{
      session: $session,
      kind: $kind,
      at: $at,
      message: ($payload.message // null),
      notification_type: (if $nt != "" then $nt else ($payload.notification_type // null) end),
      tool_name: ($payload.tool_name // $payload.tool_use.name // null),
      codex_thread_id: (if $thread != "" then $thread else null end)
    }'
)" >> "$EVENTS_FILE"
HOOK_EOF
RUN chmod +x /usr/local/bin/codehub-hook

# ── Claude Code hook configuration (MANAGED settings) ───────────────────────
# CRITICAL: hooks must live in MANAGED settings, NOT $CLAUDE_CONFIG_DIR/settings.json.
# CLAUDE_CONFIG_DIR=/config/claude is bind-mounted from the host (lifecycle.rs),
# so anything written to the image's /config/claude is SHADOWED by the host mount
# (which Claude itself overwrites with its own prefs, e.g. {"theme":"dark"}) — the
# image-default hooks there NEVER reach the agent. That was the long-standing bug:
# no hook ever fired, so awaiting-input / turn / tool state was always empty.
#
# Managed settings live at a fixed system path OUTSIDE the /config mount, are
# highest-precedence, and MERGE with the user's settings — so these hooks are
# always active regardless of the mounted config dir or per-account profile.
#   Linux path: /etc/claude-code/managed-settings.json   (verified: code.claude.com/docs/en/settings)
#   Structure:  hooks.<EventName>[].{matcher?, hooks:[{type:"command", command}]}
#
# Notification is matcher-routed: Claude's Notification stdin does not reliably
# carry the notification type, but the MATCHER does filter on it — so we route
# each subtype to codehub-hook with the subtype as $2 (see the hook script).
RUN mkdir -p /etc/claude-code && cat > /etc/claude-code/managed-settings.json <<'MANAGED_EOF'
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "/usr/local/bin/codehub-hook UserPromptSubmit" }] }
    ],
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "/usr/local/bin/codehub-hook PreToolUse" }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "/usr/local/bin/codehub-hook PostToolUse" }] }
    ],
    "Notification": [
      { "matcher": "permission_prompt", "hooks": [{ "type": "command", "command": "/usr/local/bin/codehub-hook Notification permission_prompt" }] },
      { "matcher": "idle_prompt", "hooks": [{ "type": "command", "command": "/usr/local/bin/codehub-hook Notification idle_prompt" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "/usr/local/bin/codehub-hook Stop" }] }
    ],
    "StopFailure": [
      { "hooks": [{ "type": "command", "command": "/usr/local/bin/codehub-hook StopFailure" }] }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "/usr/local/bin/codehub-hook SessionStart" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "/usr/local/bin/codehub-hook SessionEnd" }] }
    ]
  }
}
MANAGED_EOF

# A minimal image-default user settings.json so a fresh /config mount is sane.
# Intentionally carries NO hooks — those are owned by managed-settings above (a
# copy here would be shadowed by the host mount anyway).
RUN mkdir -p /config/claude && cat > /config/claude/settings.json <<'SETTINGS_EOF'
{}
SETTINGS_EOF

# ── Codex notify configuration ───────────────────────────────────────────────
# Codex reads config from $CODEX_CONFIG_DIR/config.toml. Two mechanisms (verified
# against openai/codex + developers.openai.com/codex/hooks):
#   • legacy `notify` — fires ONLY on agent-turn-complete; the event JSON is
#     appended as a trailing ARGV arg (stdin is null). codehub-hook just needs the
#     "Stop" kind, so it ignores that arg. NOTE the array is [program, args...] —
#     the previous single space-joined string never exec'd.
#   • structured `hooks` (enabled by default) — give what notify can't: turn start,
#     tool calls, and AWAITING APPROVAL (PermissionRequest). Each runs codehub-hook
#     with the event JSON on STDIN (codehub-hook reads tool_name etc. from it).
#     PermissionRequest reuses the Notification/permission_prompt kind → the
#     awaiting path. No Stop hook here — `notify` owns turn-finish (no double-count).
#
# Delivery caveat (same as Claude's old settings.json): $CODEX_CONFIG_DIR=/config
# is bind-mounted, so this image default is shadowed if the host /config/codex has
# its own config.toml. Unlike Claude, Codex exposes no system path outside the
# mount, so guaranteed delivery needs CodeHub to seed the host config (follow-up).
RUN mkdir -p /config/codex && cat > /config/codex/config.toml <<'CODEX_EOF'
# CodeHub event capture — appends turn/tool/approval events to the session file.
notify = ["/usr/local/bin/codehub-hook", "Stop"]

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "/usr/local/bin/codehub-hook UserPromptSubmit"

[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
type = "command"
command = "/usr/local/bin/codehub-hook PreToolUse"

[[hooks.PostToolUse]]
[[hooks.PostToolUse.hooks]]
type = "command"
command = "/usr/local/bin/codehub-hook PostToolUse"

[[hooks.PermissionRequest]]
[[hooks.PermissionRequest.hooks]]
type = "command"
command = "/usr/local/bin/codehub-hook Notification permission_prompt"

[[hooks.SessionStart]]
[[hooks.SessionStart.hooks]]
type = "command"
command = "/usr/local/bin/codehub-hook SessionStart"
CODEX_EOF

# Idle entrypoint — CodeHub spawns tmux sessions via docker exec
ENTRYPOINT ["tail", "-f", "/dev/null"]
