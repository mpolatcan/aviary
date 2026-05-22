---
name: lint-fix
description: Run linters and formatters across the CodeHub repo (Biome for TS/JS/CSS/JSON, rustfmt + clippy for Rust). Use before opening a PR, before a release cut, or when a CI lint job has failed.
---

# Lint + fix

CodeHub uses **Biome** for the frontend (TypeScript, JavaScript, CSS, JSON, import organisation) and the standard **rustfmt + clippy** pair for the Rust backend. Both are configured at repo root.

## Frontend — Biome

Biome is one binary, one config (`biome.json`), no plugins.

### Check (no writes)

```bash
npm run check          # Format + lint + import organize, report only
npm run lint           # Lint only
```

### Auto-fix

```bash
npm run check:fix      # Format + safe lint fixes + import organize, in place
npm run lint:fix       # Lint auto-fixes only
npm run format         # Formatter only
```

Biome's `--write` is conservative — it only applies fixes flagged as `safe`. Unsafe rules surface as remaining diagnostics; resolve those by hand.

### Type check (separate from lint)

```bash
npm run typecheck      # tsc --noEmit, catches type errors Biome can't see
```

## Backend — Rust

### Format

```bash
cd src-tauri
cargo fmt --all          # write
cargo fmt --all -- --check   # report only (use in CI)
```

`rustfmt.toml` lives in `src-tauri/` and pins edition, line width, and import reordering.

### Clippy

```bash
cd src-tauri
cargo clippy --all-targets --all-features -- -D warnings
```

`-D warnings` upgrades every clippy lint to a hard error — matches the strictness we want for releases. During iteration you can drop `-D warnings` to keep going while you sweep.

Clippy auto-fix for the lints that support it:

```bash
cargo clippy --all-targets --all-features --fix --allow-dirty --allow-staged
```

`--allow-dirty` lets clippy modify uncommitted files. `--allow-staged` lets it modify files that are staged but not committed.

## One-shot full sweep

The Makefile wraps both pipelines:

```bash
make check     # Biome + tsc + rustfmt --check + clippy -D warnings (no writes)
make fix       # Apply all safe auto-fixes, then re-run make check
```

`make fix` does Biome safe fixes → `cargo fmt` → `cargo clippy --fix` (allow-dirty / allow-staged) → re-run `make check` to confirm the sweep is idempotent. If the final check fails, the remaining issues need manual judgement.

For the raw commands without Make:

```bash
npm run check:fix && \
(cd src-tauri && cargo fmt --all && cargo clippy --all-targets --all-features --fix --allow-dirty --allow-staged) && \
npm run typecheck && \
(cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings)
```

## When to run

- **Before opening a PR** — every time. Reviewers shouldn't be the lint feedback loop.
- **After merging main into a feature branch** — config drift can introduce new violations.
- **During the `release-cut` skill** — listed in its pre-flight implicitly; do not cut a release with red lints.
- **After editing `biome.json`, `rustfmt.toml`, or `clippy.toml`** — re-sweep the whole tree so the diff stays focused on the rule change, not on accumulated drift.

## Known intentional suppressions

The config lives in `biome.json`. Notable choices:

- `style.noNonNullAssertion: off` — `!` is occasionally idiomatic in DOM code (`querySelector("#known-id")!`) and Tauri IPC fan-out, where guarding adds noise without catching real bugs.
- `a11y.useKeyWithClickEvents: off` — the app's main interactions live in a desktop webview; keyboard events are wired separately via `term.onData` and global listeners.
- `suspicious.noConsoleLog: off` — backend errors surfaced via `console.error` are deliberate; the Tauri devtools console is the catchment.

If you find yourself wanting to add a per-line `biome-ignore` comment, first check whether the rule should be off globally. One-off ignores accumulate into noise.
