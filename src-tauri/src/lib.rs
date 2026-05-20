mod docker;
mod lifecycle;
mod pty;

use docker::{Cli, DockerClient};
use lifecycle::{ContainerStatus, Lifecycle};
use pty::{PtyRegistry, SessionInfo};
use std::sync::Arc;
use tauri::{Emitter, Manager};

pub struct AppState {
    pub lifecycle: Arc<Lifecycle>,
    pub docker: Arc<DockerClient>,
    pub registry: Arc<PtyRegistry>,
}

const DEFAULT_CONTAINER: &str = "aviary-runtime";
const DEFAULT_IMAGE: &str = "mutlupolatcan/aviary-runtime:0.1.0";

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
    let _ = app.emit("aviary://lifecycle", &status);
    Ok(status)
}

#[tauri::command]
async fn container_start(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ContainerStatus, String> {
    state.lifecycle.start().await.map_err(|e| e.to_string())?;
    let status = state.lifecycle.status().await;
    let _ = app.emit("aviary://lifecycle", &status);
    Ok(status)
}

#[tauri::command]
async fn container_stop(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ContainerStatus, String> {
    state.lifecycle.stop().await.map_err(|e| e.to_string())?;
    let status = state.lifecycle.status().await;
    let _ = app.emit("aviary://lifecycle", &status);
    Ok(status)
}

#[tauri::command]
async fn container_restart(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ContainerStatus, String> {
    state.lifecycle.restart().await.map_err(|e| e.to_string())?;
    let status = state.lifecycle.status().await;
    let _ = app.emit("aviary://lifecycle", &status);
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
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let cli = Cli::parse(&cli).map_err(|e| e.to_string())?;
    state
        .docker
        .create_tmux_session(&name, cli)
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
async fn attach_session(
    name: String,
    cols: u16,
    rows: u16,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    state
        .registry
        .attach(&state.docker, &name, cols, rows, app)
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
                .unwrap_or_else(|_| "info,aviary_lib=debug".into()),
        )
        .init();

    let container_name =
        std::env::var("AVIARY_CONTAINER").unwrap_or_else(|_| DEFAULT_CONTAINER.into());
    let image = std::env::var("AVIARY_IMAGE").unwrap_or_else(|_| DEFAULT_IMAGE.into());

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
                        let _ = handle.emit("aviary://lifecycle", &status);
                    },
                    Err(e) => {
                        tracing::error!("ensure_runtime failed: {e}");
                        let _ = handle.emit("aviary://lifecycle-error", e.to_string());
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
            attach_session,
            pty_write,
            pty_resize,
            detach_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running aviary");
}
