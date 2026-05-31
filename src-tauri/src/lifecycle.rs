use crate::config::ConfigStore;
use crate::docker::{self, DockerClient};
use bollard::container::{
    Config, CreateContainerOptions, InspectContainerOptions, ListContainersOptions,
    RemoveContainerOptions, StartContainerOptions, StopContainerOptions,
};
use bollard::image::CreateImageOptions;
use bollard::models::{HostConfig, Mount, MountTypeEnum, PortBinding};
use bollard::Docker;
use futures_util::StreamExt;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum LifecycleError {
    #[error("bollard: {0}")]
    Bollard(#[from] bollard::errors::Error),
    #[error("docker daemon unreachable — is Docker Desktop running?")]
    DaemonDown,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ContainerState {
    Missing,
    Stopped,
    Starting,
    Running,
    Unreachable,
}

#[derive(Debug, Serialize, Clone)]
pub struct ContainerStatus {
    pub state: ContainerState,
    pub id: Option<String>,
    pub image: String,
    pub name: String,
}

pub struct LifecycleParts {
    pub docker: Docker,
    pub container_name: String,
    pub image: String,
    pub config_dir: PathBuf,
    pub default_workspace_dir: PathBuf,
    pub config: Arc<ConfigStore>,
    pub workspace_dir_override: Option<PathBuf>,
    pub workspace_label: Option<String>,
    pub enforce_mount: bool,
    pub vault_env: Vec<String>,
}

// Host auth env vars each CLI can authenticate from, in priority order. Keys are
// read from the host environment and forwarded into the runtime container —
// CodeHub never stores them. The empty-state / settings
// "key status" reports presence only and must NEVER surface the value.
const CLAUDE_VARS: &[&str] = &["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
const CODEX_VARS: &[&str] = &["OPENAI_API_KEY"];
const ANTIGRAVITY_VARS: &[&str] = &["GOOGLE_API_KEY", "GEMINI_API_KEY"];

fn all_auth_vars() -> impl Iterator<Item = &'static str> {
    CLAUDE_VARS
        .iter()
        .chain(CODEX_VARS)
        .chain(ANTIGRAVITY_VARS)
        .copied()
}

/// `KEY=value` pairs for every known auth var present on the host, forwarded
/// verbatim into the container so each CLI reads the name it expects. Values are
/// never logged.
pub fn auth_env() -> Vec<String> {
    auth_env_with(&[])
}

/// Like [`auth_env`] but also forwards any `extra` env var NAMES present on the
/// host — used to carry custom-named account-profile credentials (e.g.
/// `CLAUDE_TOKEN_WORK`) into the container so a session can remap the CLI's
/// canonical var to one of them by NAME, without the value ever appearing on a
/// command line. Names are deduped against the built-in set. Values never logged.
pub fn auth_env_with(extra: &[String]) -> Vec<String> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = Vec::new();
    let builtin = all_auth_vars().map(|s| s.to_string());
    for v in builtin.chain(extra.iter().cloned()) {
        if !seen.insert(v.clone()) {
            continue;
        }
        // Presence probe binds the value only to forward it; never logged.
        if let Ok(val) = std::env::var(&v) {
            out.push(format!("{v}={val}"));
        }
    }
    out
}

/// Presence-only auth status for one CLI. Carries which env var satisfied it by
/// NAME only — never the value. Serialized to the frontend as-is.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub present: bool,
    /// Always "env": keys come from the host environment, not the vault.
    pub source: &'static str,
    /// Name of the env var that satisfied the check, if any. Name only.
    pub var_name: Option<String>,
}

fn key_status_for(vars: &[&str]) -> KeyStatus {
    for v in vars {
        // Presence probe only — `is_ok()` never binds the secret value.
        if std::env::var(v).is_ok() {
            return KeyStatus {
                present: true,
                source: "env",
                var_name: Some((*v).to_string()),
            };
        }
    }
    KeyStatus {
        present: false,
        source: "env",
        var_name: None,
    }
}

