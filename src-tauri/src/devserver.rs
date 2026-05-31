//! Dev-only HTTP + WebSocket bridge (feature `devserver`).
//!
//! Lets the React frontend run in a plain browser (Vite) against a real
//! backend, so the UI can be inspected / screenshotted with live terminals —
//! something the Tauri webview (WKWebView, no CDP) does not allow.
//!
//! It reuses the exact same [`crate::docker`], [`crate::pty`] and
//! [`crate::lifecycle`] logic as the Tauri app; the only difference is the
//! transport: Tauri IPC + events become REST + a WebSocket broadcast. The
//! command surface mirrors the `#[tauri::command]`s in `lib.rs` one-for-one.
//!
//! NOT compiled into the shipped app — gated behind the `devserver` feature and
//! built only via `cargo run --bin codehub-devserver --features devserver`.

use crate::config::{ConfigStore, Settings};
use crate::docker::{Cli, DockerClient, LaunchMode, TmuxSessionRequest};
use crate::events::EventsTracker;
use crate::manager::LifecycleManager;
use crate::pty::{PaneEmitter, PtyRegistry};
use crate::types::UpdateStatus;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::broadcast;

const DEFAULT_IMAGE: &str = "ghcr.io/mpolatcan/codehub-runtime:0.1.3";
const ADDR: &str = "127.0.0.1:4555";

#[derive(Clone)]
struct AppState {
    manager: Arc<LifecycleManager>,
    registry: Arc<PtyRegistry>,
    config: Arc<ConfigStore>,
    events: Arc<EventsTracker>,
    stats_history: Arc<crate::stats_history::StatsHistory>,
    tx: broadcast::Sender<String>,
    /// Dev-only stand-in for the vault: which provider ids have a token
    /// "stored". The browser bridge has no vault, so this lets the Settings UI
    /// reflect token presence during visual verification.
    provider_tokens: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
}

/// Dev-bridge mirror of [`crate::config::provider_statuses`]: token presence comes
/// from the in-memory dev set rather than the vault.
fn dev_provider_statuses(
    providers: Vec<crate::config::ModelProvider>,
    tokens: &std::sync::Mutex<std::collections::HashSet<String>>,
) -> Vec<crate::config::ModelProviderStatus> {
    let set = tokens.lock().expect("provider_tokens mutex");
    providers
        .into_iter()
        .map(|p| {
            let has_token = set.contains(&p.id);
            crate::config::ModelProviderStatus {
                has_token,
                id: p.id,
                name: p.name,
                kind: p.kind,
                endpoint: p.endpoint,
                api_key_var: p.api_key_var,
                models: p.models,
                model: p.model,
                small_fast_model: p.small_fast_model,
                enabled: p.enabled,
            }
        })
        .collect()
}

fn docker_for(st: &AppState, workspace: &str) -> Arc<DockerClient> {
    Arc::new(st.manager.resolve(workspace, None).docker_client())
}

fn docker_container_for(st: &AppState, workspace: &str) -> Arc<DockerClient> {
    Arc::new(st.manager.workspace_container(workspace).docker_client())
}

fn lifecycle_for(st: &AppState, workspace: &str) -> Arc<crate::lifecycle::Lifecycle> {
    st.manager.workspace_container(workspace)
}

/// Pushes pane output onto the WS broadcast as the same event strings the Tauri
/// build emits, so the frontend listener code is identical across transports.
struct WsEmitter {
    tx: broadcast::Sender<String>,
}

impl WsEmitter {
    fn emit(&self, event: String, payload: serde_json::Value) {
        if let Ok(frame) = serde_json::to_string(&json!({ "event": event, "payload": payload })) {
            // Err just means no clients are connected yet — fine.
            let _ = self.tx.send(frame);
        }
    }
}

impl PaneEmitter for WsEmitter {
    fn data(&self, pane_id: &str, text: String) {
        self.emit(format!("pty://data/{}", pane_id), json!(text));
    }
    fn exit(&self, pane_id: &str, code: i32) {
        self.emit(format!("pty://exit/{}", pane_id), json!(code));
    }
}

type ApiError = (StatusCode, String);
fn err(e: impl ToString) -> ApiError {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

const WORKSPACE_REQUIRED: &str = "workspace required";
const NO_RUNNING_WORKSPACE_CONTAINER: &str = "no running workspace container";

fn bad_request(message: impl Into<String>) -> ApiError {
    (StatusCode::BAD_REQUEST, message.into())
}

fn workspace_required(workspace: Option<String>) -> Result<String, ApiError> {
    workspace.ok_or_else(|| bad_request(WORKSPACE_REQUIRED))
}

async fn running_workspace_docker(st: &AppState) -> Result<Arc<DockerClient>, ApiError> {
    st.manager.any_running_docker().await.ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            NO_RUNNING_WORKSPACE_CONTAINER.into(),
        )
    })
}

async fn docker_for_optional_workspace(
    st: &AppState,
    workspace: Option<String>,
) -> Result<Arc<DockerClient>, ApiError> {
    match workspace {
        Some(ws) => Ok(docker_container_for(st, &ws)),
        None => running_workspace_docker(st).await,
    }
}

