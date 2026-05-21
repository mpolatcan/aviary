# Aviary — Repository Guide for Claude

A Tauri 2 desktop app that runs multiple AI coding CLIs (Claude Code, Codex, Antigravity) inside one Docker container, multiplexed via tmux. Each tab in the window = one tmux session = one agent.

This file is loaded on every Claude session in this repo. Keep it short and load-bearing.

## Stack

- **Backend**: Rust 1.85+, Tauri 2, tokio, bollard (Docker API client), futures-util.
- **Frontend**: React 19 + TypeScript, Vite 5, Zustand 5 (state), Tailwind v4 + shadcn/Radix (Dialog + Popover) for chrome, xterm.js 5 (+ fit + webgl addons) for the terminal panes. xterm panes live OUTSIDE React in a non-reactive registry (`src/app/lib/panes.ts`) — `<PaneMount>` reparents the DOM node so buffers survive splits and tab switches.
- **Runtime image**: Debian-based `node:20-slim` base, `tail -f /dev/null` entrypoint, tmux server spawned on demand.
- **OS support**: macOS primary, Linux secondary, Windows untested.

## Repo layout

```
aviary/
  index.html                # React entry (#root) + SVG bird sprite
  src/                      # Frontend
    terminal.ts             # xterm.js pane factory + theme (framework-agnostic)
    vite-env.d.ts
    app/                    # React app
      main.tsx              # StrictMode render; imports theme.css then panes.css
      App.tsx               # Layout shell; wires lifecycle + keyboard shortcuts
      theme.css             # Tailwind @import + @theme token bridge
      panes.css             # Structural CSS (splits, panes, rail, tabs, launcher)
      components/           # Masthead, TabBar, Rail, Grid, PaneHead, PaneMount,
                            #   LauncherDialog, NewTabPopover, LauncherBody, ui/
      hooks/                # useKeyboard (global shortcuts), useContainerStatus
      lib/                  # store.ts (Zustand), panes.ts (registry), tree.ts
                            #   (split layout), catalog.ts (CLIS/MODES), launcher.ts,
                            #   ipc.ts (typed Tauri boundary), bridge.ts (browser-mode
                            #   transport: Tauri IPC vs dev-server REST/WS)
  src-tauri/                # Rust backend
    Cargo.toml
    tauri.conf.json
    capabilities/default.json
    src/
      main.rs               # Tiny entry, calls aviary_lib::run()
      lib.rs                # Tauri commands + setup hook
      lifecycle.rs          # Image pull, container create/start/stop
      docker.rs             # tmux session ops + exec attach
      pty.rs                # PtyRegistry — pane stream pumps (PaneEmitter trait)
      devserver.rs          # Dev-only HTTP/WS bridge (feature `devserver`)
      bin/devserver.rs      # Bridge entrypoint binary (aviary-devserver)
  runtime/
    Dockerfile              # Runtime image (CLIs + tmux)
    README.md               # Build + publish instructions
  .claude/skills/           # Workflow skills (see below)
  TEST_SCENARIOS.md         # Manual verification matrix
```

## How sessions work end-to-end

1. User opens the new-tab Popover (or ⌘T / a split control → Launcher Dialog) → picks CLI × mode → store `newPlate`/`splitSession` → `invoke("create_session", { name, cli, mode })` → backend `docker.create_tmux_session` → `docker exec aviary-runtime tmux -S /tmp/aviary new-session -d -s <name> <cli-binary>`.
2. `invoke("attach_session", { name, cols, rows })` → backend `docker.attach_exec` opens a bollard exec with `tty=true` running `tmux attach -t <name>` → returns a `pane_id`.
3. Backend spawns two tokio tasks per pane: output pump (bollard stream → `pty://data/<pane_id>` event) and input pump (mpsc channel → bollard stdin).
4. Frontend `xterm.term.onData` → `invoke("pty_write", ...)`, `term.onResize` → `invoke("pty_resize", ...)`.
5. Closing a session (store `closeSession`, also reachable via ⌘W) calls `kill_session(name)` BEFORE `registry.destroyPane(name)` (which detaches the bollard exec). tmux is killed first so no resize/write can race a dying pane. This order regressed before — guard it (TEST_SCENARIOS S3/S5/S7/S8).

## Local dev

A `Makefile` at repo root is the canonical entry point. Run `make help` for the full list.

```bash
# One-time
source ~/.cargo/env                                 # cargo on PATH (also in ~/.zshrc)
make install                                         # npm deps; cargo fetches on first build
make image                                           # build runtime image at the tag pinned in lib.rs

# Day-to-day
make dev                                             # Vite + Tauri, hot-reloads frontend
make dev-web                                          # Vite + standalone backend bridge, NO Tauri window
                                                     #   → drive the UI in a plain browser at :1420 with a
                                                     #   live backend (visual review / playwright screenshots)
make check                                           # Full lint sweep (Biome + tsc + rustfmt + clippy)
make fix                                             # Apply all safe auto-fixes, then re-check
make image-verify                                    # Smoke-test installed CLIs in the runtime image
```

CI mirrors `make check` (see `.github/workflows/ci.yml`). Don't introduce checks locally that CI doesn't enforce, and vice versa.

Environment knobs:

| Env var | Purpose | Default |
|---|---|---|
| `AVIARY_CONTAINER` | Container name | `aviary-runtime` |
| `AVIARY_IMAGE` | Image tag | `ghcr.io/mpolatcan/aviary-runtime:0.1.0` |
| `AVIARY_NETWORK_MODE` | Docker network mode | `bridge` |
| `CLAUDE_CODE_OAUTH_TOKEN` | Skip /login in Claude Code | unset |

