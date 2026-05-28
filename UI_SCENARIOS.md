# UI Interaction Scenarios — UX / UI / design detection

> Sibling to `TEST_SCENARIOS.md`. That file verifies **functional behavior**
> (lifecycle, tmux kill order, IPC). This file is a library of **interaction
> flows** that drive the UI like a user — open, fill, submit, stack, split, drag,
> resize, theme-switch — and surface **UX / UI / design** issues that static
> review misses. Run before a release cut or after any layout/design change.
> Findings are visual-judgment calls, not pass/fail assertions.

Each scenario: **Reach → Steps (copy-paste playwright-cli) → Expect → Check →
Found** (issues seen on the last run, with screenshot ref).

---

## Setup

```bash
make dev-web            # Vite :1420 + backend bridge :4555 against a live container
playwright-cli open --browser=chrome
playwright-cli resize 1440 900
```

**Screenshots go in `.playwright-cli/` (gitignored).** Always pass
`--filename=.playwright-cli/<name>.png`, then `Read` the PNG. Run
`playwright-cli console` after each interaction — a clean console is part of the
check.

## Invocation patterns (all verified to work)

- **Keyboard shortcuts fire over the terminal** (handlers attach at capture
  phase): `playwright-cli press "Meta+e"`. Use these first — they don't depend on
  refs. Modifier names: `Meta`=⌘, `Alt`=⌥, `Shift`=⇧. Keys: `"Meta+Shift+l"`,
  `"Meta+\\"`, `"Meta+1"`, `"Meta+BracketLeft"`, `"Alt+Tab"`, `"Shift+Slash"` (=`?`),
  `"Meta+Comma"`, `"Escape"`.
- **Labeled buttons:** `playwright-cli click "getByRole('button', { name: 'Files' })"`.
  For names that include a badge/shortcut, use a regex: `{ name: /Dashboard/ }`,
  `{ name: /New agent/ }`.
- **Accessible name ≠ visible label.** Some controls are CSS-uppercased
  (workspaces filters resolve as `'all'`/`'running'`/`'stopped'`, NOT "All"…) or
  have a doubled name from icon-alt + text (agent tabs = `'Codex Codex'`,
  `'Claude Code Claude Code'`). If a `name:` lookup "does not match any
  elements", `snapshot` and read the real name. After `goto`/hash-nav, give the
  view a beat (`sleep 1`) before the first click — DevPreview re-renders async.
- **DevPreview screen nav (no reload):** `playwright-cli eval "window.location.hash='#/__screens/<key>'"`.
- **Hash roots (need reload):** `playwright-cli goto …#/companion` then
  `playwright-cli reload`. A bare hash `goto` does NOT re-run `main.tsx`.
- **Theme:** `playwright-cli localstorage-set codehub.theme <dark|gray|light>` then `reload`.
- **Width:** `playwright-cli resize <w> <h>`.
- **Unlabeled icon buttons** (pane expand, panel close `×`, dropdown chevrons)
  have no stable name → `playwright-cli snapshot`, find the `ref=eN`, then
  `click eN`. Refs are per-render; re-snapshot after big DOM churn.

## Command quick-reference

| Action | Key | Action | Key |
|---|---|---|---|
| Files pane | `Meta+e` | Command palette | `Meta+k` |
| Shell pane | `Meta+Shift+b` | Shortcuts help | `Shift+Slash` |
| Diff inspector | `Meta+d` | Settings | `Meta+Comma` |
| Resume drawer | `Meta+r` | Theme cycle | `Meta+Shift+l` |
| New agent session | `Meta+n` | Companion | `Meta+Shift+c` |
| New workspace tab | `Meta+t` | Notifications | `Meta+Shift+n` |
| Close pane | `Meta+w` | Dev tools | `Meta+Alt+i` |
| Close workspace | `Meta+Shift+w` | Jump tab 1–9 | `Meta+1`…`Meta+9` |
| Split vertical | `Meta+\\` | Prev / next tab | `Meta+BracketLeft` / `Right` |
| Split horizontal | `Meta+Shift+\\` | Cycle panes | `Alt+Tab` |

