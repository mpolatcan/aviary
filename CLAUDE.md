# Aviary — Repository Guide for Claude

A Tauri 2 desktop app that runs multiple AI coding CLIs (Claude Code, Codex, Antigravity) inside one Docker container, multiplexed via tmux. Each tab in the window = one tmux session = one agent.

This file is loaded on every Claude session in this repo. Keep it short and load-bearing.

## Stack

- **Backend**: Rust 1.85+, Tauri 2, tokio, bollard (Docker API client), futures-util.
- **Frontend**: TypeScript, Vite 5, xterm.js 5 (+ fit + webgl addons). No UI framework — vanilla DOM.
- **Runtime image**: Debian-based `node:20-slim` base, `tail -f /dev/null` entrypoint, tmux server spawned on demand.
- **OS support**: macOS primary, Linux secondary, Windows untested.

## Repo layout

```
aviary/
  index.html                # Aviary chrome + SVG sprite (birds + cage)
  src/                      # Frontend
    main.ts                 # Tab manager, modal, lifecycle wiring, masthead
    terminal.ts             # xterm.js pane factory + theme
    style.css               # Field-journal design tokens + components
    vite-env.d.ts
  src-tauri/                # Rust backend
    Cargo.toml
    tauri.conf.json
    capabilities/default.json
    src/
      main.rs               # Tiny entry, calls aviary_lib::run()
      lib.rs                # Tauri commands + setup hook
      lifecycle.rs          # Image pull, container create/start/stop
      docker.rs             # tmux session ops + exec attach
      pty.rs                # PtyRegistry — pane stream pumps
  runtime/
    Dockerfile              # Runtime image (CLIs + tmux)
    README.md               # Build + publish instructions
  .claude/skills/           # Workflow skills (see below)
  TEST_SCENARIOS.md         # Manual verification matrix
```

## How sessions work end-to-end

1. User clicks `+` → modal picks CLI → `invoke("create_session", { name, cli })` → backend `docker.create_tmux_session` → `docker exec aviary-runtime tmux -S /tmp/aviary new-session -d -s <name> <cli-binary>`.
2. `invoke("attach_session", { name, cols, rows })` → backend `docker.attach_exec` opens a bollard exec with `tty=true` running `tmux attach -t <name>` → returns a `pane_id`.
3. Backend spawns two tokio tasks per pane: output pump (bollard stream → `pty://data/<pane_id>` event) and input pump (mpsc channel → bollard stdin).
4. Frontend `xterm.term.onData` → `invoke("pty_write", ...)`, `term.onResize` → `invoke("pty_resize", ...)`.
5. Closing a tab calls `kill_session(name)` BEFORE `detach_session(pane_id)`. `kill_session` also calls `registry.detach_by_session(name)` to drop bookkeeping before tmux kill so no resize/write can resurrect a dying pane.

## Local dev

```bash
# One-time
source ~/.cargo/env                                 # cargo on PATH (also in ~/.zshrc)
docker build -t mutlupolatcan/aviary-runtime:0.1.0 runtime/
npm install

# Day-to-day
npm run tauri dev                                   # Vite + Tauri, hot-reloads frontend
cargo check --manifest-path src-tauri/Cargo.toml    # Backend type-check only
```

Environment knobs:

| Env var | Purpose | Default |
|---|---|---|
| `AVIARY_CONTAINER` | Container name | `aviary-runtime` |
| `AVIARY_IMAGE` | Image tag | `mutlupolatcan/aviary-runtime:0.1.0` |
| `AVIARY_NETWORK_MODE` | Docker network mode | `bridge` |
| `CLAUDE_CODE_OAUTH_TOKEN` | Skip /login in Claude Code | unset |

## Conventions

- **Don't add dependencies casually.** Each Rust crate or npm package counts as a cold-start cost.
- **Frontend state is plain Maps in `main.ts`.** No store library, no framework. If state ever needs reactivity beyond Maps, propose a switch — don't quietly import one.
- **Tauri commands return `Result<T, String>`.** Coerce backend errors with `.map_err(|e| e.to_string())`. Don't leak typed errors across the IPC boundary.
- **Design tokens live in `:root` of `style.css`.** Never inline raw hex values; use the variables.
- **Bird silhouettes go in the SVG sprite** in `index.html`. Reference via `<use href="#bird-foo"/>`. Don't inline new SVGs per-tab.
- **CLIs are enumerated in three places** (kept deliberately in sync): `Cli` enum in `docker.rs`, `CLIS` array in `main.ts`, and the `RUN` line in `runtime/Dockerfile`. The `add-cli` skill walks the full update.
- **Never commit `Cargo.lock`** — wait, scratch that: do commit `Cargo.lock`. Aviary is an application binary, not a library, so the lock is part of the build contract.
- **Don't commit `dist/`** — it's a Vite build artifact. `src-tauri/target/` and `node_modules/` are also gitignored.

## Gotchas / non-obvious things

- **`tauri::generate_context!` macro reads `tauri.conf.json` at compile time** and validates icon paths + `frontendDist`. If `dist/` is missing, `cargo check` fails with a proc-macro panic. Either run `npm run build` once, or keep the gitignored placeholder. Avoid this trap when running CI.
- **Bollard `create_exec` requires explicit type annotation** in our codebase: `create_exec::<String>(...)`. Without it the compiler cannot infer `T: Into<String>`.
- **`SHELL ["bash", "-euo", "pipefail", "-c"]` is set in the runtime Dockerfile.** This matters because we use `curl ... | bash` patterns to install CLIs; without pipefail, a failing curl silently succeeds and the CLI is missing from the image. Do not remove it.
- **macOS Docker Desktop "host network" is gated behind a beta flag.** We default `AVIARY_NETWORK_MODE=bridge` to keep things portable. Override to `host` only if the user has Docker Desktop 4.34+ with the beta enabled.
- **The runtime container's entrypoint is `tail -f /dev/null`.** It does NOT launch tmux. The tmux server is started by the first `docker exec ... tmux new-session ...` call. Sessions share `TMUX_TMPDIR=/tmp/aviary`.
- **The webview drag region** is set via `-webkit-app-region: drag` on `#masthead` and `#tabbar`. Buttons inside those regions must reset with `-webkit-app-region: no-drag` or clicks will be captured by window-drag.
- **Antigravity install URL is unverified** (`antigravity.google/cli/install.sh` returned an SSL self-signed cert chain error during build). The line is commented out in `runtime/Dockerfile`. Until confirmed, selecting Antigravity in the CLI modal spawns a tmux session that exits immediately.

## Testing posture

There is no automated IPC test suite yet. Manual regression matrix lives in `TEST_SCENARIOS.md` — run it before any release cut, paying special attention to the close-tab → tmux-kill flow (S3, S5, S7, S8) which previously regressed.

## When in doubt

- Prefer reading `src-tauri/src/lib.rs` first — it lists every Tauri command and is the cleanest map of how the app is glued together.
- If a backend change requires a new IPC command, also add it to the `tauri::generate_handler![...]` list in `lib.rs:run()`.
- If a frontend file fails to type-check after a CSS import, ensure `src/vite-env.d.ts` declares the module.
