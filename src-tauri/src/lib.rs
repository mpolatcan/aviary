// Modules are `pub` so the dev-server bin (feature `devserver`, see
// devserver.rs) can reuse the same docker / pty / lifecycle logic without going
// through Tauri.
#[cfg(feature = "devserver")]
pub mod devserver;
pub mod docker;
pub mod lifecycle;
pub mod pty;

use docker::{
    AgentVersion, Cli, ContainerStats, DockerClient, GitStatus, LaunchMode, MountInfo, ProcessInfo,
};
use lifecycle::{ContainerStatus, DockerInfo, KeyStatus, Lifecycle};
use pty::{PaneEmitter, PtyRegistry, SessionInfo};
use std::collections::HashMap;
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
const DEFAULT_IMAGE: &str = "ghcr.io/mpolatcan/codehub-runtime:0.1.2";

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
async fn container_stats(state: tauri::State<'_, AppState>) -> Result<ContainerStats, String> {
    state.docker.stats().await.map_err(|e| e.to_string())
}

/// Tail of the runtime container's log (Containers view log panel). `tail`
/// defaults to 200 lines. Errs when the container is down.
#[tauri::command]
async fn container_logs(
    state: tauri::State<'_, AppState>,
    tail: Option<u32>,
) -> Result<Vec<String>, String> {
    state
        .docker
        .logs(tail.unwrap_or(200))
        .await
        .map_err(|e| e.to_string())
}

/// Real bind/volume mounts of the runtime container (Containers view Mounts
/// card). Reports the actual host paths behind `/workspace` and `/config`.
#[tauri::command]
async fn container_mounts(state: tauri::State<'_, AppState>) -> Result<Vec<MountInfo>, String> {
    state.docker.mounts().await.map_err(|e| e.to_string())
}

/// Working-tree status of the `/workspace` mount (Hub activity rail "Changes").
/// Reports branch + ahead/behind + changed files; `is_repo: false` when
/// /workspace is not a git repo. Errs only when the container is down.
#[tauri::command]
async fn container_git_status(state: tauri::State<'_, AppState>) -> Result<GitStatus, String> {
    state.docker.git_status().await.map_err(|e| e.to_string())
}

/// Unified diff for one `/workspace` path (rail "Changes" → diff viewer).
#[tauri::command]
async fn container_git_diff(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    state
        .docker
        .git_diff(&path)
        .await
        .map_err(|e| e.to_string())
}

/// Processes running inside the runtime container (Containers view "Processes"
/// card), from `docker top`. Errs only when the container is down.
#[tauri::command]
async fn container_top(state: tauri::State<'_, AppState>) -> Result<Vec<ProcessInfo>, String> {
    state.docker.top().await.map_err(|e| e.to_string())
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

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            let app_data = app.path().app_data_dir().expect("app_data_dir unavailable");
            // One-time carry-over of pre-rebrand (Aviary) auth + workspace data.
            migrate_legacy_app_data(&app_data);
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
            docker_info,
            agent_key_status,
            agent_versions,
            container_stats,
            container_logs,
            container_mounts,
            container_git_status,
            container_git_diff,
            container_top,
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