Diff inspector: `j`/`k` hunk, `s` stage, `u` unstage, `Meta+p` PR, `c` commit.
Container: `Meta+Shift+x` exec, `Meta+Alt+r` restart, `Meta+Alt+period` stop,
`Meta+Alt+l` logs. Selection: `Meta+f` find, `Meta+a` select-all, `Meta+c` copy,
`Meta+Shift+v` paste-plain, `Slash` search. Accounts: `Meta+Shift+a` switch,
`Meta+Alt+b` billing.

> **Keymap conflicts found:** `Meta+Shift+n` = "New workspace" on buttons but
> "Toggle notifications" in the Shortcuts panel; `Meta+a` = "New agent" (action
> bar) vs "Select all" (Shortcuts panel). Reconcile before trusting either.

## Reaching each surface

**DevPreview keys** (`#/__screens/<key>`): `empty` `main-hub-a` `hub-states`
`welcome` `spawn` `new-workspace` `palette` `shortcuts` `about` `dashboard`
`workspaces` `settings` `settings-agents` `settings-integrations`
`settings-platform` `settings-notifications` `live-activities` `companion`
`agent-settings` `resume` `session-detail` `states`.
**Live app:** `http://localhost:1420/`. **Hash roots:** `#/companion`
`#/__primitives` `#/__states`.

---

# Scenarios

## Group A — Entry & navigation

### S-A1 · Empty state (no workspaces)
```
playwright-cli goto "http://localhost:1420/#/__screens/empty"
playwright-cli hover "getByRole('button', { name: /Claude Code/ })"
playwright-cli screenshot --filename=.playwright-cli/s-a1-empty.png
```
- **Expect:** hero, docker-connected pill, 3 agent cards, "New workspace" CTA. Sidebar = Hub + Settings only.
- **Check:** hero vertical balance; card hover; CTA naming (New workspace ≠ New agent); "Set up API key" contrast.

### S-A2 · Welcome (has workspaces)
```
playwright-cli eval "window.location.hash='#/__screens/welcome'"
playwright-cli screenshot --filename=.playwright-cli/s-a2-welcome.png
```
- **Expect:** RECENT list + Blank / From GitHub / Resume cards; sidebar = Hub+Dashboard+Workspaces+Settings.
- **Check:** "open" pill contrast; start-card rhythm; "Dashboard N" badge value.

### S-A3 · Sidebar nav switching
```
playwright-cli goto "http://localhost:1420/"
playwright-cli reload
playwright-cli click "getByRole('button', { name: /Dashboard/ })"
playwright-cli click "getByRole('button', { name: 'Workspaces' })"
playwright-cli click "getByRole('button', { name: 'Settings' })"
playwright-cli click "getByRole('button', { name: 'Hub' })"
playwright-cli screenshot --filename=.playwright-cli/s-a3-nav.png
```
- **Expect:** main region swaps; active item gets indicator bar + highlight.
- **Check:** active-state consistency; badge vs reality.

### S-A4 · Sidebar collapse
```
playwright-cli snapshot           # find the collapse button (top-right of masthead), e.g. e13
playwright-cli click e13
playwright-cli screenshot --filename=.playwright-cli/s-a4-collapse.png
playwright-cli click e13
```
- **Check:** collapsed icons remain meaningful; no layout jump.

## Group B — Workspace lifecycle dialogs

### S-B1 · New-workspace wizard
```
playwright-cli goto "http://localhost:1420/"
playwright-cli reload
playwright-cli press "Meta+Shift+n"                  # opens wizard (see keymap conflict note)
playwright-cli fill "getByRole('textbox')" "/tmp/demo-repo"
playwright-cli click "getByRole('button', { name: /Continue/ })"   # → Container
playwright-cli screenshot --filename=.playwright-cli/s-b1-wizard-2.png
playwright-cli press "Escape"
```
- **Expect:** stepper Repository → Container → Name & launch; selected-repo chip; Continue advances.
- **Check:** stepper active/done states; per-step validation; backdrop scrim.
- **Found:** GitHub pointer here = "Settings → Integrations", but Integrations page says "Coding Agents". Pick one.

### S-B2 · Spawn-agent dialog
```
playwright-cli click "getByRole('button', { name: /New agent/ })"
playwright-cli snapshot                              # AGENT / MODE / ACCOUNT dropdowns + GROUP chips
playwright-cli screenshot --filename=.playwright-cli/s-b2-spawn.png
playwright-cli click "getByRole('button', { name: 'Cancel' })"
```
- **Expect:** agent×mode×account×placement; primary "Add agent".
- **Check:** dropdown contents; ACCOUNT "Default" red dot reads as error for a no-credential default.

