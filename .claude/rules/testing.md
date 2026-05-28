# Testing rules

> Imported by the repo root `CLAUDE.md` via `@.claude/rules/testing.md`. Loaded every session — keep it load-bearing.

## Testing posture

There is no automated IPC test suite yet. Manual regression matrix lives in `TEST_SCENARIOS.md` — run it before any release cut, paying special attention to the close-tab → tmux-kill flow (S3, S5, S7, S8) which previously regressed.

## Visual / design verification (mandatory for any UI change)

ALWAYS visually verify frontend, layout, styling, or UX changes in a real browser before claiming they work — reading the diff is not enough. Use the **dev bridge + Playwright CLI**, never inference:

1. `make dev-web` — boots Vite (`:1420`) + the backend bridge (`:4555`) against a live container, no Tauri window.
2. Drive it with the `playwright-cli` skill: `open --browser=chrome`, `resize 1440 900`, `goto http://localhost:1420`, then capture with `screenshot --filename=.playwright-cli/<name>.png` and `Read` the PNG.
3. Capture every state the change touches — for launch UX that means each surface (`+` new-tab, ⌘T, pane split control, rail "+") — and compare them against each other for consistency, not just the default view.
4. Check the browser `console` for errors after interacting.

**Screenshot artifacts always go in `.playwright-cli/` (already gitignored) — never the repo root.** `playwright-cli`'s `--filename` defaults to the current working directory, so pass an explicit `.playwright-cli/<name>.png` path every time. Saving verification screenshots to the repo root pollutes the working tree (it accreted 50+ stray PNGs before this rule existed).

Don't mark UI work done on inference alone — describe the screenshots you actually observed.
