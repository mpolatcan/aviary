# CodeHub — Repository Guide for Claude

A Tauri 2 desktop app that runs multiple AI coding CLIs (Claude Code, Codex, Antigravity) in Docker containers, multiplexed via tmux. Each tab in the window = one tmux session = one agent. Each workspace gets its own container (`codehub-ws-<key>`) so the hub's fleet view reports REAL per-workspace cpu/mem/net/state.

This file is loaded on every Claude session in this repo. Keep it short and load-bearing.

## Behavioral rules

1. **Think before coding.** State assumptions explicitly. If multiple interpretations exist, present them — don't pick silently. If something is unclear, stop and ask. Push back when a simpler approach exists.
2. **Simplicity first.** Minimum code that solves the problem. No features beyond what was asked. No abstractions for single-use code. No speculative "flexibility". If 200 lines could be 50, rewrite it.
3. **Surgical changes.** Touch only what you must. Don't "improve" adjacent code, comments, or formatting. Match existing style. Remove imports/variables YOUR changes made unused — don't remove pre-existing dead code unless asked. Every changed line should trace to the user's request.
4. **Goal-driven execution.** Transform tasks into verifiable goals. For multi-step tasks, state a brief plan with checkpoints. Build → verify → iterate, not build-everything-then-check.

## Stack

- **Backend**: Rust 1.85+, Tauri 2, tokio, bollard (Docker API client), futures-util.
- **Frontend**: React 19 + TypeScript, Vite 5, Zustand 5 (state), Tailwind v4 + shadcn/Radix (Dialog + Popover) for chrome, xterm.js 5 (+ fit + canvas addons) for the terminal panes. xterm panes live OUTSIDE React in a non-reactive registry (`src/app/lib/panes.ts`) — `<PaneMount>` reparents the DOM node so buffers survive splits and tab switches.
- **Runtime image**: Debian-based `node:20-slim` base, `tail -f /dev/null` entrypoint, tmux server spawned on demand.
- **OS support**: macOS primary, Linux secondary, Windows untested.

## Repo layout