### S-B3 · Workspace close confirmation
```
playwright-cli snapshot                              # find workspace-tab close ×, e.g. e107
playwright-cli click e107
playwright-cli screenshot --filename=.playwright-cli/s-b3-closeconfirm.png
```
- **Expect:** confirm dialog counts working agents; container persists after close.
- **Check:** count accuracy; destructive styling.

## Group C — Hub panes & docked panels (highest value)

### S-C1 · Open each panel solo
```
playwright-cli press "Meta+e"   ; playwright-cli screenshot --filename=.playwright-cli/s-c1-files.png ; playwright-cli press "Meta+e"
playwright-cli press "Meta+d"   ; playwright-cli screenshot --filename=.playwright-cli/s-c1-diff.png  ; playwright-cli press "Meta+d"
playwright-cli press "Meta+Shift+b" ; playwright-cli screenshot --filename=.playwright-cli/s-c1-shell.png ; playwright-cli press "Meta+Shift+b"
playwright-cli press "Meta+r"   ; playwright-cli screenshot --filename=.playwright-cli/s-c1-resume.png ; playwright-cli press "Meta+r"
```
- **Expect:** each opens in its dock; panes resize; toggle off restores.
- **Check:** with one panel open, panes still usable; smooth transitions.

### S-C2 · Panel-stacking stress ★
```
playwright-cli press "Meta+e"                        # Files
playwright-cli press "Meta+d"                        # Diff
playwright-cli click "getByRole('button', { name: 'README.md' })"   # → FilePreview
playwright-cli screenshot --filename=.playwright-cli/s-c2-stack.png
playwright-cli console
```
- **Expect:** terminals keep a usable minimum width; status bar stays one line.
- **Check:** pane width floor; header-control overlap; status-bar overflow.
- **Found:** **HIGH** — panes collapse to ~50px (text shatters ~4 chars/line); header controls overlap; status bar wraps to 2 clipped lines. No min-width / no panel cap. `live-03-filepreview`

### S-C3 · File preview open/close
```
playwright-cli press "Meta+e"
playwright-cli click "getByRole('button', { name: 'package.json' })"
playwright-cli screenshot --filename=.playwright-cli/s-c3-preview.png
playwright-cli press "Escape"                        # expected to close
playwright-cli snapshot                              # if still open → find preview × ref, click it
```
- **Check:** file renders; Esc and `×` both close; footer (lines · type · path).
- **Found:** FilePreview ignores Esc — had to use the toggle/×. `live-05-shell`

### S-C4 · Split + focus mode
```
playwright-cli press "Meta+\\"                       # split
playwright-cli snapshot                              # find a pane expand icon, e.g. e161
playwright-cli click e161                            # → focus/maximize
playwright-cli screenshot --filename=.playwright-cli/s-c4-focus.png
playwright-cli press "Escape"                        # exit focus
```
- **Expect:** focused pane maximizes; siblings → "Minimized · N" strip; Esc exits.
- **Found:** works. `live-06-focus`

### S-C5 · Drag-reorder pane
```
playwright-cli snapshot                              # source pane head eA, target leaf eB
playwright-cli drag eA eB
playwright-cli screenshot --filename=.playwright-cli/s-c5-drag.png
```
- **Expect:** drop-zone overlays on every other leaf; drop relocates; switch mid-drag clears overlays.
- **Found:** not exercised headlessly — verify manually.

### S-C6 · Pane telemetry populates ★
```
# with an agent mid-turn:
playwright-cli --raw snapshot | grep -A1 -iE "ctx|turn|tok|edits"
playwright-cli screenshot --filename=.playwright-cli/s-c6-telemetry.png
```
- **Expect:** ctx/turn/tok/$/edits populate during a turn; bottom bar humanized.
- **Found:** **MED** — strip stays "—" even while agents "working" (literal "—" in DOM); ContextGauge primitive works with data → wiring gap. `net ↓257077 KB` unhumanized; mem GiB vs inspector MB/GB. `live-00`

## Group D — Floating overlays