/// Per-CLI presence of a host auth key. Reports booleans + var names only.
pub fn agent_key_status() -> HashMap<String, KeyStatus> {
    HashMap::from([
        ("claude".to_string(), key_status_for(CLAUDE_VARS)),
        ("codex".to_string(), key_status_for(CODEX_VARS)),
        ("antigravity".to_string(), key_status_for(ANTIGRAVITY_VARS)),
    ])
}

/// Docker daemon reachability + version, for the empty-state pill and Settings.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DockerInfo {
    pub reachable: bool,
    pub version: Option<String>,
    pub api_version: Option<String>,
}

/// Build + host platform identity for the Settings "About" pane. Every field is
/// a compile-time crate constant or a `std::env::consts` value — nothing is
/// fabricated and there is no network/update check.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    /// Target OS, e.g. "macos", "linux", "windows".
    pub os: String,
    /// Target architecture, e.g. "aarch64", "x86_64".
    pub arch: String,
    /// OS family, e.g. "unix", "windows".
    pub family: String,
    pub commit_hash: Option<String>,
    pub build_date: Option<String>,
}

/// App + platform identity from build-time constants (no I/O, never fails).
pub fn app_info() -> AppInfo {
    AppInfo {
        name: env!("CARGO_PKG_NAME").to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        family: std::env::consts::FAMILY.to_string(),
        commit_hash: option_env!("CODEHUB_COMMIT").map(|s| s.to_string()),
        build_date: option_env!("CODEHUB_BUILD_DATE").map(|s| s.to_string()),
    }
}

/// Host memory + disk stats (About screen).
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HostStats {
    pub memory_total: u64,
    pub memory_available: u64,
    pub disk_total: u64,
    pub disk_available: u64,
}

/// Read host stats via platform commands (no new crate).
pub fn host_stats() -> HostStats {
    let mut stats = HostStats {
        memory_total: 0,
        memory_available: 0,
        disk_total: 0,
        disk_available: 0,
    };
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
        {
            if let Ok(s) = String::from_utf8(out.stdout) {
                stats.memory_total = s.trim().parse().unwrap_or(0);
            }
        }
        if let Ok(out) = std::process::Command::new("vm_stat").output() {
            if let Ok(s) = String::from_utf8(out.stdout) {
                let page_size: u64 = 16384;
                let free: u64 = s
                    .lines()
                    .find(|l| l.contains("Pages free"))
                    .and_then(|l| l.split_whitespace().last())
                    .and_then(|n| n.trim_end_matches('.').parse().ok())
                    .unwrap_or(0);
                stats.memory_available = free * page_size;
            }
        }
    }
    if let Ok(out) = std::process::Command::new("df").args(["-k", "/"]).output() {
        if let Ok(s) = String::from_utf8(out.stdout) {
            if let Some(line) = s.lines().nth(1) {
                let cols: Vec<&str> = line.split_whitespace().collect();
                if cols.len() >= 4 {
                    stats.disk_total = cols[1].parse::<u64>().unwrap_or(0) * 1024;
                    stats.disk_available = cols[3].parse::<u64>().unwrap_or(0) * 1024;
                }
            }
        }
    }
    stats
}

/// Runtime tool versions from inside a container.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeVersions {
    pub node: Option<String>,
    pub tmux: Option<String>,
    pub git: Option<String>,
}

/// Where `/workspace` mounts from, and whether the container needs recreating to
/// pick up a changed choice. `mounted` is the host path the *running* container
/// actually has bound (from `docker inspect`); `effective` is what config selects
/// now. They differ after the user changes the workspace dir but before the
/// runtime is recreated — `needs_recreate` flags exactly that.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    /// Host dir config currently selects for `/workspace`.
    pub effective: String,
    /// Host dir the running container actually has bound, if any.
    pub mounted: Option<String>,
    /// True when a container exists and its bound dir differs from `effective`.
    pub needs_recreate: bool,
}