```
codehub/
  index.html                # React entry (#root) + SVG bird sprite
  src/                      # Frontend
    terminal.ts             # xterm.js pane factory + theme (framework-agnostic)
    vite-env.d.ts
    app/                    # React app
      main.tsx              # StrictMode render; imports fonts.css, theme.css, panes.css
      App.tsx               # Layout shell; wires lifecycle + keyboard shortcuts
      fonts.css             # @font-face: self-hosted JetBrainsMono Terminal WOFF2
                            #   (files in public/fonts/)
      theme.css             # Tailwind @import + @theme token bridge
      tokens.css            # Design tokens: 3 themes (dark/gray/light), status
                            #   colors, agent accents, shadcn bridge, helper classes
      panes.css             # Structural CSS (splits, panes, rail, tabs, launcher)
      screens/              # Full-page views (13 files):
                            #   Dashboard, Settings, Welcome, NewWorkspace,
                            #   SessionDetail, AgentDetail, Integrations (Settings
                            #   sub-pane), Companion, EmptyState, Resume,
                            #   SpawnDialog, LiveActivities, States.
                            #   (Usage = sidebar view rendered inside Dashboard,
                            #   not its own file)
      components/           # Top-level shared: Grid, PaneHead, PaneMount, PaneFoot,
                            #   SpawnModal, SpawnPane, spawn-form, LoginTerminalDialog,
                            #   ApiKeyDialog, AboutDialog. Plus three subdirectories:
                            #   hub/ — HubSidebar, HubTabs, HubStatusBar, DiffViewer,
                            #     DiffBody, FilesBrowser, ActionBar, CommandPalette,
                            #     Shortcuts, GroupsBar, WorkspaceBar, RuntimeBanner,
                            #     ShellPanel, … (hub chrome only)
                            #   primitives/ — AgentGlyph, StatusDot, StatusBadge,
                            #     CompanionAvatar, Character, Logo, Tag, Segmented,
                            #     icons, IconBtn, Spark, MetricStat, ContextGauge
                            #   ui/ — shadcn primitives (Button, Dialog, Popover, etc.)
      hooks/                # useKeyboard, useContainerStatus, useContainerStatsPoll,
                            #   useSessionUsage (+useCodexUsage), useBurnRate,
                            #   useActivityPoll, useAgentEvents, useGitStatusPoll
      lib/                  # store.ts (Zustand main), overlay.ts (Zustand panels/
                            #   modals/grid), panes.ts (registry), tree.ts (split
                            #   layout), catalog.ts (CLIS/MODES), launcher.ts,
                            #   ipc.ts (typed Tauri boundary), bridge.ts (browser-mode
                            #   transport: Tauri IPC vs dev-server REST/WS),
                            #   theme.ts (dark/gray/light toggle + persistence),
                            #   activity.ts (deriveLiveStatus — shared live status),
                            #   pty-output.ts + block-glyph-overlay.ts (terminal
                            #   render: ANSI normalize + U+2580-U+259F block overlay)
  src-tauri/                # Rust backend (workspace ROOT = the app crate)
    Cargo.toml              # [workspace] root + app package `codehub`
    tauri.conf.json
    capabilities/default.json
    devserver/              # Dev-bridge bin crate (workspace member, NOT bundled)
      Cargo.toml            #   pkg `codehub-devserver`; deps on `codehub` w/ feature
      src/main.rs           #   thin entry → codehub_lib::devserver::serve()
    src/
      main.rs               # Tiny entry, calls codehub_lib::run()
      lib.rs                # Tauri commands + setup hook
      manager.rs            # LifecycleManager — per-workspace container
                            #   resolution (codehub-ws-<key>); fleet listing
      lifecycle.rs          # Image pull, container create/start/stop
      docker.rs             # tmux session ops + exec attach
      pty.rs                # PtyRegistry — pane stream pumps (PaneEmitter trait)
      events.rs             # Agent-event hook tailer: one bollard-exec tailer per
                            #   running container, dedup replay cursor, EventsTracker
      activity.rs           # Activity ring buffer + pending-prompt tracking
      config.rs             # Settings / agent-config persistence store
      island.rs             # macOS Dynamic Island companion (objc2/AppKit NSPanel)
      types.rs              # Shared IPC types
      devserver.rs          # Dev-only HTTP/WS bridge logic (feature `devserver`)
  runtime/
    Dockerfile              # Runtime image (CLIs + tmux)
    README.md               # Build + publish instructions
  design/                   # Design canvas (JSX reference screens, not imported)
  .claude/skills/           # Workflow skills (see below)
  TEST_SCENARIOS.md         # Manual verification matrix
```

## How sessions work end-to-end

1. User opens the new-tab Popover (or ⌘T / a split control → Launcher Dialog) → picks CLI × mode → store `newPlate`/`splitSession` → `invoke("create_session", { name, cli, mode, workspace })` → backend resolves the target container via `LifecycleManager` (ensuring `codehub-ws-<key>` exists) → `docker.create_tmux_session` → `docker exec codehub-ws-<key> tmux -S /tmp/codehub new-session -d -s <name> <cli-binary>`.
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
make dev-signed                                       # like `make dev` but codesigns the debug binary with a
                                                     #   stable self-signed cert (CODEHUB_DEV_IDENTITY, default
                                                     #   codehub-dev). Was needed so macOS Keychain "Always
                                                     #   Allow" persisted across rebuilds — now MOOT: the
                                                     #   credential vault is an encrypted file (vault.rs), the
                                                     #   app makes NO keychain access, so plain `make dev`
                                                     #   never prompts. Kept for future signed-build needs.
                                                     #   Rerun to pick up Rust changes (no hot Rust reload).
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
| `CODEHUB_IMAGE` | Image tag | `ghcr.io/mpolatcan/codehub-runtime:0.1.3` |
| `CODEHUB_NETWORK_MODE` | Docker network mode | `bridge` |
| `CLAUDE_CODE_OAUTH_TOKEN` | Skip /login in Claude Code | unset |

## Conventions