## Conventions

- **Don't add dependencies casually.** Each Rust crate or npm package counts as a cold-start cost.
- **Frontend state is a single Zustand store** in `src/app/lib/store.ts` (workspaces, session metadata, container status). The launcher has its own small store (`lib/launcher.ts`). Don't reach for Redux/Context — extend the store.
- **xterm panes are never disposed except by `closeSession`.** They live in the `lib/panes.ts` registry and get reparented by `<PaneMount>`; disposing on unmount would wipe scrollback on every split/tab-switch.
- **Tauri commands return `Result<T, String>`.** Coerce backend errors with `.map_err(|e| e.to_string())`. Don't leak typed errors across the IPC boundary.
- **Design tokens live in the `@theme` block of `theme.css`** (exposed as `--color-*` / `--font-*`). Never inline raw hex values; use the tokens (Tailwind utilities like `text-accent` or `var(--color-...)` in `panes.css`).
- **Bird silhouettes go in the SVG sprite** in `index.html`. Reference via `<use href="#bird-foo"/>`. Don't inline new SVGs per-tab.
- **CLIs are enumerated in four places** (kept deliberately in sync): `Cli` enum in `docker.rs`, `Cli` type in `src/app/lib/ipc.ts`, `CLIS` + `MODE_SUPPORT` in `src/app/lib/catalog.ts`, and the `RUN` line in `runtime/Dockerfile`. The `add-cli` skill walks the full update.
- **Never commit `Cargo.lock`** — wait, scratch that: do commit `Cargo.lock`. Aviary is an application binary, not a library, so the lock is part of the build contract.
- **Don't commit `dist/`** — it's a Vite build artifact. `src-tauri/target/` and `node_modules/` are also gitignored.

## Gotchas / non-obvious things

- **`src-tauri/Cargo.toml` pins `default-run = "aviary"`.** The dev bridge added a second binary (`aviary-devserver`); without `default-run`, the `cargo run` that `tauri dev` / `make dev` invoke can't pick a target and fails with "could not determine which binary to run". Keep the pin if you add more binaries.
- **`tauri::generate_context!` macro reads `tauri.conf.json` at compile time** and validates icon paths + `frontendDist`. If `dist/` is missing, `cargo check` fails with a proc-macro panic. Either run `npm run build` once, or keep the gitignored placeholder. Avoid this trap when running CI.
- **Bollard `create_exec` requires explicit type annotation** in our codebase: `create_exec::<String>(...)`. Without it the compiler cannot infer `T: Into<String>`.
- **`SHELL ["bash", "-euo", "pipefail", "-c"]` is set in the runtime Dockerfile.** This matters because we use `curl ... | bash` patterns to install CLIs; without pipefail, a failing curl silently succeeds and the CLI is missing from the image. Do not remove it.
- **macOS Docker Desktop "host network" is gated behind a beta flag.** We default `AVIARY_NETWORK_MODE=bridge` to keep things portable. Override to `host` only if the user has Docker Desktop 4.34+ with the beta enabled.
- **The runtime container's entrypoint is `tail -f /dev/null`.** It does NOT launch tmux. The tmux server is started by the first `docker exec ... tmux new-session ...` call. Sessions share `TMUX_TMPDIR=/tmp/aviary`.
- **The webview drag region** is set via `-webkit-app-region: drag` on the masthead and tabbar (React sets it through the `WebkitAppRegion` style prop). Buttons inside those regions must reset with `WebkitAppRegion: "no-drag"` or clicks get captured by window-drag.
- **Antigravity install URL is unverified** (`antigravity.google/cli/install.sh` returned an SSL self-signed cert chain error during build). The line is commented out in `runtime/Dockerfile`, and `catalog.ts` `MODE_SUPPORT` caps Antigravity to Standard only. Until confirmed, selecting Antigravity spawns a tmux session that exits immediately.
- **xterm panes mount via `absolute inset-0`, never flexbox.** `.pane-body` is `position:relative; flex:1` but NOT `display:flex`; a `flex-1` slot collapses to height 0 and the absolutely-positioned `.term-surface` renders blank. `<PaneMount>` fills the slot with `absolute inset-0` + a `ResizeObserver` that re-fits on resize (there is no window-level resize handler — the observer is it).
- **Global keyboard shortcuts (`useKeyboard`) attach at the capture phase** so they beat xterm's textarea handler. Don't switch to bubble phase, and don't blanket-skip on `TEXTAREA` — xterm's helper IS a textarea, so the rename-input guard keys off the `.pane-name-input` class instead.

## Testing posture

There is no automated IPC test suite yet. Manual regression matrix lives in `TEST_SCENARIOS.md` — run it before any release cut, paying special attention to the close-tab → tmux-kill flow (S3, S5, S7, S8) which previously regressed.

## When in doubt

- Prefer reading `src-tauri/src/lib.rs` first for the backend — it lists every Tauri command and is the cleanest map of how the app is glued together. For the frontend, `src/app/lib/store.ts` is the equivalent map (every state mutation + the IPC calls each one fires).
- If a backend change requires a new IPC command, it now has a **four-point sync** (the dev bridge mirrors the IPC surface): the `tauri::generate_handler![...]` list in `lib.rs:run()`, the typed `ipc` object in `src/app/lib/ipc.ts`, a REST route in `src-tauri/src/devserver.rs`, and its command→REST mapping in `src/app/lib/bridge.ts`. Skip the last two only if you never need browser-mode (`make dev-web`).
- If a frontend file fails to type-check after a CSS import, ensure `src/vite-env.d.ts` declares the module.