pub struct Lifecycle {
    pub docker: Docker,
    pub container_name: String,
    pub image: String,
    pub config_dir: PathBuf,
    /// Built-in per-user workspace dir, used when config selects none.
    pub default_workspace_dir: PathBuf,
    /// UI/config store; the effective workspace dir + account profiles are read
    /// from here at container-create time (Tier-2 / Tier-3).
    pub config: Arc<ConfigStore>,
    /// Explicit workspace directory override. When `Some`, this directory is
    /// bound at `/workspace` authoritatively and the global config `workspace_dir`
    /// is ignored — each workspace owns its own mount. `None` lets the lifecycle
    /// resolve the dir from config. Built by `LifecycleManager::for_workspace`.
    pub workspace_dir_override: Option<PathBuf>,
    /// The ORIGINAL workspace key this container represents (before
    /// `sanitize_key` mangles it into the container name). Stamped onto the
    /// container as the `codehub.workspace` label at create-time so multi-container
    /// listing can recover it and startup restore can re-tie the session to its
    /// real workspace.
    pub workspace_label: Option<String>,
    /// Whether to RECREATE an existing container when its live `/workspace` bind
    /// no longer matches `workspace_dir()`. True ONLY when the caller EXPLICITLY
    /// requested a mount (e.g. re-pointing a workspace at a new repo dir) — a
    /// deliberate, destructive mount change. False for passive ops (start /
    /// restart / status), so they never silently recreate a container onto a
    /// different mount and lose its sessions.
    pub enforce_mount: bool,
    /// Extra `KEY=value` env vars injected into the container at create-time,
    /// sourced from vault-backed account profiles. Populated by the manager
    /// when the lifecycle is resolved, so `ensure_container` can inject them
    /// alongside the host-env-forwarded vars.
    pub vault_env: Vec<String>,
}

impl Lifecycle {
    /// Build a `Lifecycle` reusing an existing daemon connection (the manager
    /// connects once and shares the `Docker` handle across every workspace
    /// lifecycle). `workspace_dir_override` pins the `/workspace` bind;
    /// pass `None` to let the lifecycle resolve the dir from config.
    pub fn from_parts(parts: LifecycleParts) -> Self {
        let LifecycleParts {
            docker,
            container_name,
            image,
            config_dir,
            default_workspace_dir,
            config,
            workspace_dir_override,
            workspace_label,
            enforce_mount,
            vault_env,
        } = parts;
        Self {
            docker,
            container_name,
            image,
            config_dir,
            default_workspace_dir,
            config,
            workspace_dir_override,
            workspace_label,
            enforce_mount,
            vault_env,
        }
    }

    /// Host directory to bind at `/workspace`.
    ///
    /// When `workspace_dir_override` is `Some`, the override is returned verbatim
    /// — it is created on demand by `ensure_container`, so it need not exist yet.
    /// When `None`, uses the config's `workspace_dir` if set and still an existing
    /// directory, otherwise the built-in default. A configured-but-missing dir
    /// falls back rather than failing the container create.
    pub fn workspace_dir(&self) -> PathBuf {
        if let Some(dir) = &self.workspace_dir_override {
            return dir.clone();
        }
        match self.config.get().workspace_dir {
            Some(d) if std::path::Path::new(&d).is_dir() => PathBuf::from(d),
            _ => self.default_workspace_dir.clone(),
        }
    }

    /// The `SavedWorkspace` this container represents, matched by `workspace_label`.
    /// The label is the frontend CONTAINER key, which for a saved workspace is
    /// `<name-slug>-<id>` (or just `<id>` when the name slugs to nothing). Ids are
    /// globally unique, so an id-suffix match identifies the workspace without
    /// re-deriving the lossy slug in Rust. `None` for ad-hoc tabs / unsaved
    /// containers (no label, or no matching saved entry).
    fn saved_workspace(&self) -> Option<crate::config::SavedWorkspace> {
        let key = self.workspace_label.as_ref()?;
        self.config
            .get()
            .saved_workspaces
            .into_iter()
            .find(|w| *key == w.id || key.ends_with(&format!("-{}", w.id)))
    }

    /// Resolve container resource limits: per-workspace override (from
    /// SavedWorkspace.sizing) → global default_sizing → hardcoded default.
    fn resolve_sizing(&self) -> crate::config::ContainerSizing {
        if let Some(sizing) = self.saved_workspace().and_then(|w| w.sizing) {
            return sizing;
        }
        self.config.get().default_sizing
    }

