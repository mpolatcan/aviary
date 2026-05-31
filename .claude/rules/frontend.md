# Frontend work rules

> Loaded every session via CLAUDE.md `@.claude/rules/frontend.md`.

## Required skills for UI work

Any frontend task — new screens, component changes, layout fixes, design polish, UX improvements — MUST use these skills:

1. **`/frontend-design:frontend-design`** — invoke for all visual/design/UX work. Covers component design, layout composition, styling, motion, theming, and design-system alignment.
2. **shadcn primitives** — use the existing shadcn/Radix components in `src/app/ui/`. See the rule below.

## ALWAYS use shadcn for controls — never hand-roll (rule)

**Every interactive control that has a shadcn/ui equivalent MUST use the shadcn component from `src/app/ui/`. Never hand-roll an inline-styled version of something shadcn already provides.** This is non-negotiable and applies to every screen.

Mandatory mapping (control → component):

| Control | Use | Not |
|---|---|---|
| button (text or icon) | `<Button>` (`ui/button`); icon buttons → `IconBtn` (renders `<Button variant="ghostIcon">`) | raw `<button style=…>`, `.btn` CSS class |
| toggle / switch | `<Switch>` (`ui/switch`); pressable icon/filter toggle → `<Toggle>` (`ui/toggle`) | hand-rolled `role="switch"`/`aria-pressed` button |
| checkbox | `<Checkbox>` (`ui/checkbox`) | `role="checkbox"` button, `<input type="checkbox">` |
| range / slider | `<Slider>` (`ui/slider`) | `<input type="range">` |
| native dropdown select | `<Select>` (`ui/select`) | `<select>` / hidden-native-select tricks |
| action menu (trigger) | `<DropdownMenu>` (`ui/dropdown-menu`) | bespoke absolute-positioned menus |
| inline single-select (segmented) | `<Segmented>` → `ToggleGroup` (`ui/toggle-group`) | hand-rolled pill row |
| chip / label pill | `<Badge>` (`ui/badge`) (via `Tag`) | inline-styled span pill |
| text input / textarea | `<Input>` / `<Textarea>` | raw `<input>` / `<textarea>` |
| dialog / popover / tabs / tooltip / separator / card | `ui/dialog`, `ui/popover`, `ui/tabs`, `Tip`(`ui/tooltip`), `ui/separator`, `ui/card` | custom equivalents |

If a needed shadcn primitive isn't in `ui/` yet, **add it** (radix-ui is already a dep) rather than hand-rolling.

**Migration status:** every native form control (`<input>`/`<select>`/`<textarea>`/checkbox/range) and every hand-rolled duplicate of a shadcn primitive has been migrated. `grep -rn "<input\|<select\|<textarea" src/app/screens src/app/components` must stay empty. **Hover tooltips are 100% `Tip` (Radix), zero native `title=` on DOM elements** — never add `title=` to a `<button>`/`<span>`/`<div>`/`<a>` for a tooltip; wrap it in `<Tip text=…>`. (Disabled control → wrap in a `<span>` so Radix fires. Section-label component props like `PaneHead title=`/`HubBanner title=` and the `CommandDialog title=` a11y label are NOT tooltips — those stay.)

