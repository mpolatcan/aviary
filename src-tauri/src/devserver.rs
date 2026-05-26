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
use crate::docker::{Cli, DockerClient, LaunchMode};
use crate::events::EventsTracker;
use crate::lifecycle::Lifecycle;
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

const DEFAULT_CONTAINER: &str = "codehub-runtime";
const DEFAULT_IMAGE: &str = "ghcr.io/mpolatcan/codehub-runtime:0.1.3";
const ADDR: &str = "127.0.0.1:4555";

#[derive(Clone)]
struct AppState {
    lifecycle: Arc<Lifecycle>,
    // Resolves a per-workspace `Lifecycle`/container (mirrors the Tauri AppState)
    // so the session handlers can target the right container under the
    // per-workspace flag; `lifecycle` above is `manager.default()`.
    manager: Arc<LifecycleManager>,
    docker: Arc<DockerClient>,
    registry: Arc<PtyRegistry>,
    config: Arc<ConfigStore>,
    events: Arc<EventsTracker>,
    // Pre-serialized `{event, payload}` frames fanned out to every WS client.
    tx: broadcast::Sender<String>,
}

/// DockerClient for a SESSION command's target container (mirrors lib.rs
/// `docker_for`): `workspace` is the per-workspace key; `None` / flag off → the
/// shared runtime (a session keyed `ws-x` lives in `codehub-runtime` when off).
fn docker_for(st: &AppState, workspace: Option<&str>) -> Arc<DockerClient> {
    Arc::new(st.manager.resolve(workspace, None).docker_client())
}

/// DockerClient for an INSPECTION command, BY NAME with no flag fallback
/// (mirrors lib.rs `docker_container_for`): an explicit `workspace` ALWAYS
/// targets that per-workspace container, reading its OWN stats/logs/procs.
fn docker_container_for(st: &AppState, workspace: Option<&str>) -> Arc<DockerClient> {
    Arc::new(st.manager.resolve_container(workspace).docker_client())
}

/// Lifecycle for an optional workspace key, BY NAME with no flag fallback
/// (mirrors lib.rs `lifecycle_for`): `None` → the shared runtime, `Some(key)` →
/// `codehub-ws-<key>` even when the flag is off, so a workspace card's
/// Start/Stop/Restart never acts on `codehub-runtime`.
fn lifecycle_for(st: &AppState, workspace: Option<&str>) -> Arc<crate::lifecycle::Lifecycle> {
    st.manager.resolve_container(workspace)
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

pub async fn serve() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,codehub_lib=debug".into()),
        )
        .init();

    // CODEHUB_* canonical; AVIARY_* kept as a fallback for existing setups.
    let container = std::env::var("CODEHUB_CONTAINER")
        .or_else(|_| std::env::var("AVIARY_CONTAINER"))
        .unwrap_or_else(|_| DEFAULT_CONTAINER.into());
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
    // resolution; the shared-runtime lifecycle is `manager.default()`.
    let manager = Arc::new(
        LifecycleManager::new(
            container,
            image,
            data_dir.join("config"),
            data_dir.join("workspace"),
            config.clone(),
        )
        .expect("docker daemon unreachable — is Docker running?"),
    );
    let lifecycle = manager.default();
    let docker = Arc::new(lifecycle.docker_client());
    let registry = Arc::new(PtyRegistry::new());
    let events = Arc::new(EventsTracker::new());
    let (tx, _) = broadcast::channel::<String>(1024);

    // Provision the runtime in the background, mirroring lib.rs setup; the
    // frontend's initial GET /status sees the result and the WS streams updates.
    {
        let lifecycle = lifecycle.clone();
        let tx = tx.clone();
        tokio::spawn(async move {
            let frame = match lifecycle.ensure_runtime().await {
                Ok(status) => json!({ "event": "codehub://lifecycle", "payload": status }),
                Err(e) => {
                    json!({ "event": "codehub://lifecycle-error", "payload": e.to_string() })
                },
            };
            let _ = tx.send(frame.to_string());
        });
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

    let state = AppState {
        lifecycle,
        manager,
        docker,
        registry,
        config,
        events,
        tx,
    };

    let app = Router::new()
        .route("/status", get(status))
        .route("/container-start", post(container_start))
        .route("/container-stop", post(container_stop))
        .route("/container-restart", post(container_restart))
        .route("/docker-info", get(docker_info))
        .route("/app-info", get(app_info))
        .route("/per-workspace-enabled", get(per_workspace_enabled))
        .route("/config", get(get_config).put(set_config))
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
        .route("/account-profiles/:id", delete(remove_account_profile))
        .route("/agent-key-status", get(agent_key_status))
        .route("/agent-versions", get(agent_versions))
        .route("/container-stats", get(container_stats))
        .route("/container-logs", get(container_logs))
        .route("/container-mounts", get(container_mounts))
        .route("/container-image", get(container_image))
        .route("/container-health", get(container_health))
        .route("/container-list-dir", get(container_list_dir))
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
        .route("/container-git-commit", post(container_git_commit))
        .route("/container-git-open-pr", post(container_git_open_pr))
        .route("/container-top", get(container_top))
        .route("/claude-usage", get(claude_usage))
        .route("/claude-sessions", get(claude_sessions))
        .route("/claude-session-usage", get(claude_session_usage))
        .route("/claude-integrations", get(claude_integrations))
        .route("/claude-agent-config", get(claude_agent_config))
        .route("/container-git-log", get(container_git_log))
        .route("/session-activity", get(session_activity))
        // Phase-0 completion contract (stub handlers; mirror lib.rs).
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
        .route("/sessions", get(list_sessions).post(create_session))
        .route("/sessions/:name", delete(kill_session))
        .route("/sessions/:name/rename", post(rename_session))
        .route("/attach", post(attach))
        .route("/panes/:id/write", post(write))
        .route("/panes/:id/resize", post(resize))
        .route("/panes/:id", delete(detach))
        .route("/events", get(ws_events))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(ADDR).await.expect("bind");
    tracing::info!("codehub dev bridge on http://{ADDR}  (proxied at /__bridge)");
    axum::serve(listener, app).await.expect("serve");
}