    /// Extra host dirs bind-mounted alongside `/workspace`, from this container's
    /// SavedWorkspace (`additional_dirs`). Each lands at `/workspace/<basename>`.
    /// Empty for ad-hoc tabs / unsaved containers. Read at create-time, so adding
    /// a repo to an existing workspace takes effect on the next container recreate.
    fn resolve_additional_dirs(&self) -> Vec<PathBuf> {
        self.saved_workspace()
            .map(|w| w.additional_dirs)
            .unwrap_or_default()
            .into_iter()
            .filter(|d| !d.trim().is_empty())
            .map(PathBuf::from)
            .collect()
    }

    /// Env var NAMES referenced by env-backed account profiles, so they get
    /// forwarded into the container at create-time. Names only — never values.
    /// Vault-backed profiles are read only when a selected account is launched.
    fn profile_env_vars(&self) -> Vec<String> {
        self.config
            .get()
            .account_profiles
            .into_iter()
            .filter_map(|p| p.var_name().map(|s| s.to_string()))
            .collect()
    }

    /// Single source of truth: returns the current state of the runtime container.
    pub async fn status(&self) -> ContainerStatus {
        let mut status = ContainerStatus {
            state: ContainerState::Missing,
            id: None,
            image: self.image.clone(),
            name: self.container_name.clone(),
        };

        // probe daemon
        if self.docker.version().await.is_err() {
            status.state = ContainerState::Unreachable;
            return status;
        }

        let mut filters = HashMap::new();
        filters.insert("name".to_string(), vec![self.container_name.clone()]);
        let containers = self
            .docker
            .list_containers(Some(ListContainersOptions::<String> {
                all: true,
                filters,
                ..Default::default()
            }))
            .await
            .unwrap_or_default();

        if let Some(c) = containers.first() {
            status.id = c.id.clone();
            // Report the image the container ACTUALLY runs (it may predate a
            // config default bump), not the configured `self.image` — otherwise
            // the Containers header claims a tag the container isn't running.
            // Fall back to the configured image only when the container is gone.
            if let Some(img) = c.image.clone() {
                status.image = img;
            }
            status.state = match c.state.as_deref() {
                Some("running") => ContainerState::Running,
                Some("created") | Some("exited") | Some("paused") | Some("dead") => {
                    ContainerState::Stopped
                },
                Some("restarting") => ContainerState::Starting,
                _ => ContainerState::Stopped,
            };
        }

        status
    }

    pub async fn ensure_image(&self) -> Result<(), LifecycleError> {
        // already present?
        if self.docker.inspect_image(&self.image).await.is_ok() {
            return Ok(());
        }

        let mut pull = self.docker.create_image(
            Some(CreateImageOptions {
                from_image: self.image.clone(),
                ..Default::default()
            }),
            None,
            None,
        );

        while let Some(info) = pull.next().await {
            let info = info?;
            tracing::debug!(?info, "image pull progress");
        }
        Ok(())
    }

