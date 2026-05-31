//! Per-workspace container manager.
//!
//! Every workspace gets its own container (`codehub-ws-<key>`) so the hub's
//! fleet view reports REAL per-workspace cpu/mem/net/disk/state.
//!
//! The manager connects to the daemon ONCE and shares that `Docker` handle
//! across every `Lifecycle` it produces (cheap clones), caching one `Lifecycle`
//! per resolved container name.

use crate::config::ConfigStore;
use crate::docker::{DockerClient, SessionInfo};
use crate::lifecycle::{
    ContainerState, ContainerStatus, DockerInfo, Lifecycle, LifecycleError, LifecycleParts,
};
use bollard::container::ListContainersOptions;
use bollard::Docker;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Docker label keys that mark a container as a CodeHub-managed per-workspace
/// container and record its original workspace key. Written at create-time in
/// `Lifecycle::ensure_container`; read back by `list_workspace_containers`.
const LABEL_MANAGED: &str = "codehub.managed";
const LABEL_WORKSPACE: &str = "codehub.workspace";

/// One CodeHub-managed per-workspace container: its workspace key plus a
/// `ContainerStatus` derived from the SINGLE `list_containers` sweep (no extra
/// per-container `status()` round-trips). Backs the fleet/Workspaces inspector.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContainer {
    /// Original workspace key (the `codehub.workspace` label).
    pub key: String,
    /// State + id + image + name, same shape every other container surface uses.
    pub status: ContainerStatus,
}

/// Map a docker `state` string (from `list_containers`) to our `ContainerState`,
/// mirroring `Lifecycle::status`. A listed container always exists, so `Missing`
/// / `Unreachable` never apply here.
fn map_list_state(s: Option<&str>) -> ContainerState {
    match s {
        Some("running") => ContainerState::Running,
        Some("restarting") => ContainerState::Starting,
        _ => ContainerState::Stopped,
    }
}

/// Prefix for per-workspace container names: `codehub-ws-<sanitized-key>`.
pub const WS_CONTAINER_PREFIX: &str = "codehub-ws-";

/// FNV-1a 64-bit hash. A FIXED algorithm (implemented inline, no dependency) so
/// the value is stable across process runs AND Rust/toolchain versions —
/// container identity must survive app upgrades, which rules out `DefaultHasher`
/// (its algorithm is explicitly allowed to change between releases, which would
/// orphan every existing per-workspace container after an upgrade).
fn fnv1a_64(s: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in s.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Coerce an arbitrary workspace key into a UNIQUE, valid Docker container-name
/// segment. Docker names must match `[a-zA-Z0-9][a-zA-Z0-9_.-]*`.
///
/// The readable slug (lowercase, non-alphanumerics collapsed to single `-`,
/// trimmed, capped) is LOSSY — `hello_world`, `hello-world` and `Hello World!`
/// all slug to `hello-world`, and empty/separator-only keys slug to nothing — so
/// the slug alone cannot be the identity without colliding distinct workspaces
/// onto one container (shared mount + tmux sessions). We therefore append a hash
/// of the FULL ORIGINAL key: `<slug>-<fnv1a_hex>` (or just the hash when the slug
/// is empty). Distinct keys get distinct names; the slug is human-facing garnish.
pub fn sanitize_key(key: &str) -> String {
    let mut slug = String::with_capacity(key.len());
    let mut prev_dash = false;
    for ch in key.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }
    let slug: String = slug.chars().take(32).collect();
    let slug = slug.trim_matches('-');
    let hash = fnv1a_64(key);
    if slug.is_empty() {
        format!("{hash:016x}")
    } else {
        format!("{slug}-{hash:016x}")
    }
}

pub struct LifecycleManager {
    docker: Docker,
    image: String,
    config_dir: PathBuf,
    default_workspace_dir: PathBuf,
    config: Arc<ConfigStore>,
    vault: Option<Arc<crate::vault::Vault>>,
    cache: Mutex<HashMap<String, Arc<Lifecycle>>>,
}

