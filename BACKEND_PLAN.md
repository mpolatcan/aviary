# CodeHub — Backend capability plan

Status: **planning** · Owner: TBD · Created 2026-05-22

The CodeHub design (handoff bundle) shows several screens — **Empty state**,
**Spawn dialog**, **Settings** — whose controls assume backend capabilities the
current Tauri/Rust side does not have. This document maps each design data need
to the concrete backend work required, so we can decide build order before
porting the screens (Phase 2+).

**Key-source decision (made):** API credentials live in **host environment
variables**, forwarded into the runtime container — matching today's model. We
do NOT introduce OS-keychain storage in v1. "Key status" checks only report
*presence*, never values.

---

## Current backend surface (as built)

IPC commands (`src-tauri/src/lib.rs`, typed in `src/app/lib/ipc.ts`):

| Command | Signature | Returns |
|---|---|---|
| `container_status` | `()` | `ContainerStatus { state }` — `missing\|stopped\|starting\|running\|unreachable` |
| `ensure_runtime` / `container_start` / `container_stop` / `container_restart` | container lifecycle | `()` |
| `list_sessions` | `()` | `SessionInfo[]` |
| `create_session` | `(name, cli, mode, alias)` | `()` |
| `kill_session` / `rename_session` | `(name[, alias])` | `()` |
| `attach_session` | `(name, cols, rows)` | `paneId` |
| `pty_write` / `pty_resize` / `detach_session` | pane I/O | `()` |

Events: `codehub://lifecycle`, `codehub://lifecycle-error`.
Types: `Cli = claude\|codex\|antigravity`, `Mode = standard\|auto\|yolo`.

Runtime model (`src-tauri/src/lifecycle.rs`):

- **One** shared runtime container (name + image from `CODEHUB_*` env, `AVIARY_*` fallback).
- Host `workspace_dir` bind-mounted at `/workspace` (RW), `working_dir=/workspace`.
- Env injected: `TMUX_TMPDIR=/tmp/codehub` and, if present on host, `CLAUDE_CODE_OAUTH_TOKEN`. **No OpenAI/Gemini keys are injected today.**
- Network mode from `CODEHUB_NETWORK_MODE` env.
- Sessions are tmux windows inside the one container; each runs `<cli>` in `<mode>`.

Config persistence: **none** — everything is env-only at process start.

---

## Gap analysis by design feature

Legend — Effort: S (<½ day) · M (½–2 days) · L (>2 days / architectural).
Decision: **v1** (build now) · **defer** · **drop** (out-of-scope per design CLAUDE.md).

| Design feature (screen) | Backed today? | Tier | Effort | Decision |
|---|---|---|---|---|
| Theme dark/light (Settings·Appearance) | client-only | 0 | S | **v1** |
| Stop all sessions (Settings·Danger) | via `kill_session` loop | 0 | S | **v1** |
| Shortcuts list / notification prefs | client-local | 0 | S | **v1** |
| Docker/host info: cores, RAM, daemon (Empty pill, Container settings) | no | 1 | S | **v1** |
| Installed CLI versions (Empty cards, Settings·Agents) | no | 1 | M | **v1** |
| Agent key status — present/missing (Empty checklist, Settings, Spawn gate) | partial (only Claude injected) | 1 | M | **v1** |
| Initial prompt on spawn (Spawn dialog) | no | 1 | M | **v1** |
| Prompt templates (Spawn) | client presets | 0 | S | **v1** |
| Persistent settings/config store (most of Settings) | no | 2 | M | **v1** |
| Workspace/repo set + recents (Spawn·Repository) | fixed mount only | 2 | M | **v1 (lighter) / defer (per-session)** |
| Multi-container + attach/reuse, Default/Heavy sizing (Spawn·Container) | no (single container) | 3 | L | **defer** |
| Accounts: multi-credential per agent + usage (Spawn·Account) | no | 3 | L | **defer** |
| Cost / usage / budgets (Settings, Spawn footer) | no | 3 | L | **defer** |
| Team / billing (Settings·Account) | no | 3 | L | **drop (out-of-scope v1)** |

---

## Proposed new IPC contracts (Tier 1 + 2)

> Names follow the existing `snake_case` command + camelCase arg convention.
> All commands return `Result<T, String>` on the Rust side (coerced via
> `.map_err(|e| e.to_string())`), surfaced as typed promises in `ipc.ts`.

### Tier 1 — additive reads + spawn arg

**`docker_info() -> DockerInfo`** — read-only; backs the Empty-state pill and
container settings. Implemented via bollard `Docker::info()` + `version()`.

