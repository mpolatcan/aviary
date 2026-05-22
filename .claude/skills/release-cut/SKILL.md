---
name: release-cut
description: Cut a new CodeHub release — version bump across Cargo / package.json / tauri.conf.json / runtime image, multi-arch image publish, GitHub release with .dmg bundle. Use only after TEST_SCENARIOS regression has been run green.
---

# Cut a CodeHub release

Pre-flight required:

- Working tree clean on `main`
- `TEST_SCENARIOS.md` regression checklist (the end-of-doc list) has been walked manually
- `cargo check` clean inside `src-tauri/`
- `npm run build` clean
- Docker Hub credentials available for `ghcr.io/mpolatcan/codehub-runtime`

## 1. Bump version everywhere

The version appears in four places. Update all to the same value (`X.Y.Z`):

- `package.json` — `"version": "X.Y.Z"`
- `src-tauri/Cargo.toml` — `version = "X.Y.Z"` under `[package]`
- `src-tauri/tauri.conf.json` — `"version": "X.Y.Z"`
- `src-tauri/src/lib.rs` — `const DEFAULT_IMAGE: &str = "ghcr.io/mpolatcan/codehub-runtime:X.Y.Z";`

Commit the version bump as its own commit: `chore: bump version to X.Y.Z`.

## 2. Publish the runtime image

From repo root, after the version bump in step 1 is committed:

```bash
make image-push          # multi-arch buildx push (linux/amd64, linux/arm64)
```

The `image-push` target reads the tag from `src-tauri/src/lib.rs:DEFAULT_IMAGE` and also retags `:latest`.

Verify the manifest after push:

```bash
docker buildx imagetools inspect ghcr.io/mpolatcan/codehub-runtime:X.Y.Z
```

Both `linux/amd64` and `linux/arm64` platforms must be listed.

## 3. Build the desktop bundles

```bash
make build
```

Outputs land in `src-tauri/target/release/bundle/`:

- macOS: `dmg/CodeHub_X.Y.Z_aarch64.dmg` and/or `_x64.dmg`
- Linux: `deb/codehub_X.Y.Z_amd64.deb`, `appimage/codehub_X.Y.Z_amd64.AppImage`

On macOS, repeat the build inside an x86_64 host (or use `--target x86_64-apple-darwin`) if you want a universal release. Sign + notarize with `xcrun notarytool` before publishing if you have a developer ID.

## 4. Tag + push

```bash
git tag -a vX.Y.Z -m "CodeHub X.Y.Z"
git push origin vX.Y.Z
```

## 5. GitHub release

```bash
gh release create vX.Y.Z \
  --title "CodeHub X.Y.Z" \
  --notes-file CHANGELOG-NEXT.md \
  src-tauri/target/release/bundle/dmg/*.dmg \
  src-tauri/target/release/bundle/appimage/*.AppImage \
  src-tauri/target/release/bundle/deb/*.deb
```

If a `CHANGELOG-NEXT.md` doesn't exist yet, draft inline with `--notes "..."` — but keeping a running changelog file is cleaner.

## 6. Post-release

- Open a PR that adds the next "unreleased" header to the changelog.
- Update `CLAUDE.md` if any conventions changed in this cut.
- If a CLI install URL was newly confirmed (e.g. Antigravity), remove the "Known limitations" warning.

## Rollback

If a release ships broken:

```bash
gh release delete vX.Y.Z --yes
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z
docker buildx imagetools create --tag ghcr.io/mpolatcan/codehub-runtime:latest \
  ghcr.io/mpolatcan/codehub-runtime:<previous-version>
```

Leave the broken runtime tag in place (`X.Y.Z`) for forensics — only re-point `latest`.