### S-D1 · Command palette
```
playwright-cli press "Meta+k"
playwright-cli type "diff"
playwright-cli press "ArrowDown"
playwright-cli screenshot --filename=.playwright-cli/s-d1-palette.png
playwright-cli press "Escape"
```
- **Expect:** Agents / Spawn / Commands / Go-to sections; footer hints + count.
- **Check:** full-window scrim; active-row highlight; live filter.

### S-D2 · Shortcuts cheat sheet
```
playwright-cli press "Shift+Slash"                   # ?
playwright-cli fill "getByRole('textbox')" "split"
playwright-cli screenshot --filename=.playwright-cli/s-d2-shortcuts.png
playwright-cli press "Escape"
```
- **Check:** row-height evenness; theme-toggle label.
- **Found:** "Toggle light / dark theme" ignores the 3rd theme (cycle is dark→gray→light); multi-line rows uneven. `dark-shortcuts`

### S-D3 · About dialog (per theme)
```
for t in dark gray light; do
  playwright-cli localstorage-set codehub.theme $t ; playwright-cli reload ; sleep 1
  playwright-cli eval "window.location.hash='#/__screens/about'"
  playwright-cli screenshot --filename=.playwright-cli/s-d3-about-$t.png
done
```
- **Check:** header readability across themes.
- **Found:** light — header subtitle low-contrast gray on the teal gradient. `light-about`

## Group E — Settings (every sub-pane)

### S-E1 · Settings nav switching
```
playwright-cli goto "http://localhost:1420/#/__screens/settings" ; playwright-cli reload ; sleep 1
for s in General "Coding Agents" Integrations Platform Notifications Appearance ; do
  playwright-cli click "getByRole('button', { name: '$s' })"
  playwright-cli screenshot --filename=.playwright-cli/s-e1-$s.png
done
```
- **Check:** every nav item maps to a real pane.
- **Found:** `settings-repos` (tab "Repositories") renders **General** — no Repositories section. `dark-settings-repos`

### S-E2 · Coding Agents
```
playwright-cli goto "http://localhost:1420/#/__screens/settings-agents" ; playwright-cli reload ; sleep 1
playwright-cli click "getByRole('button', { name: 'Codex Codex' })"          # doubled a11y name
playwright-cli click "getByRole('button', { name: 'Claude Code Claude Code' })"
playwright-cli screenshot --filename=.playwright-cli/s-e2-agents.png
```
- **Check:** empty-card states; disconnected-provider signal.
- **Found:** Anthropic red left-bar vs yellow "KEY NEEDED" = mixed signal; redundant "(Claude Code)"; "v2.1.153" vs "2.1.153".

### S-E3 · Agent detail drill-in
```
playwright-cli eval "window.location.hash='#/__screens/agent-settings'"
playwright-cli screenshot --filename=.playwright-cli/s-e3-agentdetail.png
```
- **Check:** Account / Model Providers / Active Model / Permission Rules; chip affordance; badge casing.
- **Found:** "Key needed" (here) vs "KEY NEEDED" (S-E2); provider chips dim/ambiguous.

### S-E4 · Integrations
```
playwright-cli eval "window.location.hash='#/__screens/settings-integrations'"
playwright-cli screenshot --filename=.playwright-cli/s-e4-integrations.png
```
- **Check:** GitHub pointer vs S-B1; env-var box is an instruction not an input.
- **Found:** env-var `export GITHUB_TOKEN=…` styled like an editable field; GitHub-pointer conflict.

### S-E5 · Appearance — live theme + font ★
```
playwright-cli eval "window.location.hash='#/__screens/settings'"
playwright-cli click "getByRole('button', { name: 'Appearance' })"
playwright-cli snapshot                              # theme segmented control + font slider refs
# click each theme choice; drag the slider; then verify panes update without reload
playwright-cli screenshot --filename=.playwright-cli/s-e5-appearance.png
```
- **Expect:** theme applies instantly; font size flows to panes; persists after reload.
- **Found:** gray clean; light fine except About header + pale IDLE badge / "open" pill / faint divider.

### S-E6 · General toggles
```
playwright-cli click "getByRole('button', { name: 'General' })"
playwright-cli snapshot                              # toggle switches → refs
playwright-cli screenshot --filename=.playwright-cli/s-e6-general.png
```
- **Check:** on/off states distinct; purple `--pri` accent.