async fn status(State(st): State<AppState>, Query(q): Query<WorkspaceQuery>) -> impl IntoResponse {
    Json(lifecycle_for(&st, q.workspace.as_deref()).status().await)
}

// Broadcast the post-action status as a codehub://lifecycle frame (same shape
// the Tauri build emits) so every connected WS subscriber updates, then return
// it for the immediate caller. Mirrors lib.rs's container_start/stop/restart.
// ONLY for the shared runtime (`workspace` None) — that event tracks the store's
// single shared `status`, so a per-workspace frame would clobber it. Per-
// workspace state rides the fleet poll instead.
fn broadcast_lifecycle(
    st: &AppState,
    workspace: Option<&str>,
    status: &crate::lifecycle::ContainerStatus,
) {
    if workspace.is_some() {
        return;
    }
    let frame = json!({ "event": "codehub://lifecycle", "payload": status });
    let _ = st.tx.send(frame.to_string());
}

async fn container_start(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let lc = lifecycle_for(&st, q.workspace.as_deref());
    lc.start().await.map_err(err)?;
    let status = lc.status().await;
    broadcast_lifecycle(&st, q.workspace.as_deref(), &status);
    Ok(Json(status))
}

async fn container_stop(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let lc = lifecycle_for(&st, q.workspace.as_deref());
    lc.stop().await.map_err(err)?;
    let status = lc.status().await;
    broadcast_lifecycle(&st, q.workspace.as_deref(), &status);
    Ok(Json(status))
}

async fn container_restart(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let lc = lifecycle_for(&st, q.workspace.as_deref());
    lc.restart().await.map_err(err)?;
    let status = lc.status().await;
    broadcast_lifecycle(&st, q.workspace.as_deref(), &status);
    Ok(Json(status))
}

async fn docker_info(State(st): State<AppState>) -> impl IntoResponse {
    Json(st.lifecycle.docker_info().await)
}

async fn app_info() -> impl IntoResponse {
    Json(crate::lifecycle::app_info())
}

async fn per_workspace_enabled() -> impl IntoResponse {
    Json(crate::manager::per_workspace_enabled())
}

async fn get_config(State(st): State<AppState>) -> impl IntoResponse {
    Json(st.config.get())
}

async fn set_config(
    State(st): State<AppState>,
    Json(body): Json<Settings>,
) -> Result<impl IntoResponse, ApiError> {
    st.config
        .set(body)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
}

// Tier-2 / Tier-3 — workspace picker + account profiles. Mirror the lib.rs
// commands one-for-one. The native folder picker can't run in a browser, so
// pick_directory degrades to null (the UI falls back to a typed path).
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

async fn workspace_info(State(st): State<AppState>) -> impl IntoResponse {
    Json(st.lifecycle.workspace_info().await)
}

