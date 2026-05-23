// Modules are `pub` so the dev-server bin (feature `devserver`, see
// devserver.rs) can reuse the same docker / pty / lifecycle logic without going
// through Tauri.
pub mod activity;
#[cfg(feature = "devserver")]
pub mod devserver;
pub mod docker;
pub mod lifecycle;
pub mod pty;

use activity::SessionActivity;
use docker::{
    AgentVersion, ClaudeSession, ClaudeUsage, Cli, CommitInfo, ContainerStats, DockerClient,
    FileEntry, GitStatus, ImageInfo, LaunchMode, MountInfo, ProcessInfo, RuntimeHealth,
    SessionUsage,
};
use lifecycle::{AppInfo, ContainerStatus, DockerInfo, KeyStatus, Lifecycle};
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

/// Build + host platform identity for the Settings "About" pane (version, OS,
/// arch) — all compile-time / `std::env::consts` values, no I/O, no update check.
#[tauri::command]
fn app_info() -> Result<AppInfo, String> {
    Ok(lifecycle::app_info())
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

/// Identity of the runtime container's image (Containers view Image card):
/// tag/digest/created/size/arch/os. Errs only when the container/image can't be
/// inspected.
#[tauri::command]
async fn container_image(state: tauri::State<'_, AppState>) -> Result<ImageInfo, String> {
    state.docker.image_info().await.map_err(|e| e.to_string())
}

/// Liveness of the runtime container (Containers view hero): started-at, restart
/// count, status and OOM flag. Errs only when the container can't be inspected.
#[tauri::command]
async fn container_health(state: tauri::State<'_, AppState>) -> Result<RuntimeHealth, String> {
    state.docker.health().await.map_err(|e| e.to_string())
}

/// Non-recursive listing of a `/workspace` directory (Files browser). `path` is
/// confined to `/workspace`; empty → the workspace root. Errs when down or the
/// path escapes the workspace.
#[tauri::command]
async fn container_list_dir(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    state
        .docker
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
) -> Result<String, String> {
    state
        .docker
        .read_file(&path)
        .await
        .map_err(|e| e.to_string())
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

/// Combined diff of all tracked `/workspace` changes (rail "Review all" → diff
/// viewer). Empty string when the tree is clean.
#[tauri::command]
async fn container_git_diff_all(state: tauri::State<'_, AppState>) -> Result<String, String> {
    state.docker.git_diff_all().await.map_err(|e| e.to_string())
}

/// Processes running inside the runtime container (Containers view "Processes"
/// card), from `docker top`. Errs only when the container is down.
#[tauri::command]
async fn container_top(state: tauri::State<'_, AppState>) -> Result<Vec<ProcessInfo>, String> {
    state.docker.top().await.map_err(|e| e.to_string())
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

/// Recent commits on `/workspace` (Dashboard "Recent commits"). `limit` defaults
/// to 12 server-side and is clamped. Errs only when the container is down.
#[tauri::command]
async fn container_git_log(
    limit: Option<u32>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<CommitInfo>, String> {
    state
        .docker
        .git_log(limit.unwrap_or(12))
        .await
        .map_err(|e| e.to_string())
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
    resume: Option<String>,
    session_id: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let cli = Cli::parse(&cli).map_err(|e| e.to_string())?;
    let mode = mode.as_deref().map(LaunchMode::parse).unwrap_or_default();
    let alias = alias.unwrap_or_default();
    state
        .docker
        .create_tmux_session(
            &name,
            cli,
            mode,
            &alias,
            resume.as_deref(),
            session_id.as_deref(),
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

/// Current per-session activity (working/idle) derived from pane output flow.
/// In-memory and synchronous — never fails, returns an empty list when nothing
/// is attached.
#[tauri::command]
async fn session_activity(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<SessionActivity>, String> {
    Ok(state.registry.activity().snapshot())
}

/// Label of the always-on-top companion window.
const COMPANION_LABEL: &str = "companion";

/// Open (or re-focus) the floating, always-on-top companion — a small frameless
/// window that mirrors the live working/idle state of every running agent so it
/// stays visible over other apps. The window content is a real route
/// (`index.html#/companion`) that polls `session_activity`; everything it shows
/// is the honest activity signal — no fabricated turn/token/approval state.
#[tauri::command]
async fn open_companion(app: tauri::AppHandle) -> Result<(), String> {
    // Already open → just bring it forward.
    if let Some(win) = app.get_webview_window(COMPANION_LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let win = tauri::WebviewWindowBuilder::new(
        &app,
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

/// Close the companion window if it is open. No-op when it is not.
#[tauri::command]
async fn close_companion(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(COMPANION_LABEL) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Whether the companion window is currently open — lets the trigger render as a
/// toggle.
#[tauri::command]
async fn companion_open(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(app.get_webview_window(COMPANION_LABEL).is_some())
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
            app_info,
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
            container_top,
            claude_usage,
            claude_sessions,
            claude_session_usage,
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
            companion_open,
            focus_session_from_companion,
        ])
        .run(tauri::generate_context!())
        .expect("error while running codehub");
}
