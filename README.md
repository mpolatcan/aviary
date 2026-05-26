# CodeHub

A home for your AI coding agents.

Tauri desktop app that runs **Claude Code**, **Codex**, and **Antigravity** CLIs in sandboxed Docker containers, multiplexed via tmux. Each pane = one tmux session = one agent; tabs hold one or more split panes. By default each workspace gets its own container (`codehub-ws-<key>`) so its cpu/mem/network/state report as real, isolated data; set `CODEHUB_PER_WORKSPACE_CONTAINER` to an off-value to fall back to a single shared `codehub-runtime` container. CodeHub spawns and manages containers itself — no `docker compose` step.

## Why

Running multiple agent CLIs locally is messy: separate terminals, separate auth, no unified view, no isolation. CodeHub isolates each agent in a tmux session inside a container — one container per workspace by default — and gives you a single window to switch between them.

## Architecture

```mermaid
flowchart LR
    subgraph webview["Tauri webview"]
        direction TB
        UI["xterm.js · Vite<br/>React 19 + Zustand<br/>tabs ↔ split panes ↔ terminals"]
    end

    subgraph backend["Rust backend (tokio)"]
        direction TB
        LC["Lifecycle<br/>image + container"]
        DC["DockerClient<br/>exec / streams"]
        PR["PtyRegistry<br/>pane_id map"]
    end

    subgraph runtime["per-workspace container · codehub-ws-&lt;key&gt;<br/>(or shared codehub-runtime when flag off)"]
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
    participant C as codehub-runtime

    UI->>LC: ensure_runtime (spawn bg)
    LC->>D: pull ghcr.io/mpolatcan/codehub-runtime:VER
    Note right of D: ~10–20s first run only
    LC->>D: create container + volume mounts
    D->>C: start
    LC-->>UI: emit codehub://lifecycle (running)
    UI->>LC: list_sessions
    LC-->>UI: existing tmux sessions
    UI->>UI: restore tabs
```

### Per-session lifecycle (new tab, split, or ⌘T)

```mermaid
sequenceDiagram
    autonumber
    participant UI as Frontend
    participant B as Backend
    participant T as tmux (in workspace container)

    UI->>UI: launcher — agent (claude/codex/antigravity) × mode (standard/auto/yolo)
    UI->>B: create_session(name, cli, mode, workspace)
    Note right of B: resolve + ensure<br/>codehub-ws-(key)<br/>(shared runtime when flag off)
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

## Using it

- **New session** — the `+` popover (or ⌘T) picks an agent and a permission mode.
- **Permission modes** — *Standard* (agent asks first), *Auto* (auto-accepts edits, still sandboxed), *YOLO* (skips all approvals; the container is the boundary). Antigravity is Standard-only until its flags are verified.
- **Splits** — split any pane (its head controls, or ⌘\) into a binary tree; drag the divider to resize.
- **Workspaces** — the welcome screen pins and reopens saved workspaces (name + directory, persisted); each runs in its own container with `/workspace` bound to its directory (or re-points the shared container's mount when per-workspace is off). New-workspace wizard via ⌘⇧N.
- **Hub panels** — a Files browser (⌘E), a workspace Diff viewer (⌘D), and a Resume drawer (⌘R) of past Claude/Codex sessions, docked beside the panes.
- **Command palette** (⌘K) — jump to a view, focus a running session, spawn an agent, or open a recent/connected repo.
- **Views** — Hub, Dashboard, Workspaces (container inspector), Usage (token/cost rollup read from session transcripts), and Settings (agents · runtime · integrations · appearance). Dark and light themes.
- **Companion** — an always-on-top monitor window mirroring live agent status (working / awaiting input / done / failed) with inline approve/deny. On macOS a native notch "dynamic island" variant exists (experimental).
- **Keyboard** — ⌘N/⌘T new session · ⌘⇧N new workspace · ⌘W close focused · ⌘\ split · ⌘⇧\ split column · ⌘⇧B shell pane · ⌘E files · ⌘D diff · ⌘R resume · ⌘1–9 switch tab · ⌘K palette · ⌘/ all shortcuts.

## Runtime image

Lives in `runtime/`. See `runtime/README.md` for build and publish instructions.

## Prerequisites

- Rust toolchain (`rustup`, stable)
- Node 20+
- Docker Desktop running
- macOS / Linux (Windows untested)

## Setup

```bash
git clone https://github.com/mpolatcan/codehub.git
cd codehub
npm install

# Build runtime image locally (or wait for app to pull from the registry on first launch)
make image

# Dev mode (hot reload frontend, rebuild Rust on change)
make dev
```

> See `make help` for the full target list (`build`, `check`, `fix`, `image-verify`, …).

### Browser mode (dev bridge)

The Tauri webview (WKWebView) has no remote-debugging port, so the UI can't be
inspected or screenshotted from outside the app. For visual work, `make dev-web`
runs the frontend in a plain browser at <http://127.0.0.1:1420> against a real
backend — a feature-gated HTTP/WebSocket bridge that mirrors the Tauri IPC
surface. It is **dev-only** and never compiled into the shipped app.

```bash
make dev-web   # Vite + standalone backend bridge, no Tauri window
```

Override defaults:

| Env var | Purpose | Default |
|---|---|---|
| `CODEHUB_PER_WORKSPACE_CONTAINER` | One container per workspace (`codehub-ws-<key>`); off-value (`0`/`false`/`off`/`no`) → single shared runtime | ON |
| `CODEHUB_CONTAINER` | Shared-runtime container name (per-workspace off) | `codehub-runtime` |
| `CODEHUB_IMAGE` | Image tag to use (all containers) | `ghcr.io/mpolatcan/codehub-runtime:0.1.3` |
| `CODEHUB_NETWORK_MODE` | Docker network mode | `bridge` |
| `CLAUDE_CODE_OAUTH_TOKEN` | Skip `/login` in Claude Code | unset |

## Production build

```bash
make build
```

Bundles a `.dmg` on macOS, `.AppImage`/`.deb` on Linux. Output at `src-tauri/target/release/bundle/`.

## Volume layout

CodeHub stores all state under the OS app-data dir, namespaced by the bundle identifier
configured in `src-tauri/tauri.conf.json`.

| Platform | Host path | Container path | Purpose |
|---|---|---|---|
| macOS   | `~/Library/Application Support/<bundle-id>/config`    | `/config`    | Per-CLI auth state |
| macOS   | `~/Library/Application Support/<bundle-id>/workspace` | `/workspace` | Project files |
| Linux   | `~/.local/share/<bundle-id>/config`                   | `/config`    | Per-CLI auth state |
| Linux   | `~/.local/share/<bundle-id>/workspace`                | `/workspace` | Project files |

## Roadmap

- macOS Keychain for OAuth token storage (`security-framework` crate).
- Native OS notifications when an agent finishes (today surfaced in the always-on-top companion).
- Copy-mode keybindings.
- Auto-update via Tauri updater plugin.
- App icon set.
- Code-split the frontend bundle.