**Two patterns worth copying:**
- **Inline-look on a shadcn control:** override the box via className/inline-style — e.g. an inline search field is `<Input className="h-auto border-0 bg-transparent shadow-none focus-visible:ring-0">`; the rename-in-place fields are `<Input className="pane-name-input h-auto">` (keep the `pane-name-input` class — the global keyboard guard keys off it; `h-auto` kills shadcn's `h-9`).
- **Presentational checkbox on a clickable card:** when the whole card toggles selection, make the `<Checkbox>` `pointer-events-none aria-hidden tabIndex={-1}` so the click falls through to the card (Radix's hidden form-input bubbles a 2nd click that `stopPropagation` can't catch → would double-toggle).

**Inline styles are still fine** for: layout/positioning (flex, grid, padding, gap, absolute), and **domain primitives that have no shadcn equivalent** — `StatusDot`, `Spark`, `AgentGlyph`, `ContextGauge`, `MetricStat`, `ColorDot`, `TermBlock`, `Logo`. Those build directly on `tokens.css`. **`<button>` is also still correct for bespoke composite surfaces with no shadcn drop-in** — workspace tab strips (drag/color/close), the pane color-swatch (`ColorDot`), the `SpawnSplitBtn` split-button halves, file/session list rows, the settings sidebar nav, and quick-pick model chips. Those are app components, not controls to migrate. But any plain action/toggle/select/input inside them uses shadcn.

Tooltip nuance: Radix tooltips don't fire on `disabled` elements (native `title` does) — keep native `title` on disabled controls and on truncated/overflow full-text (paths).

Showcase + reference for the canonical set: `PrimitivesGallery` (`src/app/dev/PrimitivesGallery.tsx`, dev route `#/__primitives`).

## Component hierarchy

```
src/app/ui/          ← shadcn primitives (Button, Dialog, Popover, etc.) — lowest level
src/app/components/primitives/  ← domain primitives (AgentGlyph, StatusDot, Spark, etc.)
src/app/components/hub/         ← hub chrome (HubSidebar, HubTabs, HubStatusBar, etc.)
src/app/components/             ← top-level shared (PaneHead, PaneMount, SpawnModal, etc.)
src/app/screens/                ← full-page views (Dashboard, Settings, Welcome, etc.)
```

New components go at the lowest appropriate level. Don't put domain logic in `ui/`.

## Design tokens

Never inline raw hex colors. Use the design tokens from `src/app/tokens.css`:
- Surfaces: `--bg-0` through `--bg-3`, `--bg-hover`, `--bg-active`
- Text: `--fg-0` through `--fg-4`
- Borders: `--bd`, `--bd-soft`, `--bd-strong`
- Status: `--live`, `--wait`, `--idle`, `--err`, `--done`
- Primary: `--pri`, `--pri-dim`
- Agent accents: `--a-claude`, `--a-codex`, `--a-antigravity`, `--a-shell`

## Typography

**One typeface: JetBrains Mono, everywhere** (chrome + terminal). `--sans` and `--mono` (`tokens.css`) and `--font-sans`/`--font-mono`/`--font-pixel` (`theme.css`) all resolve to it. Geist and Silkscreen were dropped — don't reintroduce another family. Terminal panes stay on the self-hosted SemiBold face `"JetBrainsMono Terminal"` (a distinct family name, same typeface) — don't merge the two.

**One size scale — numeric `--fs-*` tokens in `theme.css`** (token name == px value): `--fs-9 --fs-10 --fs-11 --fs-12 --fs-13 --fs-14 --fs-16 --fs-20 --fs-26` (`--fs-base` = `--fs-12`). The old semantic names (`--fs-xs`/`sm`/`md`/`lg`/`xl`/`2xl`/`2xs`/`micro`/`pixel`) are gone — don't reintroduce them.

- **Every inline `fontSize` in `*.tsx` is `fontSize: "var(--fs-N)"`** — no raw px, no half-steps. Invariant: `grep -rnE 'fontSize:\s*[0-9]' --include='*.tsx' src/app` must stay empty.
- **CSS `font-size` in `tokens.css`/`panes.css` uses `var(--fs-N)`** too; `font:` shorthand uses on-scale px (`11px`/`12px`). No half-pixels anywhere.
- **Tailwind arbitrary sizes** use on-scale px (`text-[11px]`/`text-[12px]`), never half-pixels.
- **Exempt (stay numbers, NOT tokens):** xterm `Terminal({ fontSize: 13 })` configs — must be a number, not a CSS var (`LoginTerminalDialog.tsx` + `src/terminal.ts`); and proportional glyph sizing in domain primitives — `FileGlyph` (`6.5`/`8.5`, below the 9px floor) and `AccountAvatar` (`size * 0.42`).

## CSS class conventions

Reusable classes in `tokens.css` — use these instead of reinventing:

| Class | Purpose |
|-------|---------|
| `ch-card` | Card container (bg-2, border, rounded) |
| `ch-card-interactive` | Card with hover highlight (extends ch-card) |
| `ch-slider` | Themed range input (purple thumb, dark track) |
| `side-item` | Sidebar nav item (full-width button, hover/active states, left indicator bar) |
| `ws-card` | Workspace card — reveal `.ws-remove` on hover |
| `session-close` | Session close button — revealed on parent `.side-item:hover` |
| `mono` | Mono font + OpenType features (zero, ss01) |
| `tnum` | Tabular numeric figures |
| `lbl` | Uppercase mini-label (11px / `--fs-11`, tracked, fg-2) |
| `kbd` | Keyboard shortcut chip |
| `scroll` | Styled scrollbar container |

## Sidebar navigation

Five views in sidebar nav: Hub, Dashboard, Workspaces, Usage, Settings. Integrations is a Settings sub-pane, not a top-level view. The `useNav()` hook in `HubSidebar.tsx` defines the nav model.

## CTA naming rules

- "New workspace" / tab bar "+" → always opens workspace wizard (`setNewWorkspace(true)`)
- "New agent" / "Add agent" / action bar CTA → always opens spawn dialog (`openLaunch`)
- Never label a spawn-dialog trigger as "New workspace"

## Visual verification

All UI changes must be visually verified via `make dev-web` + Playwright before claiming done. Never trust inference alone — screenshot and read the actual result.

## Backend dependency rule

When a frontend or design change requires data that doesn't exist yet (new IPC commands, new backend state, new container metrics, etc.), **don't fake it with hardcoded/mock data and call it done.** Instead:

1. Identify what backend or data-layer work is needed.
2. Plan and implement the backend side first (Rust command, store field, IPC type, dev-bridge route).
3. Wire the frontend to the real data source.

If the backend work is out of scope or deferred, say so explicitly — don't ship a screen with placeholder data pretending it's functional.

## Frontend-specific behavioral notes

- **Don't refactor adjacent components** while fixing one screen. If you're fixing Dashboard, don't "also clean up" HubSidebar.
- **Inline styles for LAYOUT only.** Inline styles are fine for layout/positioning (flex, padding, gap, absolute). They are NOT a substitute for a shadcn control — see the ALWAYS rule above. A hand-rolled inline-styled button/toggle/select/menu is a bug to fix, not a pattern to match.
- **No speculative abstractions.** Three similar `<div>` blocks are fine. Don't extract a `<Card variant={...}>` wrapper unless it's used 5+ times. (This does not excuse hand-rolling controls — those go through shadcn regardless of count.)
- **Verify before and after.** Screenshot the screen before your change, make the change, screenshot after. Compare both.