    pub async fn ensure_container(&self) -> Result<String, LifecycleError> {
        let status = self.status().await;

        if let Some(id) = status.id {
            // A container EXPLICITLY re-pointed at a different dir is stranded on
            // its old bind mount — a bind mount is fixed at creation, so the only
            // way to honour the new dir is to recreate. This fires ONLY when the
            // caller deliberately requested a mount (`enforce_mount`): re-pointing
            // a workspace at a new repo dir. Passive ops (start / restart /
            // status) and the default per-key subdir leave `enforce_mount` false,
            // so they NEVER silently recreate a container onto a different mount
            // (which would destroy its running sessions). The shared runtime is
            // also never enforced here — its mount change is confirm-driven
            // (`workspace_info().needs_recreate` → UI confirm → `recreate()`).
            let want = self.workspace_dir().to_string_lossy().to_string();
            let mounted = self.mounted_workspace_source().await;
            if mount_needs_recreate(self.enforce_mount, mounted.as_deref(), &want) {
                tracing::info!(
                    container = %self.container_name,
                    %want,
                    "per-workspace mount changed; recreating container to apply it"
                );
                self.docker
                    .remove_container(
                        &id,
                        Some(RemoveContainerOptions {
                            force: true,
                            v: false,
                            link: false,
                        }),
                    )
                    .await?;
                // fall through to create with the current mount
            } else if status.state == ContainerState::Running {
                return Ok(id);
            } else {
                // exists but stopped — start it
                self.docker
                    .start_container(&id, None::<StartContainerOptions<String>>)
                    .await?;
                return Ok(id);
            }
        }

        // create new. We mount ONLY /workspace (the repo). Agent config — settings,
        // hooks, transcripts under /config/{claude,codex,…} — is DELIBERATELY NOT
        // mounted from the host: the container is a clean sandbox seeded from the
        // image. The only host→container flow is credentials (OAuth tokens, API
        // keys, custom model providers), injected per-launch from the vault as
        // env (see account_launch_script / provider_session_env), never
        // via a config bind mount. Configs/transcripts are therefore container-
        // local and ephemeral; persistence of credentials lives in the vault.
        let workspace_dir = self.workspace_dir();
        let additional = self.resolve_additional_dirs();
        let mut mounts = Vec::new();

        if additional.is_empty() {
            // Single-repo workspace: bind it at the /workspace ROOT. The git-status
            // poll and the default agent cwd both read /workspace, so a lone repo
            // must live there (and every pre-existing workspace already does).
            std::fs::create_dir_all(&workspace_dir)?;
            mounts.push(Mount {
                target: Some("/workspace".into()),
                source: Some(workspace_dir.to_string_lossy().to_string()),
                typ: Some(MountTypeEnum::BIND),
                ..Default::default()
            });
        } else {
            // Multi-repo workspace: /workspace is the PARENT, and EVERY repo —
            // the primary included — mounts at /workspace/<basename>, so they read
            // consistently and the repo picker lists them the same way. Docker
            // creates the /workspace mount point itself (image WORKDIR). Dedupe by
            // target so repos sharing a basename can't collide (first wins).
            let mut seen_targets = std::collections::HashSet::new();
            for dir in std::iter::once(workspace_dir).chain(additional) {
                let Some(base) = dir.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                let target = format!("/workspace/{base}");
                if !seen_targets.insert(target.clone()) {
                    continue;
                }
                std::fs::create_dir_all(&dir)?;
                mounts.push(Mount {
                    target: Some(target),
                    source: Some(dir.to_string_lossy().to_string()),
                    typ: Some(MountTypeEnum::BIND),
                    ..Default::default()
                });
            }
        }

        let sizing = self.resolve_sizing();
        let host_config = HostConfig {
            mounts: Some(mounts),
            network_mode: Some(host_network_mode()),
            restart_policy: Some(bollard::models::RestartPolicy {
                name: Some(bollard::models::RestartPolicyNameEnum::UNLESS_STOPPED),
                maximum_retry_count: None,
            }),
            // Empty map keeps Docker happy when network_mode = host
            port_bindings: Some(HashMap::<String, Option<Vec<PortBinding>>>::new()),
            nano_cpus: sizing.cpu_count.map(|c| (c * 1_000_000_000.0) as i64),
            memory: sizing.memory_mb.map(|m| (m * 1024 * 1024) as i64),
            ..Default::default()
        };

        // Forward every host auth key the CLIs may need (Claude / Codex /
        // Antigravity) plus any custom-named account-profile vars, so a session
        // can remap its CLI's canonical var by NAME. Values never touch the logs.
        let mut env = docker::base_container_env();
        env.extend(auth_env_with(&self.profile_env_vars()));
        // Vault-backed secrets are not injected here. Vault reads happen only
        // when the user explicitly launches/uses an account that needs them.
        env.extend(self.vault_env.iter().cloned());

        // Per-workspace containers self-describe via labels: `codehub.managed`
        // lets multi-container listing enumerate exactly the containers we own,
        // and `codehub.workspace` records the ORIGINAL workspace key so startup
        // restore can recover it (the container NAME is a one-way `sanitize_key`
        // hash, so the key cannot be derived from the name). The shared runtime
        // gets no labels — it has no single workspace identity.
        let labels = self.workspace_label.as_ref().map(|key| {
            HashMap::from([
                ("codehub.managed".to_string(), "true".to_string()),
                ("codehub.workspace".to_string(), key.clone()),
            ])
        });

        let config = Config {
            image: Some(self.image.clone()),
            env: Some(env),
            host_config: Some(host_config),
            working_dir: Some("/workspace".into()),
            tty: Some(true),
            open_stdin: Some(true),
            labels,
            ..Default::default()
        };

        let created = self
            .docker
            .create_container(
                Some(CreateContainerOptions {
                    name: self.container_name.clone(),
                    platform: None,
                }),
                config,
            )
            .await?;

        self.docker
            .start_container(&created.id, None::<StartContainerOptions<String>>)
            .await?;

        Ok(created.id)
    }

