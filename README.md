# Aviary

A home for your AI coding agents.

Tauri desktop app that runs **Claude Code**, **Codex**, and **Antigravity** CLIs inside a single sandboxed Docker container, multiplexed via tmux. Each tab in the window = one tmux session = one agent. Aviary spawns and manages the container itself — no `docker compose` step.

## Why

Running multiple agent CLIs locally is messy: separate terminals, separate auth, no unified view, no isolation. Aviary cages each agent in its own tmux session inside one container, and gives you a single window to switch between them.

## Architecture

```mermaid
flowchart LR
    subgraph webview["Tauri webview"]
        direction TB
        UI["xterm.js · Vite<br/>vanilla TS<br/>tabs ↔ panes ↔ terminals"]
    end

    subgraph backend["Rust backend (tokio)"]
        direction TB
        LC["Lifecycle<br/>image + container"]
        DC["DockerClient<br/>exec / streams"]
        PR["PtyRegistry<br/>pane_id map"]
    end

    subgraph runtime["aviary-runtime container"]
        direction TB
        TMUX["tmux server<br/>idle until first session"]
        CLIS["claude · codex<br/>antigravity"]
        TMUX -. spawns .-> CLIS
    end

    webview <-- "IPC<br/>invoke / event" --> backend
    backend <-- "/var/run/docker.sock<br/>bollard" --> runtime

    classDef webviewBox fill:#e8f1ff,stroke:#3b6dba,stroke-width:1.5px,color:#1a2436
    classDef backendBox fill:#fff4dc,stroke:#b6873a,stroke-width:1.5px,color:#2a1f10
    classDef runtimeBox fill:#e6f3e1,stroke:#4f7d3a,stroke-width:1.5px,color:#1d2a17
    classDef inner    fill:#ffffff,stroke:#6a6a6a,stroke-width:1px,color:#1c1c1c

    class webview webviewBox
    class backend backendBox
    class runtime runtimeBox
    class UI,LC,DC,PR,TMUX,CLIS inner
```

### Boot sequence

```mermaid
sequenceDiagram
    autonumber
    participant UI as Frontend
    participant LC as Lifecycle
    participant D as Docker
    participant C as aviary-runtime

    UI->>LC: ensure_runtime (spawn bg)
    LC->>D: pull ghcr.io/mpolatcan/aviary-runtime:VER
    Note right of D: ~10–20s first run only
    LC->>D: create container + volume mounts
    D->>C: start
    LC-->>UI: emit aviary://lifecycle (running)
    UI->>LC: list_sessions
    LC-->>UI: existing tmux sessions
    UI->>UI: restore tabs
```

### Per-session lifecycle (user clicks **+**)

```mermaid
sequenceDiagram
    autonumber
    participant UI as Frontend
    participant B as Backend
    participant T as tmux (in container)

    UI->>UI: CLI picker modal (claude / codex / antigravity)
    UI->>B: create_session(name, cli)
    B->>T: docker exec — tmux new-session -d -s NAME CLI
    UI->>B: attach_session(name, cols, rows)
    B->>T: bollard exec tty=true — tmux attach -t NAME
    B-->>UI: pane_id
    loop while attached
        T-->>B: stdout chunks
        B-->>UI: pty://data/PANE_ID
        UI->>B: pty_write(paneId, data)
        B->>T: stdin
        UI->>B: pty_resize(paneId, cols, rows)
        B->>T: TIOCSWINSZ
    end
```

## Runtime image

Lives in `runtime/`. See `runtime/README.md` for build and publish instructions.

## Prerequisites

- Rust toolchain (`rustup`, stable)
- Node 20+
- Docker Desktop running
- macOS / Linux (Windows untested)

## Setup

```bash
git clone https://github.com/mpolatcan/aviary.git
cd aviary
npm install

# Build runtime image locally (or wait for app to pull from the registry on first launch)
make image

# Dev mode (hot reload frontend, rebuild Rust on change)
make dev
```

> See `make help` for the full target list (`build`, `check`, `fix`, `image-verify`, …).

Override defaults:

| Env var | Purpose | Default |
|---|---|---|
| `AVIARY_CONTAINER` | Container name | `aviary-runtime` |
| `AVIARY_IMAGE` | Image tag to use | `ghcr.io/mpolatcan/aviary-runtime:0.1.0` |
| `AVIARY_NETWORK_MODE` | Docker network mode | `bridge` |
| `CLAUDE_CODE_OAUTH_TOKEN` | Skip `/login` in Claude Code | unset |

## Production build

```bash
make build
```

Bundles a `.dmg` on macOS, `.AppImage`/`.deb` on Linux. Output at `src-tauri/target/release/bundle/`.

## Volume layout

Aviary stores all state under the OS app-data dir, namespaced by the bundle identifier
configured in `src-tauri/tauri.conf.json`.

| Platform | Host path | Container path | Purpose |
|---|---|---|---|
| macOS   | `~/Library/Application Support/<bundle-id>/config`    | `/config`    | Per-CLI auth state |
| macOS   | `~/Library/Application Support/<bundle-id>/workspace` | `/workspace` | Project files |
| Linux   | `~/.local/share/<bundle-id>/config`                   | `/config`    | Per-CLI auth state |
| Linux   | `~/.local/share/<bundle-id>/workspace`                | `/workspace` | Project files |

## Roadmap

- macOS Keychain for OAuth token storage (`security-framework` crate).
- Bell-character detection -> native notification when an agent finishes.
- Split panes (tmux split-window), copy mode keybindings, session rename.
- Multiple workspaces (one container per workspace dir).
- Auto-update via Tauri updater plugin.
- Icon set (cage grid + bird silhouette).