```ts
interface DockerInfo {
  connected: boolean;
  daemonVersion: string;   // e.g. "25.0.3"
  cores: number;           // info.NCPU
  memTotalBytes: number;   // info.MemTotal
  socket: string;          // the endpoint we connected to
}
```
Risk: low (read-only). Degrades to `connected:false` when the daemon is down.

**`app_info() -> AppInfo`** **DONE** — `lifecycle::app_info()`; build + host
identity (name/version/os/arch/family) from `env!("CARGO_PKG_*")` +
`std::env::consts`. No I/O, never fails, no update check. Backs the Settings
**About** pane (version/OS/arch + Docker version via `docker_info` + agent
versions via `agent_versions`; absent reads render em-dash, nothing fabricated).

**`agent_versions() -> Record<Cli, AgentVersion>`** — backs agent cards/settings.
Execs `<cli> --version` inside the running container; caches per container start.

```ts
interface AgentVersion { installed: boolean; version: string | null }
```
Risk: med — requires a running container; return `installed:false` when absent or
the container isn't up. Do not block the UI on it (async, cache).

**`agent_key_status() -> Record<Cli, KeyStatus>`** — presence only, never values.

```ts
interface KeyStatus { present: boolean; source: "env"; varName: string }
```
Host env var per agent (authoritative mapping — also what `lifecycle` must inject):
| Cli | env var |
|---|---|
| claude | `CLAUDE_CODE_OAUTH_TOKEN` (fallback `ANTHROPIC_API_KEY`) |
| codex | `OPENAI_API_KEY` |
| antigravity | `GOOGLE_API_KEY` (fallback `GEMINI_API_KEY`) |

⚠️ **Security (Insider escalation — secrets):** this command must only ever read
`std::env::var(..).is_ok()` and return the boolean + the var *name*. Never return,
log, or trace the value. Add a unit test asserting the value never appears in the
serialized output.

**Sub-task — inject the other agents' keys.** Today `lifecycle` only forwards
`CLAUDE_CODE_OAUTH_TOKEN`. For Codex/Antigravity to actually run, extend the env
build to forward `OPENAI_API_KEY` / `GOOGLE_API_KEY` when present. Same place,
`lifecycle.rs` env vec.

**Initial prompt on spawn** — extend, backward-compatibly:

```
create_session(name, cli, mode, alias, initialPrompt?: string)
```
After the pane is live, `pty_write` the prompt followed by `\r`. Empty/absent →
current behavior. Templates are a client-side preset list (no backend).

### Tier 2 — config store + workspace

**Config store** — JSON at `app_data/config/settings.json`, env as fallback/override.

```ts
interface Config {
  defaultAgent: Cli;
  defaultMode: Mode;
  theme: "dark" | "light" | "system";
  networkMode: string;        // mirrors CODEHUB_NETWORK_MODE
  autoApproveSafe: boolean;
  workspaceDir: string;
  recentWorkspaces: string[];
}
get_config() -> Config
set_config(patch: Partial<Config>) -> Config   // shallow-merge + persist, returns full
```
Precedence: explicit env var > stored config > built-in default (document clearly;
keep the `AVIARY_*`/`CODEHUB_*` fallbacks honored as overrides).

**Workspace picker (lighter v1)** — set the single mounted dir + recents:

