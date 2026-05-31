# CodeHub — implementation guide for Claude Code

> **HISTORICAL (archive).** This is the original Aviary→CodeHub migration
> handoff; the migration shipped and the rebrand is complete. **Live guidance
> lives in the root `/CLAUDE.md`.** The `design/{CLAUDE,MIGRATION,COMPONENTS,
> SCREENS}.md` files referenced below were removed after the migration — the
> "source-of-truth files" and "first action" sections are obsolete. The
> **design language rules** and **component vocabulary** sections remain a
> useful reference; everything framed as a pending task is done.

> Read this whole file before touching any source. The design is finished;
> your job is to port it cleanly into the existing Tauri v2 + React codebase
> formerly known as **Aviary**.

---

## What you're building

**CodeHub** — a Tauri-based desktop hub that runs coding agents (Claude Code,
Codex, Antigravity) in Docker containers and presents them through tmux
sessions. The product was previously named "Aviary" and is being rebranded.

This repo is the existing Aviary codebase. Your work is:

1. Rename Aviary → CodeHub throughout (binary, window title, plist, etc.)
2. Rebuild the UI using the new design system documented in `design/`
3. Preserve all existing runtime behavior (tmux, Docker, agent processes)

You are **not** replacing the Rust backend or the agent process management.
You are replacing the **chrome** (sidebars, tabs, panes, modals, settings).

---

## Source-of-truth files (read in this order)

```
design/CLAUDE.md          ← you are here
design/MIGRATION.md       ← phased rollout plan
design/COMPONENTS.md      ← component map: our names → shadcn names
design/SCREENS.md         ← list of every screen + which one to port first
design/styles.css         ← design tokens (CSS vars)
design/components.jsx     ← shared primitives (AgentGlyph, MetricStat, …)
design/screens/*.jsx      ← canonical layout for each screen
design/index.html         ← how the screens are wired together
```

The `design/` folder is a working React canvas. You can `open design/index.html`
in a browser to see every screen rendered at 1440×900 with current data. Use
it as your visual reference; do not import from it.

---

## Tech stack decisions (already made — do not re-litigate)

- **Tauri v2** for the desktop shell. Existing build. Keep.
- **React 19** + **TypeScript** for the UI. Existing.
- **shadcn/ui** for primitives. Add this.
- **Tailwind CSS** as the styling backbone. Replace existing CSS-in-JS with
  Tailwind classes paired with shadcn primitives.
- **xterm.js** for tmux output. Existing.
- **JetBrains Mono** as the single typeface (chrome + terminal). Load from
  Google Fonts. (Originally paired with **Geist** for sans prose; Geist was
  later dropped — the app is all-mono now.)
- **No emojis** in chrome. No reproduced third-party logos.

---

## Design language rules (non-negotiable)

1. **All JetBrains Mono.** One typeface across all chrome (originally
   mono-first with Geist for sans prose — settings descriptions, captions,
   hints; Geist was later dropped, so everything is mono now). Use
   `font-weight: 600` for headings.
2. **Cool-neutral darks.** Surfaces lift from `bg-0` (`#08090b`) to `bg-3`
   (`#1f242d`). Borders sit between bg layers, not on top of them.
3. **Primary is violet, status is warm.** `--pri` lives at hue 295 (cool
   violet); `--live` / `--wait` / `--err` / agent identity colors are all
   warm. This split keeps CTAs visually distinct from any status surface.
4. **Three semantic accents only.** `--live` (green), `--wait` (amber),
   `--err` (red). Status everywhere uses these. Agent identity colors
   (`--a-claude`, `--a-codex`, `--a-antigravity`) appear ONLY on glyphs,
   avatars, and chips — never on chrome.
5. **Antigravity is cyan, not green.** `oklch(0.78 0.13 200)`. Avoid drift
   toward green-teal — it collides with `--live`.
6. **Tabular nums for all numeric stats** (cost, tokens, turn, percentages).
   `font-variant-numeric: tabular-nums` or shadcn's `tabular-nums` class.
7. **No tracked-uppercase labels in metric strips.** Use lowercase mono
   labels (the `.lbl-soft` class) so the *value* is the loud thing.
8. **"Workspaces", not "Containers", in user-facing copy.** Each workspace
   is backed by one container; the technical container ID (e.g.
   `aurora-cc-3a8f`) only appears in runtime/infra surfaces like the
   Workspaces inspector and the status bar.
9. **Light mode is real.** Token names match shadcn. `.dark` and `.light`
   selectors swap them. Both themes ship.

---

## Component vocabulary

These are domain components I built in `design/components.jsx` and
`design/screens/hub-states.jsx`. They do NOT exist in shadcn. Port them
into `src/components/primitives/` and `src/components/chrome/`.

**Identity + status primitives** (`primitives/`):

