// Modules are `pub` so the dev-server bin (feature `devserver`, see
// devserver.rs) can reuse the same docker / pty / lifecycle logic without going
// through Tauri.
pub mod activity;
pub mod config;
#[cfg(feature = "devserver")]
pub mod devserver;
pub mod docker;
/// Agent-event hooks subsystem (§7, COMPLETION_PLAN.md).
pub mod events;
// Native macOS Dynamic Island companion. On other platforms the companion stays
// a WebviewWindow (see open_companion below).
#[cfg(target_os = "macos")]
pub mod island;
pub mod lifecycle;
/// Per-workspace container manager (per-workspace-container architecture).
pub mod manager;
pub mod pty;
/// Shared IPC response types (Phase-0 completion contract).
pub mod types;

use activity::SessionActivity;
use config::{AccountProfile, ConfigStore, Settings};
use docker::{
    AgentConfig, AgentVersion, ClaudeIntegrations, ClaudeSession, ClaudeUsage, Cli, CommitInfo,
    ContainerStats, DockerClient, FileEntry, GitStatus, ImageInfo, LaunchMode, MountInfo,
    ProcessInfo, RuntimeHealth, SessionUsage,
};
use events::EventsTracker;
use lifecycle::{AppInfo, ContainerStatus, DockerInfo, KeyStatus, Lifecycle, WorkspaceInfo};
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
    /// Shared-runtime lifecycle (`codehub-runtime`). Today every IPC command
    /// targets this; it is `manager.default()`. Per-workspace lifecycles are
    /// resolved through `manager` (per-workspace-container migration, Phase 1).
    pub lifecycle: Arc<Lifecycle>,
    /// Resolves a `Lifecycle` per workspace (`codehub-ws-<key>`) when the
    /// `CODEHUB_PER_WORKSPACE_CONTAINER` flag is on, else the shared default.
    pub manager: Arc<LifecycleManager>,
    pub docker: Arc<DockerClient>,
    pub registry: Arc<PtyRegistry>,
    pub config: Arc<ConfigStore>,
    /// Agent-event hook state: pending prompts + activity ring buffer.
    pub events: Arc<EventsTracker>,
}

const DEFAULT_CONTAINER: &str = "codehub-runtime";
const DEFAULT_IMAGE: &str = "ghcr.io/mpolatcan/codehub-runtime:0.1.3";

/// DockerClient for a session command's target container. `workspace` is the
/// per-workspace key the frontend tracks; `None` (or the per-workspace flag off)
/// resolves to the shared runtime — identical to the pre-per-workspace behaviour.
/// Used by the session lifecycle commands so a tmux session is created/attached/
/// killed in the container that actually hosts it.
fn docker_for(state: &AppState, workspace: Option<&str>) -> Arc<DockerClient> {
    Arc::new(state.manager.resolve(workspace, None).docker_client())
}

/// DockerClient for an inspection command's target container, BY NAME with no
/// flag fallback (mirrors `lifecycle_for`). Unlike `docker_for` (used by session
/// create/attach/kill, where a key means the shared runtime when the flag is
/// off), an explicit `workspace` here ALWAYS targets that per-workspace
/// container — reading its OWN stats/logs/procs, never the shared runtime's.
fn docker_container_for(state: &AppState, workspace: Option<&str>) -> Arc<DockerClient> {
    Arc::new(state.manager.resolve_container(workspace).docker_client())
}

/// The lifecycle for an optional workspace key, BY NAME with no flag fallback:
/// `None` → the shared runtime, `Some(key)` → that workspace's container
/// (`codehub-ws-<key>`), even when the per-workspace flag is off. Backs the
/// inspector / lifecycle commands so Start/Stop/Restart on a workspace card
/// always act on THAT container and never on `codehub-runtime`. (Session
/// commands use `manager.resolve`, which DOES fall back to shared when off.)
fn lifecycle_for(state: &AppState, workspace: Option<&str>) -> Arc<Lifecycle> {
    state.manager.resolve_container(workspace)
}

