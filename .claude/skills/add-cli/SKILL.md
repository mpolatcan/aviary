---
name: add-cli
description: Add a new AI coding agent CLI to CodeHub's lineup. Walks the four-file sync — Dockerfile, Rust enum, frontend spec, bird sprite — and the runtime rebuild that ships it.
---

# Add a new CLI to CodeHub

Adding a CLI is a four-file change. Skipping any step will produce silent runtime failures (modal entry exists but session dies, or vice versa). Do all four in one commit.

## 1. Dockerfile — install the binary

Edit `runtime/Dockerfile`. Add a `RUN` line in the install block:

```dockerfile
# <Name> (<vendor>)
RUN curl -fsSL <install-url> | bash
# or
RUN npm install -g <package>
```

Verify the binary lands on `PATH`. Some installers drop binaries to `~/.local/bin` — the Dockerfile already exports that via `ENV PATH`. Others install to `/usr/local/bin` (npm) automatically.

If the CLI needs a config dir, add an `ENV` line so the path is predictable and mountable under `/config`:

```dockerfile
ENV <NAME>_CONFIG_DIR=/config/<name>
```

## 2. Rust — `Cli` enum

Edit `src-tauri/src/docker.rs`:

- Add a variant to `enum Cli`.
- Update `Cli::binary()` to return the executable name on PATH.
- Update `Cli::parse()` to accept the lowercase id (and any sensible aliases).

The enum has `#[serde(rename_all = "lowercase")]`, so the frontend sends the lowercase variant name.

## 3. Frontend — `CLIS` array + `Cli` type

Edit `src/app/lib/catalog.ts`. Add an entry to the `CLIS: CliSpec[]` array with:

- `id`: matches the lowercase enum variant
- `label`: display name (e.g. "Claude Code")
- `alias`: short bird name used in the auto-generated session alias (e.g. "Owl")
- `species`: Latin/common species (decorative — the ornithological-field-journal vibe)
- `bird`: `#bird-<slug>` referencing an SVG symbol id in `index.html`

In the same file, add the new CLI to `MODE_SUPPORT` with its allowed launch modes
(`["standard", "auto", "yolo"]`, or `["standard"]` if flags are unverified).

Extend the `Cli` type union in `src/app/lib/ipc.ts`:

```ts
export type Cli = "claude" | "codex" | "antigravity" | "<new-id>";
```

## 4. SVG sprite — bird silhouette

Edit `index.html`. Add a `<symbol id="bird-<slug>" viewBox="0 0 64 64">` inside the existing `<defs>` block. Keep it a single-colour silhouette path that uses `fill="currentColor"` so the tab/modal colour transitions still apply. Bird species choice matters — pick one whose vibe matches the CLI's personality (owl = thoughtful, raven = scribe, falcon = speed, kingfisher = precise, etc.).

## 5. Bump runtime image tag

Edit `src-tauri/src/lib.rs`:

```rust
const DEFAULT_IMAGE: &str = "ghcr.io/mpolatcan/codehub-runtime:0.1.<NEXT>";
```

This ensures end users get a fresh pull when they update CodeHub.

## 6. Rebuild + verify

Invoke the `runtime-rebuild` skill with the new version tag. Then `npm run tauri dev`, open the modal, confirm the new card appears with the right bird and binomial, click it, confirm a working session.

## Checklist

- [ ] `runtime/Dockerfile` — install line + optional `ENV`
- [ ] `docker.rs` — `Cli` variant + `binary()` + `parse()`
- [ ] `src/app/lib/catalog.ts` — `CLIS` entry + `MODE_SUPPORT` entry
- [ ] `src/app/lib/ipc.ts` — `Cli` type union
- [ ] `index.html` — `<symbol id="bird-...">` in sprite
- [ ] `lib.rs` — `DEFAULT_IMAGE` tag bump
- [ ] Runtime image rebuilt + smoke-tested
- [ ] CLAUDE.md "Known limitations" updated if install URL is provisional
- [ ] One commit covering all of the above