- `AgentGlyph({agent, size, color})` — geometric mark per agent
- `AccountAvatar({id, size, ring})` — hash-derived colored letter avatar
- `StatusDot({status, pulse})` — small colored dot with pulse animation
- `StatusBadge({status, children})` — pill with dot + label
- `ContextGauge({used, max, label, width})` — inline bar showing token usage. **Baseline-aligned** — copy the structure from `design/components.jsx` exactly or sibling stats will misalign.
- `MetricStat({label, value, delta, deltaTone, spend})` — inline label/value pair
- `Spark({data, w, h, color, fill})` — minimal sparkline svg
- `TermBlock({lines})` — terminal output renderer (lines = [[className, text], …])
- `Tag({children, color})` — small bordered chip

**Hub chrome** (`chrome/`):

- `HubFrame` — full hub shell, props: `tabs / pseudoTab / tabsOverflow / meta / status / banner / leftPanel / bottomPanel / drawer / rail / actionBar / resumeActive / filesOpen / shellOpen / diffOpen`. Every hub-derived screen (main hub, hub state snapshots, session detail, etc.) wears this chrome.
- `StaticTabBar` / `WorkspaceTab` / `MetaStrip` / `ActionBar` / `StatusBar` / `HubBanner`
- `PaneAddBtn` — utility-toggle chip (Files / Shell / Diff). `active` prop fills with the pane-type accent. **There is no `kind="agent"`** in production — agents go through `SpawnSplitBtn`.
- `SpawnSplitBtn` + `SpawnPlacementMenu` — the bottom action bar's primary CTA. Replaces the old Split-right + Split-down + New-agent trio. Click main half → spawn into default split-right placement. Click chevron → menu (Split right `⌘\`, Split down `⌘⇧\`, In new group `⌘G`, In new tab `⌘⇧T`).

**Overlay windows** (Phase 5):

- `Island({state})` — dynamic island in its six states
- `CompanionAvatar({agent, status, bubble})` — floating puck with status ring
- `Character({kind, expression})` — companion character styles

For shadcn equivalents of our built-in helpers (Toggle → `Switch`, .card →
`<Card>`, .btn → `<Button>`), see `design/COMPONENTS.md`.

---

## What MUST be preserved from the Aviary codebase

- Tmux session management (the Rust side that spawns/attaches tmux)
- Docker container lifecycle (pull, create, mount, exec, stop, prune)
- Agent process supervision (Claude Code, Codex, Antigravity child procs)
- Existing API-key keychain reads
- File-watcher for `/workspace` modifications
- WebSocket pipe from Rust → xterm.js
- The IPC command surface (`#[tauri::command]` entries). Refactor only if
  the new design needs additional commands; never remove existing ones
  without first proving they're unused.

---

## What MUST change

- Window title `Aviary` → `CodeHub`
- Bundle id `com.aviary.*` → `com.codehub.*` (coordinate with whoever owns
  the cert)
- App icon (placeholder for now; new asset coming)
- The owl/bird metaphor everywhere (variables, copy, asset filenames,
  notification titles) — replace with neutral CodeHub vocabulary
- All UI components and CSS

---

## How to interact with me (the human running you)

1. **Always read first.** Before any edit, summarize what you found and what
   you plan to do. I will say "proceed" before you run code.
2. **One phase per session.** Do not start Phase 2 work while finishing
   Phase 1. The `MIGRATION.md` ordering is intentional.
3. **Branch per phase.** `feat/codehub-phase-0`, `feat/codehub-phase-1`, etc.
   Open a PR at the end of each phase.
4. **Tests stay green.** Every PR must pass the existing test suite.
   If a test references "Aviary" branding, update it; if it tests behavior,
   never weaken it.
5. **Ask, don't guess** on naming. The new product name is **CodeHub**.
   Variable names like `aviaryClient` should become `codeHubClient`, NOT
   `client` (preserves the namespace).

---

## Out of scope for v1

- Web build (we are desktop-first)
- Mobile companion
- Team / shared sessions
- Session checkpoints / branching
- MCP marketplace UI (we have an "Add MCP" button but no browse experience)
- Workspace templates
- **Broadcast** (one-prompt-to-N-agents). Was designed; cut as over-engineered for v1. Use parallel agents in split panes instead.
- **Compare mode** in the bottom action bar. Same outcome already ships via side-by-side split panes.
- **Hub B** (the old 2×2 compare grid). The recursive split inside the main hub covers this; toggle the activity rail off via Tweaks for an even barer view.

These are documented in `design/screens/` for future reference only —
do NOT implement in v1. Files for cut items have been removed from
`design/screens/`; if you see them in old branches, ignore.

---

## First action

Read `design/MIGRATION.md`. Confirm you understand the phased plan and
present a 5-bullet summary of Phase 0 before touching any files.
