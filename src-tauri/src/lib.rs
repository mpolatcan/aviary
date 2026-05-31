// Modules are `pub` so the dev-server bin (feature `devserver`, see
// devserver.rs) can reuse the same docker / pty / lifecycle logic without going
// through Tauri.
pub mod activity;
/// Container-mediated agent login flows.
pub mod auth;
pub mod config;
#[cfg(feature = "devserver")]
pub mod devserver;
pub mod docker;
/// Agent-event hooks subsystem.
pub mod events;
// Native macOS Dynamic Island companion. On other platforms the companion stays
// a WebviewWindow (see open_companion below).
#[cfg(target_os = "macos")]
pub mod island;
pub mod lifecycle;
/// Per-workspace container manager (per-workspace-container architecture).
pub mod manager;
pub mod pty;
pub mod pty_output;
/// Per-workspace container stats ring buffer (sparklines).
pub mod stats_history;
/// Shared IPC response types (Phase-0 completion contract).
pub mod types;
/// Encrypted-file credential vault for built-in agent accounts + GitHub.
pub mod vault;

use activity::SessionActivity;
use config::{AccountProfile, ConfigStore, Settings};
use docker::{
    AgentConfig, AgentVersion, ClaudeIntegrations, ClaudeSession, ClaudeUsage, Cli, CommitInfo,
    ContainerStats, DirEntry, DockerClient, FileEntry, GitStatus, ImageInfo, LaunchMode, MountInfo,
    ProcessInfo, RuntimeHealth, SessionUsage, TmuxSessionRequest,
};
use events::EventsTracker;
use lifecycle::{AppInfo, ContainerStatus, KeyStatus, Lifecycle, WorkspaceInfo};
use manager::LifecycleManager;
use pty::{PaneEmitter, PtyRegistry, SessionInfo};
// Re-export Phase-0 contract types so devserver.rs can import them from `crate::`.
pub use config::{profile_statuses, AccountProfileStatus};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{Emitter, Manager};
pub use types::{
    ActivityEvent, AgentEvent, CodexDayUsage, CodexModelRate, CodexModelUsage, CodexRateLimits,
    CodexSession, CodexSessionUsage, CodexTokenTotals, CodexUsage, GithubRepo, GithubStatus,
    PendingPrompt, UpdateStatus,
};

/// Bridges a pane's output to the Tauri webview as `pty://data|exit/<id>`
/// events — the production [`PaneEmitter`].
struct TauriEmitter(tauri::AppHandle);

impl PaneEmitter for TauriEmitter {
    fn data(&self, pane_id: &str, text: String) {
        let _ = self.0.emit(&format!("pty://data/{}", pane_id), text);
    }
    fn exit(&self, pane_id: &str, code: i32) {
        let _ = self.0.emit::<i32>(&format!("pty://exit/{}", pane_id), code);
    }
}

pub struct AppState {
    /// Resolves a `Lifecycle` per workspace (`codehub-ws-<key>`). Owns the
    /// single daemon connection shared across all per-workspace lifecycles.
    pub manager: Arc<LifecycleManager>,
    pub registry: Arc<PtyRegistry>,
    pub config: Arc<ConfigStore>,
    /// Agent-event hook state: pending prompts + activity ring buffer.
    pub events: Arc<EventsTracker>,
    /// Per-workspace container stats ring buffer (sparkline charts).
    pub stats_history: Arc<stats_history::StatsHistory>,
    /// Encrypted-file credential vault for built-in agent accounts + GitHub.
    pub vault: Arc<vault::Vault>,
}

const DEFAULT_IMAGE: &str = "ghcr.io/mpolatcan/codehub-runtime:0.1.3";

/// DockerClient for a session command's target container. `workspace` is the
/// per-workspace key identifying the container (`codehub-ws-<key>`).
fn docker_for(state: &AppState, workspace: &str) -> Arc<DockerClient> {
    Arc::new(state.manager.resolve(workspace, None).docker_client())
}

/// DockerClient for an inspection command's target container.
fn docker_container_for(state: &AppState, workspace: &str) -> Arc<DockerClient> {
    Arc::new(state.manager.workspace_container(workspace).docker_client())
}

/// The lifecycle for a workspace key. Backs Start/Stop/Restart on workspace cards.
fn lifecycle_for(state: &AppState, workspace: &str) -> Arc<Lifecycle> {
    state.manager.workspace_container(workspace)
}