pub async fn serve() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,codehub_lib=debug".into()),
        )
        .init();

    let image = std::env::var("CODEHUB_IMAGE")
        .or_else(|_| std::env::var("AVIARY_IMAGE"))
        .unwrap_or_else(|_| DEFAULT_IMAGE.into());
    let data_dir = std::env::var("CODEHUB_DEV_DATA")
        .or_else(|_| std::env::var("AVIARY_DEV_DATA"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
                .join(".codehub-devserver")
        });

    // Config loads first: the lifecycle reads the effective workspace dir +
    // account-profile env vars from it at container-create time (mirrors lib.rs).
    let config = Arc::new(ConfigStore::load(data_dir.join("settings.json")));
    // Mirror lib.rs: the manager owns the daemon connection and the per-workspace
    // resolution. No shared runtime — every session belongs to a workspace.
    let manager = Arc::new(
        LifecycleManager::new(
            image,
            data_dir.join("config"),
            data_dir.join("workspace"),
            config.clone(),
        )
        .expect("docker daemon unreachable — is Docker running?"),
    );
    let registry = Arc::new(PtyRegistry::new());
    // Mirror lib.rs: link the events tracker to the activity tracker so hook
    // events drive the live turn/tool/status signal in browser mode too (without
    // this the bridge ingests events but never folds them into session_activity,
    // so the hook-driven states never appear in `make dev-web`).
    let events = Arc::new(EventsTracker::with_activity(registry.activity()));
    let (tx, _) = broadcast::channel::<String>(1024);

    // Verify the Docker daemon is reachable (mirrors lib.rs setup). No shared
    // runtime to provision — per-workspace containers are created lazily in
    // create_session.
    {
        let info = manager.docker_info().await;
        if info.reachable {
            tracing::info!("docker daemon reachable (version {:?})", info.version);
        } else {
            tracing::warn!("docker daemon unreachable — workspace containers will fail");
        }
    }

    // Start the event tailer for the dev bridge (mirrors lib.rs setup). The
    // reconciler fans a tail out across the shared runtime AND every live
    // per-workspace container — same attach/parse loop the Tauri app runs — with a
    // WS-frame sink instead of a window emit. The WsEmitter handles pty output;
    // this handles hook events.
    {
        let tx_for_events = tx.clone();
        // Runs under `#[tokio::main]`, so spawn the loop with tokio directly (the
        // Tauri app uses tauri::async_runtime — see events::start_event_tailer).
        tokio::spawn(crate::events::reconcile_event_tailers_loop(
            manager.clone(),
            events.clone(),
            move |event| {
                if let Ok(frame) = serde_json::to_string(&serde_json::json!({
                    "event": "codehub://agent-event",
                    "payload": event,
                })) {
                    let _ = tx_for_events.send(frame);
                }
            },
        ));
    }

    let stats_hist = Arc::new(crate::stats_history::StatsHistory::new());
    let state = AppState {
        manager: manager.clone(),
        registry,
        config,
        events,
        stats_history: stats_hist,
        tx: tx.clone(),
        provider_tokens: Arc::new(std::sync::Mutex::new(std::collections::HashSet::new())),
    };

    let app = Router::new()
        .route("/status", get(status))
        .route("/container-start", post(container_start))
        .route("/container-stop", post(container_stop))
        .route("/container-restart", post(container_restart))
        .route("/docker-info", get(docker_info))
        .route("/detect-docker-runtime", get(detect_docker_runtime))
        .route("/start-docker-app", post(start_docker_app))
        .route("/app-info", get(app_info))
        .route("/host-stats", get(host_stats))
        .route("/runtime-versions", get(runtime_versions))
        .route("/config", get(get_config).put(set_config))
        .route(
            "/prompt-templates",
            post(add_prompt_template).delete(remove_prompt_template),
        )
        .route("/pick-directory", post(pick_directory))
        .route("/workspace-dir", put(set_workspace_dir))
        .route("/workspace-info", get(workspace_info))
        .route("/recreate-runtime", post(recreate_runtime))
        .route(
            "/workspace-containers",
            get(list_workspace_containers).delete(remove_workspace_container),
        )
        .route(
            "/account-profiles",
            get(list_account_profiles).post(add_account_profile),
        )
        .route(
            "/account-profiles/:id",
            delete(remove_account_profile).patch(rename_account_profile),
        )
        .route(
            "/account-profiles/:id/enabled",
            post(set_account_profile_enabled),
        )
        .route("/agent-key-status", get(agent_key_status))
        .route("/agent-versions", get(agent_versions))
        .route("/container-stats", get(container_stats))
        .route("/container-stats-history", get(container_stats_history))
        .route("/container-logs", get(container_logs))
        .route("/container-mounts", get(container_mounts))
        .route("/container-image", get(container_image))
        .route("/container-health", get(container_health))
        .route("/container-list-dir", get(container_list_dir))
        .route("/container-browse-dirs", get(container_browse_dirs))
        .route("/container-read-file", get(container_read_file))
        .route("/container-git-status", get(container_git_status))
        .route("/container-git-diff", get(container_git_diff))
        .route("/container-git-diff-all", get(container_git_diff_all))
        .route("/container-git-diff-staged", get(container_git_diff_staged))
        .route(
            "/container-git-diff-unstaged",
            get(container_git_diff_unstaged),
        )
        .route("/container-git-stage-all", post(container_git_stage_all))
        .route("/container-git-stage-file", post(container_git_stage_file))
        .route(
            "/container-git-unstage-file",
            post(container_git_unstage_file),
        )
        .route("/container-git-stage-hunk", post(container_git_stage_hunk))
        .route("/container-git-commit", post(container_git_commit))
        .route("/container-git-open-pr", post(container_git_open_pr))
        .route("/set-agent-model", post(set_agent_model))
        .route("/set-permission-mode", post(set_permission_mode))
        .route("/set-permission-rules", post(set_permission_rules))
        .route("/toggle-mcp-server", post(toggle_mcp_server))
        .route("/container-top", get(container_top))
        .route("/container-env", get(container_env))
        .route("/container-repos", get(container_repos))
        .route("/container-git-clone", post(container_git_clone))
        .route("/stop-all-agents", post(stop_all_agents))
        .route("/rolling-usage", get(rolling_usage))
        .route("/claude-usage", get(claude_usage))
        .route("/claude-sessions", get(claude_sessions))
        .route("/claude-session-usage", get(claude_session_usage))
        .route("/claude-integrations", get(claude_integrations))
        .route("/claude-agent-config", get(claude_agent_config))
        .route("/container-git-log", get(container_git_log))
        .route("/session-activity", get(session_activity))
        // Phase-0 completion contract: live handlers mirroring lib.rs.
        .route("/pending-prompts", get(pending_prompts))
        .route("/respond-prompt", post(respond_prompt))
        .route("/session-activity-history", get(session_activity_history))
        .route("/codex-usage", get(codex_usage))
        .route("/codex-sessions", get(codex_sessions))
        .route("/codex-session-usage", get(codex_session_usage))
        .route("/codex-rate-limits", get(codex_rate_limits))
        .route("/github-status", get(github_status))
        .route("/github-repos", get(github_repos))
        .route("/check-update", get(check_update))
        .route("/search-transcripts", get(search_transcripts))
        .route(
            "/providers",
            get(list_providers)
                .post(add_provider)
                .delete(remove_provider),
        )
        .route("/providers/update", post(update_provider))
        .route("/providers/token", post(set_provider_token))
        .route("/sessions", get(list_sessions).post(create_session))
        .route("/sessions/:name", delete(kill_session))
        .route("/sessions/:name/rename", post(rename_session))
        .route("/attach", post(attach))
        .route("/panes/:id/write", post(write))
        .route("/panes/:id/resize", post(resize))
        .route("/panes/:id", delete(detach))
        // Vault: Tauri-only (encrypted file vault). Stub 501 for browser dev bridge.
        .route("/vault-store-key", post(vault_not_supported))
        .route("/vault-delete-key", post(vault_not_supported))
        .route("/vault-has-key", get(vault_has_key_not_supported))
        .route("/vault-initiate-oauth", post(vault_not_supported))
        .route("/events", get(ws_events))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(ADDR).await.expect("bind");
    tracing::info!("codehub dev bridge on http://{ADDR}  (proxied at /__bridge)");
    axum::serve(listener, app).await.expect("serve");
}