```
pick_workspace_dir() -> string | null     // tauri-plugin-dialog folder picker
```
Then persist via `set_config({ workspaceDir, recentWorkspaces })`. Changing it
requires recreating the container (it's the bind-mount source) — surface that as
a "restart runtime to apply" affordance. **Per-session repos** (different mount
per tab) need the Tier-3 multi-container work and are deferred.

### Tier 3 — deferred (architecture notes only, no contracts yet)

- **Multi-container / attach-reuse / sizing.** Replaces the single-container model
  with a registry: container per repo (or per session), resource limits
  (CPU/mem), attach to an existing one. Touches `lifecycle.rs` deeply + new
  status/stats commands (`docker.stats()`). Largest item; gate behind its own
  design pass.
- **Accounts** (multi-credential per agent + per-account usage). New auth concept;
  the product is single-user today. Revisit only if multi-account is a real need.
- **Cost / usage / budgets.** Requires per-turn token+cost capture from each CLI's
  output/telemetry, which is not uniformly exposed. Spike per-CLI feasibility first.
- **Team / billing.** Out-of-scope v1 per the design's own `CLAUDE.md`. Render as
  "Coming soon".
- **Container inspector live feeds (P4 Containers view).** The view renders the
  real shared runtime (name/state/image/id, docker version, attached sessions,
  the fixed `/workspace` mount, host-env credential presence). Remaining feeds:
  - ~~`container_stats`~~ **DONE** — `DockerClient::stats()` (bollard
    `docker.stats()`, one-shot `stream:false` so the CPU delta is valid). The
    Containers view polls it ~2s while mounted + running and fills the
    CPU/Memory/Net/Disk gauge cards; em-dash when down or before the first poll.
  - ~~`container_logs`~~ **DONE** — `DockerClient::logs(tail)` (bollard
    `docker.logs()`, one-shot tail of stdout+stderr, no timestamps, split into
    lines). The Containers view polls it ~4s while mounted + running and renders
    the tail in the "Container log" panel, auto-scrolled to newest; honest
    placeholder when down or before the first read. (Polling, not a
    `codehub://container-log` event stream — a stream is a later upgrade if the
    cadence proves too coarse.)
  - ~~Host side of the bind mount (the absolute host path behind `/workspace`)~~
    **DONE** — `DockerClient::mounts()` reads the running container's actual
    mounts via `docker inspect` (source/destination/rw/kind), so the Containers
    "Mounts" card shows the real host paths behind `/config` and `/workspace`
    rather than a hardcoded guess. Fetched once when the runtime comes up (mounts
    are fixed for the container's lifetime); falls back to the `/workspace`
    description with an em-dash host when down.
  - ~~`container_top` (processes)~~ **DONE** — `DockerClient::top()` (bollard
    `docker.top_processes()` = host `ps` against the container PID namespace, so
    no in-container `ps` is required). `parse_top` maps columns by title (robust
    across platform `ps` layouts; `CMD`/`COMMAND` falls back to the last column),
    unit-tested. The Containers view polls it ~3s while mounted + running and
    renders a PID/user/time/command table in the "Processes" card; honest
    placeholder when down or before the first read.
  - ~~`container_image` (image identity)~~ **DONE** — `DockerClient::image_info()`
    resolves the container's image ref via `inspect_container`, then
    `inspect_image` for tag/digest/created/size/arch/os → `ImageInfo` (all
    `Option`, em-dash when absent). Backs the Containers "Image" card; fetched
    once on the running transition (fixed for the container's lifetime).
  - ~~`container_health` (liveness)~~ **DONE** — `DockerClient::health()` reads
    `inspect_container`'s `State` → `RuntimeHealth{startedAt,restartCount,status,
    oomKilled}` (all `Option`; the zero `0001-01-01T00:00:00Z` start is dropped).
    Backs the Containers hero: `· up {age}` derived from `startedAt`, plus
    `· {n} restarts` and a red `· OOM-killed` flag when present. Fetched once on
    the running transition; uptime advances off the ~2s stats re-render.
  All container-inspector feeds are now real (status / stats / logs / mounts /
  processes / image / health). Multi-container (Tier-3) is the only remaining
  Containers-view work.
- **Hub activity rail (P4 Hub A).** Two sections:
  - ~~"Changes"~~ **DONE** — `DockerClient::git_status()` runs
    `git status --porcelain=v1 --branch` inside `/workspace` →
    `GitStatus{isRepo,branch,ahead,behind,files[{path,status}],total}` (parser
    unit-tested). The rail polls it ~5s while running and lists changed files
    with porcelain-coded accents (A→live, M/R→wait, D→err, ?→dim); honest
    one-liners for not-a-repo / clean / down. `files` capped at 200, `total`
    carries the full count. **Diff viewing DONE** — `DockerClient::git_diff(path)`
    (per file) and `git_diff_all()` (combined `diff HEAD`, the rail "Review all"
    button) feed a parsed unified-diff modal (file headers, hunks, +/- lines).
  - "Activity" turn-event feed — still **pending**: needs an app-level event bus
    / permission-prompt stream the agents don't emit yet (their prompts render in
    the terminal today). Stays an honest empty state until that surface exists.
- **Workspace files browser (P4 Hub A toolbar).** ~~Browse `/workspace`~~ **DONE**
  — the design's `workspace.jsx` 3-pane (file tree + editor + cost telemetry) is
  mostly fabrication-blocked (per-turn cost/tokens), but its genuinely-real core
  is a read-only file browser. `DockerClient::list_dir(path)` runs
  `find -maxdepth 1 -mindepth 1 -printf '%y\t%s\t%f\n'` inside the container →
  `Vec<FileEntry{name,kind,size}>` (parser unit-tested, capped 500 entries), and
  `read_file(path)` is `head -c 262144 -- <path>` (256 KiB cap, UTF-8-lossy).
  Both confine to `/workspace` server-side via `workspace_path()` (rejects `..`
  and any path outside the tree; `InvalidPath` error, unit-tested). The Hub
  toolbar Files button opens a modal (overlay store `files`, mirroring `diff`)
  with breadcrumb nav, dirs-first listing + byte sizes, and a click-to-preview
  pane; disabled while the runtime is down. No writes — read-only by design.
- **Dashboard (P4).** ~~Cross-session overview~~ **DONE (real subset)** — the
  Dashboard view is now a real read-only overview built from data the backend
  already reports: live session count + per-session agent/mode/tab (store) +
  real per-session uptime (`list_sessions` now carries tmux `session_created`,
  shown as "up 6h"), runtime CPU/memory (`container_stats`), `/workspace` git status
  (`container_git_status`: branch + ahead/behind + changed-file count), and
  ~~recent commits~~ **DONE** — `DockerClient::git_log(limit)` runs
  `git log --pretty=format:%H%x1f%an%x1f%ar%x1f%s` inside `/workspace` →
  `Vec<CommitInfo{hash,author,relative,subject}>` (US-delimited, parser
  unit-tested, limit clamped to 50). The design's per-session token/cost/turn
  telemetry, activity chart, attention queue and account-usage roll-ups are
  **omitted** (not faked) — they need the per-turn cost/usage capture below.
  - Per-session token/cost/turn + activity chart + attention queue — still
    **deferred**: requires per-turn token+cost capture from each CLI's output
    and a turn-event bus (same blocker as the Hub "Activity" feed).
- **Planned screens (P4 honest stubs).** Designed screens whose REAL data needs
  backend CodeHub doesn't capture yet are shipped as navigable `PlannedScreen`
  stubs (sidebar "More" group) that name what's missing — never fabricated. They
  become real once their blocker lands:
  - **Usage** — needs **per-turn token/cost/turn capture** from each CLI's output
    (the numbers live only inside each CLI's own session today). Same blocker as
    the Dashboard cost roll-ups, Hub PaneHead metrics and the Activity feed.
  - **Resume** — needs **persistent session history**: tmux sessions are
    ephemeral and discarded on close, so there is no past session to reopen. A
    history store (session metadata + transcript) would unblock it.
  - **Integrations** — needs **integration connectors + credential storage**
    (GitHub / issue trackers / chat); none implemented.
  - **Platform** — **dropped** (not stubbed). The design's platform screen asserts
    a multi-container fleet + companion/dynamic-island/broadcast-compare features
    that conflict with CodeHub's single shared-runtime model; a faithful port would
    be almost entirely fabricated. Its honest subset already lives in Dashboard +
    Containers.
  - **Hub B** (`main-hub-b.jsx`) — **dropped** (not stubbed). An alternate Hub
    layout; the primary Hub A shipped in P3. A second selectable layout is pure
    redundancy with no new data, so it's not ported.
- **Broadcast (P4).** ~~Send one prompt to many agents~~ **Send DONE / compare
  blocked.** The design's value — side-by-side answer columns + per-agent
  token/cost/elapsed/winner — is fabrication-blocked (no structured per-turn
  answer or cost capture; see below). The genuinely-real core IS built: a
  `BroadcastModal` (overlay store `broadcast`, opened from the Hub toolbar Send
  button + a command-palette action) writes one prompt + Enter to each selected
  running session's pty via the existing `pty_write` — exactly as if the user
  typed it into each pane. No new backend. The blocked compare grid is omitted,
  not stubbed (the send IS the honest realization). Verified end-to-end: the
  prompt reached both live tmux panes.
- **Session detail (P4).** ~~Focused-session view~~ **DONE (core) / telemetry
  blocked.** `session-detail.jsx` is a single session's terminal + a tabbed
  inspector. The genuinely-real core IS built: a `SessionDetail` screen (store
  `detailSession` + `openDetail`/`closeDetail`, opened from a PaneHead expand
  button, rendered in App ahead of the view switch) reparents the session's live
  xterm on the left (existing `PaneMount`) and a Diff/Logs inspector on the right
  reusing existing backends — Diff polls `container_git_diff_all` through the
  shared `DiffBody` renderer, Logs polls `container_logs`, the header branch comes
  from `container_git_status`. No new backend. The design's per-turn header
  telemetry (ctx gauge / turn / tokens / cost / budget) is **omitted** (not faked)
  — same per-turn-capture blocker below. Because every session shares ONE runtime,
  git + logs are workspace/runtime-wide, not per-session, and the inspector is
  labelled accordingly. Verified end-to-end against the live runtime (dark+light).
- **Companion / live-activities (P5).** ~~Floating always-on-top per-agent
  avatars + dynamic-island~~ **DONE (always-on-top monitor) / rich-state blocked.**
  An always-on-top companion window is built: `open_companion`/`close_companion`/
  `companion_open` create a frameless, `always_on_top`, skip-taskbar `WebviewWindow`
  (label `companion`, top-right pinned) that loads the real `index.html#/companion`
  route. Its content (`Companion.tsx`) polls `session_activity` and renders each
  running agent as an avatar puck (agent-colored ring, lit while working) + alias +
  honest working/idle + quiet-duration; clicking a row calls
  `focus_session_from_companion`, which raises the main window and emits
  `codehub://focus-session` (the main app focuses that session in the Hub). To make
  the companion self-sufficient — it runs in its own webview and cannot read the
  main store — `session_activity` was enriched with the agent identity (`cli` +
  `alias`), registered on `create_session` (both hosts) and falling back to the
  tmux session name when a pre-existing entry has no label. Triggered from the
  sidebar Views nav + a command-palette "Open companion window" action.
  - **Honest scope.** The design's per-agent draggable/cloneable avatars, the
    dynamic-island compact metaphor, and all turn/token/approve/done badges are
    **omitted** (not faked): the rich states need per-turn capture (below) and the
    multi-window drag/character system is polish (P6). The shipped companion shows
    only the real working/idle signal.
  - **Verification gap (explicit).** A second always-on-top OS window cannot be
    exercised in the dev-web bridge or Playwright (single page, no native window
    manager, no `always_on_top`). What IS verified: the companion **content route**
    renders end-to-end against the live runtime in dark + light with real activity
    (enriched aliases, session-name fallback, a genuinely-working codex session,
    idle durations). The native window creation / always-on-top / top-right pin /
    drag region / cross-window `codehub://focus-session` jump are compile-checked
    (`cargo clippy -D warnings`) + capability-wired (`companion` added to
    `capabilities/default.json` windows) but need a `tauri dev` / built-app smoke
    test to confirm OS behavior. The bridge degrades the window commands to honest
    no-ops in the browser (`companion_open` → false).
- **Per-turn capture (the big unlock).** ~~A subsystem that tails each agent
  pane's output…~~ **Foundation DONE (activity signal) / token-cost still
  deferred.** The robust, CLI-agnostic layer is built: the pty output pump tees
  every chunk into an `ActivityTracker` (`activity.rs`), and `session_activity`
  reports each session's `working`/`idle` state from output flow (working =
  output within a 1500ms grace window) plus `idleMs` + total `bytes`. This is
  shared by both hosts (it lives on `PtyRegistry`, so the dev bridge gets it
  free). Consumed by the Hub: PaneHead's status dot + "working/idle" line is now
  real (was a focus proxy), and the rail's **Activity** section is now a real
  live per-session working/idle list (was honest-empty). Known honest limits,
  documented in `activity.rs`: the output signal can't separate idle from
  waiting-for-approval from done (all "quiet"), and a shared repaint (e.g. a tmux
  status-bar clock tick) can briefly read every session as "working".
  - **Still deferred — turn boundaries + token/cost/turn-count.** These don't come
    from output flow; they need either a per-CLI parser of each TUI's status line
    (fragile, version-specific) or reading the CLIs' own session files (Claude's
    `~/.claude/projects/**/*.jsonl` etc. — in-container, also unblocks Resume's
    persistent history). That parser/reader layer is the remaining work for Usage,
    Dashboard cost roll-ups, PaneHead token/cost metrics, broadcast compare and the
    session-detail transcript. Won't be scraped from the terminal blindly.

---

## Recommended build order

1. **Tier 0** (theme, stop-all, prompt templates, shortcuts/notif prefs) — unblocks
   Empty-state + Settings shells immediately, ships light mode. No Rust.
2. **Config store** (Tier 2) — foundational; most Settings rows persist through it.
3. **Tier 1 reads** (`docker_info`, `agent_versions`, `agent_key_status`) +
   the key-injection sub-task — fills the Empty-state pill/checklist and Settings
   agent rows with real data. (Security review on `agent_key_status`.)
4. **Initial prompt on spawn** — completes the real Spawn dialog (agent×mode×prompt).
5. **Workspace picker (lighter)** — optional within P2; otherwise its own follow-up.
6. **Tier 3** — separate design + PRs, post-v1. Render as "Coming soon" until then.

Screens (Phase 2) port against this: anything in Tier 0–2 wires to real data;
Tier 3 controls render disabled / "Coming soon" (sanctioned by the design's
out-of-scope list).