#[tauri::command]
async fn container_status(
    state: tauri::State<'_, AppState>,
    workspace: Option<String>,
) -> Result<ContainerStatus, String> {
    Ok(lifecycle_for(&state, workspace.as_deref()).status().await)
}

/// Run a lifecycle mutation (start/stop/restart/recreate), then read the fresh
/// status and return it. Broadcasts on `codehub://lifecycle` ONLY for the shared
/// runtime (`workspace` is None) — the store's single `status` tracks the shared
/// runtime, so a per-workspace event would clobber its identity/state. Per-
/// workspace state is surfaced by the fleet poll (`list_workspace_containers`),
/// not this event.
async fn lifecycle_op(
    lc: &Lifecycle,
    app: &tauri::AppHandle,
    workspace: Option<&str>,
    op: impl std::future::Future<Output = Result<(), lifecycle::LifecycleError>>,
) -> Result<ContainerStatus, String> {
    op.await.map_err(|e| e.to_string())?;
    let status = lc.status().await;
    if workspace.is_none() {
        let _ = app.emit("codehub://lifecycle", &status);
    }
    Ok(status)
}

#[tauri::command]
async fn container_start(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    workspace: Option<String>,
) -> Result<ContainerStatus, String> {
    let lc = lifecycle_for(&state, workspace.as_deref());
    lifecycle_op(&lc, &app, workspace.as_deref(), lc.start()).await
}

#[tauri::command]
async fn container_stop(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    workspace: Option<String>,
) -> Result<ContainerStatus, String> {
    let lc = lifecycle_for(&state, workspace.as_deref());
    lifecycle_op(&lc, &app, workspace.as_deref(), lc.stop()).await
}