    pub async fn ensure_runtime(&self) -> Result<ContainerStatus, LifecycleError> {
        self.ensure_image().await?;
        self.ensure_container().await?;
        Ok(self.status().await)
    }

    pub async fn start(&self) -> Result<(), LifecycleError> {
        self.ensure_container().await?;
        Ok(())
    }

    pub async fn stop(&self) -> Result<(), LifecycleError> {
        let status = self.status().await;
        if let Some(id) = status.id {
            self.docker
                .stop_container(&id, Some(StopContainerOptions { t: 10 }))
                .await?;
        }
        Ok(())
    }

    pub async fn restart(&self) -> Result<(), LifecycleError> {
        self.stop().await.ok();
        self.start().await
    }

    pub async fn remove(&self) -> Result<(), LifecycleError> {
        let status = self.status().await;
        if let Some(id) = status.id {
            self.docker
                .remove_container(
                    &id,
                    Some(RemoveContainerOptions {
                        force: true,
                        v: false,
                        link: false,
                    }),
                )
                .await?;
        }
        Ok(())
    }

    /// Remove the container and recreate it from scratch, so a changed bind-mount
    /// source (the workspace dir) or a newly-added account-profile env var takes
    /// effect. Destructive to running tmux sessions — the caller confirms first.
    pub async fn recreate(&self) -> Result<(), LifecycleError> {
        self.remove().await?;
        self.ensure_container().await?;
        Ok(())
    }

    /// The configured-vs-mounted workspace dir + whether a recreate is needed to
    /// reconcile them. `mounted` is read from the running container's actual bind
    /// mount (`docker inspect`); when no container exists, `needs_recreate` is
    /// false (the next create will use `effective`).
    pub async fn workspace_info(&self) -> WorkspaceInfo {
        let effective = self.workspace_dir().to_string_lossy().to_string();
        let mounted = self.mounted_workspace_source().await;
        let needs_recreate = match &mounted {
            Some(m) => m != &effective,
            None => false,
        };
        WorkspaceInfo {
            effective,
            mounted,
            needs_recreate,
        }
    }

