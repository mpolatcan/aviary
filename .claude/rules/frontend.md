# Frontend work rules

> Loaded every session via CLAUDE.md `@.claude/rules/frontend.md`.

## Required skills for UI work

Any frontend task — new screens, component changes, layout fixes, design polish, UX improvements — MUST use these skills:

1. **`/frontend-design:frontend-design`** — invoke for all visual/design/UX work. Covers component design, layout composition, styling, motion, theming, and design-system alignment.
2. **shadcn primitives** — use the existing shadcn/Radix components in `src/app/ui/` (Button, Dialog, Popover, etc.) before building custom ones. Check `src/app/ui/` for available primitives.

## Component hierarchy

```
src/app/ui/          ← shadcn primitives (Button, Dialog, Popover, etc.) — lowest level
src/app/components/primitives/  ← domain primitives (AgentGlyph, StatusDot, Spark, etc.)
src/app/components/hub/         ← hub chrome (HubSidebar, HubTabs, ActivityRail, etc.)
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
| `lbl` | Uppercase mini-label (10.5px, tracked, fg-2) |
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

- **Don't refactor adjacent components** while fixing one screen. If you're fixing Dashboard, don't "also clean up" ActivityRail.
- **Match existing inline-style patterns.** This codebase uses inline styles extensively (not Tailwind classes) for component-level layout. Don't convert existing inline styles to Tailwind unless asked.
- **No speculative abstractions.** Three similar `<div>` blocks are fine. Don't extract a `<Card variant={...}>` wrapper unless it's used 5+ times.
- **Verify before and after.** Screenshot the screen before your change, make the change, screenshot after. Compare both.