#[tauri::command]
async fn container_status(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<ContainerStatus, String> {
    Ok(lifecycle_for(&state, &workspace).status().await)
}

async fn lifecycle_op(
    lc: &Lifecycle,
    _app: &tauri::AppHandle,
    op: impl std::future::Future<Output = Result<(), lifecycle::LifecycleError>>,
) -> Result<ContainerStatus, String> {
    op.await.map_err(|e| e.to_string())?;
    Ok(lc.status().await)
}

#[tauri::command]
async fn container_start(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    workspace: String,
) -> Result<ContainerStatus, String> {
    let lc = lifecycle_for(&state, &workspace);
    lifecycle_op(&lc, &app, lc.start()).await
}

#[tauri::command]
async fn container_stop(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    workspace: String,
) -> Result<ContainerStatus, String> {
    let lc = lifecycle_for(&state, &workspace);
    lifecycle_op(&lc, &app, lc.stop()).await
}

#[tauri::command]
async fn container_restart(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    workspace: String,
) -> Result<ContainerStatus, String> {
    let lc = lifecycle_for(&state, &workspace);
    lifecycle_op(&lc, &app, lc.restart()).await
}

/// Enumerate the CodeHub-managed per-workspace containers (key + status), for the
/// fleet / Workspaces inspector. Empty when the flag is off / none exist.
#[tauri::command]
async fn list_workspace_containers(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<manager::WorkspaceContainer>, String> {
    state
        .manager
        .list_workspace_containers()
        .await
        .map_err(|e| e.to_string())
}

/// Remove a per-workspace container by key (Prune / explicit delete). Destructive
/// to that workspace's sessions — the UI confirms first. No `codehub://lifecycle`
/// broadcast (that event tracks the SHARED runtime); the fleet poll
/// (`list_workspace_containers`) reflects the removal on its next tick.
#[tauri::command]
async fn remove_workspace_container(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<(), String> {
    state
        .manager
        .remove_workspace(&workspace)
        .await
        .map_err(|e| e.to_string())
}

/// Daemon reachability + version for the empty-state pill / Settings.
#[tauri::command]
async fn docker_info(state: tauri::State<'_, AppState>) -> Result<lifecycle::DockerInfo, String> {
    Ok(state.manager.docker_info().await)
}

/// Detect which container runtimes are installed (Docker Desktop / OrbStack) and
/// whether the daemon socket is reachable. Backs the first-run empty-state hero:
/// "Start Docker" / "Start OrbStack" vs "Install a container runtime".
#[tauri::command]
async fn detect_docker_runtime(
    state: tauri::State<'_, AppState>,
) -> Result<DockerRuntimeDetection, String> {
    let mut installed = Vec::new();
    if std::path::Path::new("/Applications/Docker.app").exists() {
        installed.push("docker".to_string());
    }
    if std::path::Path::new("/Applications/OrbStack.app").exists() {
        installed.push("orbstack".to_string());
    }
    let daemon_running = state.manager.docker_info().await.reachable;
    Ok(DockerRuntimeDetection {
        installed,
        daemon_running,
    })
}

/// Open a container runtime app (Docker Desktop or OrbStack) so its daemon
/// starts. macOS only (`open -a`); on other platforms returns an error nudging
/// the user to start the daemon manually.
#[tauri::command]
async fn start_docker_app(runtime: String) -> Result<(), String> {
    let app_name = match runtime.as_str() {
        "docker" => "Docker",
        "orbstack" => "OrbStack",
        _ => return Err(format!("unknown runtime: {runtime}")),
    };
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", app_name])
            .spawn()
            .map_err(|e| format!("failed to open {app_name}: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(format!(
            "auto-start not supported on this platform — start {app_name} manually"
        ))
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct DockerRuntimeDetection {
    pub installed: Vec<String>,
    pub daemon_running: bool,
}

/// Presence-only auth status per CLI. Reports booleans + env var names; never
/// the secret values (see lifecycle::agent_key_status).
#[tauri::command]
fn agent_key_status() -> Result<HashMap<String, KeyStatus>, String> {
    Ok(lifecycle::agent_key_status())
}

/// Build + host platform identity for the Settings "About" pane (version, OS,
/// arch) — all compile-time / `std::env::consts` values, no I/O, no update check.
#[tauri::command]
fn app_info() -> Result<AppInfo, String> {
    Ok(lifecycle::app_info())
}

/// Host memory + disk stats (About screen).
#[tauri::command]
fn host_stats() -> Result<lifecycle::HostStats, String> {
    Ok(lifecycle::host_stats())
}

/// Runtime tool versions from inside a workspace container (About screen).
#[tauri::command]
async fn runtime_versions(
    workspace: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<lifecycle::RuntimeVersions, String> {
    let docker = match workspace {
        Some(ref key) => Arc::new(state.manager.workspace_container(key).docker_client()),
        None => state
            .manager
            .any_running_docker()
            .await
            .ok_or_else(|| "no running workspace container".to_string())?,
    };
    docker.runtime_versions().await.map_err(|e| e.to_string())
}

/// Current persisted UI preferences (Settings screen). In-memory snapshot —
/// never fails.
#[tauri::command]
fn get_config(state: tauri::State<'_, AppState>) -> Result<Settings, String> {
    Ok(state.config.get())
}

pub fn preserve_backend_owned_settings(mut next: Settings, current: &Settings) -> Settings {
    next.account_profiles = current.account_profiles.clone();
    next
}

/// Replace the persisted UI preferences and write them to disk. Returns the
/// stored settings so the frontend can confirm what landed.
#[tauri::command]
fn set_config(config: Settings, state: tauri::State<'_, AppState>) -> Result<Settings, String> {
    // Account profiles are mutated through dedicated add/remove commands because
    // they are coupled to vault entries. Generic UI settings writes can be
    // based on an older frontend config snapshot, so never let them roll account
    // metadata backward and orphan freshly stored vault credentials.
    let current = state.config.get();
    state
        .config
        .set(preserve_backend_owned_settings(config, &current))
}

/// List model providers with live token presence (no secret exposed).
#[tauri::command]
fn list_providers(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<config::ModelProviderStatus>, String> {
    Ok(config::provider_statuses(
        state.config.get().providers,
        Some(&state.vault),
    ))
}

/// Add a model provider.
#[expect(clippy::too_many_arguments, reason = "Tauri IPC passes args by name")]
#[tauri::command]
fn add_provider(
    name: String,
    kind: String,
    endpoint: Option<String>,
    api_key_var: Option<String>,
    models: Vec<String>,
    model: Option<String>,
    small_fast_model: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<config::ModelProviderStatus>, String> {
    let mut settings = state.config.get();
    settings.providers.push(config::ModelProvider {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        kind,
        endpoint,
        api_key_var,
        models,
        model,
        small_fast_model,
        enabled: true,
    });
    let saved = state.config.set(settings)?;
    Ok(config::provider_statuses(
        saved.providers,
        Some(&state.vault),
    ))
}

/// Remove a model provider by id (also drops its vault token, if any).
#[tauri::command]
fn remove_provider(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<config::ModelProviderStatus>, String> {
    let mut settings = state.config.get();
    settings.providers.retain(|p| p.id != id);
    let saved = state.config.set(settings)?;
    let _ = state.vault.delete(&id);
    Ok(config::provider_statuses(
        saved.providers,
        Some(&state.vault),
    ))
}

/// Update a model provider (partial update by id).
#[expect(clippy::too_many_arguments, reason = "Tauri IPC passes args by name")]
#[tauri::command]
fn update_provider(
    id: String,
    name: Option<String>,
    endpoint: Option<String>,
    enabled: Option<bool>,
    models: Option<Vec<String>>,
    model: Option<String>,
    small_fast_model: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<config::ModelProviderStatus>, String> {
    let mut settings = state.config.get();
    if let Some(p) = settings.providers.iter_mut().find(|p| p.id == id) {
        if let Some(n) = name {
            p.name = n;
        }
        if let Some(e) = endpoint {
            p.endpoint = Some(e);
        }
        if let Some(en) = enabled {
            p.enabled = en;
        }
        if let Some(m) = models {
            p.models = m;
        }
        if let Some(m) = model {
            p.model = Some(m);
        }
        if let Some(m) = small_fast_model {
            p.small_fast_model = Some(m);
        }
    }
    let saved = state.config.set(settings)?;
    Ok(config::provider_statuses(
        saved.providers,
        Some(&state.vault),
    ))
}

/// Store (or clear) a model provider's secret token in the encrypted vault,
/// keyed by the provider id — the same vault namespace as account profiles. An
/// empty token deletes the entry. The secret is never returned or persisted to
/// settings.json; only its presence is reported (via `list_providers`).
#[tauri::command]
fn set_provider_token(
    id: String,
    token: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<config::ModelProviderStatus>, String> {
    let token = token.trim();
    if token.is_empty() {
        state.vault.delete(&id).map_err(|e| e.to_string())?;
    } else {
        state.vault.store(&id, token).map_err(|e| e.to_string())?;
    }
    Ok(config::provider_statuses(
        state.config.get().providers,
        Some(&state.vault),
    ))
}

/// Search transcripts across sessions (Command Palette).
#[tauri::command]
async fn search_transcripts(
    query: String,
    limit: Option<u32>,
    workspace: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<docker::SearchHit>, String> {
    let docker = match workspace {
        Some(ref key) => Arc::new(state.manager.workspace_container(key).docker_client()),
        None => state
            .manager
            .any_running_docker()
            .await
            .ok_or_else(|| "no running workspace container".to_string())?,
    };
    docker
        .search_transcripts(&query, limit.unwrap_or(20))
        .await
        .map_err(|e| e.to_string())
}

/// Add a prompt template and persist.
#[tauri::command]
fn add_prompt_template(
    name: String,
    prompt: String,
    cli: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<config::PromptTemplate>, String> {
    let mut settings = state.config.get();
    settings.prompt_templates.push(config::PromptTemplate {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        prompt,
        cli,
    });
    let saved = state.config.set(settings)?;
    Ok(saved.prompt_templates)
}

/// Remove a prompt template by id and persist.
#[tauri::command]
fn remove_prompt_template(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<config::PromptTemplate>, String> {
    let mut settings = state.config.get();
    settings.prompt_templates.retain(|t| t.id != id);
    let saved = state.config.set(settings)?;
    Ok(saved.prompt_templates)
}

// — Tier-2: workspace / repository picker —

/// Open the OS folder picker and return the chosen absolute path (None when the
/// user cancels). Native-only; the dev bridge degrades this to null.
#[tauri::command]
async fn pick_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let picked = rx.await.map_err(|e| e.to_string())?;
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string()))
}

/// Set the host directory bound at `/workspace` and bump the MRU recents. The
/// path must be an existing directory. Does NOT recreate the container — the
/// mount source is fixed at create-time, so the caller applies it via
/// `recreate_runtime` (a "restart runtime to apply" affordance).
#[tauri::command]
fn set_workspace_dir(path: String, state: tauri::State<'_, AppState>) -> Result<Settings, String> {
    if !std::path::Path::new(&path).is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    state.config.set_workspace_dir(path)
}

/// Configured-vs-mounted workspace dir + whether a recreate is needed to apply a
/// change. Backs the "restart runtime to apply" banner. Operates on the given
/// workspace's container.
#[tauri::command]
async fn workspace_info(
    state: tauri::State<'_, AppState>,
    workspace: Option<String>,
) -> Result<WorkspaceInfo, String> {
    match workspace {
        Some(key) => Ok(lifecycle_for(&state, &key).workspace_info().await),
        None => {
            // No workspace context — return a placeholder with the config-driven
            // effective dir and no mounted path (no container to inspect).
            let effective = state.config.get().workspace_dir.unwrap_or_default();
            Ok(WorkspaceInfo {
                effective,
                mounted: None,
                needs_recreate: false,
            })
        },
    }
}

/// Remove + recreate a workspace container so a changed workspace mount (or a
/// newly-added account-profile env var) takes effect. Destructive to running
/// sessions — the UI confirms first.
#[tauri::command]
async fn recreate_runtime(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    workspace: String,
) -> Result<ContainerStatus, String> {
    let lc = lifecycle_for(&state, &workspace);
    lifecycle_op(&lc, &app, lc.recreate()).await
}

// — Tier-3: label-only account profiles (no secrets stored) —
// `AccountProfileStatus` + `profile_statuses` live in `config` (next to
// `AccountProfile`); re-exported above so `crate::` paths + devserver keep
// working. `build_account_profile` stays here — it bridges `Cli` + `docker`
// validation with the config type, so it belongs in the glue layer.

// ── Phase-0 completion contract ────────────────────────
// The response structs live in `types.rs` and are re-exported from `crate::` above
// so devserver.rs can continue to import them from `crate::`. The commands below
// now have real implementations.

/// All stored account profiles + live presence status.
#[tauri::command]
fn list_account_profiles(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AccountProfileStatus>, String> {
    Ok(profile_statuses(
        state.config.get().account_profiles,
        Some(&state.vault),
    ))
}

/// Validate + construct an env-backed account profile. Shared by the Tauri
/// command and the dev bridge. Rejects agents with no credential var, an
/// empty label, and any `var_name` that isn't a safe env identifier.
pub fn build_account_profile(
    agent: &str,
    label: &str,
    var_name: &str,
) -> Result<AccountProfile, String> {
    let cli = Cli::parse(agent).map_err(|e| e.to_string())?;
    if cli.canonical_auth_var().is_none() {
        return Err(format!("{agent} has no credential to remap"));
    }
    let label = label.trim().to_string();
    if label.is_empty() {
        return Err("label is required".into());
    }
    let var_name = var_name.trim().to_string();
    if !docker::is_env_name(&var_name) {
        return Err(format!(
            "invalid environment variable name: {var_name} (use letters, digits, underscore)"
        ));
    }
    Ok(AccountProfile {
        id: uuid::Uuid::new_v4().to_string(),
        agent: cli.binary().to_string(),
        label,
        enabled: true,
        credential: config::CredentialSource::Env { var_name },
    })
}

/// Construct a vault-backed account profile. The secret itself is stored
/// separately via `vault_store_key`; this only records the profile metadata.
pub fn build_vault_profile(agent: &str, label: &str) -> Result<AccountProfile, String> {
    let label = label.trim().to_string();
    if label.is_empty() {
        return Err("label is required".into());
    }
    if agent == "github" {
        return Ok(AccountProfile {
            id: uuid::Uuid::new_v4().to_string(),
            agent: "github".to_string(),
            label,
            enabled: true,
            credential: config::CredentialSource::Vault,
        });
    }

    let cli = Cli::parse(agent).map_err(|e| e.to_string())?;
    if cli.canonical_auth_var().is_none() {
        return Err(format!("{agent} has no credential to manage"));
    }
    Ok(AccountProfile {
        id: uuid::Uuid::new_v4().to_string(),
        agent: cli.binary().to_string(),
        label,
        enabled: true,
        credential: config::CredentialSource::Vault,
    })
}

#[cfg(test)]
mod account_profile_tests {
    use super::*;

    #[test]
    fn vault_profile_accepts_github_connector() {
        let profile = build_vault_profile("github", "GitHub").expect("github vault profile");
        assert_eq!(profile.agent, "github");
        assert!(matches!(
            profile.credential,
            config::CredentialSource::Vault
        ));
    }

    #[test]
    fn vault_env_name_is_shell_safe_for_uuid_profiles() {
        let name = config::vault_env_name("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
        assert!(docker::is_env_name(&name));
        assert_eq!(name, "CODEHUB_VAULT_3F2504E0_4F89_11D3_9A0C_0305E82C3301");
    }

    #[test]
    fn ui_settings_update_preserves_backend_owned_account_profiles() {
        let profile =
            build_vault_profile("claude", "Claude Max").expect("valid Claude vault profile");
        let stale_profile =
            build_vault_profile("codex", "Stale Codex").expect("valid Codex vault profile");

        let current = Settings {
            account_profiles: vec![profile.clone()],
            ..Default::default()
        };

        let incoming = Settings {
            density: "compact".into(),
            account_profiles: vec![stale_profile],
            ..Default::default()
        };

        let merged = preserve_backend_owned_settings(incoming, &current);
        assert_eq!(merged.density, "compact");
        assert_eq!(merged.account_profiles, vec![profile]);
    }
}

/// Add an account profile. `source` determines env-backed (requires var_name)
/// or vault-backed (var_name ignored). Returns the full list + presence.
#[tauri::command]
fn add_account_profile(
    agent: String,
    label: String,
    var_name: Option<String>,
    source: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AccountProfileStatus>, String> {
    let profile = if source.as_deref() == Some("vault") {
        build_vault_profile(&agent, &label)?
    } else {
        build_account_profile(&agent, &label, &var_name.unwrap_or_default())?
    };
    let next = state.config.add_account_profile(profile)?;
    Ok(profile_statuses(next.account_profiles, Some(&state.vault)))
}

/// Remove an account profile by id. Cascades to vault deletion for
/// vault-backed profiles. Returns the full updated list + presence.
#[tauri::command]
fn remove_account_profile(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AccountProfileStatus>, String> {
    // Delete from vault if it was vault-backed (no-op if env-backed).
    let _ = state.vault.delete(&id);
    let next = state.config.remove_account_profile(&id)?;
    Ok(profile_statuses(next.account_profiles, Some(&state.vault)))
}

/// Rename an account profile's label. Returns the full updated list + presence.
#[tauri::command]
fn rename_account_profile(
    id: String,
    label: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AccountProfileStatus>, String> {
    let next = state.config.rename_account_profile(&id, &label)?;
    Ok(profile_statuses(next.account_profiles, Some(&state.vault)))
}

/// Enable or disable an account profile (kept, but offered/hidden at spawn).
/// Returns the full updated list + presence.
#[tauri::command]
fn set_account_profile_enabled(
    id: String,
    enabled: bool,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AccountProfileStatus>, String> {
    let next = state.config.set_account_profile_enabled(&id, enabled)?;
    Ok(profile_statuses(next.account_profiles, Some(&state.vault)))
}

/// `<cli> --version` for each agent inside a running workspace container.
#[tauri::command]
async fn agent_versions(
    state: tauri::State<'_, AppState>,
) -> Result<HashMap<String, AgentVersion>, String> {
    let docker = state
        .manager
        .any_running_docker()
        .await
        .ok_or_else(|| "no running workspace container".to_string())?;
    Ok(docker.agent_versions().await)
}

/// One-shot CPU/mem/net/disk for a workspace container (Containers view gauges).
/// When workspace is omitted, uses any running container (app-wide stats poll).
#[tauri::command]
async fn container_stats(
    state: tauri::State<'_, AppState>,
    workspace: Option<String>,
) -> Result<ContainerStats, String> {
    let docker = match workspace {
        Some(ref key) => Arc::new(state.manager.workspace_container(key).docker_client()),
        None => state
            .manager
            .any_running_docker()
            .await
            .ok_or_else(|| "no running workspace container".to_string())?,
    };
    docker.stats().await.map_err(|e| e.to_string())
}

/// Sparkline history for a workspace container's stats (Container Inspector).
#[tauri::command]
async fn container_stats_history(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<Vec<stats_history::StatsPoint>, String> {
    Ok(state.stats_history.history(&workspace))
}

/// Tail of a workspace container's log (Containers view log panel).
#[tauri::command]
async fn container_logs(
    state: tauri::State<'_, AppState>,
    tail: Option<u32>,
    workspace: String,
) -> Result<Vec<String>, String> {
    docker_container_for(&state, &workspace)
        .logs(tail.unwrap_or(200))
        .await
        .map_err(|e| e.to_string())
}

/// Real bind/volume mounts of a workspace container (Containers view Mounts card).
#[tauri::command]
async fn container_mounts(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<Vec<MountInfo>, String> {
    docker_container_for(&state, &workspace)
        .mounts()
        .await
        .map_err(|e| e.to_string())
}

/// Identity of a workspace container's image (Containers view Image card).
/// When workspace is omitted (Settings/About), uses any running container.
#[tauri::command]
async fn container_image(
    state: tauri::State<'_, AppState>,
    workspace: Option<String>,
) -> Result<ImageInfo, String> {
    let docker = match workspace {
        Some(ref key) => Arc::new(state.manager.workspace_container(key).docker_client()),
        None => state
            .manager
            .any_running_docker()
            .await
            .ok_or_else(|| "no running workspace container".to_string())?,
    };
    docker.image_info().await.map_err(|e| e.to_string())
}

/// Liveness of a workspace container (Containers view hero).
/// When workspace is omitted, uses any running container.
#[tauri::command]
async fn container_health(
    state: tauri::State<'_, AppState>,
    workspace: Option<String>,
) -> Result<RuntimeHealth, String> {
    let docker = match workspace {
        Some(ref key) => Arc::new(state.manager.workspace_container(key).docker_client()),
        None => state
            .manager
            .any_running_docker()
            .await
            .ok_or_else(|| "no running workspace container".to_string())?,
    };
    docker.health().await.map_err(|e| e.to_string())
}

/// Non-recursive listing of a `/workspace` directory (Files browser).
#[tauri::command]
async fn container_list_dir(
    state: tauri::State<'_, AppState>,
    path: String,
    workspace: String,
) -> Result<Vec<FileEntry>, String> {
    docker_container_for(&state, &workspace)
        .list_dir(&path)
        .await
        .map_err(|e| e.to_string())
}

/// Immediate subdirectories of a `/workspace` path, git-repo-flagged. Powers the
/// agent-pane working-directory browser (multi-repo mounts nest repos deeper than
/// `container_repos` discovery reaches).
#[tauri::command]
async fn container_browse_dirs(
    state: tauri::State<'_, AppState>,
    path: String,
    workspace: String,
) -> Result<Vec<DirEntry>, String> {
    docker_container_for(&state, &workspace)
        .browse_dirs(&path)
        .await
        .map_err(|e| e.to_string())
}

/// First 256 KiB of a `/workspace` file (Files browser preview).
#[tauri::command]
async fn container_read_file(
    state: tauri::State<'_, AppState>,
    path: String,
    workspace: String,
) -> Result<String, String> {
    docker_container_for(&state, &workspace)
        .read_file(&path)
        .await
        .map_err(|e| e.to_string())
}

/// Working-tree status of the `/workspace` mount (Hub activity rail "Changes").
#[tauri::command]
async fn container_git_status(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<GitStatus, String> {
    docker_container_for(&state, &workspace)
        .git_status()
        .await
        .map_err(|e| e.to_string())
}

/// Unified diff for one `/workspace` path (rail "Changes" → diff viewer).
#[tauri::command]
async fn container_git_diff(
    path: String,
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<String, String> {
    docker_container_for(&state, &workspace)
        .git_diff(&path)
        .await
        .map_err(|e| e.to_string())
}

/// Combined diff of all tracked `/workspace` changes.
#[tauri::command]
async fn container_git_diff_all(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<String, String> {
    docker_container_for(&state, &workspace)
        .git_diff_all()
        .await
        .map_err(|e| e.to_string())
}

/// Staged-only diff of `/workspace` (`git diff --cached`).
#[tauri::command]
async fn container_git_diff_staged(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<String, String> {
    docker_container_for(&state, &workspace)
        .git_diff_staged()
        .await
        .map_err(|e| e.to_string())
}

/// Unstaged diff of tracked `/workspace` files (`git diff`).
#[tauri::command]
async fn container_git_diff_unstaged(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<String, String> {
    docker_container_for(&state, &workspace)
        .git_diff_unstaged()
        .await
        .map_err(|e| e.to_string())
}

/// Stage every `/workspace` change (`git add -A`).
#[tauri::command]
async fn container_git_stage_all(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<(), String> {
    docker_container_for(&state, &workspace)
        .git_stage_all()
        .await
        .map_err(|e| e.to_string())
}

/// Commit the staged `/workspace` changes (`git commit -m <message>`).
#[tauri::command]
async fn container_git_commit(
    message: String,
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<String, String> {
    docker_container_for(&state, &workspace)
        .git_commit(&message)
        .await
        .map_err(|e| e.to_string())
}

/// Push the current `/workspace` branch and open a GitHub PR for it.
#[tauri::command]
async fn container_git_open_pr(
    title: String,
    body: String,
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<String, String> {
    docker_container_for(&state, &workspace)
        .git_open_pr(&title, &body)
        .await
        .map_err(|e| e.to_string())
}

/// Stage a single file in /workspace.
#[tauri::command]
async fn container_git_stage_file(
    path: String,
    workspace: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    docker_container_for(&state, &workspace)
        .git_stage_file(&path)
        .await
        .map_err(|e| e.to_string())
}

/// Unstage a single file in /workspace.
#[tauri::command]
async fn container_git_unstage_file(
    path: String,
    workspace: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    docker_container_for(&state, &workspace)
        .git_unstage_file(&path)
        .await
        .map_err(|e| e.to_string())
}

/// Apply a patch to the staging area (per-hunk staging).
#[tauri::command]
async fn container_git_stage_hunk(
    patch: String,
    workspace: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    docker_container_for(&state, &workspace)
        .git_stage_hunk(&patch)
        .await
        .map_err(|e| e.to_string())
}

/// Set Claude Code's active model.
#[tauri::command]
async fn set_agent_model(
    model: String,
    workspace: String,
    state: tauri::State<'_, AppState>,
) -> Result<AgentConfig, String> {
    let docker = docker_container_for(&state, &workspace);
    docker
        .set_claude_model(&model)
        .await
        .map_err(|e| e.to_string())?;
    docker
        .claude_agent_config()
        .await
        .map_err(|e| e.to_string())
}

/// Set Claude Code's default permission mode.
#[tauri::command]
async fn set_permission_mode(
    mode: String,
    workspace: String,
    state: tauri::State<'_, AppState>,
) -> Result<AgentConfig, String> {
    let docker = docker_container_for(&state, &workspace);
    docker
        .set_permission_mode(&mode)
        .await
        .map_err(|e| e.to_string())?;
    docker
        .claude_agent_config()
        .await
        .map_err(|e| e.to_string())
}

/// Set Claude Code's permission rules for a bucket (allow/ask/deny).
#[tauri::command]
async fn set_permission_rules(
    bucket: String,
    rules: Vec<String>,
    workspace: String,
    state: tauri::State<'_, AppState>,
) -> Result<AgentConfig, String> {
    let docker = docker_container_for(&state, &workspace);
    docker
        .set_permission_rules(&bucket, &rules)
        .await
        .map_err(|e| e.to_string())?;
    docker
        .claude_agent_config()
        .await
        .map_err(|e| e.to_string())
}

/// Toggle an MCP server's enabled state.
#[tauri::command]
async fn toggle_mcp_server(
    name: String,
    enabled: bool,
    workspace: String,
    state: tauri::State<'_, AppState>,
) -> Result<ClaudeIntegrations, String> {
    let docker = docker_container_for(&state, &workspace);
    docker
        .toggle_mcp_server(&name, enabled)
        .await
        .map_err(|e| e.to_string())?;
    docker
        .claude_integrations()
        .await
        .map_err(|e| e.to_string())
}

/// Processes running inside a workspace container (Containers view "Processes" card).
#[tauri::command]
async fn container_top(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<Vec<ProcessInfo>, String> {
    docker_container_for(&state, &workspace)
        .top()
        .await
        .map_err(|e| e.to_string())
}

/// Environment variables in a workspace container (Container Inspector).
/// Auth secrets are filtered out by the backend (no-secret-leaking contract).
#[tauri::command]
async fn container_env(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<Vec<docker::EnvEntry>, String> {
    docker_container_for(&state, &workspace)
        .container_env()
        .await
        .map_err(|e| e.to_string())
}

/// Git repositories discovered under /workspace (Container Inspector).
#[tauri::command]
async fn container_repos(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<Vec<docker::RepoInfo>, String> {
    docker_container_for(&state, &workspace)
        .container_repos()
        .await
        .map_err(|e| e.to_string())
}

/// Clone a git repo by URL into /workspace (Welcome "From GitHub" template).
#[tauri::command]
async fn container_git_clone(
    state: tauri::State<'_, AppState>,
    url: String,
    workspace: String,
) -> Result<String, String> {
    let lifecycle = state.manager.resolve(&workspace, None);
    lifecycle
        .ensure_runtime()
        .await
        .map_err(|e| e.to_string())?;
    lifecycle
        .docker_client()
        .git_clone(&url)
        .await
        .map_err(|e| e.to_string())
}

/// Aggregate token-usage analytics (Usage view) from Claude Code's on-disk
/// session transcripts. Reads from `/config` (shared mount) via any running
/// workspace container. Errs when no containers are running.
#[tauri::command]
async fn claude_usage(state: tauri::State<'_, AppState>) -> Result<ClaudeUsage, String> {
    let docker = state
        .manager
        .any_running_docker()
        .await
        .ok_or_else(|| "no running workspace container".to_string())?;
    docker.claude_usage().await.map_err(|e| e.to_string())
}

/// Past Claude conversations from on-disk transcripts (Resume screen).
#[tauri::command]
async fn claude_sessions(state: tauri::State<'_, AppState>) -> Result<Vec<ClaudeSession>, String> {
    let docker = state
        .manager
        .any_running_docker()
        .await
        .ok_or_else(|| "no running workspace container".to_string())?;
    docker.claude_sessions().await.map_err(|e| e.to_string())
}

/// Live token tally for one Claude session (its `--session-id` transcript).
#[tauri::command]
async fn claude_session_usage(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<SessionUsage>, String> {
    let docker = state
        .manager
        .any_running_docker()
        .await
        .ok_or_else(|| "no running workspace container".to_string())?;
    docker
        .claude_session_usage(&id)
        .await
        .map_err(|e| e.to_string())
}

/// Build the native island's honest one-line Claude metric (e.g.
/// "14 edits · 184.2k tok") from a real [`SessionUsage`]. Returns `None` when
/// there is nothing real to show (no edits and no tokens) so the row stays
/// metric-less rather than displaying a fabricated "0".
#[cfg(target_os = "macos")]
fn island_metric(u: &SessionUsage) -> Option<String> {
    let tok = u.tokens_in.saturating_add(u.tokens_out);
    if u.edits == 0 && tok == 0 {
        return None;
    }
    let tok_str = if tok >= 1000 {
        format!("{:.1}k tok", tok as f64 / 1000.0)
    } else {
        format!("{tok} tok")
    };
    if u.edits > 0 {
        Some(format!("{} edits · {tok_str}", u.edits))
    } else {
        Some(tok_str)
    }
}

/// What Claude is connected to (Integrations screen): the signed-in account +
/// configured MCP servers. Reads from `/config` via any running container.
#[tauri::command]
async fn claude_integrations(
    state: tauri::State<'_, AppState>,
) -> Result<ClaudeIntegrations, String> {
    let docker = state
        .manager
        .any_running_docker()
        .await
        .ok_or_else(|| "no running workspace container".to_string())?;
    docker
        .claude_integrations()
        .await
        .map_err(|e| e.to_string())
}

/// Claude's configurable surface (Agent settings detail): active model, default
/// permission mode, sub-agents, skills, plugins. Reads from `/config`.
#[tauri::command]
async fn claude_agent_config(state: tauri::State<'_, AppState>) -> Result<AgentConfig, String> {
    let docker = state
        .manager
        .any_running_docker()
        .await
        .ok_or_else(|| "no running workspace container".to_string())?;
    docker
        .claude_agent_config()
        .await
        .map_err(|e| e.to_string())
}

/// Recent commits on `/workspace` (Dashboard "Recent commits").
#[tauri::command]
async fn container_git_log(
    limit: Option<u32>,
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<Vec<CommitInfo>, String> {
    docker_container_for(&state, &workspace)
        .git_log(limit.unwrap_or(12))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_sessions(state: tauri::State<'_, AppState>) -> Result<Vec<SessionInfo>, String> {
    state
        .manager
        .list_all_sessions()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[expect(
    clippy::too_many_arguments,
    reason = "Tauri IPC passes these command arguments by name from the frontend"
)]
async fn create_session(
    name: String,
    cli: String,
    mode: Option<String>,
    alias: Option<String>,
    resume: Option<String>,
    session_id: Option<String>,
    account: Option<String>,
    workspace: String,
    workspace_dir: Option<String>,
    cwd: Option<String>,
    task_description: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let cli = Cli::parse(&cli).map_err(|e| e.to_string())?;
    let mode = mode.as_deref().map(LaunchMode::parse).unwrap_or_default();
    let alias = alias.unwrap_or_default();
    // Resolve the chosen account profile to the env var name the session should
    // remap its CLI's canonical auth var from. Env-backed profiles use the host
    // var name. Vault-backed profiles are read just-in-time from the vault and
    // forwarded through this Docker exec's structured env, so existing workspace
    // containers can use accounts created after the container started.
    let mut account_var: Option<String> = None;
    let mut account_env: Vec<String> = Vec::new();
    // Harness env injected when launching under a third-party model provider
    // (MiniMax, z.ai, …): base URL + model + the vault-stored token, set as pane
    // env so the CLI reads it like an exported var. Mutually exclusive with the
    // account-remap path below.
    let mut provider_env: Vec<String> = Vec::new();
    let mut restore_claude_bundle_env: Option<String> = None;
    let mut restore_codex_auth_env: Option<String> = None;
    if let Some(id) = account {
        // A provider id resolves to a configured endpoint, not an account profile.
        if let Some(provider) = state
            .config
            .get()
            .providers
            .into_iter()
            .find(|p| p.id == id)
        {
            let token = state
                .vault
                .read(&provider.id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| {
                    format!(
                        "provider '{}' has no token stored; add it in Settings → Coding Agents.",
                        provider.name
                    )
                })?;
            provider_env = config::provider_session_env(&provider, &token);
        } else {
            let profile = state
                .config
                .get()
                .account_profiles
                .into_iter()
                .find(|p| p.id == id);
            match profile {
                Some(profile) => match profile.credential {
                    config::CredentialSource::Env { var_name } => {
                        // tmux only imports a var given `VAR=VALUE`, so forward the
                        // host value into this exec's env for the launch wrapper to
                        // read (create_tmux_session pushes the assignment).
                        if let Ok(val) = std::env::var(&var_name) {
                            account_env.push(format!("{var_name}={val}"));
                        }
                        account_var = Some(var_name);
                    },
                    config::CredentialSource::Vault => {
                        let env_name = config::vault_env_name(&profile.id);
                        let secret = state
                        .vault
                        .read(&profile.id)
                        .map_err(|e| e.to_string())?
                        .ok_or_else(|| {
                            let _ = state.config.remove_account_profile(&profile.id);
                            format!(
                                "selected account '{}' is missing from the vault; removed the broken profile. Sign in again.",
                                profile.label
                            )
                        })?;
                        account_env.push(format!("{env_name}={secret}"));
                        if matches!(cli, Cli::Claude)
                            && secret.starts_with(auth::CLAUDE_AUTH_BUNDLE_PREFIX)
                        {
                            restore_claude_bundle_env = Some(env_name);
                        } else if matches!(cli, Cli::Codex) {
                            // Codex reads $CODEX_HOME/auth.json — materialize it via a
                            // pre-exec (not the broken tmux `-e` import); launch plainly.
                            restore_codex_auth_env = Some(env_name);
                        } else {
                            account_var = Some(env_name);
                        }
                    },
                },
                None => {
                    let secret = state
                        .vault
                        .read(&id)
                        .map_err(|e| e.to_string())?
                        .ok_or_else(|| "selected account profile not found".to_string())?;
                    let label = match cli {
                        Cli::Claude => "Claude",
                        Cli::Codex => "Codex",
                        Cli::Antigravity => "Antigravity",
                        Cli::Shell => "Shell",
                    };
                    let _ = state.config.add_account_profile(AccountProfile {
                        id: id.clone(),
                        agent: cli.binary().to_string(),
                        label: label.to_string(),
                        enabled: true,
                        credential: config::CredentialSource::Vault,
                    });
                    let env_name = config::vault_env_name(&id);
                    account_env.push(format!("{env_name}={secret}"));
                    if matches!(cli, Cli::Claude)
                        && secret.starts_with(auth::CLAUDE_AUTH_BUNDLE_PREFIX)
                    {
                        restore_claude_bundle_env = Some(env_name);
                    } else if matches!(cli, Cli::Codex) {
                        restore_codex_auth_env = Some(env_name);
                    } else {
                        account_var = Some(env_name);
                    }
                },
            }
        }
    }
    let lifecycle = state
        .manager
        .resolve(&workspace, workspace_dir.map(std::path::PathBuf::from));
    lifecycle
        .ensure_runtime()
        .await
        .map_err(|e| e.to_string())?;
    let docker = lifecycle.docker_client();
    let mut session_env: Vec<String> = provider_env;
    let mut launch_account_env = account_env;
    if let Some(env_name) = restore_claude_bundle_env {
        let dir = docker
            .restore_claude_bundle_from_env(&env_name, &launch_account_env)
            .await
            .map_err(|e| e.to_string())?;
        session_env.push(format!("CLAUDE_CONFIG_DIR={dir}"));
        launch_account_env.clear();
    }
    if let Some(env_name) = restore_codex_auth_env {
        // Write $CODEX_HOME/auth.json from the vault secret before launch, then run
        // Codex plainly (account_var stays None). CODEX_HOME is pinned by the base
        // pane env, so the bare `codex` finds the credential we just materialized.
        docker
            .restore_codex_auth_from_env(&env_name, &launch_account_env)
            .await
            .map_err(|e| e.to_string())?;
        launch_account_env.clear();
    }
    docker
        .create_tmux_session(TmuxSessionRequest {
            name: &name,
            cli,
            mode,
            alias: &alias,
            resume: resume.as_deref(),
            session_id: session_id.as_deref(),
            account_var: account_var.as_deref(),
            session_env: &session_env,
            account_env: &launch_account_env,
            cwd: cwd.as_deref(),
        })
        .await
        .map_err(|e| e.to_string())?;
    let git_branch = docker
        .exec_capture_pub(vec!["git", "-C", "/workspace", "branch", "--show-current"])
        .await
        .ok()
        .and_then(|b: String| {
            let b = b.trim().to_string();
            if b.is_empty() {
                None
            } else {
                Some(b)
            }
        });
    let claude_id = resume.as_deref().or(session_id.as_deref());
    state.registry.activity().register(
        &name,
        cli.binary(),
        &alias,
        claude_id,
        git_branch.as_deref(),
        task_description.as_deref(),
    );
    Ok(())
}

#[tauri::command]
async fn kill_session(
    name: String,
    workspace: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.registry.detach_by_session(&name).await;
    state.events.remove_session(&name);
    docker_for(&state, &workspace)
        .kill_tmux_session(&name)
        .await
        .map_err(|e| e.to_string())
}

/// Kill all agent sessions in a workspace (Settings danger zone).
#[tauri::command]
async fn stop_all_agents(
    workspace: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let docker = docker_for(&state, &workspace);
    let sessions = docker
        .list_tmux_sessions()
        .await
        .map_err(|e| e.to_string())?;
    for s in sessions {
        state.registry.detach_by_session(&s.name).await;
        state.events.remove_session(&s.name);
        let _ = docker.kill_tmux_session(&s.name).await;
    }
    Ok(())
}

/// Rolling usage for the last N hours (default 24). Sums by_day from Claude
/// and Codex usage, filtered to the time window.
#[tauri::command]
async fn rolling_usage(
    hours: Option<u32>,
    state: tauri::State<'_, AppState>,
) -> Result<crate::types::RollingUsage, String> {
    let window_hours = hours.unwrap_or(24);
    let docker = state
        .manager
        .any_running_docker()
        .await
        .ok_or_else(|| "no running workspace container".to_string())?;
    let cutoff_date = utc_date_minus_hours(window_hours);
    let mut tokens_in: u64 = 0;
    let mut tokens_out: u64 = 0;
    let mut est_cost_usd: f64 = 0.0;
    if let Ok(claude) = docker.claude_usage().await {
        for d in &claude.by_day {
            if d.date >= cutoff_date {
                tokens_in += d.totals.input + d.totals.cache_read;
                tokens_out += d.totals.output;
                est_cost_usd += d.est_cost_usd;
            }
        }
    }
    if let Ok(codex) = docker.codex_usage().await {
        for d in &codex.by_day {
            if d.date >= cutoff_date {
                tokens_in += d.totals.input + d.totals.cached_input;
                tokens_out += d.totals.output + d.totals.reasoning_output;
                est_cost_usd += d.est_cost_usd;
            }
        }
    }
    Ok(crate::types::RollingUsage {
        tokens_in,
        tokens_out,
        est_cost_usd,
        window_hours,
    })
}

/// Compute a UTC date string (YYYY-MM-DD) for now minus `hours`.
pub fn utc_date_minus_hours(hours: u32) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let cutoff_secs = now_secs.saturating_sub(u64::from(hours) * 3600);
    let days = cutoff_secs / 86400;
    // Civil date from days since 1970-01-01 (Algorithm from Howard Hinnant).
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

#[tauri::command]
async fn rename_session(
    name: String,
    alias: String,
    workspace: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    docker_for(&state, &workspace)
        .rename_tmux_window(&name, &alias)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn attach_session(
    name: String,
    cols: u16,
    rows: u16,
    workspace: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let docker = docker_for(&state, &workspace);
    state
        .registry
        .attach(&docker, &name, cols, rows, Arc::new(TauriEmitter(app)))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn pty_write(
    pane_id: String,
    data: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state
        .registry
        .write(&pane_id, data.as_bytes())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn pty_resize(
    pane_id: String,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // resize_exec only needs the raw Docker handle (exec ids are globally unique).
    let docker = Arc::new(DockerClient::from_docker(
        state.manager.docker_handle(),
        String::new(),
    ));
    state
        .registry
        .resize(&docker, &pane_id, cols, rows)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn detach_session(pane_id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.registry.detach(&pane_id).await;
    Ok(())
}

/// Current per-session activity (working/idle) derived from pane output flow.
/// In-memory and synchronous — never fails, returns an empty list when nothing
/// is attached.
#[tauri::command]
async fn session_activity(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<SessionActivity>, String> {
    Ok(state.registry.activity().snapshot())
}

/// Label of the always-on-top companion window (non-macOS webview companion).
#[cfg(not(target_os = "macos"))]
const COMPANION_LABEL: &str = "companion";

/// Build (or re-focus) the non-macOS webview companion window. Shared by the
/// `open_companion` command and the global-shortcut handler so both create the
/// window identically when it does not exist yet.
#[cfg(not(target_os = "macos"))]
fn show_companion_window(app: &tauri::AppHandle) -> Result<(), String> {
    // Already open → just bring it forward.
    if let Some(win) = app.get_webview_window(COMPANION_LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let win = tauri::WebviewWindowBuilder::new(
        app,
        COMPANION_LABEL,
        tauri::WebviewUrl::App("index.html#/companion".into()),
    )
    .title("CodeHub Companion")
    .inner_size(248.0, 360.0)
    .min_inner_size(200.0, 160.0)
    .decorations(false)
    .always_on_top(true)
    .resizable(true)
    .skip_taskbar(true)
    .build()
    .map_err(|e| e.to_string())?;
    // Best-effort: pin to the top-right of the primary monitor, leaving a small
    // inset. Positioning failure is non-fatal — the window still opens.
    if let Ok(Some(monitor)) = win.primary_monitor() {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let inset = (24.0 * scale) as i32;
        let win_w = (248.0 * scale) as i32;
        let x = (size.width as i32 - win_w - inset).max(0);
        let _ = win.set_position(tauri::PhysicalPosition::new(x, inset));
    }
    Ok(())
}

/// Toggle the non-macOS webview companion: hide it when it exists and is
/// currently visible, otherwise show/create + focus it. Used by the global
/// shortcut so repeated presses flip the window on and off (mirroring
/// `island::toggle` on macOS), rather than only ever raising it.
#[cfg(not(target_os = "macos"))]
fn toggle_companion_window(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(COMPANION_LABEL) {
        if win.is_visible().unwrap_or(false) {
            win.hide().map_err(|e| e.to_string())?;
            return Ok(());
        }
    }
    show_companion_window(app)
}

/// Open (or re-focus) the companion — a floating overlay that mirrors the live
/// working/idle state of every running agent so it stays visible over other
/// apps. Everything it shows is the honest activity signal — no fabricated
/// turn/token/approval state.
///
/// On macOS this is the native Dynamic Island ([`island`]); elsewhere it is a
/// small frameless `WebviewWindow` loading the real `index.html#/companion`
/// route.
#[cfg(target_os = "macos")]
#[tauri::command]
async fn open_companion(app: tauri::AppHandle) -> Result<(), String> {
    island::show(&app);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn open_companion(app: tauri::AppHandle) -> Result<(), String> {
    show_companion_window(&app)
}

/// Close/hide the companion. No-op when it is not open.
#[cfg(target_os = "macos")]
#[tauri::command]
async fn close_companion(app: tauri::AppHandle) -> Result<(), String> {
    island::hide(&app);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn close_companion(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(COMPANION_LABEL) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Jump from the companion to a session in the main window: raise + focus the
/// main window, then emit `codehub://focus-session` so the app focuses that
/// session and leaves any open detail view. Missing main window is a no-op.
#[tauri::command]
async fn focus_session_from_companion(name: String, app: tauri::AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
        let _ = main.emit("codehub://focus-session", name);
    }
    Ok(())
}

// ── Phase-0 completion contract: live command handlers ──────────────────────
// Honest-empty defaults remain for absent agent signals, but these handlers now
// read the live event, usage, and transcript sources instead of placeholder data.

/// Sessions awaiting user input right now (← agent-native hooks, §7).
/// Reads the in-memory [`EventsTracker`] — never fabricated, honest-empty when
/// no hooks have fired yet.
#[tauri::command]
async fn pending_prompts(state: tauri::State<'_, AppState>) -> Result<Vec<PendingPrompt>, String> {
    Ok(state.events.pending_prompts())
}

/// Answer a pending prompt by writing the accept/deny keystroke to that pane.
/// Writes via the same `pty_write` transport as broadcast. Clears the pending
/// state optimistically so the UI responds before the next hook line arrives.
/// Provisional keystrokes per §7.6 (unverified — confirmed on first authed run).
#[tauri::command]
async fn respond_prompt(
    session: String,
    allow: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // Determine the CLI for this session from the activity snapshot.
    let cli_opt = state
        .registry
        .activity()
        .snapshot()
        .into_iter()
        .find(|a| a.session == session)
        .and_then(|a| a.cli);

    // If we can't identify the CLI, we don't know which keystroke to send —
    // sending a wrong key to an unknown prompt is worse than doing nothing.
    let Some(cli) = cli_opt else {
        tracing::warn!("respond_prompt: no activity record for session {session}, skipping");
        return Ok(());
    };

    let keystroke = if allow {
        events::accept_keystroke(&cli)
    } else {
        events::deny_keystroke(&cli)
    };

    if let Some(key) = keystroke {
        // Look up the actual pane_id (UUID) for this session — the registry
        // keys panes by UUID, not session name.
        if let Some(pane_id) = state.registry.pane_for_session(&session).await {
            // Attempt the write; swallow if the pane raced to detach.
            let _ = state.registry.write(&pane_id, key.as_bytes()).await;
        } else {
            tracing::debug!("respond_prompt: no pane attached for session {session}");
        }
    }

    // Optimistically clear so the UI reflects the response without waiting for
    // the next hook line.
    state.events.clear_pending(&session);
    Ok(())
}

/// Activity/turn history ring buffer (all sessions when `session` omitted).
/// Returns events from the in-memory ring buffer fed by the hook tail task.
#[tauri::command]
async fn session_activity_history(
    session: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ActivityEvent>, String> {
    Ok(state.events.activity_history(session.as_deref()))
}

/// Codex usage analytics from rollout files.
#[tauri::command]
async fn codex_usage(state: tauri::State<'_, AppState>) -> Result<CodexUsage, String> {
    let docker = state
        .manager
        .any_running_docker()
        .await
        .ok_or_else(|| "no running workspace container".to_string())?;
    docker.codex_usage().await.map_err(|e| e.to_string())
}

/// Past Codex conversations from rollout files (Resume view).
#[tauri::command]
async fn codex_sessions(state: tauri::State<'_, AppState>) -> Result<Vec<CodexSession>, String> {
    let docker = state
        .manager
        .any_running_docker()
        .await
        .ok_or_else(|| "no running workspace container".to_string())?;
    docker.codex_sessions().await.map_err(|e| e.to_string())
}

/// Live per-session Codex tally from its rollout file.
#[tauri::command]
async fn codex_session_usage(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<CodexSessionUsage>, String> {
    let docker = state
        .manager
        .any_running_docker()
        .await
        .ok_or_else(|| "no running workspace container".to_string())?;
    docker
        .codex_session_usage(&id)
        .await
        .map_err(|e| e.to_string())
}

/// Codex rate-limit / plan meters from the most recent rollout file.
#[tauri::command]
async fn codex_rate_limits(
    state: tauri::State<'_, AppState>,
) -> Result<Option<CodexRateLimits>, String> {
    let docker = state
        .manager
        .any_running_docker()
        .await
        .ok_or_else(|| "no running workspace container".to_string())?;
    docker.codex_rate_limits().await.map_err(|e| e.to_string())
}

/// GitHub connection status (Integrations). Reads GITHUB_TOKEN presence on the
/// host — presence-only, the value is NEVER returned.
#[tauri::command]
async fn github_status(state: tauri::State<'_, AppState>) -> Result<GithubStatus, String> {
    let docker = state
        .manager
        .any_running_docker()
        .await
        .ok_or_else(|| "no running workspace container".to_string())?;
    docker.github_status().await.map_err(|e| e.to_string())
}

/// Repos visible to the connected GitHub account (up to 30, sorted by push date).
#[tauri::command]
async fn github_repos(state: tauri::State<'_, AppState>) -> Result<Vec<GithubRepo>, String> {
    let docker = state
        .manager
        .any_running_docker()
        .await
        .ok_or_else(|| "no running workspace container".to_string())?;
    docker.github_repos().await.map_err(|e| e.to_string())
}

/// App update check (Settings → About). Honest-thin: returns the current
/// version with `available: null`. A real updater plugin (tauri-plugin-updater)
/// is deferred to a future PR — wiring it now would add a new Tauri plugin
/// dependency and a GitHub release feed that doesn't exist yet.
#[tauri::command]
async fn check_update() -> Result<UpdateStatus, String> {
    // Honest: no update feed configured yet. Returns current version so the
    // About screen always has a real version string to display.
    Ok(UpdateStatus {
        current: env!("CARGO_PKG_VERSION").to_string(),
        available: None,
        notes: None,
    })
}

// ── Vault commands ────────────────────────────────────────────────────────
// Manage secrets in the encrypted-file vault for built-in agents + GitHub. The
// ONLY command that accepts a secret over IPC is `vault_store_key` (paste
// flow); no command ever returns a secret value.

/// Store an API key / token in the vault (paste flow for Codex/Antigravity/
/// GitHub PAT). The secret crosses IPC exactly once (paste → backend → vault)
/// and is never logged, returned, or written outside the encrypted vault file.
#[tauri::command]
fn vault_store_key(
    profile_id: String,
    secret: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state
        .vault
        .store(&profile_id, &secret)
        .map_err(|e| e.to_string())
}

/// Delete a vault entry by profile id.
#[tauri::command]
fn vault_delete_key(profile_id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.vault.delete(&profile_id).map_err(|e| e.to_string())
}

/// Metadata-only presence check — consults the in-memory vault index, never
/// decrypting or returning the secret; launch/use paths perform the real read.
#[tauri::command]
fn vault_has_key(profile_id: String, state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let configured = state
        .config
        .get()
        .account_profiles
        .into_iter()
        .any(|p| p.id == profile_id && p.is_vault());
    Ok(configured && state.vault.exists(&profile_id))
}

/// Start a container-mediated login for an agent. Creates a temporary
/// container with a tmux session running the agent's login command. Returns
/// the session name + workspace key so the frontend can open it as a visible
/// pane. After the user completes login, the frontend calls
/// `vault_complete_login` to capture the credential.
///
/// GitHub has no container step; it starts the device-code polling loop in the
/// background and emits auth-progress events directly.
#[tauri::command]
async fn vault_initiate_oauth(
    provider: String,
    profile_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    match provider.as_str() {
        "claude" | "codex" | "antigravity" => {
            let spec = auth::login_spec(&provider)
                .ok_or_else(|| format!("unknown provider: {provider}"))?;
            let (login_cmd, _) = spec;

            // Use a dedicated temporary workspace key for login containers.
            let ws_key = format!("codehub-login-{}", uuid::Uuid::new_v4());
            let session_name = format!(
                "login-{provider}-{}",
                &profile_id[..8.min(profile_id.len())]
            );

            // Ensure the container is running.
            let lifecycle = state.manager.resolve(&ws_key, None);
            lifecycle
                .ensure_runtime()
                .await
                .map_err(|e| e.to_string())?;
            let docker = lifecycle.docker_client();

            // Build the login command as a normal CodeHub tmux session. It must
            // use the default socket under TMUX_TMPDIR, because `attach_session`
            // attaches through that same socket.
            let mut tmux_cmd: Vec<String> = ["tmux", "new-session", "-d", "-s"]
                .iter()
                .map(|s| s.to_string())
                .collect();
            tmux_cmd.push(session_name.clone());
            tmux_cmd.push("-n".into());
            tmux_cmd.push("Login".into());
            docker::push_base_tmux_env(&mut tmux_cmd);
            if provider == "claude" {
                docker::push_tmux_env(
                    &mut tmux_cmd,
                    format!(
                        "CLAUDE_CONFIG_DIR={}",
                        auth::claude_login_config_dir(&session_name)
                    ),
                );
            }
            tmux_cmd.extend(login_cmd.into_iter().map(String::from));
            docker
                .exec_capture_pub(tmux_cmd.iter().map(String::as_str).collect())
                .await
                .map_err(|e| e.to_string())?;
            let capture_path = auth::login_capture_path(&session_name);
            let pipe_cmd = format!("cat >> {capture_path}");
            let _ = docker
                .exec_capture_pub(vec![
                    "tmux",
                    "pipe-pane",
                    "-o",
                    "-t",
                    &session_name,
                    &pipe_cmd,
                ])
                .await;

            Ok(serde_json::json!({
                "sessionName": session_name,
                "workspace": ws_key,
                "provider": provider,
                "profileId": profile_id,
            }))
        },
        "github" => {
            let vault = state.vault.clone();
            let app2 = app.clone();
            let pid = profile_id.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = auth::github_login(&vault, &pid, &app2).await {
                    tracing::warn!("github login failed: {e}");
                }
            });
            Ok(serde_json::json!({ "provider": "github", "profileId": profile_id }))
        },
        _ => Err(format!("unknown provider: {provider}")),
    }
}

/// After a login session exits, read the credential from the container and
/// store it in the vault. The frontend calls this when the login pane closes.
#[tauri::command]
async fn vault_complete_login(
    provider: String,
    profile_id: String,
    workspace: String,
    session_name: Option<String>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let docker = Arc::new(
        state
            .manager
            .workspace_container(&workspace)
            .docker_client(),
    );

    let result = async {
        let credential =
            auth::capture_credential(&docker, &provider, session_name.as_deref()).await?;

        if let Some(cred) = credential {
            auth::store_credential(&state.vault, &profile_id, &provider, &cred, &app)?;
        } else {
            let message = auth::login_failure_message(&docker, &provider, session_name.as_deref())
                .await
                .unwrap_or_else(|| "No credential found after login".into());
            let _ = app.emit(
                "codehub://auth-progress",
                auth::AuthProgress {
                    profile_id: profile_id.clone(),
                    provider: provider.clone(),
                    stage: "error".into(),
                    url: None,
                    user_code: None,
                    message: Some(message.clone()),
                },
            );
            return Err(message);
        }

        Ok(())
    }
    .await;

    // Clean up the temporary login container whether capture succeeded or not.
    let _ = state.manager.remove_workspace(&workspace).await;
    result
}

/// Bundle identifier used by the app before the Aviary→CodeHub rebrand. The OS
/// app-data dir is namespaced by this id, so a rebranded build looks at a fresh
/// (empty) path and existing users would lose their CLI auth + workspace.
const LEGACY_BUNDLE_ID: &str = "com.mutlupolatcan.aviary";

/// One-time migration for the rebrand: if the new (CodeHub) app-data dir does
/// not exist yet but the legacy (Aviary) one does, move it over. Old and new
/// dirs are siblings under the same OS app-data root, so this is a same-volume
/// rename — cheap and atomic. Failure is non-fatal: we log and fall back to a
/// fresh dir rather than block startup.
fn migrate_legacy_app_data(new_app_data: &std::path::Path) {
    // Never clobber an existing CodeHub dir; only migrate into a clean slot.
    if new_app_data.exists() {
        return;
    }
    let Some(parent) = new_app_data.parent() else {
        return;
    };
    let legacy = parent.join(LEGACY_BUNDLE_ID);
    if !legacy.is_dir() {
        return;
    }
    match std::fs::rename(&legacy, new_app_data) {
        Ok(()) => tracing::info!(
            "migrated app data from legacy {} to {}",
            legacy.display(),
            new_app_data.display()
        ),
        Err(e) => tracing::warn!(
            "could not migrate legacy app data from {} ({e}); starting fresh",
            legacy.display()
        ),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,codehub_lib=debug".into()),
        )
        .init();

    let image = std::env::var("CODEHUB_IMAGE")
        .or_else(|_| std::env::var("AVIARY_IMAGE"))
        .unwrap_or_else(|_| DEFAULT_IMAGE.into());

    // P5 global shortcut: Cmd+Shift+J (macOS) / Ctrl+Shift+J (Win/Linux) toggles
    // the always-on-top surface — the native island on macOS, the webview
    // companion elsewhere. `Modifiers` is an all-required bitflag set (not an
    // either/or CmdOrCtrl alias), so the platform modifier is chosen at compile
    // time; listing both Super and Control would force users to hold both keys.
    // Registered through the plugin builder with an on-press handler so the
    // keystroke works while CodeHub is in the background (a global hotkey).
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};
    #[cfg(target_os = "macos")]
    let toggle_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyJ);
    #[cfg(not(target_os = "macos"))]
    let toggle_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyJ);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        // Persist each window's position/size across restarts (the companion in
        // particular, so it reopens where the user left it).
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcut(toggle_shortcut)
                .expect("register global toggle shortcut")
                .with_handler(move |app, shortcut, event| {
                    // Only act on key-DOWN of our shortcut; ignore the release.
                    if event.state() != ShortcutState::Pressed || shortcut != &toggle_shortcut {
                        return;
                    }
                    #[cfg(target_os = "macos")]
                    {
                        island::toggle(app);
                    }
                    #[cfg(not(target_os = "macos"))]
                    {
                        let _ = toggle_companion_window(app);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            let app_data = app.path().app_data_dir().expect("app_data_dir unavailable");
            // One-time carry-over of pre-rebrand (Aviary) auth + workspace data.
            migrate_legacy_app_data(&app_data);
            let config_dir = app_data.join("config");
            let workspace_dir = app_data.join("workspace");

            // UI preferences — separate file from the container config mount.
            // Loaded BEFORE the lifecycle: the effective workspace dir + account
            // profile env vars are read from it at container-create time.
            let config = Arc::new(ConfigStore::load(app_data.join("settings.json")));
            let app_vault = Arc::new(vault::Vault::new(app_data.clone()));

            let manager = Arc::new(
                LifecycleManager::new(image.clone(), config_dir, workspace_dir, config.clone())?
                    .with_vault(app_vault.clone()),
            );
            let registry = Arc::new(PtyRegistry::new());
            let events = Arc::new(EventsTracker::with_activity(registry.activity()));

            let notify_config = config.clone();

            #[cfg(target_os = "macos")]
            let island_registry = registry.clone();
            #[cfg(target_os = "macos")]
            let island_events = events.clone();
            #[cfg(target_os = "macos")]
            let island_manager = manager.clone();
            #[cfg(target_os = "macos")]
            let island_config = config.clone();
            #[cfg(not(target_os = "macos"))]
            let companion_launch_config = config.clone();

            let stats_hist = Arc::new(stats_history::StatsHistory::new());

            // Background poller: sample container_stats for all running
            // workspaces every 2s, feeding the sparkline ring buffer.
            {
                let poller_manager = manager.clone();
                let poller_hist = stats_hist.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        if let Ok(containers) = poller_manager.list_workspace_containers().await {
                            for wc in containers {
                                if wc.status.state == lifecycle::ContainerState::Running {
                                    let docker =
                                        poller_manager.workspace_container(&wc.key).docker_client();
                                    if let Ok(stats) = docker.stats().await {
                                        poller_hist.push(&wc.key, &stats);
                                    }
                                }
                            }
                        }
                    }
                });
            }

            // Credential-sync loop: persist the OAuth token Claude refreshes in
            // place back to the vault so a profile doesn't drift into 401 once its
            // login-time access token expires. Tauri-only (the vault lives under
            // the app data dir; the dev bridge has none). Spawned on Tauri's runtime — a
            // bare tokio::spawn in `setup` would abort (CLAUDE.md spawner gotcha).
            {
                let cred_manager = manager.clone();
                let cred_config = config.clone();
                let cred_vault = app_vault.clone();
                tauri::async_runtime::spawn(auth::credential_sync_loop(
                    cred_manager,
                    cred_config,
                    cred_vault,
                ));
            }

            app.manage(AppState {
                manager: manager.clone(),
                registry,
                config,
                events: events.clone(),
                stats_history: stats_hist,
                vault: app_vault,
            });

            // macOS: drive the native Dynamic Island from the live activity feed.
            // Every signal is honest (mirrors the frontend `deriveLiveStatus`):
            //   - Wait  ← `pending_prompts()` / hook `Awaiting` (a real prompt)
            //   - Err   ← a turn that just failed (transient ~6s linger)
            //   - Done  ← a turn that just finished (transient ~6s linger)
            //   - Live  ← a turn in flight; sub-line shows the current tool /
            //             "thinking" + tool count + the live turn clock
            //   - Idle  ← otherwise (sub-line shows the Claude edits·tok metric)
            //   - agent ← the registered cli id (dot identity)
            // Now that the hooks distinguish turn-finish (`Stop` → transient Done)
            // from failure (`StopFailure` → transient Err) and from idle, these are
            // emitted from REAL events — no recency heuristic, nothing fabricated.
            //
            // The island AUTO-POPS (and expands) when a row newly enters awaiting or
            // a turn just finished/failed — the "needs you / done" announcement —
            // then collapses back to the pill after a short window (awaiting holds
            // it open until answered). The loop therefore runs every tick even while
            // hidden, to detect those transitions; only the heavier Claude metric
            // read is gated on the island being visible.
            #[cfg(target_os = "macos")]
            {
                use std::collections::{HashMap, HashSet};
                use std::time::{Duration, Instant};
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    // A finished/failed turn lingers as a transient badge this long
                    // (matches the frontend OUTCOME_LINGER_MS).
                    const OUTCOME_LINGER_MS: u64 = 6000;
                    // How long the panel auto-expands to announce a fresh event
                    // before it's allowed to collapse back to the pill.
                    const ANNOUNCE: Duration = Duration::from_millis(5000);
                    // Refresh the (heavier) Claude transcript metric every 5th tick.
                    const METRIC_EVERY: u64 = 5;

                    let mut tick = tokio::time::interval(Duration::from_millis(1000));
                    let mut metric_cache: HashMap<String, String> = HashMap::new();
                    let mut prev_awaiting: HashSet<String> = HashSet::new();
                    let mut last_outcome_ms: HashMap<String, u64> = HashMap::new();
                    let mut announce_until: Option<Instant> = None;
                    let mut ticks: u64 = 0;
                    // Tracks the show_companion setting edge so we auto-show on
                    // launch (first tick, enabled) and on a later re-enable.
                    let mut prev_enabled = false;

                    loop {
                        tick.tick().await;
                        // Master enable (Settings → "Dynamic Island"). Default on:
                        // shows on launch; turning it off hides + parks the feed.
                        let enabled = island_config.get().show_companion;
                        if enabled && !prev_enabled {
                            island::show(&handle);
                        }
                        prev_enabled = enabled;
                        if !enabled {
                            if island::is_visible() {
                                island::hide(&handle);
                            }
                            continue;
                        }
                        let visible = island::is_visible();
                        let activity = island_registry.activity().snapshot();
                        let waiting: HashSet<String> = island_events
                            .pending_prompts()
                            .into_iter()
                            .map(|p| p.session)
                            .collect();

                        // The Claude metric (idle rows) needs a heavy transcript
                        // read — only do it while the island is actually on screen.
                        if visible && ticks % METRIC_EVERY == 0 {
                            if let Some(docker) = island_manager.any_running_docker().await {
                                for a in &activity {
                                    let Some(id) = a.claude_id.as_deref() else {
                                        continue;
                                    };
                                    match docker.claude_session_usage(id).await {
                                        Ok(Some(u)) => {
                                            if let Some(m) = island_metric(&u) {
                                                metric_cache.insert(a.session.clone(), m);
                                            } else {
                                                metric_cache.remove(&a.session);
                                            }
                                        },
                                        _ => {
                                            metric_cache.remove(&a.session);
                                        },
                                    }
                                }
                            }
                        }
                        let live_sessions: HashSet<&str> =
                            activity.iter().map(|a| a.session.as_str()).collect();
                        metric_cache.retain(|s, _| live_sessions.contains(s.as_str()));
                        ticks = ticks.wrapping_add(1);

                        // Build rows + detect the events that auto-pop the island: a
                        // NEW awaiting prompt, or a freshly finished/failed turn.
                        // Status precedence mirrors the frontend deriveLiveStatus:
                        // wait > err > done > live > idle.
                        let now = Instant::now();
                        let mut any_awaiting = false;
                        let mut new_awaiting = false;
                        let mut fresh_outcome = false;
                        let mut cur_awaiting: HashSet<String> = HashSet::new();
                        let mut cur_outcome_ms: HashMap<String, u64> = HashMap::new();

                        let rows: Vec<island::IslandRow> = activity
                            .iter()
                            .map(|a| {
                                let waiting_now = waiting.contains(&a.session)
                                    || a.session_status == activity::SessionStatus::Awaiting;
                                let outcome_fresh = a
                                    .outcome_ms_ago
                                    .map(|ms| ms < OUTCOME_LINGER_MS)
                                    .unwrap_or(false);
                                let status = if waiting_now {
                                    island::IslandStatus::Wait
                                } else if outcome_fresh
                                    && a.last_outcome == Some(activity::TurnOutcome::Failed)
                                {
                                    island::IslandStatus::Err
                                } else if outcome_fresh
                                    && a.last_outcome == Some(activity::TurnOutcome::Completed)
                                {
                                    island::IslandStatus::Done
                                } else if (a.seen_hooks
                                    && a.session_status == activity::SessionStatus::Running)
                                    || (!a.seen_hooks
                                        && matches!(a.state, activity::ActivityState::Working))
                                {
                                    island::IslandStatus::Live
                                } else {
                                    island::IslandStatus::Idle
                                };

                                if waiting_now {
                                    any_awaiting = true;
                                    cur_awaiting.insert(a.session.clone());
                                    if !prev_awaiting.contains(&a.session) {
                                        new_awaiting = true;
                                    }
                                }
                                // Fresh outcome = the outcome clock reset since the
                                // last tick (a new Stop drops ms_ago back near 0) and
                                // is recent — so each finished/failed turn announces
                                // exactly once, not every tick of its linger.
                                if let Some(ms) = a.outcome_ms_ago {
                                    cur_outcome_ms.insert(a.session.clone(), ms);
                                    let prev = last_outcome_ms.get(&a.session).copied();
                                    if ms < OUTCOME_LINGER_MS
                                        && prev.map(|p| ms < p).unwrap_or(true)
                                    {
                                        fresh_outcome = true;
                                    }
                                }

                                island::IslandRow {
                                    label: a.alias.clone().unwrap_or_else(|| a.session.clone()),
                                    session: a.session.clone(),
                                    agent: a.cli.clone(),
                                    status,
                                    metric: metric_cache.get(&a.session).cloned(),
                                    model: None,
                                    branch: a.git_branch.clone(),
                                    current_tool: a.current_tool.clone(),
                                    turns: a.turns,
                                    tool_calls: a.tool_calls,
                                    turn_ms: a.turn_elapsed_ms,
                                }
                            })
                            .collect();

                        prev_awaiting = cur_awaiting;
                        last_outcome_ms = cur_outcome_ms;

                        if new_awaiting || fresh_outcome {
                            announce_until = Some(now + ANNOUNCE);
                        }
                        let announcing = announce_until.map(|t| now < t).unwrap_or(false);
                        // Awaiting holds the panel open until answered; a finish/fail
                        // expands for the announce window then collapses to the pill.
                        let want_expanded = any_awaiting || announcing;
                        // Pop when expanding; stay present once shown.
                        let want_present = want_expanded || visible;

                        if want_present {
                            island::drive(
                                &handle,
                                island::IslandSnapshot { rows },
                                want_present,
                                want_expanded,
                            );
                        }
                    }
                });
            }

            // Non-macOS: open the companion window on launch when enabled (the
            // macOS island handles its own launch-show via the feed's enable edge).
            #[cfg(not(target_os = "macos"))]
            if companion_launch_config.get().show_companion {
                let _ = show_companion_window(&app.handle());
            }

            // Daemon reachability check — containers are created on demand by
            // create_session, so we just verify Docker is up and emit a synthetic
            // "running" status to trigger the frontend bootstrap (session restore).
            let handle = app.handle().clone();
            let startup_manager = manager.clone();
            tauri::async_runtime::spawn(async move {
                let info = startup_manager.docker_info().await;
                if info.reachable {
                    let status = ContainerStatus {
                        state: lifecycle::ContainerState::Running,
                        id: None,
                        image: image.clone(),
                        name: "daemon".to_string(),
                    };
                    let _ = handle.emit("codehub://lifecycle", &status);
                } else {
                    let _ = handle.emit(
                        "codehub://lifecycle-error",
                        "Docker daemon unreachable — is Docker Desktop running?".to_string(),
                    );
                }
            });

            // Start the agent-event hook tail — reconciler fans a tail out to
            // every live workspace container, feeding the EventsTracker.
            events::start_event_tailer(
                manager.clone(),
                events,
                notify_config,
                app.handle().clone(),
            );

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            container_status,
            container_start,
            container_stop,
            container_restart,
            docker_info,
            detect_docker_runtime,
            start_docker_app,
            app_info,
            host_stats,
            runtime_versions,
            get_config,
            set_config,
            add_prompt_template,
            remove_prompt_template,
            pick_directory,
            set_workspace_dir,
            workspace_info,
            recreate_runtime,
            list_workspace_containers,
            remove_workspace_container,
            list_account_profiles,
            add_account_profile,
            remove_account_profile,
            rename_account_profile,
            set_account_profile_enabled,
            agent_key_status,
            agent_versions,
            container_stats,
            container_stats_history,
            container_logs,
            container_mounts,
            container_image,
            container_health,
            container_list_dir,
            container_browse_dirs,
            container_read_file,
            container_git_status,
            container_git_diff,
            container_git_diff_all,
            container_git_diff_staged,
            container_git_diff_unstaged,
            container_git_stage_all,
            container_git_stage_file,
            container_git_unstage_file,
            container_git_stage_hunk,
            container_git_commit,
            container_git_open_pr,
            set_agent_model,
            set_permission_mode,
            set_permission_rules,
            toggle_mcp_server,
            container_top,
            container_env,
            container_repos,
            container_git_clone,
            claude_usage,
            claude_sessions,
            claude_session_usage,
            claude_integrations,
            claude_agent_config,
            container_git_log,
            list_sessions,
            create_session,
            kill_session,
            stop_all_agents,
            rolling_usage,
            rename_session,
            attach_session,
            pty_write,
            pty_resize,
            detach_session,
            session_activity,
            open_companion,
            close_companion,
            focus_session_from_companion,
            // Phase-0 completion contract: live command handlers.
            pending_prompts,
            respond_prompt,
            session_activity_history,
            codex_usage,
            codex_sessions,
            codex_session_usage,
            codex_rate_limits,
            github_status,
            github_repos,
            check_update,
            search_transcripts,
            list_providers,
            add_provider,
            remove_provider,
            update_provider,
            set_provider_token,
            // Vault: encrypted-file credential management for built-in agents + GitHub.
            vault_store_key,
            vault_delete_key,
            vault_has_key,
            vault_initiate_oauth,
            vault_complete_login,
        ])
        .run(tauri::generate_context!())
        .expect("error while running codehub");
}
