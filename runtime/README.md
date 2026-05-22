# CodeHub Runtime Image

Container image bundling AI coding CLIs that CodeHub multiplexes via tmux.

## CLIs included

- **Claude Code** (Anthropic) — native binary, `/root/.local/bin/claude`
- **Codex** (OpenAI) — npm global, `codex`
- **Antigravity** (Google) — installer script, `antigravity`

## How it runs

The container does not run any CLI as PID 1. It idles on `tail -f /dev/null`. CodeHub spawns tmux sessions inside it on demand via `docker exec -it codehub-runtime tmux ...`. The tmux server persists across exec invocations because they all attach to the same `TMUX_TMPDIR=/tmp/codehub` socket.

## Volume layout

| Host path (macOS) | Container path | Purpose |
|---|---|---|
| `~/Library/Application Support/codehub/config` | `/config` | Auth state for each CLI (`claude`, `codex`, `antigravity` subdirs) |
| `~/Library/Application Support/codehub/workspace` | `/workspace` | Project files visible to all CLIs |

## Building manually (dev)

```bash
docker build -t codehub-runtime:dev .
```

## Publishing release image

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/mpolatcan/codehub-runtime:0.1.1 \
  -t ghcr.io/mpolatcan/codehub-runtime:latest \
  --push .
```

CodeHub's `lifecycle.rs` pulls `ghcr.io/mpolatcan/codehub-runtime:<codehub-version>` on first launch.
