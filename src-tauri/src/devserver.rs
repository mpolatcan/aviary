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

use crate::docker::{Cli, DockerClient, LaunchMode};
use crate::lifecycle::Lifecycle;
use crate::pty::{PaneEmitter, PtyRegistry};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::broadcast;

const DEFAULT_CONTAINER: &str = "codehub-runtime";
const DEFAULT_IMAGE: &str = "ghcr.io/mpolatcan/codehub-runtime:0.1.2";
const ADDR: &str = "127.0.0.1:4555";

#[derive(Clone)]
struct AppState {
    lifecycle: Arc<Lifecycle>,
    docker: Arc<DockerClient>,
    registry: Arc<PtyRegistry>,
    // Pre-serialized `{event, payload}` frames fanned out to every WS client.
    tx: broadcast::Sender<String>,
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

    let lifecycle = Arc::new(
        Lifecycle::new(
            container,
            image,
            data_dir.join("config"),
            data_dir.join("workspace"),
        )
        .expect("docker daemon unreachable — is Docker running?"),
    );
    let docker = Arc::new(lifecycle.docker_client());
    let registry = Arc::new(PtyRegistry::new());
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

    let state = AppState {
        lifecycle,
        docker,
        registry,
        tx,
    };

    let app = Router::new()
        .route("/status", get(status))
        .route("/docker-info", get(docker_info))
        .route("/agent-key-status", get(agent_key_status))
        .route("/agent-versions", get(agent_versions))
        .route("/container-stats", get(container_stats))
        .route("/container-logs", get(container_logs))
        .route("/sessions", get(list_sessions).post(create_session))
        .route("/sessions/:name", delete(kill_session))
        .route("/sessions/:name/rename", post(rename_session))
        .route("/attach", post(attach))
        .route("/panes/:id/write", post(write))
        .route("/panes/:id/resize", post(resize))
        .route("/panes/:id", delete(detach))
        .route("/events", get(events))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(ADDR).await.expect("bind");
    tracing::info!("codehub dev bridge on http://{ADDR}  (proxied at /__bridge)");
    axum::serve(listener, app).await.expect("serve");
}

async fn status(State(st): State<AppState>) -> impl IntoResponse {
    Json(st.lifecycle.status().await)
}

async fn docker_info(State(st): State<AppState>) -> impl IntoResponse {
    Json(st.lifecycle.docker_info().await)
}

async fn agent_key_status() -> impl IntoResponse {
    Json(crate::lifecycle::agent_key_status())
}

async fn agent_versions(State(st): State<AppState>) -> impl IntoResponse {
    Json(st.docker.agent_versions().await)
}

async fn container_stats(State(st): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    st.docker.stats().await.map(Json).map_err(err)
}

#[derive(Deserialize)]
struct LogsQuery {
    tail: Option<u32>,
}

async fn container_logs(
    State(st): State<AppState>,
    Query(q): Query<LogsQuery>,
) -> Result<impl IntoResponse, ApiError> {
    st.docker
        .logs(q.tail.unwrap_or(200))
        .await
        .map(Json)
        .map_err(err)
}

async fn list_sessions(State(st): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    st.docker.list_tmux_sessions().await.map(Json).map_err(err)
}

#[derive(Deserialize)]
struct CreateBody {
    name: String,
    cli: String,
    mode: Option<String>,
    alias: Option<String>,
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
    st.docker
        .create_tmux_session(
            &body.name,
            cli,
            mode,
            body.alias.as_deref().unwrap_or_default(),
        )
        .await
        .map_err(err)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn kill_session(
    State(st): State<AppState>,
    Path(name): Path<String>,
) -> Result<StatusCode, ApiError> {
    // Same ordering as lib.rs: drop pane bookkeeping before killing tmux.
    st.registry.detach_by_session(&name).await;
    st.docker.kill_tmux_session(&name).await.map_err(err)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct RenameBody {
    alias: String,
}

async fn rename_session(
    State(st): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<RenameBody>,
) -> Result<StatusCode, ApiError> {
    st.docker
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
}

async fn attach(
    State(st): State<AppState>,
    Json(body): Json<AttachBody>,
) -> Result<Json<String>, ApiError> {
    let emitter = Arc::new(WsEmitter { tx: st.tx.clone() });
    st.registry
        .attach(&st.docker, &body.name, body.cols, body.rows, emitter)
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

async fn events(ws: WebSocketUpgrade, State(st): State<AppState>) -> impl IntoResponse {
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