impl LifecycleManager {
    pub fn new(
        image: String,
        config_dir: PathBuf,
        default_workspace_dir: PathBuf,
        config: Arc<ConfigStore>,
    ) -> Result<Self, LifecycleError> {
        let docker = Docker::connect_with_local_defaults()?;
        Ok(Self {
            docker,
            image,
            config_dir,
            default_workspace_dir,
            config,
            vault: None,
            cache: Mutex::new(HashMap::new()),
        })
    }

    pub fn with_vault(mut self, vault: Arc<crate::vault::Vault>) -> Self {
        self.vault = Some(vault);
        self
    }

    /// Container name for a per-workspace key: `codehub-ws-<sanitized-key>`.
    fn container_name_for(&self, key: &str) -> String {
        format!("{WS_CONTAINER_PREFIX}{}", sanitize_key(key))
    }

    /// Resolve the lifecycle for a workspace `key`. Returns/caches a dedicated
    /// `codehub-ws-<key>` lifecycle. `workspace_dir` pins the `/workspace` bind
    /// when explicitly provided; `None` lets the lifecycle resolve it from config.
    fn for_workspace(&self, key: &str, workspace_dir: Option<PathBuf>) -> Arc<Lifecycle> {
        self.build_workspace(key, workspace_dir)
    }

    /// Alias for `for_workspace(key, None)` — resolves the lifecycle for a
    /// workspace container by key, without overriding the workspace dir.
    pub fn workspace_container(&self, key: &str) -> Arc<Lifecycle> {
        self.build_workspace(key, None)
    }

    /// Build/cache a per-workspace container lifecycle. With NO explicit dir the
    /// container mounts the config-driven workspace dir (else the built-in
    /// default). `override = None` lets `Lifecycle::workspace_dir()` resolve that
    /// path; `enforce = false` so passive resolves never recreate. An EXPLICIT
    /// per-tab dir (`Some`) is a deliberate mount choice → pinned and enforced
    /// (recreate a container bound elsewhere).
    fn build_workspace(&self, key: &str, workspace_dir: Option<PathBuf>) -> Arc<Lifecycle> {
        let name = self.container_name_for(key);
        let (dir, enforce) = match workspace_dir {
            Some(d) => (Some(d), true),
            None => (None, false),
        };
        self.get_or_build(name, dir, Some(key.to_string()), enforce)
    }

    /// Resolve by workspace key. The key is required — every session belongs to a
    /// workspace. `workspace_dir` optionally pins the mount.
    pub fn resolve(&self, key: &str, workspace_dir: Option<PathBuf>) -> Arc<Lifecycle> {
        self.for_workspace(key, workspace_dir)
    }

    /// Raw bollard `Docker` handle — for daemon-level operations (`docker_info`,
    /// `resize_exec`) that don't need a specific container.
    pub fn docker_handle(&self) -> Docker {
        self.docker.clone()
    }

    /// Daemon reachability + version. Best-effort: an unreachable daemon yields
    /// `reachable: false` with empty version fields rather than an error.
    pub async fn docker_info(&self) -> DockerInfo {
        match self.docker.version().await {
            Ok(v) => DockerInfo {
                reachable: true,
                version: v.version,
                api_version: v.api_version,
            },
            Err(_) => DockerInfo {
                reachable: false,
                version: None,
                api_version: None,
            },
        }
    }

    /// The configured pinned runtime image tag (`CODEHUB_IMAGE` / default).
    /// Always available without a container — the New Workspace wizard shows it
    /// as the base image before any workspace container exists.
    pub fn image(&self) -> &str {
        &self.image
    }

    /// Return a `DockerClient` for any running workspace container. Used by
    /// global commands (agent_versions, claude_usage, etc.) that need a container
    /// but aren't workspace-specific. Returns `None` when no containers are
    /// running.
    pub async fn any_running_docker(&self) -> Option<Arc<DockerClient>> {
        for wc in self.list_workspace_containers().await.ok()? {
            if wc.status.state == ContainerState::Running {
                return Some(Arc::new(DockerClient::from_docker(
                    self.docker.clone(),
                    wc.status.name,
                )));
            }
        }
        None
    }