async fn status(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    Ok(Json(lifecycle_for(&st, &ws).status().await))
}

// Broadcast the post-action status as a codehub://lifecycle frame (same shape
// the Tauri build emits) so every connected WS subscriber updates, then return
// it for the immediate caller. Mirrors lib.rs's container_start/stop/restart.
fn broadcast_lifecycle(st: &AppState, status: &crate::lifecycle::ContainerStatus) {
    let frame = json!({ "event": "codehub://lifecycle", "payload": status });
    let _ = st.tx.send(frame.to_string());
}

async fn container_start(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    let lc = lifecycle_for(&st, &ws);
    lc.start().await.map_err(err)?;
    let status = lc.status().await;
    broadcast_lifecycle(&st, &status);
    Ok(Json(status))
}

async fn container_stop(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    let lc = lifecycle_for(&st, &ws);
    lc.stop().await.map_err(err)?;
    let status = lc.status().await;
    broadcast_lifecycle(&st, &status);
    Ok(Json(status))
}

async fn container_restart(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    let lc = lifecycle_for(&st, &ws);
    lc.restart().await.map_err(err)?;
    let status = lc.status().await;
    broadcast_lifecycle(&st, &status);
    Ok(Json(status))
}

async fn docker_info(State(st): State<AppState>) -> impl IntoResponse {
    Json(st.manager.docker_info().await)
}

async fn detect_docker_runtime(State(st): State<AppState>) -> impl IntoResponse {
    let mut installed = Vec::new();
    if std::path::Path::new("/Applications/Docker.app").exists() {
        installed.push("docker".to_string());
    }
    if std::path::Path::new("/Applications/OrbStack.app").exists() {
        installed.push("orbstack".to_string());
    }
    let daemon_running = st.manager.docker_info().await.reachable;
    Json(crate::DockerRuntimeDetection {
        installed,
        daemon_running,
    })
}

#[derive(Deserialize)]
struct StartDockerAppBody {
    runtime: String,
}