#[tauri::command]
async fn container_restart(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    workspace: Option<String>,
) -> Result<ContainerStatus, String> {
    let lc = lifecycle_for(&state, workspace.as_deref());
    lifecycle_op(&lc, &app, workspace.as_deref(), lc.restart()).await
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
async fn docker_info(state: tauri::State<'_, AppState>) -> Result<DockerInfo, String> {
    Ok(state.lifecycle.docker_info().await)
}

/// Presence-only auth status per CLI. Reports booleans + env var names; never
/// the secret values (see BACKEND_PLAN.md / lifecycle::agent_key_status).
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

/// Whether the per-workspace-container runtime mode is active (the
/// `CODEHUB_PER_WORKSPACE_CONTAINER` flag). The frontend uses this to decide
/// whether a new tab gets its own container key — flag OFF, sessions live in
/// the shared runtime and must carry `containerKey: undefined`.
#[tauri::command]
fn per_workspace_enabled() -> Result<bool, String> {
    Ok(manager::per_workspace_enabled())
}

/// Current persisted UI preferences (Settings screen). In-memory snapshot —
/// never fails.
#[tauri::command]
fn get_config(state: tauri::State<'_, AppState>) -> Result<Settings, String> {
    Ok(state.config.get())
}

/// Replace the persisted UI preferences and write them to disk. Returns the
/// stored settings so the frontend can confirm what landed.
#[tauri::command]
fn set_config(config: Settings, state: tauri::State<'_, AppState>) -> Result<Settings, String> {
    state.config.set(config)
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
/// change. Backs the "restart runtime to apply" banner.
#[tauri::command]
async fn workspace_info(state: tauri::State<'_, AppState>) -> Result<WorkspaceInfo, String> {
    Ok(state.lifecycle.workspace_info().await)
}

/// Remove + recreate the runtime container so a changed workspace mount (or a
/// newly-added account-profile env var) takes effect. Destructive to running
/// sessions — the UI confirms first. Emits codehub://lifecycle like the other
/// lifecycle controls.
#[tauri::command]
async fn recreate_runtime(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ContainerStatus, String> {
    lifecycle_op(&state.lifecycle, &app, None, state.lifecycle.recreate()).await
}

// — Tier-3: label-only account profiles (no secrets stored) —
// `AccountProfileStatus` + `profile_statuses` live in `config` (next to
// `AccountProfile`); re-exported above so `crate::` paths + devserver keep
// working. `build_account_profile` stays here — it bridges `Cli` + `docker`
// validation with the config type, so it belongs in the glue layer.

// ── Phase-0 completion contract (COMPLETION_PLAN.md) ────────────────────────
// The response structs live in `types.rs` and are re-exported from `crate::` above
// so devserver.rs can continue to import them from `crate::`. The commands below
// now have real implementations (the BE track fills them per COMPLETION_PLAN.md).

// Sentinel kept only for devserver.rs backward-compat during the transition;
// will be removed once devserver stubs are updated to real state access.
#[allow(dead_code)]
pub(crate) const STUB_RATES_AS_OF: &str = "unloaded";

/// All stored account profiles + live presence of each one's host env var.
#[tauri::command]
fn list_account_profiles(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AccountProfileStatus>, String> {
    Ok(profile_statuses(state.config.get().account_profiles))
}

/// Validate + construct a label-only account profile (no secret). Shared by the
/// Tauri command and the dev bridge. Rejects agents with no credential var, an
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
        var_name,
    })
}

/// Add a label-only account profile (agent + label + host env var NAME). No
/// secret is stored. Returns the full updated list + presence.
#[tauri::command]
fn add_account_profile(
    agent: String,
    label: String,
    var_name: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AccountProfileStatus>, String> {
    let profile = build_account_profile(&agent, &label, &var_name)?;
    let next = state.config.add_account_profile(profile)?;
    Ok(profile_statuses(next.account_profiles))
}

/// Remove an account profile by id. Returns the full updated list + presence.
#[tauri::command]
fn remove_account_profile(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AccountProfileStatus>, String> {
    let next = state.config.remove_account_profile(&id)?;
    Ok(profile_statuses(next.account_profiles))
}

/// `<cli> --version` for each agent inside the runtime container.
#[tauri::command]
async fn agent_versions(
    state: tauri::State<'_, AppState>,
) -> Result<HashMap<String, AgentVersion>, String> {
    Ok(state.docker.agent_versions().await)
}

/// One-shot CPU/mem/net/disk for the runtime container (Containers view gauges).
/// Errs when the container is down so the UI keeps the gauges blank.
#[tauri::command]
async fn container_stats(
    state: tauri::State<'_, AppState>,
    workspace: Option<String>,
) -> Result<ContainerStats, String> {
    docker_container_for(&state, workspace.as_deref())
        .stats()
        .await
        .map_err(|e| e.to_string())
}

/// Tail of the runtime container's log (Containers view log panel). `tail`
/// defaults to 200 lines. Errs when the container is down.
#[tauri::command]
async fn container_logs(
    state: tauri::State<'_, AppState>,
    tail: Option<u32>,
    workspace: Option<String>,
) -> Result<Vec<String>, String> {
    docker_container_for(&state, workspace.as_deref())
        .logs(tail.unwrap_or(200))
        .await
        .map_err(|e| e.to_string())
}

/// Real bind/volume mounts of the runtime container (Containers view Mounts
/// card). Reports the actual host paths behind `/workspace` and `/config`.
#[tauri::command]
async fn container_mounts(
    state: tauri::State<'_, AppState>,
    workspace: Option<String>,
) -> Result<Vec<MountInfo>, String> {
    docker_container_for(&state, workspace.as_deref())
        .mounts()
        .await
        .map_err(|e| e.to_string())
}

/// Identity of the runtime container's image (Containers view Image card):
/// tag/digest/created/size/arch/os. Errs only when the container/image can't be
/// inspected.
#[tauri::command]
async fn container_image(
    state: tauri::State<'_, AppState>,
    workspace: Option<String>,
) -> Result<ImageInfo, String> {
    docker_container_for(&state, workspace.as_deref())
        .image_info()
        .await
        .map_err(|e| e.to_string())
}

/// Liveness of the runtime container (Containers view hero): started-at, restart
/// count, status and OOM flag. Errs only when the container can't be inspected.
#[tauri::command]
async fn container_health(
    state: tauri::State<'_, AppState>,
    workspace: Option<String>,
) -> Result<RuntimeHealth, String> {
    docker_container_for(&state, workspace.as_deref())
        .health()
        .await
        .map_err(|e| e.to_string())
}

/// Non-recursive listing of a `/workspace` directory (Files browser). `path` is
/// confined to `/workspace`; empty → the workspace root. Errs when down or the
/// path escapes the workspace.
#[tauri::command]
async fn container_list_dir(
    state: tauri::State<'_, AppState>,
    path: String,
    workspace: Option<String>,
) -> Result<Vec<FileEntry>, String> {
    docker_container_for(&state, workspace.as_deref())
        .list_dir(&path)
        .await
        .map_err(|e| e.to_string())
}

/// First 256 KiB of a `/workspace` file (Files browser preview). `path` is
/// confined to `/workspace`. Errs when down or the path escapes.
#[tauri::command]
async fn container_read_file(
    state: tauri::State<'_, AppState>,
    path: String,
    workspace: Option<String>,
) -> Result<String, String> {
    docker_container_for(&state, workspace.as_deref())
        .read_file(&path)
        .await
        .map_err(|e| e.to_string())
}

/// Working-tree status of the `/workspace` mount (Hub activity rail "Changes").
/// Reports branch + ahead/behind + changed files; `is_repo: false` when
/// /workspace is not a git repo. Errs only when the container is down.
#[tauri::command]
async fn container_git_status(
    state: tauri::State<'_, AppState>,
    workspace: Option<String>,
) -> Result<GitStatus, String> {
    docker_container_for(&state, workspace.as_deref())
        .git_status()
        .await
        .map_err(|e| e.to_string())
}

/// Unified diff for one `/workspace` path (rail "Changes" → diff viewer).
#[tauri::command]
async fn container_git_diff(
    path: String,
    state: tauri::State<'_, AppState>,
    workspace: Option<String>,
) -> Result<String, String> {
    docker_container_for(&state, workspace.as_deref())
        .git_diff(&path)
        .await
        .map_err(|e| e.to_string())
}

/// Combined diff of all tracked `/workspace` changes (rail "Review all" → diff
/// viewer). Empty string when the tree is clean.
#[tauri::command]
async fn container_git_diff_all(
    state: tauri::State<'_, AppState>,
    workspace: Option<String>,
) -> Result<String, String> {
    docker_container_for(&state, workspace.as_deref())
        .git_diff_all()
        .await
        .map_err(|e| e.to_string())
}

/// Staged-only diff of `/workspace` (`git diff --cached`) — the session-detail
/// inspector's "Staged" filter. Empty string when nothing is staged.
#[tauri::command]
async fn container_git_diff_staged(
    state: tauri::State<'_, AppState>,
    workspace: Option<String>,
) -> Result<String, String> {
    docker_container_for(&state, workspace.as_deref())
        .git_diff_staged()
        .await
        .map_err(|e| e.to_string())
}

/// Unstaged diff of tracked `/workspace` files (`git diff`) — the "Unstaged"
/// filter. Empty string when the tracked tree matches the index.
#[tauri::command]
async fn container_git_diff_unstaged(
    state: tauri::State<'_, AppState>,
    workspace: Option<String>,
) -> Result<String, String> {
    docker_container_for(&state, workspace.as_deref())
        .git_diff_unstaged()
        .await
        .map_err(|e| e.to_string())
}

/// Stage every `/workspace` change (`git add -A`) — session-detail "Stage all".
#[tauri::command]
async fn container_git_stage_all(
    state: tauri::State<'_, AppState>,
    workspace: Option<String>,
) -> Result<(), String> {
    docker_container_for(&state, workspace.as_deref())
        .git_stage_all()
        .await
        .map_err(|e| e.to_string())
}

/// Commit the staged `/workspace` changes (`git commit -m <message>`) — returns
/// git's summary line on success, or its verbatim message as the error.
#[tauri::command]
async fn container_git_commit(
    message: String,
    state: tauri::State<'_, AppState>,
    workspace: Option<String>,
) -> Result<String, String> {
    docker_container_for(&state, workspace.as_deref())
        .git_commit(&message)
        .await
        .map_err(|e| e.to_string())
}

/// Push the current `/workspace` branch and open a GitHub PR for it — returns the
/// new PR's URL. Honest descriptive error when a precondition is missing (no
/// token / remote / branch) or GitHub rejects it.
#[tauri::command]
async fn container_git_open_pr(
    title: String,
    body: String,
    state: tauri::State<'_, AppState>,
    workspace: Option<String>,
) -> Result<String, String> {
    docker_container_for(&state, workspace.as_deref())
        .git_open_pr(&title, &body)
        .await
        .map_err(|e| e.to_string())
}

/// Processes running inside the runtime container (Containers view "Processes"
/// card), from `docker top`. Errs only when the container is down.
#[tauri::command]
async fn container_top(
    state: tauri::State<'_, AppState>,
    workspace: Option<String>,
) -> Result<Vec<ProcessInfo>, String> {
    docker_container_for(&state, workspace.as_deref())
        .top()
        .await
        .map_err(|e| e.to_string())
}

/// Aggregate token-usage analytics (Usage view) from Claude Code's on-disk
/// session transcripts. Token + turn + session counts are factual; cost is an
/// estimate from a published rate table. Errs only when the container is down.
#[tauri::command]
async fn claude_usage(state: tauri::State<'_, AppState>) -> Result<ClaudeUsage, String> {
    state.docker.claude_usage().await.map_err(|e| e.to_string())
}

/// Past Claude conversations from on-disk transcripts (Resume screen), newest
/// first, so one can be reopened with `--resume`. Errs only when the container
/// is down.
#[tauri::command]
async fn claude_sessions(state: tauri::State<'_, AppState>) -> Result<Vec<ClaudeSession>, String> {
    state
        .docker
        .claude_sessions()
        .await
        .map_err(|e| e.to_string())
}

/// Live token tally for one Claude session (its `--session-id` transcript), for
/// the Hub pane header. `None` when there is no usable data yet. Errs only when
/// the container is down.
#[tauri::command]
async fn claude_session_usage(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<SessionUsage>, String> {
    state
        .docker
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

/// What the runtime's Claude is connected to (Integrations screen): the signed-in
/// account + configured MCP servers, from on-disk config. Identity only, no
/// credential. Errs only when the container is down.
#[tauri::command]
async fn claude_integrations(
    state: tauri::State<'_, AppState>,
) -> Result<ClaudeIntegrations, String> {
    state
        .docker
        .claude_integrations()
        .await
        .map_err(|e| e.to_string())
}

/// The runtime Claude's configurable surface (Agent settings detail): active
/// model, default permission mode, sub-agents, skills, plugins and installed
/// marketplaces, all read from on-disk config. Factual only; empty collections
/// are honest, not sample data. Errs only when the container is down.
#[tauri::command]
async fn claude_agent_config(state: tauri::State<'_, AppState>) -> Result<AgentConfig, String> {
    state
        .docker
        .claude_agent_config()
        .await
        .map_err(|e| e.to_string())
}

/// Recent commits on `/workspace` (Dashboard "Recent commits"). `limit` defaults
/// to 12 server-side and is clamped. Errs only when the container is down.
#[tauri::command]
async fn container_git_log(
    limit: Option<u32>,
    state: tauri::State<'_, AppState>,
    workspace: Option<String>,
) -> Result<Vec<CommitInfo>, String> {
    docker_container_for(&state, workspace.as_deref())
        .git_log(limit.unwrap_or(12))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_sessions(state: tauri::State<'_, AppState>) -> Result<Vec<SessionInfo>, String> {
    // Multi-container: the shared runtime PLUS every per-workspace container,
    // each session tagged with its workspace key so restore re-ties it to the
    // right container. Flag-off → shared runtime only (unchanged).
    state
        .manager
        .list_all_sessions()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn create_session(
    name: String,
    cli: String,
    mode: Option<String>,
    alias: Option<String>,
    resume: Option<String>,
    session_id: Option<String>,
    // Account profile id (Tier-3). Resolves to that profile's host env var NAME,
    // which the session shell remaps the CLI's canonical credential var onto.
    // Absent / unknown → the default (canonical host env), unchanged behavior.
    account: Option<String>,
    // Per-workspace-container target. `workspace` is the workspace key; when the
    // per-workspace flag is on this session is created in that workspace's own
    // container (`codehub-ws-<key>`), lazily ensured here. `workspace_dir` is the
    // host dir to bind at `/workspace` for a first-time create (None → a built-in
    // per-key dir). Both absent / flag off → the shared runtime (unchanged).
    workspace: Option<String>,
    workspace_dir: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let cli = Cli::parse(&cli).map_err(|e| e.to_string())?;
    let mode = mode.as_deref().map(LaunchMode::parse).unwrap_or_default();
    let alias = alias.unwrap_or_default();
    // Look up the chosen account profile's env var NAME (never a value).
    let account_var = account.and_then(|id| {
        state
            .config
            .get()
            .account_profiles
            .into_iter()
            .find(|p| p.id == id)
            .map(|p| p.var_name)
    });
    // Resolve the target container. A per-workspace container is created lazily
    // here on first spawn; the shared runtime (no workspace label) is already up
    // from app launch, so it is not re-ensured. Gating on the label — not on
    // `workspace_dir_override` — because a per-ws container with no explicit dir
    // now mounts the config-driven dir (override None) yet STILL needs ensuring.
    let lifecycle = state.manager.resolve(
        workspace.as_deref(),
        workspace_dir.map(std::path::PathBuf::from),
    );
    if lifecycle.workspace_label.is_some() {
        lifecycle
            .ensure_runtime()
            .await
            .map_err(|e| e.to_string())?;
    }
    lifecycle
        .docker_client()
        .create_tmux_session(
            &name,
            cli,
            mode,
            &alias,
            resume.as_deref(),
            session_id.as_deref(),
            account_var.as_deref(),
        )
        .await
        .map_err(|e| e.to_string())?;
    // Record the agent identity so the activity snapshot (and the companion
    // window built on it) can show who each session is, not just its tmux name.
    // For Claude, the transcript id it launched with (resumed id, else the fresh
    // --session-id) rides along so satellite views can read a live token tally.
    let claude_id = resume.as_deref().or(session_id.as_deref());
    state
        .registry
        .activity()
        .register(&name, cli.binary(), &alias, claude_id);
    Ok(())
}

#[tauri::command]
async fn kill_session(
    name: String,
    // Per-workspace target (see `create_session`) — the container the session
    // lives in, so tmux is killed there.
    workspace: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // Drop local pane bookkeeping first so resize / write attempts mid-kill
    // cannot resurrect a half-dead pane.
    state.registry.detach_by_session(&name).await;
    // Purge event state so stale pending entries don't outlive the session and
    // the HashMap key is eventually reclaimed.
    state.events.remove_session(&name);
    docker_for(&state, workspace.as_deref())
        .kill_tmux_session(&name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn rename_session(
    name: String,
    alias: String,
    // Per-workspace target (see `create_session`).
    workspace: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    docker_for(&state, workspace.as_deref())
        .rename_tmux_window(&name, &alias)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn attach_session(
    name: String,
    cols: u16,
    rows: u16,
    // Per-workspace target (see `create_session`). Must match the workspace the
    // session was created in so the exec opens against the right container.
    workspace: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let docker = docker_for(&state, workspace.as_deref());
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
    state
        .registry
        .resize(&state.docker, &pane_id, cols, rows)
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

// ── Phase-0 completion contract: stub commands ──────────────────────────────
// Honest-empty defaults so the live app degrades gracefully; the parallel fleet
// fills the bodies. NOT panics, NOT Err.

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

/// Codex usage analytics from rollout files — mirrors the claude* usage surface.
/// Token + turn + session counts are factual from the on-disk rollout files;
/// cost is an estimate from a published rate table. Errs only when the container
/// is down.
#[tauri::command]
async fn codex_usage(state: tauri::State<'_, AppState>) -> Result<CodexUsage, String> {
    state.docker.codex_usage().await.map_err(|e| e.to_string())
}

/// Past Codex conversations from rollout files (Resume view), newest first.
/// Errs only when the container is down.
#[tauri::command]
async fn codex_sessions(state: tauri::State<'_, AppState>) -> Result<Vec<CodexSession>, String> {
    state
        .docker
        .codex_sessions()
        .await
        .map_err(|e| e.to_string())
}

/// Live per-session Codex tally from its rollout file; `None` when there is no
/// usable data yet. `id` is the session directory path segment under
/// `/root/.codex/sessions/` (e.g. "2026/05/24"). Errs only when the container
/// is down.
#[tauri::command]
async fn codex_session_usage(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<CodexSessionUsage>, String> {
    state
        .docker
        .codex_session_usage(&id)
        .await
        .map_err(|e| e.to_string())
}

/// Codex rate-limit / plan meters from the most recent rollout file; `None`
/// when no data is on disk. The only on-disk quota source — no billing API.
/// Errs only when the container is down.
#[tauri::command]
async fn codex_rate_limits(
    state: tauri::State<'_, AppState>,
) -> Result<Option<CodexRateLimits>, String> {
    state
        .docker
        .codex_rate_limits()
        .await
        .map_err(|e| e.to_string())
}

/// GitHub connection status (Integrations). Reads GITHUB_TOKEN presence on the
/// host — presence-only, the value is NEVER returned. When present, calls the
/// GitHub API via the already-forwarded token in the container for identity.
#[tauri::command]
async fn github_status(state: tauri::State<'_, AppState>) -> Result<GithubStatus, String> {
    state
        .docker
        .github_status()
        .await
        .map_err(|e| e.to_string())
}

/// Repos visible to the connected GitHub account (up to 30, sorted by push
/// date). Empty when the token is absent or the container is down.
#[tauri::command]
async fn github_repos(state: tauri::State<'_, AppState>) -> Result<Vec<GithubRepo>, String> {
    state.docker.github_repos().await.map_err(|e| e.to_string())
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

    // CODEHUB_* is canonical; AVIARY_* kept as a fallback so existing user
    // environments keep working after the rebrand.
    let container_name = std::env::var("CODEHUB_CONTAINER")
        .or_else(|_| std::env::var("AVIARY_CONTAINER"))
        .unwrap_or_else(|_| DEFAULT_CONTAINER.into());
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

            // The manager owns the single daemon connection and produces a
            // `Lifecycle` per workspace; the shared-runtime lifecycle every
            // existing command uses today is `manager.default()`.
            let manager = Arc::new(LifecycleManager::new(
                container_name.clone(),
                image.clone(),
                config_dir,
                workspace_dir,
                config.clone(),
            )?);
            let lifecycle = manager.default();
            let docker = Arc::new(lifecycle.docker_client());
            let registry = Arc::new(PtyRegistry::new());
            let events = Arc::new(EventsTracker::new());

            // Read at notification time by the event tailer so a just-changed
            // toggle applies immediately (config is moved into AppState below).
            let notify_config = config.clone();

            #[cfg(target_os = "macos")]
            let island_registry = registry.clone();
            #[cfg(target_os = "macos")]
            let island_events = events.clone();
            #[cfg(target_os = "macos")]
            let island_docker = docker.clone();

            app.manage(AppState {
                lifecycle: lifecycle.clone(),
                manager: manager.clone(),
                docker: docker.clone(),
                registry,
                config,
                events: events.clone(),
            });

            // macOS: feed the native Dynamic Island a RICH snapshot while it is on
            // screen. Every signal is honest:
            //   - Wait    ← `events.pending_prompts()` (a real permission prompt)
            //   - Live    ← activity state Working (output within the grace window)
            //   - Idle    ← otherwise
            //   - agent   ← the registered cli id (dot identity)
            //   - metric  ← `claude_session_usage` for Claude sessions only, where a
            //               transcript with real usage exists; never fabricated.
            // Done/Err are intentionally NOT emitted: the hook taxonomy folds
            // `StopFailure` into `stop`, and a finished turn is indistinguishable
            // from idle without inventing a recency heuristic — so we stay silent
            // rather than fake them.
            //
            // Status refreshes every 1s (responsive awaiting/working). The Claude
            // metric is heavier (a `cat` of the transcript per session), so it is
            // re-read on a slower cadence and cached between reads — the island
            // shows the last real reading, not a stale-frozen or fabricated one.
            #[cfg(target_os = "macos")]
            {
                use std::collections::{HashMap, HashSet};
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    // ~1s status cadence; refresh Claude metrics every 5th tick.
                    const METRIC_EVERY: u64 = 5;
                    let mut tick = tokio::time::interval(std::time::Duration::from_millis(1000));
                    let mut metric_cache: HashMap<String, String> = HashMap::new();
                    let mut ticks: u64 = 0;
                    loop {
                        tick.tick().await;
                        if !island::is_visible() {
                            continue;
                        }
                        let activity = island_registry.activity().snapshot();
                        let waiting: HashSet<String> = island_events
                            .pending_prompts()
                            .into_iter()
                            .map(|p| p.session)
                            .collect();

                        // Refresh the Claude metric line on the slow cadence, then
                        // prune cache entries for sessions that no longer exist.
                        if ticks % METRIC_EVERY == 0 {
                            for a in &activity {
                                let Some(id) = a.claude_id.as_deref() else {
                                    continue;
                                };
                                match island_docker.claude_session_usage(id).await {
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
                            let live: HashSet<&str> =
                                activity.iter().map(|a| a.session.as_str()).collect();
                            metric_cache.retain(|s, _| live.contains(s.as_str()));
                        }
                        ticks = ticks.wrapping_add(1);

                        let rows = activity
                            .into_iter()
                            .map(|a| {
                                let status = if waiting.contains(&a.session) {
                                    island::IslandStatus::Wait
                                } else if matches!(a.state, activity::ActivityState::Working) {
                                    island::IslandStatus::Live
                                } else {
                                    island::IslandStatus::Idle
                                };
                                let metric = metric_cache.get(&a.session).cloned();
                                island::IslandRow {
                                    label: a.alias.unwrap_or_else(|| a.session.clone()),
                                    session: a.session,
                                    agent: a.cli,
                                    status,
                                    metric,
                                }
                            })
                            .collect();
                        island::update_rich(&handle, island::IslandSnapshot { rows });
                    }
                });
            }

            // Kick off runtime provisioning in background; frontend listens for status events.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match lifecycle.ensure_runtime().await {
                    Ok(status) => {
                        let _ = handle.emit("codehub://lifecycle", &status);
                    },
                    Err(e) => {
                        tracing::error!("ensure_runtime failed: {e}");
                        let _ = handle.emit("codehub://lifecycle-error", e.to_string());
                    },
                }
            });

            // Start the agent-event hook tail (§7). A reconciler fans a tail out
            // to the shared runtime AND every live per-workspace container (each
            // keeps its events in its own container-local /tmp/codehub/events),
            // feeding the EventsTracker. Retries on disconnect.
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
            app_info,
            per_workspace_enabled,
            get_config,
            set_config,
            pick_directory,
            set_workspace_dir,
            workspace_info,
            recreate_runtime,
            list_workspace_containers,
            remove_workspace_container,
            list_account_profiles,
            add_account_profile,
            remove_account_profile,
            agent_key_status,
            agent_versions,
            container_stats,
            container_logs,
            container_mounts,
            container_image,
            container_health,
            container_list_dir,
            container_read_file,
            container_git_status,
            container_git_diff,
            container_git_diff_all,
            container_git_diff_staged,
            container_git_diff_unstaged,
            container_git_stage_all,
            container_git_commit,
            container_git_open_pr,
            container_top,
            claude_usage,
            claude_sessions,
            claude_session_usage,
            claude_integrations,
            claude_agent_config,
            container_git_log,
            list_sessions,
            create_session,
            kill_session,
            rename_session,
            attach_session,
            pty_write,
            pty_resize,
            detach_session,
            session_activity,
            open_companion,
            close_companion,
            focus_session_from_companion,
            // Phase-0 completion contract (stubs; BE track fills bodies).
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running codehub");
}
