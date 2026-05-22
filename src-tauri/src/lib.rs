// Modules are `pub` so the dev-server bin (feature `devserver`, see
// devserver.rs) can reuse the same docker / pty / lifecycle logic without going
// through Tauri.
#[cfg(feature = "devserver")]
pub mod devserver;
pub mod docker;
pub mod lifecycle;
pub mod pty;

use docker::{Cli, DockerClient, LaunchMode};
use lifecycle::{ContainerStatus, Lifecycle};
use pty::{PaneEmitter, PtyRegistry, SessionInfo};
use std::sync::Arc;
use tauri::{Emitter, Manager};

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
    pub lifecycle: Arc<Lifecycle>,
    pub docker: Arc<DockerClient>,
    pub registry: Arc<PtyRegistry>,
}

const DEFAULT_CONTAINER: &str = "codehub-runtime";
const DEFAULT_IMAGE: &str = "ghcr.io/mpolatcan/codehub-runtime:0.1.1";

#[tauri::command]
async fn container_status(state: tauri::State<'_, AppState>) -> Result<ContainerStatus, String> {
    Ok(state.lifecycle.status().await)
}

#[tauri::command]
async fn ensure_runtime(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ContainerStatus, String> {
    let status = state
        .lifecycle
        .ensure_runtime()
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit("codehub://lifecycle", &status);
    Ok(status)
}

#[tauri::command]
async fn container_start(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ContainerStatus, String> {
    state.lifecycle.start().await.map_err(|e| e.to_string())?;
    let status = state.lifecycle.status().await;
    let _ = app.emit("codehub://lifecycle", &status);
    Ok(status)
}

#[tauri::command]
async fn container_stop(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ContainerStatus, String> {
    state.lifecycle.stop().await.map_err(|e| e.to_string())?;
    let status = state.lifecycle.status().await;
    let _ = app.emit("codehub://lifecycle", &status);
    Ok(status)
}

#[tauri::command]
async fn container_restart(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ContainerStatus, String> {
    state.lifecycle.restart().await.map_err(|e| e.to_string())?;
    let status = state.lifecycle.status().await;
    let _ = app.emit("codehub://lifecycle", &status);
    Ok(status)
}

#[tauri::command]
async fn list_sessions(state: tauri::State<'_, AppState>) -> Result<Vec<SessionInfo>, String> {
    state
        .docker
        .list_tmux_sessions()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_session(
    name: String,
    cli: String,
    mode: Option<String>,
    alias: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let cli = Cli::parse(&cli).map_err(|e| e.to_string())?;
    let mode = mode.as_deref().map(LaunchMode::parse).unwrap_or_default();
    state
        .docker
        .create_tmux_session(&name, cli, mode, alias.as_deref().unwrap_or_default())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn kill_session(name: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    // Drop local pane bookkeeping first so resize / write attempts mid-kill
    // cannot resurrect a half-dead pane.
    state.registry.detach_by_session(&name).await;
    state
        .docker
        .kill_tmux_session(&name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn rename_session(
    name: String,
    alias: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state
        .docker
        .rename_tmux_window(&name, &alias)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn attach_session(
    name: String,
    cols: u16,
    rows: u16,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    state
        .registry
        .attach(
            &state.docker,
            &name,
            cols,
            rows,
            Arc::new(TauriEmitter(app)),
        )
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

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            let app_data = app.path().app_data_dir().expect("app_data_dir unavailable");
            let config_dir = app_data.join("config");
            let workspace_dir = app_data.join("workspace");

            let lifecycle = Arc::new(Lifecycle::new(
                container_name.clone(),
                image.clone(),
                config_dir,
                workspace_dir,
            )?);
            let docker = Arc::new(lifecycle.docker_client());
            let registry = Arc::new(PtyRegistry::new());

            app.manage(AppState {
                lifecycle: lifecycle.clone(),
                docker,
                registry,
            });

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

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            container_status,
            ensure_runtime,
            container_start,
            container_stop,
            container_restart,
            list_sessions,
            create_session,
            kill_session,
            rename_session,
            attach_session,
            pty_write,
            pty_resize,
            detach_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running codehub");
}