async fn recreate_runtime(State(st): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    st.lifecycle.recreate().await.map_err(err)?;
    let status = st.lifecycle.status().await;
    broadcast_lifecycle(&st, None, &status);
    Ok(Json(status))
}

async fn list_account_profiles(State(st): State<AppState>) -> impl IntoResponse {
    Json(crate::profile_statuses(st.config.get().account_profiles))
}

#[derive(Deserialize)]
struct AddProfileBody {
    agent: String,
    label: String,
    var_name: String,
}

async fn add_account_profile(
    State(st): State<AppState>,
    Json(body): Json<AddProfileBody>,
) -> Result<impl IntoResponse, ApiError> {
    let profile = crate::build_account_profile(&body.agent, &body.label, &body.var_name)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let next = st.config.add_account_profile(profile).map_err(err)?;
    Ok(Json(crate::profile_statuses(next.account_profiles)))
}

async fn remove_account_profile(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let next = st.config.remove_account_profile(&id).map_err(err)?;
    Ok(Json(crate::profile_statuses(next.account_profiles)))
}

async fn agent_key_status() -> impl IntoResponse {
    Json(crate::lifecycle::agent_key_status())
}

async fn agent_versions(State(st): State<AppState>) -> impl IntoResponse {
    Json(st.docker.agent_versions().await)
}

async fn container_stats(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    docker_container_for(&st, q.workspace.as_deref())
        .stats()
        .await
        .map(Json)
        .map_err(err)
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
    let key = q
        .workspace
        .ok_or((StatusCode::BAD_REQUEST, "workspace required".into()))?;
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
    docker_container_for(&st, q.workspace.as_deref())
        .logs(q.tail.unwrap_or(200))
        .await
        .map(Json)
        .map_err(err)
}

async fn container_mounts(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    docker_container_for(&st, q.workspace.as_deref())
        .mounts()
        .await
        .map(Json)
        .map_err(err)
}

async fn container_image(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    docker_container_for(&st, q.workspace.as_deref())
        .image_info()
        .await
        .map(Json)
        .map_err(err)
}

async fn container_health(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    docker_container_for(&st, q.workspace.as_deref())
        .health()
        .await
        .map(Json)
        .map_err(err)
}

#[derive(Deserialize)]
struct PathQuery {
    /// Empty / absent → the workspace root.
    path: Option<String>,
    /// Per-workspace container key (absent → shared runtime).
    workspace: Option<String>,
}

async fn container_list_dir(
    State(st): State<AppState>,
    Query(q): Query<PathQuery>,
) -> Result<impl IntoResponse, ApiError> {
    docker_container_for(&st, q.workspace.as_deref())
        .list_dir(&q.path.unwrap_or_default())
        .await
        .map(Json)
        .map_err(err)
}

async fn container_read_file(
    State(st): State<AppState>,
    Query(q): Query<PathQuery>,
) -> Result<impl IntoResponse, ApiError> {
    docker_container_for(&st, q.workspace.as_deref())
        .read_file(&q.path.unwrap_or_default())
        .await
        .map(Json)
        .map_err(err)
}

async fn container_git_status(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    docker_container_for(&st, q.workspace.as_deref())
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
    docker_container_for(&st, q.workspace.as_deref())
        .git_diff(&q.path)
        .await
        .map(Json)
        .map_err(err)
}

async fn container_git_diff_all(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    docker_container_for(&st, q.workspace.as_deref())
        .git_diff_all()
        .await
        .map(Json)
        .map_err(err)
}

async fn container_git_diff_staged(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    docker_container_for(&st, q.workspace.as_deref())
        .git_diff_staged()
        .await
        .map(Json)
        .map_err(err)
}

async fn container_git_diff_unstaged(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    docker_container_for(&st, q.workspace.as_deref())
        .git_diff_unstaged()
        .await
        .map(Json)
        .map_err(err)
}

async fn container_git_stage_all(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    docker_container_for(&st, q.workspace.as_deref())
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
    docker_container_for(&st, q.workspace.as_deref())
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
    docker_container_for(&st, q.workspace.as_deref())
        .git_open_pr(&body.title, &body.body)
        .await
        .map(Json)
        .map_err(err)
}

async fn container_top(
    State(st): State<AppState>,
    Query(q): Query<WorkspaceQuery>,
) -> Result<impl IntoResponse, ApiError> {
    docker_container_for(&st, q.workspace.as_deref())
        .top()
        .await
        .map(Json)
        .map_err(err)
}