    /// Host path the running container has bound at `/workspace`, if any. `None`
    /// when the container is missing or the daemon is unreachable.
    async fn mounted_workspace_source(&self) -> Option<String> {
        let info = self
            .docker
            .inspect_container(&self.container_name, None::<InspectContainerOptions>)
            .await
            .ok()?;
        info.mounts?.into_iter().find_map(|m| {
            if m.destination.as_deref() == Some("/workspace") {
                m.source
            } else {
                None
            }
        })
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

    pub fn docker_client(&self) -> DockerClient {
        DockerClient::from_docker(self.docker.clone(), self.container_name.clone())
    }
}

/// Whether an existing container must be recreated to pick up a changed
/// `/workspace` bind mount. Recreates ONLY when the caller explicitly requested
/// a mount (`enforce_mount == true`) — a deliberate re-point. Passive ops and the
/// shared runtime pass `false`, so they never destructively recreate. A
/// missing/unknown live mount also returns `false` — we only recreate on a
/// *confirmed* mismatch, never speculatively.
fn mount_needs_recreate(enforce_mount: bool, mounted: Option<&str>, want: &str) -> bool {
    enforce_mount && matches!(mounted, Some(m) if m != want)
}

fn host_network_mode() -> String {
    // macOS Docker Desktop supports host network behind a feature flag.
    // Default to `bridge` to maximize compatibility; users can override.
    std::env::var("CODEHUB_NETWORK_MODE")
        .or_else(|_| std::env::var("AVIARY_NETWORK_MODE"))
        .unwrap_or_else(|_| "bridge".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mount_recreate_only_when_enforced_and_confirmed_mismatch() {
        // not enforced (passive start/restart/status, default per-key dir, shared
        // runtime) → never recreate, even on a live-mount mismatch
        assert!(!mount_needs_recreate(false, Some("/old"), "/new"));
        assert!(!mount_needs_recreate(false, Some("/old"), "/old"));
        // enforced (explicit re-point): recreate only on a confirmed mismatch
        assert!(mount_needs_recreate(true, Some("/old"), "/new"));
        assert!(!mount_needs_recreate(true, Some("/same"), "/same"));
        // unknown/absent live mount → never recreate speculatively
        assert!(!mount_needs_recreate(true, None, "/new"));
    }

    // The single most important property of `agent_key_status`: it must report
    // presence only and never let a secret value reach the serialized payload.
    #[test]
    fn key_status_reports_presence_without_leaking_value() {
        let secret = "sk-codehub-test-DO-NOT-LEAK-9f3a2b";
        // SAFETY: process-global env mutation; no other test reads this var.
        unsafe {
            std::env::set_var("OPENAI_API_KEY", secret);
        }

        let status = agent_key_status();
        let codex = status.get("codex").expect("codex entry present");
        assert!(codex.present, "codex key should read as present");
        assert_eq!(codex.var_name.as_deref(), Some("OPENAI_API_KEY"));
        assert_eq!(codex.source, "env");

        let json = serde_json::to_string(&status).expect("serializes");
        assert!(
            !json.contains(secret),
            "secret value leaked into serialized key status: {json}"
        );

        unsafe {
            std::env::remove_var("OPENAI_API_KEY");
        }
    }

    #[test]
    fn auth_env_forwards_present_vars_only() {
        unsafe {
            std::env::set_var("GOOGLE_API_KEY", "g-test-token");
            std::env::remove_var("GEMINI_API_KEY");
        }
        let env = auth_env();
        assert!(env.iter().any(|e| e.starts_with("GOOGLE_API_KEY=")));
        assert!(!env.iter().any(|e| e.starts_with("GEMINI_API_KEY=")));
        unsafe {
            std::env::remove_var("GOOGLE_API_KEY");
        }
    }

    // A custom-named account-profile var present on the host is forwarded into
    // the container so a session can remap onto it by NAME; absent extras are not.
    #[test]
    fn auth_env_with_forwards_present_extras_and_dedups() {
        unsafe {
            std::env::set_var("CLAUDE_TOKEN_WORK", "tok-work-present");
            std::env::remove_var("CLAUDE_TOKEN_ABSENT");
        }
        let extra = vec![
            "CLAUDE_TOKEN_WORK".to_string(),
            "CLAUDE_TOKEN_ABSENT".to_string(),
            // duplicate of a built-in name must not produce two entries
            "CLAUDE_CODE_OAUTH_TOKEN".to_string(),
        ];
        let env = auth_env_with(&extra);
        assert!(
            env.iter().any(|e| e.starts_with("CLAUDE_TOKEN_WORK=")),
            "present custom var should be forwarded"
        );
        assert!(
            !env.iter().any(|e| e.starts_with("CLAUDE_TOKEN_ABSENT=")),
            "absent custom var must not be forwarded"
        );
        let canon = env
            .iter()
            .filter(|e| e.starts_with("CLAUDE_CODE_OAUTH_TOKEN="))
            .count();
        assert!(
            canon <= 1,
            "canonical var must not be duplicated by an extra"
        );
        unsafe {
            std::env::remove_var("CLAUDE_TOKEN_WORK");
        }
    }
}