- **Don't add dependencies casually.** Each Rust crate or npm package counts as a cold-start cost.
- **Frontend state is a single Zustand store** in `src/app/lib/store.ts` (workspaces, session metadata, container status). Two satellite stores exist: `lib/overlay.ts` (docked panels, modals, grid drag state) and `lib/launcher.ts` (spawn modal context). Don't reach for Redux/Context — extend the existing stores.
- **xterm panes are never disposed except by `closeSession`.** They live in the `lib/panes.ts` registry and get reparented by `<PaneMount>`; disposing on unmount would wipe scrollback on every split/tab-switch.
- **Tauri commands return `Result<T, String>`.** Coerce backend errors with `.map_err(|e| e.to_string())`. Don't leak typed errors across the IPC boundary.
- **Three themes: dark (default), gray, light.** Tokens live in `tokens.css` (`--bg-*`, `--fg-*`, `--live`, `--wait`, etc.), bridged to Tailwind in `theme.css`. Theme is toggled via `lib/theme.ts` (localStorage-persisted, `<html>` class swap). Never inline raw hex values; use tokens.
- **Full-page views live in `screens/`** (13 files). For the frontend map, start at `store.ts` (state) + `App.tsx` (routing). The screens directory is the equivalent of a router — `App.tsx` conditionally renders each based on `view` state. Sidebar nav: Hub, Dashboard, Workspaces, Usage, Settings (Integrations lives inside Settings, not as a top-level view).
- **CTA naming convention**: "New agent" / "Add agent" always opens the spawn dialog (`useLauncher.open`, ⌘N). "New workspace" / "Open workspace" opens the **launcher overlay** (`overlay.setLauncher`, ⌘T / the tab-bar "+" / sidebar "+") — the Welcome content (recent / resume / Blank-wizard / GitHub) rendered above the hub so a workspace can be opened or resumed without closing every tab; its "Blank workspace" card opens the 3-step wizard (`setNewWorkspace`). Never use "New workspace" for something that spawns an agent.
- **Keyboard shortcuts are a contract**: `useKeyboard.ts` is the single source of truth; the cheat sheet (`Shortcuts.tsx` `SHORTCUT_GROUPS`) and every on-screen `kbd`/title label MUST list ONLY real bindings and match it exactly (no aspirational rows). ⌘R is deliberately left UNbound so the webview reload works. Core: ⌘T launcher · ⌘N new agent · ⌘⇧N agent-in-new-group · ⌘\ split · ⌘W/⌘⇧W close pane/workspace · ⌘E/⌘D/⌘J/⌘B files/diff/shell/sidebar · ⌘1-9/⌘[/⌘] tabs · ⌘⇧L theme · ⌘⇧J companion (Rust-global).
- **Workspace close confirmation**: closing a workspace tab shows a `confirmCloseWorkspace` dialog ONLY when an agent is still working (idle workspaces close silently). Closing kills the sessions and **stops** the workspace container (`removeWorkspace` → `container_stop`, fire-and-forget, only when no remaining tab routes to it) so it stops leaking CPU/mem. The stopped container persists — reopening the same saved workspace reuses it (the `containerKey` is a stable readable slug, `codehub-ws-<name>-<savedWorkspaceId>`, not a random per-launch id), and `ensure_container` restarts it. Prune for good from the Workspaces view.
- **Bird silhouettes go in the SVG sprite** in `index.html`. Reference via `<use href="#bird-foo"/>`. Don't inline new SVGs per-tab.
- **CLIs are enumerated in four places** (kept deliberately in sync): `Cli` enum in `docker.rs`, `Cli` type in `src/app/lib/ipc.ts`, `CLIS` + `MODE_SUPPORT` in `src/app/lib/catalog.ts`, and the `RUN` line in `runtime/Dockerfile`. The `add-cli` skill walks the full update.
- **Never commit `Cargo.lock`** — wait, scratch that: do commit `Cargo.lock`. CodeHub is an application binary, not a library, so the lock is part of the build contract.
- **Don't commit `dist/`** — it's a Vite build artifact. `src-tauri/target/` and `node_modules/` are also gitignored.

## Gotchas / non-obvious things