async fn claude_usage(State(st): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    st.docker.claude_usage().await.map(Json).map_err(err)
}

async fn claude_sessions(State(st): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    st.docker.claude_sessions().await.map(Json).map_err(err)
}

async fn claude_integrations(State(st): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    st.docker.claude_integrations().await.map(Json).map_err(err)
}

async fn claude_agent_config(State(st): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    st.docker.claude_agent_config().await.map(Json).map_err(err)
}

#[derive(Deserialize)]
struct SessionUsageQuery {
    id: String,
}

async fn claude_session_usage(
    State(st): State<AppState>,
    Query(q): Query<SessionUsageQuery>,
) -> Result<impl IntoResponse, ApiError> {
    st.docker
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
    docker_container_for(&st, q.workspace.as_deref())
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
    /// Per-workspace-container target + first-create mount dir (see lib.rs).
    workspace: Option<String>,
    workspace_dir: Option<String>,
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
    // Resolve the chosen account profile to its env var NAME (never a value).
    let account_var = body.account.as_deref().and_then(|id| {
        st.config
            .get()
            .account_profiles
            .into_iter()
            .find(|p| p.id == id)
            .map(|p| p.var_name)
    });
    // Resolve the target container; lazily ensure a per-workspace one (mirror
    // lib.rs). Gate on the workspace label, not the dir override — a per-ws
    // container with no explicit dir mounts the config-driven dir (override
    // None) yet still needs ensuring.
    let lifecycle = st.manager.resolve(
        body.workspace.as_deref(),
        body.workspace_dir.map(std::path::PathBuf::from),
    );
    if lifecycle.workspace_label.is_some() {
        lifecycle.ensure_runtime().await.map_err(err)?;
    }
    lifecycle
        .docker_client()
        .create_tmux_session(
            &body.name,
            cli,
            mode,
            &alias,
            body.resume.as_deref(),
            body.session_id.as_deref(),
            account_var.as_deref(),
        )
        .await
        .map_err(err)?;
    // Mirror lib.rs: record agent identity (+ Claude transcript id) for the
    // activity snapshot.
    let claude_id = body.resume.as_deref().or(body.session_id.as_deref());
    st.registry
        .activity()
        .register(&body.name, cli.binary(), &alias, claude_id);
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
    // Same ordering as lib.rs: drop pane bookkeeping before killing tmux.
    st.registry.detach_by_session(&name).await;
    st.events.remove_session(&name);
    docker_for(&st, q.workspace.as_deref())
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
    docker_for(&st, body.workspace.as_deref())
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
    let emitter = Arc::new(WsEmitter { tx: st.tx.clone() });
    let docker = docker_for(&st, body.workspace.as_deref());
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
    st.registry
        .resize(&st.docker, &id, body.cols, body.rows)
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
    st.docker.codex_usage().await.map(Json).map_err(err)
}

async fn codex_sessions(State(st): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    st.docker.codex_sessions().await.map(Json).map_err(err)
}

#[derive(Deserialize)]
struct CodexSessionUsageQuery {
    id: String,
}

async fn codex_session_usage(
    State(st): State<AppState>,
    Query(q): Query<CodexSessionUsageQuery>,
) -> Result<impl IntoResponse, ApiError> {
    st.docker
        .codex_session_usage(&q.id)
        .await
        .map(Json)
        .map_err(err)
}

async fn codex_rate_limits(State(st): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    st.docker.codex_rate_limits().await.map(Json).map_err(err)
}

async fn github_status(State(st): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    st.docker.github_status().await.map(Json).map_err(err)
}

async fn github_repos(State(st): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    st.docker.github_repos().await.map(Json).map_err(err)
}

async fn check_update() -> impl IntoResponse {
    Json(UpdateStatus {
        current: env!("CARGO_PKG_VERSION").to_string(),
        available: None,
        notes: None,
    })
}

async fn ws_events(ws: WebSocketUpgrade, State(st): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| client(socket, st.tx.subscribe()))
}

// Server -> client only: forward broadcast frames; drain incoming so the socket
// stays healthy. Frontend writes go over REST, not this socket.
async fn client(socket: WebSocket, mut rx: broadcast::Receiver<String>) {
    let (mut sink, mut stream) = socket.split();
    let pump = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(frame) => {
                    if sink.send(Message::Text(frame)).await.is_err() {
                        break;
                    }
                },
                // Heavy output overran the buffer — skip the dropped frames and
                // keep the socket alive rather than disconnecting the client.
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