### S-E7 · Platform matrix
```
playwright-cli eval "window.location.hash='#/__screens/settings-platform'"
playwright-cli screenshot --filename=.playwright-cli/s-e7-platform.png
```
- **Check:** legend swatch contrast; stale references.
- **Found:** lists "Usage" — view removed (folded into Dashboard's "Usage analytics"). Same stale ref in README.

### S-E8 · Notifications
```
playwright-cli eval "window.location.hash='#/__screens/settings-notifications'"
playwright-cli screenshot --filename=.playwright-cli/s-e8-notifications.png
```
- **Check:** dark macOS-mock preview renders in all themes; toggle states.

## Group F — Data views

### S-F1 · Dashboard ★
```
playwright-cli eval "window.location.hash='#/__screens/dashboard'"
playwright-cli click "getByRole('button', { name: 'Running' })"   # Sessions filter
playwright-cli click "getByRole('button', { name: 'All' })"
playwright-cli screenshot --filename=.playwright-cli/s-f1-dashboard.png
```
- **Expect:** counts agree across cards/table/sidebar badge.
- **Found:** **MED** — "RUNNING 3 of 2 sessions" (running > total; sidebar "Dashboard 3" shares it). CONTEXT·AVG dead "—" with no "no data" label (sibling CODEX QUOTA says "no rollout data"). `gray-dashboard`, `wide1920-dashboard`

### S-F2 · Workspaces inspector
```
playwright-cli eval "window.location.hash='#/__screens/workspaces'"
playwright-cli click "getByRole('button', { name: 'running' })"   # lowercase a11y name
playwright-cli click "getByRole('button', { name: 'stopped' })"
playwright-cli click "getByRole('button', { name: 'all' })"
playwright-cli screenshot --filename=.playwright-cli/s-f2-inspector.png
```
- **Check:** distinguishable list entries; metric-card consistency; destructive Stop styling.
- **Found:** two entries both "Workspace 1" (only hash differs); NET I/O hatch card unlike siblings; CPU 3% (list) vs 3.5% (detail); mount order nondeterministic.

### S-F3 · Session detail / diff inspector
```
playwright-cli eval "window.location.hash='#/__screens/session-detail'"
playwright-cli click "getByRole('button', { name: 'Split' })"
playwright-cli click "getByRole('button', { name: 'Unified' })"
playwright-cli click "getByRole('button', { name: /Staged/ })"
playwright-cli screenshot --filename=.playwright-cli/s-f3-sessiondetail.png
```
- **Check:** diff readability; INSPECT·DIFF active-tab clarity.
- **Found:** active-tab state subtle.

### S-F4 · Resume drawer
```
playwright-cli eval "window.location.hash='#/__screens/resume'"
playwright-cli fill "getByRole('textbox')" "sound"
playwright-cli click "getByRole('button', { name: /Today/ })"
playwright-cli screenshot --filename=.playwright-cli/s-f4-resume.png
```
- **Check:** card layout (branch/time/snippet/turns/model); dock flip; counts match tabs.

## Group G — Design canvases & galleries

### S-G1 · Companion (embedded + standalone)
```
playwright-cli eval "window.location.hash='#/__screens/companion'"
playwright-cli screenshot --filename=.playwright-cli/s-g1-companion-embedded.png
playwright-cli goto "http://localhost:1420/#/companion" ; playwright-cli reload ; sleep 1
playwright-cli screenshot --filename=.playwright-cli/s-g1-companion-window.png
```
- **Check:** companion states (Idle/Thinking/Awaiting/Done/Failed/Bubble/Dragging/Docked); character row.

### S-G2 · Live activities
```
playwright-cli eval "window.location.hash='#/__screens/live-activities'"
playwright-cli screenshot --filename=.playwright-cli/s-g2-liveactivities.png
```
- **Check:** island/notification/expanded variants; right panel doesn't clip at section boundary.
- **Found:** captured once at reduced scale — re-verify (likely capture race). `light-live-activities`

### S-G3 · States gallery
```
playwright-cli goto "http://localhost:1420/#/__states" ; playwright-cli reload ; sleep 1
playwright-cli screenshot --filename=.playwright-cli/s-g3-states.png
```
- **Check:** loading (lifecycle steps + skeleton), error (crash, 401); recovery-button colors.
- **Found:** green "Restart with 8 GiB" vs purple "Reauthorize" — inconsistent primary color. `dark-states`

### S-G4 · Primitives gallery
```
playwright-cli goto "http://localhost:1420/#/__primitives" ; playwright-cli reload ; sleep 1
playwright-cli screenshot --filename=.playwright-cli/s-g4-primitives.png
```
- **Check:** AgentGlyph / StatusDot / StatusBadge / ContextGauge / MetricStat / Spark / Tag, all states.
- **Found:** ContextGauge works with data here → confirms S-C6 is a wiring gap.

## Group H — Theme parity sweep

### S-H1 · Each theme × key screens
```
for t in dark gray light ; do
  playwright-cli localstorage-set codehub.theme $t ; playwright-cli reload ; sleep 1
  for k in dashboard workspaces settings-agents welcome main-hub-a states resume ; do
    playwright-cli eval "window.location.hash='#/__screens/$k'"
    playwright-cli screenshot --filename=.playwright-cli/$t-$k.png
  done
done
```
- **Check:** contrast, token bleed, status-color correctness, surface tones.

## Group I — Responsive sweep

### S-I1 · Width breakpoints
```
for w in "1100 800" "1280 800" "1440 900" "1920 1080" ; do
  playwright-cli resize ${w}
  for k in dashboard workspaces settings-agents welcome main-hub-a ; do
    playwright-cli eval "window.location.hash='#/__screens/$k'"
    playwright-cli screenshot --filename=".playwright-cli/w${w%% *}-$k.png"
  done
done
playwright-cli resize 1440 900
```
- **Check:** reflow, overflow, truncation, over-stretch.
- **Found (1100):** hub pane headers wrap name ("Claude / 3") + version instead of truncating; settings "Claude Code" heading wraps to 2 lines; workspaces detail header crowds + mounts truncate. Dashboard/Welcome reflow clean; 1920 fine.

## Group J — Event-driven states (manual triggers)

### S-J1 · Prompt toasts
- **Reach:** live hub; drive a real agent to a permission prompt. **Check:** toast placement, Approve/Deny, stacking. *(Not triggerable headlessly.)*

### S-J2 · Runtime banner
- **Reach:** live hub with image missing / pulling / daemon error. **Check:** banner copy + severity color per state.

---

## Appendix — First-run findings (2026-05-28)

86 screenshots in `.playwright-cli/` (23 screens × 3 themes + 6 live overlays +
2 standalone roots + narrow/wide). Prioritized:

**HIGH** — Panel-stacking crush (S-C2).

**MED** — Dashboard "3 of 2 sessions" overcount (S-F1) · empty pane telemetry
(S-C6) · agent version 2.1.153 vs terminal v2.1.150 · CONTEXT·AVG dead card
(S-F1) · duplicate "Workspace 1" names (S-F2) · settings-repos→General (S-E1) ·
3-theme toggle mislabel (S-D2) · GitHub-pointer conflict (S-B1/S-E4) · States
primary-color inconsistency (S-G3) · docked-Diff too narrow (S-C1) · status-bar
overflow (S-C2) · light About-header contrast (S-D3) · unhumanized net I/O
(S-C6) · keymap conflicts ⌘⇧N and ⌘A (quick-reference).

**LOW** — redundant "(Claude Code)" everywhere · "v" prefix drift · KEY NEEDED vs
Key needed casing · stale "Usage" refs · Anthropic red-bar vs yellow-badge ·
spawn red "Default" dot · progressive sidebar nav · NET I/O hatch card · CPU
rounding + mount-order nondeterminism · env-var-as-input · dim provider chips ·
uneven shortcut rows · About teal-header outlier · Shell 1 vs Shell 2 numbering ·
FilePreview ignores Esc · "Reading workspace stats…" stuck · pale light badges ·
GiB vs MB/GB units · subtle diff active-tab · a11y: agent tabs have doubled
accessible names ("Codex Codex") · a11y: filter-tab name casing differs
(workspaces "running" lowercase vs dashboard "Running").

**Non-bugs** — modal "dark patch" in light DevPreview = scrim framing artifact
(real scrim is full-window, `live-07-palette`); DevPreview "hub-states" ==
"main-hub-a" backdrop; app v0.1.2 vs image 0.1.3 is intentional.
