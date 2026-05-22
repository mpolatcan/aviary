---
name: runtime-rebuild
description: Rebuild and re-tag the CodeHub runtime Docker image. Use when the Dockerfile, CLI install commands, or base image change, or when verifying a clean rebuild against the current source.
---

# Rebuild CodeHub runtime image

Run this skill when any of:

- `runtime/Dockerfile` was edited
- a CLI install command was added, removed, or updated
- the runtime tag in `lib.rs` (`DEFAULT_IMAGE`) was bumped
- you want to verify a clean build from scratch (no Docker layer cache)

## Steps

1. **Confirm tag.** Read `src-tauri/src/lib.rs` and locate `DEFAULT_IMAGE` (line near the top of `run()`). The version after `:` is the source of truth.

2. **Build.** From repo root:

   ```bash
   make image                # equivalent to: docker build -t <repo>:<VERSION> runtime/
   make image-nocache        # --no-cache, guaranteed-clean rebuild
   ```

   Both targets parse the version from `src-tauri/src/lib.rs:DEFAULT_IMAGE`. Override via:

   ```bash
   make image IMAGE_TAG=0.2.0
   ```

3. **Smoke-test inside the image** before declaring success:

   ```bash
   make image-verify
   ```

   Every CLI must produce a path + version. If `which antigravity` is added it will currently fail because Antigravity install is commented out — that is expected; do not block on it.

4. **Tag `latest`** only if this is the canonical version on `main`:

   ```bash
   docker tag ghcr.io/mpolatcan/codehub-runtime:<VERSION> ghcr.io/mpolatcan/codehub-runtime:latest
   ```

5. **Multi-arch build for publishing** (only when cutting a release — see `release-cut` skill):

   ```bash
   make image-push          # buildx --platform linux/amd64,linux/arm64 --push
   ```

## Notes

- `SHELL ["bash", "-euo", "pipefail", "-c"]` at the top of the Dockerfile is intentional. If a `curl … | bash` install line fails silently, pipefail surfaces it as a build error. Don't remove this.
- If the build succeeds but a CLI is missing in the smoke test, suspect a silent install failure — re-run with `--progress=plain` and inspect the relevant `RUN` step.
- Layer caching: editing a line invalidates all subsequent `RUN` layers. Cluster slow installs (Claude, Codex, Antigravity) above lines that change often (config envs) to maximize cache reuse during iteration.