- **The `make dev-web` Rust bridge (`codehub-devserver`) is a SEPARATELY compiled binary.** When it is already running and you edit a Rust struct that crosses IPC (e.g. `AgentConfig`, `Settings`), the live bridge keeps serving the OLD shape — serde silently drops unknown fields — so browser-mode verification shows stale/empty data even though the code is right. Rebuild + restart the bridge (`cargo run -p codehub-devserver` recompiles on launch) after any backend struct change before trusting a `make dev-web` check.
- **SPA hash routes (`#/companion`, dev `#/__states` etc.) need a FULL page reload to switch.** `src/app/main.tsx` reads `window.location.hash` exactly once at module load to pick the root. Navigating via Playwright `goto …#/companion` (or any in-page hash change) does NOT re-render — you keep seeing the previous view. Force `window.location.reload()` after setting the hash when driving these routes for visual checks.
- **The app crate (`src-tauri/Cargo.toml`) must have exactly ONE binary, and the dev bridge lives in a separate workspace member (`src-tauri/devserver/`).** Tauri's bundler enumerates *every* bin target of the package being built — both `[[bin]]` entries AND every file under `src/bin/` — and tries to copy each into the bundle, **ignoring `required-features`**. A feature-gated dev bin inside the app package therefore breaks `tauri build` ("Failed to copy binary … `release/devserver` does not exist"), even though it's never compiled. So the bridge is its own crate, run with `cargo run -p codehub-devserver` (no `--features` flag — the member enables the `devserver` feature on its `codehub` path-dep). Don't add a second `[[bin]]` or any `src/bin/*.rs` to the app crate; add a workspace member instead. (This bit us on the v0.1.1 release — v0.1.0 shipped fine because it had a single binary.)
- **`tauri::generate_context!` macro reads `tauri.conf.json` at compile time** and validates icon paths + `frontendDist`. If `dist/` is missing, `cargo check` fails with a proc-macro panic. Either run `npm run build` once, or keep the gitignored placeholder. Avoid this trap when running CI.
- **Bollard `create_exec` requires explicit type annotation** in our codebase: `create_exec::<String>(...)`. Without it the compiler cannot infer `T: Into<String>`.
- **`SHELL ["bash", "-euo", "pipefail", "-c"]` is set in the runtime Dockerfile.** This matters because we use `curl ... | bash` patterns to install CLIs; without pipefail, a failing curl silently succeeds and the CLI is missing from the image. Do not remove it.
- **macOS Docker Desktop "host network" is gated behind a beta flag.** We default `CODEHUB_NETWORK_MODE=bridge` to keep things portable. Override to `host` only if the user has Docker Desktop 4.34+ with the beta enabled.
- **Every container's entrypoint is `tail -f /dev/null`.** It does NOT launch tmux. The tmux server is started by the first `docker exec ... tmux new-session ...` call, per container. Sessions share `TMUX_TMPDIR=/tmp/codehub` *within a container*; with per-workspace containers (default) each workspace runs its OWN tmux server, so `tmux ls` only lists that workspace's sessions — verify lifecycle (S3/S5/S7/S8) against the specific `codehub-ws-<key>` container, not globally. A container persists running-but-empty after its last tab closes (lifecycle is decoupled from sessions; prune via the Workspaces inspector).
- **The in-pane tmux status bar is themed via `runtime/tmux.conf`** (COPYed to `/root/.tmux.conf`, loaded on tmux server start). It restyles tmux's default green to CodeHub's palette (`bg=#171b22` panel, neutral `#ecedf0` wordmark) so the bar reads as app chrome. Changing it needs an image rebuild (`make image`); to preview on a live container without a rebuild: `docker cp runtime/tmux.conf <container>:/root/.tmux.conf && docker exec -e TMUX_TMPDIR=/tmp/codehub <container> tmux source-file /root/.tmux.conf` (replace `<container>` with the workspace container name, e.g. `codehub-ws-...`). Keep the hexes in sync with the design tokens in `tokens.css` (`--bg-*`/`--fg-*`); xterm's own ANSI palette mirrors the same tokens in `src/terminal.ts` (sRGB conversions of the oklch accents).
- **The webview drag region** is set via `-webkit-app-region: drag` on the masthead and tabbar (React sets it through the `WebkitAppRegion` style prop). Buttons inside those regions must reset with `WebkitAppRegion: "no-drag"` or clicks get captured by window-drag.
- **Antigravity install URL is unverified** (`antigravity.google/cli/install.sh` returned an SSL self-signed cert chain error during build). The line is commented out in `runtime/Dockerfile`, and `catalog.ts` `MODE_SUPPORT` caps Antigravity to Standard only. Until confirmed, selecting Antigravity spawns a tmux session that exits immediately.
- **xterm panes mount via `absolute inset-0`, never flexbox.** `.pane-body` is `position:relative; flex:1` but NOT `display:flex`; a `flex-1` slot collapses to height 0 and the absolutely-positioned `.term-surface` renders blank. `<PaneMount>` fills the slot with `absolute inset-0` + a `ResizeObserver` that re-fits on resize (there is no window-level resize handler — the observer is it).
- **xterm panes use the canvas renderer (`@xterm/addon-canvas`), not `@xterm/addon-webgl` or the DOM renderer** (`src/terminal.ts`). WKWebView's WebGL glyph atlas can clip U+2580-U+259F block glyphs into thin horizontal strokes, while xterm's DOM renderer can show the same corruption if block glyphs fall back to a different font. Keep `customGlyphs: true` with the canvas addon and keep the self-hosted WOFF2 `JetBrainsMono Terminal` face for the whole terminal. Gate `createPane` on `MONO_READY` (`document.fonts.load('600 13px "JetBrainsMono Terminal"')`) so xterm measures cells against the real terminal font, not a fallback. The key tmux detail is in `docker.rs::attach_exec`: use `tmux -u attach-session` and set `LANG=C.UTF-8`/`LC_ALL=C.UTF-8`. Without `-u`, tmux downgraded Claude's stored UTF-8 block art to `_`/ASCII-like cells before xterm ever saw it. Terminal output is still normalized in `src-tauri/src/pty_output.rs` and `src/app/lib/pty-output.ts` to rewrite Claude's `48;5;16` background to `49`, but U+2580-U+259F block elements must pass through unchanged. For rendering stability, every pane write goes through a single xterm write queue, fits are debounced to one `requestAnimationFrame`, `pty_resize` is deduped by cols/rows, and the terminal host owns clipping/containment (`.term-surface` / `.login-term-surface`). Don't reintroduce direct `term.write(...)`, immediate `fit.fit()` from `ResizeObserver`, or extra scroll containers around xterm.
- **The frontend has NO React error boundary** — a single uncaught render throw unmounts the WHOLE tree (blank window, looks like a native "crash"). This bit us via `SessionRow` (`HubSidebar.tsx`): a `if (!meta) return null` guard sat ABOVE its `useSessionUsage` hook, so closing a pane (which deletes `sessionMeta[session]` → row re-renders with `meta` undefined → early return → fewer hooks) threw "Rendered fewer hooks than expected" and blanked the app. Rule: in any component that early-returns on missing session/meta, ALL hooks (incl. `useSessionUsage`) MUST run above the guard — `SessionDetail.tsx` and `SessionRow` both do this now; mirror it. Surfaced only in a real webview, not `make dev-web`-via-Chrome inference — read the console (`playwright-cli console`) to catch it.
- **Global keyboard shortcuts (`useKeyboard`) attach at the capture phase** so they beat xterm's textarea handler. Don't switch to bubble phase, and don't blanket-skip on `TEXTAREA` — xterm's helper IS a textarea, so the rename-input guard keys off the `.pane-name-input` class instead.
- **Spawn background tasks in the Tauri `setup` hook with `tauri::async_runtime::spawn`, NOT `tokio::spawn`.** `setup` runs on the main thread with no entered tokio runtime, so a bare `tokio::spawn` panics (`there is no reactor running`) — and because it unwinds across the Obj-C `did_finish_launching` boundary, the process *aborts* instead of erroring. Code shared with the dev bridge (which runs under `#[tokio::main]`, where `tokio::spawn` is valid) must not bake in the spawner: expose the loop as a plain `async fn` and let each caller spawn on its own runtime (see `events::event_tailer_loop` + its two call sites). This shipped as a latent startup crash because the subsystem had only ever run via `make dev-web`, never a real Tauri launch.
- **The agent-event tailer (`events.rs`) keys strictly by container ID, never name.** Agents append JSON lines to `/tmp/codehub/events/<session>.jsonl` (container-LOCAL, NOT mounted — that's why per-workspace containers each need their own tailer). The reconciler runs one bollard-exec `tail` per running container, re-scanning every 5s, and a per-container/per-session replay cursor de-dups the full-file replays that `tail -n +1 -F` re-emits on every (re)attach. Key the cursor by container **ID** (not name): a recreate (new id, fresh `/tmp`) then drops the stale cursor instead of suppressing fresh events, and an old tailer can't exec into a same-name replacement. Don't reintroduce a name fallback — it replays from line 1 on the first id flip (this regressed four times; see PR #64).
- **`tmux new-session -e VAR` (name-only) is a NO-OP — tmux only imports a var from `-e VAR=VALUE`.** A bare `-e VAR` does NOT pull the value from the exec's environment; the session var is simply never set. This silently broke account-credential delivery: `create_session` forwarded the secret in the bollard-exec env and pushed `-e CODEHUB_VAULT_x` (name only), so the launch wrapper's `${SRC}` was always empty → no `auth.json` written, no key exported → the CLI launched unauthenticated (Codex showed onboarding). Fix in `docker.rs create_tmux_session`: push the full `VAR=VALUE` assignment (looked up from `account_env`); env-backed profiles source the value via `std::env::var` in `create_session`. The value then lives in the container's tmux session env (the sandbox boundary). Claude-bundle and Codex instead use a pre-exec (`restore_claude_bundle_from_env` / `restore_codex_auth_from_env`) that writes the credential file with the secret passed through the exec env (never argv/session-env) and launch the CLI plainly (`account_var` stays `None`).
- **The vault stores a one-time credential SNAPSHOT; OAuth tokens refresh in-container and drift to 401 unless written back.** Login captures a point-in-time bundle (Claude: tar of `~/.claude`; Codex: `auth.json`) into the vault — an **encrypted file** (XChaCha20-Poly1305) under the app-data dir (`vault.bin` + a 0600 `vault.key`), NOT the OS keychain; see `vault.rs`. (The keychain was dropped because an unsigned/ad-hoc open-source build has no stable code signature, so its ACL re-prompted on every launch.) Each launch restores the snapshot. The CLI refreshes the short-lived access token *in place*, but that refresh is discarded next launch — so the vault's tokens freeze at login and eventually 401 once the refresh token ages out, forcing manual re-login. `auth::credential_sync_loop` (single global task spawned in the Tauri `setup`, Tauri-only — the dev bridge has no vault) closes this: every 10 min it stats each profile's on-disk credential, and on a fingerprint change (the CLI just refreshed) re-captures and `vault.store`s it. Claude is per-profile (`/config/claude-profiles/<env>/.credentials.json`); Codex shares one `/config/codex/auth.json` per container, attributed back to a profile by ChatGPT `account_id`.
- **The Claude vault bundle MUST stay small — it's delivered to the restore as a single ENV VAR (Linux `MAX_ARG_STRLEN` = 128 KiB).** `capture_claude_bundle_at` tars an ALLOWLIST — `.credentials.json` + `.claude.json` + `settings.json` only — NOT the whole config dir. A denylist (`--exclude` projects/sessions/cache/…) once let `plugins/` bloat the bundle to ~3 MB; `restore_claude_bundle_from_env` passes it via `account_env` → the in-container `execve` rejects the oversized env string (`argument list too long`) → restore silently fails → Claude launches LOGGED OUT (no `.credentials.json`, no `oauthAccount`). The three files stay ~10–30 KB. If `.claude.json` ever bloats past the cap, switch restore to stdin; until then keep the allowlist. (Recovery without re-login: extract the 3 files from the bloated bundle, re-tar, re-`vault.store`.)
- **Codex (0.135) REWRITES `$CODEX_HOME/config.toml` on first run (trust + tui nux) and DROPS any baked `[[hooks.*]]`/`notify`** — so seeding hooks into config.toml silently vanishes and the hub sees zero Codex activity. Deliver Codex's agent-event hooks as launch-time `-c` overrides on the argv instead (`CODEX_HOOK_ARGS` in `docker.rs`, spliced in by `launch_argv`): `-c` rides the argv (execed directly, clobber-immune, applied every launch). Codex 0.135 also gates hooks behind a startup trust review, so pass `--dangerously-bypass-hook-trust` (the container is a vetted source). Codex's `notify` (turn-finish → `Stop`) is verified to fire and is exempt from trust; the structured `[[hooks.*]]` (UserPromptSubmit/PreToolUse/PostToolUse/PermissionRequest/SessionStart) are interactive-session-only — `codex exec` does NOT run them, so they can't be verified headlessly. The `codehub-hook` append script is image-baked, so this is a Rust-only fix (no image rebuild). Codex sandbox: the **container is the boundary**, so all Codex modes launch with `--sandbox danger-full-access` (`launch_argv`) — Codex's own OS sandbox (`workspace-write`/`read-only`) shells out to bubblewrap, which can't create a user namespace in Docker's VM (`bwrap: No permissions to create a new namespace`; installing bwrap won't help, the kernel forbids unprivileged userns) → every tool call fails AND a bwrap warning prints. `danger-full-access` runs tools directly, no bwrap. Approval policy is the only mode knob: Standard=`on-request` (asks per command → fires PermissionRequest → awaiting), Auto=`never` (autonomous), Yolo=`--yolo`. The `--dangerously-bypass-hook-trust` banner Codex prints each launch is EXPECTED — it confirms our baked hooks run without the interactive trust review.
- **"Awaiting / needs input" = a HARD block only, not idle.** `events.rs::ingest` maps to the awaiting state ONLY: Claude `Notification permission_prompt`, and the structured ask tools via `PreToolUse` (`is_ask_tool`: Claude `AskUserQuestion`, Codex `request_user_input`). It is cleared by `Stop`, `UserPromptSubmit`, and `PostToolUse`. Claude's `Notification idle_prompt` ("Claude is waiting for your input") fires after EVERY turn-end and is **idle, not awaiting** — mapping it to awaiting made every finished Claude session falsely read "needs input"; it now clears pending + settles idle. Both `pendingPrompts` AND `sessionStatus==="awaiting"` feed `deriveLiveStatus` (`lib/activity.ts`), so awaiting must set/clear BOTH. Fundamental limit: a plain-text question at turn-end is indistinguishable from "done" (no hook), so a Codex question in Default mode — where `request_user_input` is disabled — can't be detected and shows idle.
- **Codex rollouts live under `$CODEX_HOME` (`/config/codex/sessions/**`), NOT `~/.codex`.** `codex_usage`/`codex_sessions`/`codex_rate_limits`/`codex_session_usage` (`docker.rs`) read there — a `/root/.codex/sessions` path is a bug that silently returns empty (this regressed once). **Per-pane Codex telemetry** (the pane-FOOTER `PaneFoot` ctx-gauge/turn/tok strip — moved off the pane head; `edits` dropped) needs a per-session key: Claude pins `--session-id` (→ `activity.claude_id`); Codex generates its own rollout uuid, captured via the **notify `thread-id`** — codex's `notify` fires `codehub-hook` with a JSON arg `{"type":"agent-turn-complete","thread-id":"<uuid>",...}`; the hook emits it as `codex_thread_id`, `events.rs` stores it as `activity.codex_id`, and `codex_session_usage(id)` globs the one `rollout-*<uuid>.jsonl`. Frontend mirrors Claude: `useCodexUsage(activity.codexId)` in `PaneFoot`/`HubSidebar` (both usage hooks run unconditionally — never `??`-gate a hook call). This needs the image-baked `codehub-hook` change, so it requires `make image` + recreating Codex containers, not just an app rebuild.
- **Claude writes each session's transcript to a project dir SLUGGED FROM THE AGENT'S CWD** (`/workspace/foo` → `~/.claude/projects/-workspace-foo/<id>.jsonl`), NOT a fixed `-workspace` dir. So `claude_session_usage` (the per-pane token tally feeding `PaneFoot`/`HubSidebar`) must glob the id under ANY project dir (`*/projects/*/<id>.jsonl`) — a hardcoded `…/projects/-workspace/<id>.jsonl` path silently returns 0 turns for any agent pinned to a sub-dir (the per-agent-cwd / multi-repo-mount feature), so the footer + sidebar show `tok 0` despite a live conversation (green unit tests, dead UI; regressed when per-agent cwd landed). The id is a unique uuid → globbing across project dirs can't collide. Related: `SessionMeta.cwd` (the agent's launch dir, also shown in the sidebar/footer) is **in-memory only** — like `claudeId` and pane color, an adopted/restored session loses it and falls back to the workspace mount dir.
- **Codex 0.135 rollout JSONL is ENVELOPED — every line is `{"type":"event_msg","payload":{"type":<kind>,…}}`, NOT flat.** All rollout parsers in `docker.rs` (`parse_codex_usage`/`parse_codex_sessions`/`codex_session_usage_from_raw`/`extract_codex_rate_limits` + `codex_acc_common`) key off the top-level `type=="event_msg"` + `payload.type` (`token_count`/`task_started`/`task_complete`/`user_message`), and token fields are `*_tokens` (`input_tokens`, not `input`). The session id is written ONCE per file in the `session_meta` line's `payload.id` (older Codex stamped every line with `session_id`) — carry it forward (`codex_line_sid`). Context window = `task_started.model_context_window`; rate-limit `resets_at` is an epoch NUMBER (not a string). Parsing the old flat shape silently returns all-zeros — GREEN unit tests but DEAD UI — so keep the test fixtures in the enveloped shape. (Claude's per-pane context-window gauge has no transcript field → mapped by model family in `claude_context_window`: opus-4.x/sonnet-4.x → 1M, haiku → 200K, else em-dash.)
- **`ActivityTracker` hook setters (`set_status`/`on_*`) MUST create the entry (`or_default`), never no-op on an unregistered session.** On app restart the `events.rs` tailer replays a session's events (and advances its per-session replay cursor) BEFORE the pane re-attaches and calls `register()`. A `get_mut` no-op there drops the hook AND the cursor moves past it, so `seen_hooks` never gets set → `deriveLiveStatus` falls back to the byte-flow signal → an idle Claude reads "working" on every TUI redraw (a scroll, or the SIGWINCH from opening files/shell/diff). A fired hook proves the session is live; a stale entry for a closed session is harmless (rows render from the workspace tree, never from this map). `SessionStart` is handled in `ingest` precisely so an unprompted session is hook-aware + idle, not byte-flow-working.