    fn get_or_build(
        &self,
        container_name: String,
        dir: Option<PathBuf>,
        label: Option<String>,
        enforce_mount: bool,
    ) -> Arc<Lifecycle> {
        let mut cache = self.cache.lock().expect("lifecycle cache poisoned");
        if let Some(existing) = cache.get(&container_name) {
            if existing.workspace_dir_override == dir && existing.enforce_mount == enforce_mount {
                return existing.clone();
            }
        }
        let vault_env = self.build_vault_env();
        let lifecycle = Arc::new(Lifecycle::from_parts(LifecycleParts {
            docker: self.docker.clone(),
            container_name: container_name.clone(),
            image: self.image.clone(),
            config_dir: self.config_dir.clone(),
            default_workspace_dir: self.default_workspace_dir.clone(),
            config: self.config.clone(),
            workspace_dir_override: dir,
            workspace_label: label,
            enforce_mount,
            vault_env,
        }));
        cache.insert(container_name, lifecycle.clone());
        lifecycle
    }

    /// Vault-backed secrets are intentionally not injected at container-create
    /// time — they're read just-in-time by `create_session`, so merely opening a
    /// workspace never decrypts a credential it won't use. GitHub operations
    /// should do the same when they need the token.
    fn build_vault_env(&self) -> Vec<String> {
        let _vault_configured = self.vault.is_some();
        Vec::new()
    }

    /// Enumerate every CodeHub-managed workspace container (label
    /// `codehub.managed=true`) with its workspace key + status. The key is the
    /// `codehub.workspace` label (the ORIGINAL workspace key); the container name
    /// alone can't yield it because `sanitize_key` is one-way. Includes stopped
    /// containers (`all: true`) so a closed-but-kept workspace is still listed
    /// (the Prune affordance removes them). Status is built from this one sweep —
    /// no extra per-container round-trips. Containers missing the workspace label
    /// are skipped.
    pub async fn list_workspace_containers(
        &self,
    ) -> Result<Vec<WorkspaceContainer>, LifecycleError> {
        let mut filters = HashMap::new();
        filters.insert("label".to_string(), vec![format!("{LABEL_MANAGED}=true")]);
        let containers = self
            .docker
            .list_containers(Some(ListContainersOptions::<String> {
                all: true,
                filters,
                ..Default::default()
            }))
            .await?;

        let mut out = Vec::new();
        for c in containers {
            let key = c
                .labels
                .as_ref()
                .and_then(|l| l.get(LABEL_WORKSPACE).cloned());
            let name = c
                .names
                .as_ref()
                .and_then(|n| n.first())
                .map(|s| s.trim_start_matches('/').to_string());
            let (Some(name), Some(key)) = (name, key) else {
                continue;
            };
            out.push(WorkspaceContainer {
                key,
                status: ContainerStatus {
                    state: map_list_state(c.state.as_deref()),
                    id: c.id.clone(),
                    image: c.image.clone().unwrap_or_else(|| self.image.clone()),
                    name,
                },
            });
        }
        Ok(out)
    }

    /// All tmux sessions across every workspace container, each tagged with the
    /// workspace key it belongs to. A container that is down or has no sessions
    /// contributes nothing rather than failing the whole listing. This is what
    /// lets startup restore reconstruct each workspace's tab and re-tie its
    /// sessions to the right container.
    pub async fn list_all_sessions(&self) -> Result<Vec<SessionInfo>, LifecycleError> {
        let mut all = Vec::new();
        for wc in self.list_workspace_containers().await.unwrap_or_default() {
            if wc.status.state != ContainerState::Running {
                continue;
            }
            let dc = DockerClient::from_docker(self.docker.clone(), wc.status.name);
            let mut sessions = dc.list_tmux_sessions().await.unwrap_or_default();
            for s in &mut sessions {
                s.workspace = Some(wc.key.clone());
            }
            all.extend(sessions);
        }
        Ok(all)
    }

