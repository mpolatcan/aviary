# CodeHub

A home for your AI coding agents.

Tauri desktop app that runs **Claude Code**, **Codex**, and **Antigravity** CLIs in sandboxed Docker containers, multiplexed via tmux. Each pane = one tmux session = one agent; tabs hold one or more split panes. Each workspace gets its own container (`codehub-ws-<key>`) so its cpu/mem/network/state report as real, isolated data. CodeHub spawns and manages containers itself — no `docker compose` step.

**Built with** Tauri 2 · Rust + tokio · React 19 + Zustand · xterm.js · Tailwind v4 + shadcn/ui · **JetBrains Mono** throughout.

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

    subgraph runtime["per-workspace container · codehub-ws-(key)"]
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
    participant C as codehub-ws-(key)

    UI->>LC: daemon reachability check (spawn bg)
    LC->>D: docker version
    LC-->>UI: emit codehub://lifecycle (running)
    UI->>LC: list_sessions (all workspace containers)
    LC-->>UI: existing tmux sessions
    UI->>UI: restore tabs
    Note right of LC: containers created on demand by create_session
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

- **Workspaces** — the launcher (⌘T or the `+` tab button) lists saved workspaces (name, directory, last-opened time) with search/filter, plus recent/resume entries. Each runs in its own container (`codehub-ws-<key>`) with repos mounted under `/workspace/<repo-name>`. The launcher's **Blank workspace** card opens a 3-step wizard that picks repos (local folders + GitHub), container resources (CPU/memory), and the first agent.
- **New agent** — ⌘N (or the action-bar "New agent" button) drops a *configuring* pane into the current workspace: a card to pick the agent (Claude Code / Codex / Antigravity), permission mode, **working directory** and account, then spawn. The directory field is a folder browser over the mounted `/workspace` tree — drill into any repo or sub-folder at any depth and pick it as the agent's cwd (so a workspace that mounts a parent folder of many repos still lets each agent target a specific one). ⌘⇧N spawns into a fresh group instead of the active one.
- **Permission modes** — *Standard* (agent asks first), *Auto* (auto-accepts edits, still sandboxed), *YOLO* (skips all approvals; the container is the boundary). Antigravity is Standard-only until its flags are verified.
- **Splits** — split any pane (its head controls, or ⌘\) into a binary tree; drag the divider to resize. Groups organize splits; each tab holds one or more groups.
- **Color & rename** — click the identity dot on any pane head, group tab, or workspace tab to recolor it; double-click the title to rename. Colors and names persist across reloads.
- **Hub panels** — a Files browser (⌘E), a workspace Diff viewer (⌘D), a Shell panel (⌘J), a Details/metrics panel (⌘I), and a Resume drawer (action-bar button) of past Claude/Codex sessions, docked beside the panes.
- **Per-pane telemetry** — each agent pane carries a live footer: the working directory, a context-window gauge (tokens used / model max), the turn count, and total tokens. Real per-session data read from the Claude transcript / Codex rollout — never estimated. The strip is always present (zeros until the first turn produces a transcript). The sidebar mirrors each agent: name, working dir, and live status.
- **Command palette** (⌘K) — jump to a view, focus a running session, spawn an agent, or open a recent/connected repo.
- **Views** — Hub, Dashboard, Workspaces (container manager), Usage (token/cost rollup from session transcripts), Settings (agents · runtime · integrations · appearance · keyboard shortcuts). Three themes: dark, gray, light.
- **GitHub integration** — connect a PAT or sign in via OAuth in Settings → Integrations. Browse repos, see scopes and permissions. Repos appear in the workspace wizard for cloning.
- **Companion** — an always-on-top monitor window mirroring live agent status (working / awaiting input / done / failed) with inline approve/deny. On macOS a native notch "dynamic island" variant exists (experimental).
- **Keyboard** — ⌘T launcher (new/recent/resume workspace) · ⌘N new agent · ⌘⇧N new agent in a new group · ⌘W close pane · ⌘⇧W close workspace · ⌘\ split (⌘⇧\ opposite axis) · ⌘E files · ⌘D diff · ⌘J shell · ⌘I details · ⌘B sidebar · ⌘1–9 jump to tab · ⌘[ / ⌘] prev/next tab · ⌘K palette · ⌘, settings · ⌘⇧L cycle theme · ⌘/ or ? shortcuts · ⌘⇧J companion. ⌘R is intentionally left free for webview reload.

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

> **macOS:** `make dev-signed` builds + codesigns the debug binary with a stable
> self-signed cert (`CODEHUB_DEV_IDENTITY`, default `codehub-dev`) so Keychain
> "Always Allow" survives rebuilds instead of re-prompting on every launch.
> Create the cert once via Keychain Access → Certificate Assistant (Code Signing,
> self-signed). Rerun to pick up Rust changes (no hot Rust reload).

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

- [ ] Multiple bind mounts per workspace (frontend ready; backend `lifecycle.rs` still uses a single `/workspace` bind)
- [ ] Auto-update via Tauri updater plugin
- [ ] App icon set
- [ ] Code-split the frontend bundle

Shipped since the first roadmap: per-container resource limits (`nano_cpus`/`memory` in `lifecycle.rs`), in-container `git clone` for GitHub repos, and native OS notifications on agent await/finish (`tauri-plugin-notification`).