## Frontend work

**ALWAYS use shadcn/ui components for controls — never hand-roll inline-styled buttons, toggles, selects, menus, inputs, etc.** Every control with a shadcn equivalent (`src/app/ui/`) MUST use it; add the primitive if missing. Inline styles are for layout only and for domain primitives with no shadcn equivalent (StatusDot, Spark, AgentGlyph, …). Full mapping + nuances in the rules file below.

Frontend design, skills, and token rules live in their own file:

@.claude/rules/frontend.md

## Testing posture

Testing + visual-verification rules live in their own file, imported here:

@.claude/rules/testing.md

Short version: no automated IPC suite — run `TEST_SCENARIOS.md` before a release (guard S3/S5/S7/S8); any UI change MUST be visually verified via `make dev-web` + Playwright, never inference.

## When in doubt

- Prefer reading `src-tauri/src/lib.rs` first for the backend — it lists every Tauri command and is the cleanest map of how the app is glued together. For the frontend, `src/app/lib/store.ts` is the equivalent map (every state mutation + the IPC calls each one fires).
- If a backend change requires a new IPC command, it now has a **four-point sync** (the dev bridge mirrors the IPC surface): the `tauri::generate_handler![...]` list in `lib.rs:run()`, the typed `ipc` object in `src/app/lib/ipc.ts`, a REST route in `src-tauri/src/devserver.rs`, and its command→REST mapping in `src/app/lib/bridge.ts`. Skip the last two only if you never need browser-mode (`make dev-web`).
- If a frontend file fails to type-check after a CSS import, ensure `src/vite-env.d.ts` declares the module.