    /// Remove a workspace container by key (Prune / explicit delete); a no-op
    /// when the container is already gone.
    pub async fn remove_workspace(&self, key: &str) -> Result<(), LifecycleError> {
        self.workspace_container(key).remove().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ConfigStore;
    use std::sync::Arc;

    fn manager() -> LifecycleManager {
        let config = Arc::new(ConfigStore::load(
            std::env::temp_dir().join("codehub-manager-test-settings.json"),
        ));
        LifecycleManager::new(
            "img:test".into(),
            std::env::temp_dir().join("codehub-test-config"),
            std::env::temp_dir().join("codehub-test-workspace"),
            config,
        )
        .expect("manager builds")
    }

    fn assert_valid_segment(s: &str) {
        assert!(!s.is_empty(), "segment must not be empty");
        assert!(s.len() <= 64, "segment too long: {s} ({})", s.len());
        let first = s.chars().next().unwrap();
        assert!(
            first.is_ascii_alphanumeric(),
            "must start alphanumeric: {s}"
        );
        assert!(
            s.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
            "invalid chars in segment: {s}"
        );
    }

    #[test]
    fn sanitize_key_produces_valid_docker_segments() {
        for k in [
            "ws-aurora-lq3k9",
            "Hello World!",
            "///",
            "",
            &"x".repeat(200),
        ] {
            assert_valid_segment(&sanitize_key(k));
        }
        assert!(sanitize_key("ws-aurora-lq3k9").starts_with("ws-aurora-lq3k9-"));
        assert_eq!(sanitize_key("aurora"), sanitize_key("aurora"));
    }

    #[test]
    fn sanitize_key_never_collides_distinct_keys() {
        let colliding = ["hello_world", "hello-world", "hello.world", "Hello World!"];
        let names: std::collections::HashSet<_> =
            colliding.iter().map(|k| sanitize_key(k)).collect();
        assert_eq!(
            names.len(),
            colliding.len(),
            "lossy slugs collided: {names:?}"
        );
        assert_ne!(sanitize_key(""), sanitize_key("///"));
        assert_ne!(sanitize_key(""), sanitize_key("ws"));
    }

    #[test]
    fn container_name_uses_ws_prefix() {
        let m = manager();
        let name = m.container_name_for("aurora");
        assert!(name.starts_with("codehub-ws-aurora-"), "got {name}");
        assert!(name.len() <= 255);
    }

    #[test]
    fn for_workspace_always_returns_per_workspace_container() {
        let m = manager();
        let ws = m.for_workspace("aurora", None);
        assert_eq!(ws.container_name, m.container_name_for("aurora"));
        assert!(ws.container_name.starts_with("codehub-ws-aurora-"));
        assert_eq!(ws.workspace_label.as_deref(), Some("aurora"));
        assert!(ws.workspace_dir_override.is_none());
        assert!(!ws.enforce_mount);
        // cached
        assert!(Arc::ptr_eq(&ws, &m.for_workspace("aurora", None)));
        assert!(Arc::ptr_eq(&ws, &m.workspace_container("aurora")));

        // re-pointing the SAME workspace at a different dir must rebuild
        let a = m.for_workspace("borealis", Some(PathBuf::from("/tmp/a")));
        assert_eq!(
            a.workspace_dir_override.as_deref(),
            Some(PathBuf::from("/tmp/a").as_path())
        );
        let b = m.for_workspace("borealis", Some(PathBuf::from("/tmp/b")));
        assert!(
            !Arc::ptr_eq(&a, &b),
            "changed mount must rebuild the lifecycle"
        );
        assert_eq!(
            b.workspace_dir_override.as_deref(),
            Some(PathBuf::from("/tmp/b").as_path())
        );
        assert!(Arc::ptr_eq(
            &b,
            &m.for_workspace("borealis", Some(PathBuf::from("/tmp/b")))
        ));

        // explicit re-point must not reuse a non-enforcing cache entry
        let passive = m.for_workspace("cobalt", None);
        assert!(!passive.enforce_mount, "defaulted dir → not enforced");
        assert!(passive.workspace_dir_override.is_none());
        let explicit_dir = PathBuf::from("/tmp/cobalt-explicit");
        let explicit = m.for_workspace("cobalt", Some(explicit_dir.clone()));
        assert!(explicit.enforce_mount, "explicit dir → enforced");
        assert!(
            !Arc::ptr_eq(&passive, &explicit),
            "explicit re-point must rebuild"
        );
        assert_eq!(
            explicit.workspace_dir_override.as_deref(),
            Some(explicit_dir.as_path())
        );
    }
}
