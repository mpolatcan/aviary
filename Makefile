# =============================================================================
# CodeHub — developer convenience targets.
#
# All paths are relative to repo root. Run `make help` for a quick reference.
# Variables (override on the command line, e.g. `make image IMAGE_TAG=0.2.0`):
#
#   IMAGE_TAG     Runtime image tag.  Default: parsed from src-tauri/src/lib.rs
#   IMAGE_REPO    Runtime image repo. Default: ghcr.io/mpolatcan/codehub-runtime
#   PLATFORMS     buildx platforms.   Default: linux/amd64,linux/arm64
#   CONTAINER     Runtime container name (debug helpers). Default: codehub-runtime
# =============================================================================

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

IMAGE_REPO ?= ghcr.io/mpolatcan/codehub-runtime
IMAGE_TAG  ?= $(shell grep -E 'DEFAULT_IMAGE' src-tauri/src/lib.rs | sed -E 's/.*:([0-9]+\.[0-9]+\.[0-9]+).*/\1/' | head -n1)
IMAGE      := $(IMAGE_REPO):$(IMAGE_TAG)
PLATFORMS  ?= linux/amd64,linux/arm64
CONTAINER  ?= codehub-runtime

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

.PHONY: install
install: ## Install npm dependencies (also fetches Rust deps lazily on first build)
	npm install

.PHONY: install-ci
install-ci: ## Install npm dependencies for CI (lockfile-strict)
	npm ci

# ---------------------------------------------------------------------------
# Development
# ---------------------------------------------------------------------------

.PHONY: dev
dev: ## Run Tauri dev (Vite + Rust, hot-reload frontend)
	npm run tauri dev

.PHONY: dev-server
dev-server: ## Run only the browser-mode backend bridge (HTTP/WS on :4555)
	cd src-tauri && cargo run --bin codehub-devserver --features devserver

.PHONY: dev-web
dev-web: ## Browser-mode dev: Vite (:1420) + backend bridge (:4555), no Tauri window
	@echo "Vite → http://localhost:1420  ·  bridge → /__bridge → :4555  (Ctrl-C to stop both)"
	@trap 'kill 0' EXIT; \
	  ( cd src-tauri && cargo run --bin codehub-devserver --features devserver ) & \
	  npm run dev & \
	  wait

.PHONY: build
build: ## Production build — Tauri bundle (DMG/AppImage/deb under src-tauri/target/release/bundle/)
	npm run tauri build

.PHONY: preview
preview: ## Preview the built frontend without Tauri (web only)
	npm run preview

# ---------------------------------------------------------------------------
# Lint, format, type-check
# ---------------------------------------------------------------------------

.PHONY: check
check: check-frontend check-backend ## Full sweep — Biome + tsc + rustfmt + clippy, no writes

.PHONY: check-frontend
check-frontend: ## Frontend: Biome check + tsc --noEmit
	npm run check
	npm run typecheck

.PHONY: check-backend
check-backend: ## Backend: rustfmt --check + clippy -D warnings
	cd src-tauri && cargo fmt --all -- --check
	cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings

.PHONY: fix
fix: ## Apply all safe auto-fixes (Biome + rustfmt + clippy --fix), then re-check
	npm run check:fix
	cd src-tauri && cargo fmt --all
	cd src-tauri && cargo clippy --all-targets --all-features --fix --allow-dirty --allow-staged || true
	$(MAKE) check

.PHONY: typecheck
typecheck: ## TypeScript type-check only
	npm run typecheck

# ---------------------------------------------------------------------------
# Runtime image
# ---------------------------------------------------------------------------

.PHONY: image
image: ## Build runtime image locally (host arch only) — tag from lib.rs
	docker build -t $(IMAGE) runtime/
	@echo "built $(IMAGE)"

.PHONY: image-nocache
image-nocache: ## Build runtime image with --no-cache (clean rebuild)
	docker build --no-cache -t $(IMAGE) runtime/

.PHONY: image-verify
image-verify: ## Smoke-test installed CLIs inside the runtime image
	docker run --rm --entrypoint bash $(IMAGE) -c "\
	  which claude && \
	  which codex && \
	  which tmux && \
	  claude --version && \
	  codex --version && \
	  tmux -V"

.PHONY: image-push
image-push: ## Multi-arch build + push (release path — use the release-cut skill)
	docker buildx build \
	  --platform $(PLATFORMS) \
	  -t $(IMAGE) \
	  -t $(IMAGE_REPO):latest \
	  --push runtime/

.PHONY: image-tag
image-tag: ## Print the image tag currently expected by the backend
	@echo $(IMAGE)

# ---------------------------------------------------------------------------
# Runtime container debug helpers
# ---------------------------------------------------------------------------

.PHONY: shell
shell: ## Open an interactive shell inside the running runtime container
	docker exec -it $(CONTAINER) bash

.PHONY: tmux-ls
tmux-ls: ## List tmux sessions inside the runtime container
	docker exec $(CONTAINER) tmux -S /tmp/codehub/default ls 2>/dev/null || echo "no tmux server (no sessions yet)"

.PHONY: ctr-logs
ctr-logs: ## Tail runtime container logs
	docker logs -f $(CONTAINER)

.PHONY: ctr-status
ctr-status: ## Show runtime container state (running / stopped / missing)
	@docker ps -a --filter "name=^$(CONTAINER)$$" --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' || true

.PHONY: ctr-stop
ctr-stop: ## Stop the runtime container
	-docker stop $(CONTAINER)

.PHONY: ctr-rm
ctr-rm: ## Remove the runtime container (preserves bind-mounted volumes)
	-docker rm -f $(CONTAINER)

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

.PHONY: clean
clean: ## Remove build artifacts (target, dist, node_modules)
	rm -rf src-tauri/target dist node_modules

.PHONY: clean-image
clean-image: ## Remove the locally built runtime image
	-docker image rm $(IMAGE)

# ---------------------------------------------------------------------------
# Self-doc
# ---------------------------------------------------------------------------

.PHONY: help
help: ## Show this help (group + target + one-line description)
	@awk 'BEGIN {FS = ":.*##"; printf "Usage: make \033[36m<target>\033[0m\n\nTargets:\n"} \
	  /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2 } \
	  /^## .*$$/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 4) }' $(MAKEFILE_LIST)