async fn start_docker_app(
    Json(body): Json<StartDockerAppBody>,
) -> Result<impl IntoResponse, ApiError> {
    let app_name = match body.runtime.as_str() {
        "docker" => "Docker",
        "orbstack" => "OrbStack",
        _ => return Err(err(format!("unknown runtime: {}", body.runtime))),
    };
    std::process::Command::new("open")
        .args(["-a", app_name])
        .spawn()
        .map_err(|e| err(format!("failed to open {app_name}: {e}")))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn app_info() -> impl IntoResponse {
    Json(crate::lifecycle::app_info())
}

async fn host_stats() -> impl IntoResponse {
    Json(crate::lifecycle::host_stats())
}

async fn runtime_versions(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let docker = docker_for_optional_workspace(&st, q.workspace).await?;
    docker.runtime_versions().await.map(Json).map_err(err)
}

async fn get_config(State(st): State<AppState>) -> impl IntoResponse {
    Json(st.config.get())
}

async fn set_config(
    State(st): State<AppState>,
    Json(body): Json<Settings>,
) -> Result<impl IntoResponse, ApiError> {
    let current = st.config.get();
    st.config
        .set(crate::preserve_backend_owned_settings(body, &current))
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[derive(Deserialize)]
struct PromptTemplateBody {
    name: String,
    prompt: String,
    cli: Option<String>,
}

async fn add_prompt_template(
    State(st): State<AppState>,
    Json(body): Json<PromptTemplateBody>,
) -> Result<impl IntoResponse, ApiError> {
    let mut settings = st.config.get();
    settings
        .prompt_templates
        .push(crate::config::PromptTemplate {
            id: uuid::Uuid::new_v4().to_string(),
            name: body.name,
            prompt: body.prompt,
            cli: body.cli,
        });
    let saved = st.config.set(settings).map_err(err)?;
    Ok(Json(saved.prompt_templates))
}

#[derive(Deserialize)]
struct PromptTemplateDeleteQuery {
    id: String,
}

async fn remove_prompt_template(
    State(st): State<AppState>,
    Query(q): Query<PromptTemplateDeleteQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let mut settings = st.config.get();
    settings.prompt_templates.retain(|t| t.id != q.id);
    let saved = st.config.set(settings).map_err(err)?;
    Ok(Json(saved.prompt_templates))
}

// Tier-2 / Tier-3 — workspace picker + account profiles.
async fn pick_directory() -> impl IntoResponse {
    Json(None::<String>)
}

#[derive(Deserialize)]
struct WorkspaceDirBody {
    path: String,
}

async fn set_workspace_dir(
    State(st): State<AppState>,
    Json(body): Json<WorkspaceDirBody>,
) -> Result<impl IntoResponse, ApiError> {
    if !std::path::Path::new(&body.path).is_dir() {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("not a directory: {}", body.path),
        ));
    }
    st.config
        .set_workspace_dir(body.path)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

async fn workspace_info(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> impl IntoResponse {
    match q.workspace {
        Some(key) => Json(lifecycle_for(&st, &key).workspace_info().await),
        None => {
            // No workspace context — return a placeholder with the config-driven
            // effective dir and no mounted path (mirrors lib.rs).
            let effective = st.config.get().workspace_dir.unwrap_or_default();
            Json(crate::lifecycle::WorkspaceInfo {
                effective,
                mounted: None,
                needs_recreate: false,
            })
        },
    }
}

async fn recreate_runtime(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    let lc = lifecycle_for(&st, &ws);
    lc.recreate().await.map_err(err)?;
    let status = lc.status().await;
    broadcast_lifecycle(&st, &status);
    Ok(Json(status))
}

async fn list_account_profiles(State(st): State<AppState>) -> impl IntoResponse {
    // Dev bridge has no vault access — pass None (vault-backed profiles show present=false).
    Json(crate::profile_statuses(
        st.config.get().account_profiles,
        None,
    ))
}

#[derive(Deserialize)]
struct AddProfileBody {
    agent: String,
    label: String,
    var_name: Option<String>,
    source: Option<String>,
}

async fn add_account_profile(
    State(st): State<AppState>,
    Json(body): Json<AddProfileBody>,
) -> Result<impl IntoResponse, ApiError> {
    let profile = if body.source.as_deref() == Some("vault") {
        crate::build_vault_profile(&body.agent, &body.label)
            .map_err(|e| (StatusCode::BAD_REQUEST, e))?
    } else {
        crate::build_account_profile(&body.agent, &body.label, &body.var_name.unwrap_or_default())
            .map_err(|e| (StatusCode::BAD_REQUEST, e))?
    };
    let next = st.config.add_account_profile(profile).map_err(err)?;
    Ok(Json(crate::profile_statuses(next.account_profiles, None)))
}

async fn remove_account_profile(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let next = st.config.remove_account_profile(&id).map_err(err)?;
    Ok(Json(crate::profile_statuses(next.account_profiles, None)))
}

#[derive(Deserialize)]
struct RenameProfileBody {
    label: String,
}

async fn rename_account_profile(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<RenameProfileBody>,
) -> Result<impl IntoResponse, ApiError> {
    let next = st
        .config
        .rename_account_profile(&id, &body.label)
        .map_err(err)?;
    Ok(Json(crate::profile_statuses(next.account_profiles, None)))
}

#[derive(Deserialize)]
struct EnabledBody {
    enabled: bool,
}

async fn set_account_profile_enabled(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<EnabledBody>,
) -> Result<impl IntoResponse, ApiError> {
    let next = st
        .config
        .set_account_profile_enabled(&id, body.enabled)
        .map_err(err)?;
    Ok(Json(crate::profile_statuses(next.account_profiles, None)))
}

async fn agent_key_status() -> impl IntoResponse {
    Json(crate::lifecycle::agent_key_status())
}

async fn agent_versions(State(st): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    let docker = running_workspace_docker(&st).await?;
    Ok(Json(docker.agent_versions().await))
}

async fn container_stats(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    docker_container_for(&st, &ws)
        .stats()
        .await
        .map(Json)
        .map_err(err)
}

async fn container_stats_history(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    Ok(Json(st.stats_history.history(&ws)))
}

async fn list_workspace_containers(
    State(st): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    st.manager
        .list_workspace_containers()
        .await
        .map(Json)
        .map_err(err)
}

async fn remove_workspace_container(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<StatusCode, ApiError> {
    let key = workspace_required(q.workspace)?;
    st.manager.remove_workspace(&key).await.map_err(err)?;
    // No codehub://lifecycle broadcast — that event tracks the shared runtime;
    // the fleet poll reflects the removal (mirrors lib.rs remove_workspace_container).
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct LogsQuery {
    tail: Option<u32>,
    workspace: Option<String>,
}

async fn container_logs(
    State(st): State<AppState>,
    Query(q): Query<LogsQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    docker_container_for(&st, &ws)
        .logs(q.tail.unwrap_or(200))
        .await
        .map(Json)
        .map_err(err)
}

async fn container_mounts(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    docker_container_for(&st, &ws)
        .mounts()
        .await
        .map(Json)
        .map_err(err)
}

async fn container_image(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let docker = docker_for_optional_workspace(&st, q.workspace).await?;
    docker.image_info().await.map(Json).map_err(err)
}

async fn container_health(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let docker = docker_for_optional_workspace(&st, q.workspace).await?;
    docker.health().await.map(Json).map_err(err)
}

#[derive(Deserialize)]
struct PathQuery {
    /// Empty / absent → the workspace root.
    path: Option<String>,
    /// Per-workspace container key (required).
    workspace: Option<String>,
}

async fn container_list_dir(
    State(st): State<AppState>,
    Query(q): Query<PathQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    docker_container_for(&st, &ws)
        .list_dir(&q.path.unwrap_or_default())
        .await
        .map(Json)
        .map_err(err)
}

async fn container_browse_dirs(
    State(st): State<AppState>,
    Query(q): Query<PathQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    docker_container_for(&st, &ws)
        .browse_dirs(&q.path.unwrap_or_default())
        .await
        .map(Json)
        .map_err(err)
}

async fn container_read_file(
    State(st): State<AppState>,
    Query(q): Query<PathQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    docker_container_for(&st, &ws)
        .read_file(&q.path.unwrap_or_default())
        .await
        .map(Json)
        .map_err(err)
}

async fn container_git_status(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    docker_container_for(&st, &ws)
        .git_status()
        .await
        .map(Json)
        .map_err(err)
}

#[derive(Deserialize)]
struct DiffQuery {
    path: String,
    workspace: Option<String>,
}

async fn container_git_diff(
    State(st): State<AppState>,
    Query(q): Query<DiffQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    docker_container_for(&st, &ws)
        .git_diff(&q.path)
        .await
        .map(Json)
        .map_err(err)
}

async fn container_git_diff_all(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    docker_container_for(&st, &ws)
        .git_diff_all()
        .await
        .map(Json)
        .map_err(err)
}

async fn container_git_diff_staged(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    docker_container_for(&st, &ws)
        .git_diff_staged()
        .await
        .map(Json)
        .map_err(err)
}

async fn container_git_diff_unstaged(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    docker_container_for(&st, &ws)
        .git_diff_unstaged()
        .await
        .map(Json)
        .map_err(err)
}

async fn container_git_stage_all(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    docker_container_for(&st, &ws)
        .git_stage_all()
        .await
        .map(|()| StatusCode::NO_CONTENT)
        .map_err(err)
}

#[derive(Deserialize)]
struct CommitBody {
    message: String,
}

async fn container_git_commit(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
    Json(body): Json<CommitBody>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    docker_container_for(&st, &ws)
        .git_commit(&body.message)
        .await
        .map(Json)
        .map_err(err)
}

#[derive(Deserialize)]
struct OpenPrBody {
    title: String,
    body: String,
}

async fn container_git_open_pr(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
    Json(body): Json<OpenPrBody>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    docker_container_for(&st, &ws)
        .git_open_pr(&body.title, &body.body)
        .await
        .map(Json)
        .map_err(err)
}

#[derive(Deserialize)]
struct PathWorkspaceBody {
    path: String,
    workspace: String,
}

async fn container_git_stage_file(
    State(st): State<AppState>,
    Json(body): Json<PathWorkspaceBody>,
) -> Result<StatusCode, ApiError> {
    docker_container_for(&st, &body.workspace)
        .git_stage_file(&body.path)
        .await
        .map_err(err)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn container_git_unstage_file(
    State(st): State<AppState>,
    Json(body): Json<PathWorkspaceBody>,
) -> Result<StatusCode, ApiError> {
    docker_container_for(&st, &body.workspace)
        .git_unstage_file(&body.path)
        .await
        .map_err(err)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct StageHunkBody {
    patch: String,
    workspace: String,
}

async fn container_git_stage_hunk(
    State(st): State<AppState>,
    Json(body): Json<StageHunkBody>,
) -> Result<StatusCode, ApiError> {
    docker_container_for(&st, &body.workspace)
        .git_stage_hunk(&body.patch)
        .await
        .map_err(err)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ModelBody {
    model: String,
    workspace: String,
}

async fn set_agent_model(
    State(st): State<AppState>,
    Json(body): Json<ModelBody>,
) -> Result<impl IntoResponse, ApiError> {
    let docker = docker_container_for(&st, &body.workspace);
    docker.set_claude_model(&body.model).await.map_err(err)?;
    docker.claude_agent_config().await.map(Json).map_err(err)
}

#[derive(Deserialize)]
struct PermModeBody {
    mode: String,
    workspace: String,
}

async fn set_permission_mode(
    State(st): State<AppState>,
    Json(body): Json<PermModeBody>,
) -> Result<impl IntoResponse, ApiError> {
    let docker = docker_container_for(&st, &body.workspace);
    docker.set_permission_mode(&body.mode).await.map_err(err)?;
    docker.claude_agent_config().await.map(Json).map_err(err)
}

#[derive(Deserialize)]
struct PermRulesBody {
    bucket: String,
    rules: Vec<String>,
    workspace: String,
}

async fn set_permission_rules(
    State(st): State<AppState>,
    Json(body): Json<PermRulesBody>,
) -> Result<impl IntoResponse, ApiError> {
    let docker = docker_container_for(&st, &body.workspace);
    docker
        .set_permission_rules(&body.bucket, &body.rules)
        .await
        .map_err(err)?;
    docker.claude_agent_config().await.map(Json).map_err(err)
}

#[derive(Deserialize)]
struct ToggleMcpBody {
    name: String,
    enabled: bool,
    workspace: String,
}

async fn toggle_mcp_server(
    State(st): State<AppState>,
    Json(body): Json<ToggleMcpBody>,
) -> Result<impl IntoResponse, ApiError> {
    let docker = docker_container_for(&st, &body.workspace);
    docker
        .toggle_mcp_server(&body.name, body.enabled)
        .await
        .map_err(err)?;
    docker.claude_integrations().await.map(Json).map_err(err)
}

async fn container_top(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    docker_container_for(&st, &ws)
        .top()
        .await
        .map(Json)
        .map_err(err)
}

async fn container_env(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    docker_container_for(&st, &ws)
        .container_env()
        .await
        .map(Json)
        .map_err(err)
}

async fn container_repos(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    docker_container_for(&st, &ws)
        .container_repos()
        .await
        .map(Json)
        .map_err(err)
}

#[derive(Deserialize)]
struct GitCloneBody {
    url: String,
    workspace: String,
}

async fn container_git_clone(
    State(st): State<AppState>,
    Json(body): Json<GitCloneBody>,
) -> Result<impl IntoResponse, ApiError> {
    let lifecycle = st.manager.resolve(&body.workspace, None);
    lifecycle.ensure_runtime().await.map_err(err)?;
    lifecycle
        .docker_client()
        .git_clone(&body.url)
        .await
        .map(Json)
        .map_err(err)
}

async fn stop_all_agents(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    let docker = docker_for(&st, &ws);
    let sessions = docker.list_tmux_sessions().await.map_err(err)?;
    for s in sessions {
        st.registry.detach_by_session(&s.name).await;
        st.events.remove_session(&s.name);
        let _ = docker.kill_tmux_session(&s.name).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct RollingUsageQuery {
    hours: Option<u32>,
}

async fn rolling_usage(
    State(st): State<AppState>,
    Query(q): Query<RollingUsageQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let window_hours = q.hours.unwrap_or(24);
    let docker = running_workspace_docker(&st).await?;
    let cutoff_date = crate::utc_date_minus_hours(window_hours);
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
    Ok(Json(crate::types::RollingUsage {
        tokens_in,
        tokens_out,
        est_cost_usd,
        window_hours,
    }))
}

async fn claude_usage(State(st): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    let docker = running_workspace_docker(&st).await?;
    docker.claude_usage().await.map(Json).map_err(err)
}

async fn claude_sessions(State(st): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    let docker = running_workspace_docker(&st).await?;
    docker.claude_sessions().await.map(Json).map_err(err)
}

async fn claude_integrations(State(st): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    let docker = running_workspace_docker(&st).await?;
    docker.claude_integrations().await.map(Json).map_err(err)
}

async fn claude_agent_config(State(st): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    let docker = running_workspace_docker(&st).await?;
    docker.claude_agent_config().await.map(Json).map_err(err)
}

#[derive(Deserialize)]
struct SessionUsageQuery {
    id: String,
}

async fn claude_session_usage(
    State(st): State<AppState>,
    Query(q): Query<SessionUsageQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let docker = running_workspace_docker(&st).await?;
    docker
        .claude_session_usage(&q.id)
        .await
        .map(Json)
        .map_err(err)
}

#[derive(Deserialize)]
struct LogQuery {
    limit: Option<u32>,
    workspace: Option<String>,
}

async fn container_git_log(
    State(st): State<AppState>,
    Query(q): Query<LogQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let ws = workspace_required(q.workspace)?;
    docker_container_for(&st, &ws)
        .git_log(q.limit.unwrap_or(12))
        .await
        .map(Json)
        .map_err(err)
}

async fn list_sessions(State(st): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    st.manager.list_all_sessions().await.map(Json).map_err(err)
}

async fn session_activity(State(st): State<AppState>) -> impl IntoResponse {
    Json(st.registry.activity().snapshot())
}

#[derive(Deserialize)]
struct CreateBody {
    name: String,
    cli: String,
    mode: Option<String>,
    alias: Option<String>,
    resume: Option<String>,
    session_id: Option<String>,
    /// Account profile id (Tier-3) → resolves to that profile's host env var NAME.
    account: Option<String>,
    /// Per-workspace-container target (required) + first-create mount dir.
    workspace: String,
    workspace_dir: Option<String>,
    /// In-container working directory (a path under /workspace) the agent starts in.
    cwd: Option<String>,
    task_description: Option<String>,
}

async fn create_session(
    State(st): State<AppState>,
    Json(body): Json<CreateBody>,
) -> Result<StatusCode, ApiError> {
    let cli = Cli::parse(&body.cli).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    let mode = body
        .mode
        .as_deref()
        .map(LaunchMode::parse)
        .unwrap_or_default();
    let alias = body.alias.unwrap_or_default();
    let account_var = body.account.as_deref().and_then(|id| {
        st.config
            .get()
            .account_profiles
            .into_iter()
            .find(|p| p.id == id)
            .map(|p| match &p.credential {
                crate::config::CredentialSource::Env { var_name } => var_name.clone(),
                crate::config::CredentialSource::Vault => crate::config::vault_env_name(&p.id),
            })
    });
    // Resolve the target container; lazily ensure the per-workspace container
    // (mirrors lib.rs — every session belongs to a workspace).
    let lifecycle = st.manager.resolve(
        &body.workspace,
        body.workspace_dir.map(std::path::PathBuf::from),
    );
    lifecycle.ensure_runtime().await.map_err(err)?;
    let docker = lifecycle.docker_client();
    docker
        .create_tmux_session(TmuxSessionRequest {
            name: &body.name,
            cli,
            mode,
            alias: &alias,
            resume: body.resume.as_deref(),
            session_id: body.session_id.as_deref(),
            account_var: account_var.as_deref(),
            session_env: &[],
            account_env: &[],
            cwd: body.cwd.as_deref(),
        })
        .await
        .map_err(err)?;
    let claude_id = body.resume.as_deref().or(body.session_id.as_deref());
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
    st.registry.activity().register(
        &body.name,
        cli.binary(),
        &alias,
        claude_id,
        git_branch.as_deref(),
        body.task_description.as_deref(),
    );
    Ok(StatusCode::NO_CONTENT)
}

/// Per-workspace target carried as a query param on the DELETE kill route.
#[derive(Deserialize)]
struct WorkspaceQuery {
    workspace: Option<String>,
}

async fn kill_session(
    State(st): State<AppState>,
    Path(name): Path<String>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<StatusCode, ApiError> {
    let ws = workspace_required(q.workspace)?;
    // Same ordering as lib.rs: drop pane bookkeeping before killing tmux.
    st.registry.detach_by_session(&name).await;
    st.events.remove_session(&name);
    docker_for(&st, &ws)
        .kill_tmux_session(&name)
        .await
        .map_err(err)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct RenameBody {
    alias: String,
    workspace: Option<String>,
}

async fn rename_session(
    State(st): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<RenameBody>,
) -> Result<StatusCode, ApiError> {
    let ws = workspace_required(body.workspace)?;
    docker_for(&st, &ws)
        .rename_tmux_window(&name, &body.alias)
        .await
        .map_err(err)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct AttachBody {
    name: String,
    cols: u16,
    rows: u16,
    workspace: Option<String>,
}

async fn attach(
    State(st): State<AppState>,
    Json(body): Json<AttachBody>,
) -> Result<Json<String>, ApiError> {
    let ws = workspace_required(body.workspace)?;
    let emitter = Arc::new(WsEmitter { tx: st.tx.clone() });
    let docker = docker_for(&st, &ws);
    st.registry
        .attach(&docker, &body.name, body.cols, body.rows, emitter)
        .await
        .map(Json)
        .map_err(err)
}

#[derive(Deserialize)]
struct WriteBody {
    data: String,
}

async fn write(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<WriteBody>,
) -> Result<StatusCode, ApiError> {
    st.registry
        .write(&id, body.data.as_bytes())
        .await
        .map_err(err)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ResizeBody {
    cols: u16,
    rows: u16,
}

async fn resize(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ResizeBody>,
) -> Result<StatusCode, ApiError> {
    // resize_exec only needs the raw Docker handle (exec ids are globally unique).
    let docker = Arc::new(DockerClient::from_docker(
        st.manager.docker_handle(),
        String::new(),
    ));
    st.registry
        .resize(&docker, &id, body.cols, body.rows)
        .await
        .map_err(err)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn detach(State(st): State<AppState>, Path(id): Path<String>) -> StatusCode {
    st.registry.detach(&id).await;
    StatusCode::NO_CONTENT
}

// ── Phase-0 completion contract: real handlers (BE track) ───────────────────
// These now call the same docker/events state as the Tauri commands.

async fn pending_prompts(State(st): State<AppState>) -> impl IntoResponse {
    Json(st.events.pending_prompts())
}

#[derive(Deserialize)]
struct RespondPromptBody {
    session: String,
    allow: bool,
}

async fn respond_prompt(
    State(st): State<AppState>,
    Json(body): Json<RespondPromptBody>,
) -> StatusCode {
    let cli_opt = st
        .registry
        .activity()
        .snapshot()
        .into_iter()
        .find(|a| a.session == body.session)
        .and_then(|a| a.cli);
    let Some(cli) = cli_opt else {
        tracing::warn!(
            "respond_prompt: no activity record for session {}",
            body.session
        );
        return StatusCode::NO_CONTENT;
    };
    let keystroke = if body.allow {
        crate::events::accept_keystroke(&cli)
    } else {
        crate::events::deny_keystroke(&cli)
    };
    if let Some(key) = keystroke {
        if let Some(pane_id) = st.registry.pane_for_session(&body.session).await {
            let _ = st.registry.write(&pane_id, key.as_bytes()).await;
        }
    }
    st.events.clear_pending(&body.session);
    StatusCode::NO_CONTENT
}

#[derive(Deserialize)]
struct ActivityHistoryQuery {
    session: Option<String>,
}

async fn session_activity_history(
    State(st): State<AppState>,
    Query(q): Query<ActivityHistoryQuery>,
) -> impl IntoResponse {
    Json(st.events.activity_history(q.session.as_deref()))
}

async fn codex_usage(State(st): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    let docker = running_workspace_docker(&st).await?;
    docker.codex_usage().await.map(Json).map_err(err)
}

async fn codex_sessions(State(st): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    let docker = running_workspace_docker(&st).await?;
    docker.codex_sessions().await.map(Json).map_err(err)
}

#[derive(Deserialize)]
struct CodexSessionUsageQuery {
    id: String,
}

async fn codex_session_usage(
    State(st): State<AppState>,
    Query(q): Query<CodexSessionUsageQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let docker = running_workspace_docker(&st).await?;
    docker
        .codex_session_usage(&q.id)
        .await
        .map(Json)
        .map_err(err)
}

async fn codex_rate_limits(State(st): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    let docker = running_workspace_docker(&st).await?;
    docker.codex_rate_limits().await.map(Json).map_err(err)
}

async fn github_status(State(st): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    let docker = running_workspace_docker(&st).await?;
    docker.github_status().await.map(Json).map_err(err)
}

async fn github_repos(State(st): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    let docker = running_workspace_docker(&st).await?;
    docker.github_repos().await.map(Json).map_err(err)
}

async fn check_update() -> impl IntoResponse {
    Json(UpdateStatus {
        current: env!("CARGO_PKG_VERSION").to_string(),
        available: None,
        notes: None,
    })
}

#[derive(Deserialize)]
struct SearchQuery {
    query: String,
    limit: Option<u32>,
    workspace: Option<String>,
}

async fn search_transcripts(
    State(st): State<AppState>,
    Query(q): Query<SearchQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let docker = docker_for_optional_workspace(&st, q.workspace).await?;
    docker
        .search_transcripts(&q.query, q.limit.unwrap_or(20))
        .await
        .map(Json)
        .map_err(err)
}

async fn list_providers(State(st): State<AppState>) -> impl IntoResponse {
    Json(dev_provider_statuses(
        st.config.get().providers,
        &st.provider_tokens,
    ))
}

#[derive(Deserialize)]
struct AddProviderBody {
    name: String,
    kind: String,
    endpoint: Option<String>,
    api_key_var: Option<String>,
    models: Option<Vec<String>>,
    model: Option<String>,
    small_fast_model: Option<String>,
}

async fn add_provider(
    State(st): State<AppState>,
    Json(body): Json<AddProviderBody>,
) -> Result<impl IntoResponse, ApiError> {
    let mut settings = st.config.get();
    settings.providers.push(crate::config::ModelProvider {
        id: uuid::Uuid::new_v4().to_string(),
        name: body.name,
        kind: body.kind,
        endpoint: body.endpoint,
        api_key_var: body.api_key_var,
        models: body.models.unwrap_or_default(),
        model: body.model,
        small_fast_model: body.small_fast_model,
        enabled: true,
    });
    let saved = st.config.set(settings).map_err(err)?;
    Ok(Json(dev_provider_statuses(
        saved.providers,
        &st.provider_tokens,
    )))
}

#[derive(Deserialize)]
struct RemoveProviderQuery {
    id: String,
}

async fn remove_provider(
    State(st): State<AppState>,
    Query(q): Query<RemoveProviderQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let mut settings = st.config.get();
    settings.providers.retain(|p| p.id != q.id);
    let saved = st.config.set(settings).map_err(err)?;
    st.provider_tokens
        .lock()
        .expect("provider_tokens mutex")
        .remove(&q.id);
    Ok(Json(dev_provider_statuses(
        saved.providers,
        &st.provider_tokens,
    )))
}

#[derive(Deserialize)]
struct UpdateProviderBody {
    id: String,
    name: Option<String>,
    endpoint: Option<String>,
    enabled: Option<bool>,
    models: Option<Vec<String>>,
    model: Option<String>,
    small_fast_model: Option<String>,
}

async fn update_provider(
    State(st): State<AppState>,
    Json(body): Json<UpdateProviderBody>,
) -> Result<impl IntoResponse, ApiError> {
    let mut settings = st.config.get();
    if let Some(p) = settings.providers.iter_mut().find(|p| p.id == body.id) {
        if let Some(n) = body.name {
            p.name = n;
        }
        if let Some(e) = body.endpoint {
            p.endpoint = Some(e);
        }
        if let Some(en) = body.enabled {
            p.enabled = en;
        }
        if let Some(m) = body.models {
            p.models = m;
        }
        if let Some(m) = body.model {
            p.model = Some(m);
        }
        if let Some(m) = body.small_fast_model {
            p.small_fast_model = Some(m);
        }
    }
    let saved = st.config.set(settings).map_err(err)?;
    Ok(Json(dev_provider_statuses(
        saved.providers,
        &st.provider_tokens,
    )))
}

#[derive(Deserialize)]
struct SetProviderTokenBody {
    id: String,
    token: String,
}

async fn set_provider_token(
    State(st): State<AppState>,
    Json(body): Json<SetProviderTokenBody>,
) -> Result<impl IntoResponse, ApiError> {
    {
        let mut set = st.provider_tokens.lock().expect("provider_tokens mutex");
        if body.token.trim().is_empty() {
            set.remove(&body.id);
        } else {
            set.insert(body.id.clone());
        }
    }
    Ok(Json(dev_provider_statuses(
        st.config.get().providers,
        &st.provider_tokens,
    )))
}

async fn vault_not_supported() -> StatusCode {
    StatusCode::NOT_IMPLEMENTED
}

async fn vault_has_key_not_supported() -> Json<bool> {
    Json(false)
}

async fn ws_events(ws: WebSocketUpgrade, State(st): State<AppState>) -> impl IntoResponse {
    let manager = st.manager.clone();
    ws.on_upgrade(move |socket| client(socket, st.tx.subscribe(), manager))
}

async fn client(
    socket: WebSocket,
    mut rx: broadcast::Receiver<String>,
    manager: Arc<LifecycleManager>,
) {
    let (mut sink, mut stream) = socket.split();
    // Send a synthetic lifecycle "running" frame on connect so the frontend
    // bootstrap triggers immediately (daemon reachability = "running").
    let info = manager.docker_info().await;
    if info.reachable {
        let status = crate::lifecycle::ContainerStatus {
            state: crate::lifecycle::ContainerState::Running,
            id: None,
            image: DEFAULT_IMAGE.to_string(),
            name: "daemon".to_string(),
        };
        let frame = serde_json::json!({ "event": "codehub://lifecycle", "payload": status });
        let _ = sink.send(Message::Text(frame.to_string())).await;
    }
    let pump = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(frame) => {
                    if sink.send(Message::Text(frame)).await.is_err() {
                        break;
                    }
                },
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    while let Some(Ok(msg)) = stream.next().await {
        if matches!(msg, Message::Close(_)) {
            break;
        }
    }
    pump.abort();
}
