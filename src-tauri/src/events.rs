//! Agent-event hooks subsystem (§7, COMPLETION_PLAN.md).
//!
//! Each agent appends structured events to `/tmp/codehub/events/<session>.jsonl`
//! via the hook scripts baked into the runtime image. This module owns:
//!
//! - [`EventsTracker`]: per-session in-memory state (pending prompts, turn/edit
//!   counters, activity-event ring buffer), updated as lines arrive.
//! - [`start_event_tailer`]: a long-lived bollard exec running
//!   `tail -F /tmp/codehub/events/*.jsonl` that feeds the tracker and emits the
//!   `codehub://agent-event` Tauri event to the frontend.
//! - Public read helpers used by the Tauri commands: [`EventsTracker::pending_prompts`],
//!   [`EventsTracker::activity_history`], [`accept_keystroke`], [`deny_keystroke`].
//!
//! Design notes:
//! - The tracker uses a plain `std::sync::Mutex` (short, sync-only critical
//!   sections — no `.await` across the lock).
//! - Falls back to honest-empty when the container is down or the events dir
//!   does not exist yet (the first line `tail -F` produces is a header, which the
//!   parser skips gracefully).
//! - The ring buffer cap keeps memory bounded regardless of run time.

use crate::docker::DockerClient;
use crate::lifecycle::ContainerState;
use crate::types::{ActivityEvent, AgentEvent, PendingPrompt};
use bollard::exec::{CreateExecOptions, StartExecOptions, StartExecResults};
use futures_util::StreamExt;
use serde::Deserialize;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;

// ── Error wrapper for the tail task ─────────────────────────────────────────
// We avoid `anyhow` (not in Cargo.toml) by using a simple Box<dyn Error>.
type TailError = Box<dyn std::error::Error + Send + Sync + 'static>;

/// In-container tail driver. A plain `tail -F /tmp/codehub/events/*.jsonl` is a
/// trap: the shell expands the glob ONCE at attach, so any session file created
/// AFTER the tailer attaches is never followed. That's the COMMON case for a
/// freshly-spawned per-workspace container (empty events dir → first session
/// file appears after attach), so its very first events would be lost.
///
/// Instead, poll the dir and spawn a dedicated tail per `.jsonl` the moment it
/// appears, tracking which files are already followed so each is tailed exactly
/// once (no duplicate ingestion within a tailer's lifetime).
///
/// Each tail starts at line 1 (`-n +1`), NOT the default last-10. The poll has a
/// up-to-1s discovery lag, and an agent can burst more than 10 lines into a fresh
/// file in that window; a last-10 tail would silently drop the earliest events.
/// `-n +1` emits the whole file on discovery, so nothing written before the poll
/// noticed is lost. (Re-ingesting a full file is harmless: `ingest` is replay-safe
/// — pending state converges and the activity ring is bounded — and the dedup set
/// means it only re-replays if the OUTER loop re-attaches after a container
/// stop/stream error, which is rare.)
///
/// `.keep` (the dir sentinel) never matches `*.jsonl`, so it's skipped. `trap
/// 'kill 0'` reaps the child tails when the exec shell exits. dash-compatible (the
/// runtime's `/bin/sh`): `case` glob membership, no-match glob guarded by `[ -e ]`.
const TAIL_SCRIPT: &str = r#"cd /tmp/codehub/events 2>/dev/null || exit 0
trap 'kill 0' EXIT
tailed=""
while :; do
  for f in *.jsonl; do
    [ -e "$f" ] || continue
    case " $tailed " in
      *" $f "*) ;;
      *) tail -n +1 -F "$f" 2>/dev/null & tailed="$tailed $f" ;;
    esac
  done
  sleep 1
done"#;

/// Maximum activity events retained per session in the ring buffer.
const RING_CAPACITY: usize = 200;

/// Maximum total events across all sessions (global memory bound).
const GLOBAL_RING_CAP: usize = 2000;

/// Kind string constants — match the TS `AgentEventKind` union in ipc.ts.
const KIND_NOTIFICATION: &str = "notification";
const KIND_STOP: &str = "stop";
const KIND_PRE_TOOL: &str = "pre_tool";
const KIND_POST_TOOL: &str = "post_tool";
const KIND_PROMPT_SUBMIT: &str = "prompt_submit";
const KIND_SESSION_START: &str = "session_start";
const KIND_SESSION_END: &str = "session_end";

/// Normalize the raw hook `kind` tag (set by the append script in the
/// Dockerfile) to the contract kind strings used in the IPC.
fn normalize_kind(raw: &str) -> Option<&'static str> {
    match raw {
        "Notification" => Some(KIND_NOTIFICATION),
        "Stop" | "StopFailure" => Some(KIND_STOP),
        "PreToolUse" => Some(KIND_PRE_TOOL),
        "PostToolUse" => Some(KIND_POST_TOOL),
        "UserPromptSubmit" => Some(KIND_PROMPT_SUBMIT),
        "SessionStart" => Some(KIND_SESSION_START),
        "SessionEnd" => Some(KIND_SESSION_END),
        _ => None,
    }
}

/// One pending permission prompt.
#[derive(Clone)]
pub struct PendingEntry {
    pub message: Option<String>,
    pub since: i64,
}

/// Per-session event state.
#[derive(Default)]
struct SessionState {
    pending: Option<PendingEntry>,
    history: VecDeque<ActivityEvent>,
}

/// Shared, in-memory per-session event state. Filled by the tail task and read
/// by the Tauri commands via `pending_prompts` / `session_activity_history`
/// / `respond_prompt`.
#[derive(Default)]
pub struct EventsTracker {
    inner: Mutex<HashMap<String, SessionState>>,
}

impl EventsTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Lock the inner map, recovering a poisoned lock — the state is plain data,
    /// so a panic mid-update can't leave it logically corrupt.
    fn lock_inner(&self) -> std::sync::MutexGuard<'_, HashMap<String, SessionState>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Process one line from the tail stream and update state.
    /// Returns `Some(AgentEvent)` when the line parses into an event the
    /// frontend should receive.
    pub fn ingest(&self, line: &str) -> Option<AgentEvent> {
        // The append script writes:
        // {"session":"<tmux-name>","kind":"<HookEventName>","at":<ms>,...}
        #[derive(Deserialize)]
        struct Line {
            session: String,
            kind: String,
            at: i64,
            #[serde(default)]
            message: Option<String>,
            #[serde(default)]
            notification_type: Option<String>,
            #[serde(default)]
            tool_name: Option<String>,
        }

        let Ok(ev) = serde_json::from_str::<Line>(line) else {
            return None;
        };
        let kind = normalize_kind(&ev.kind)?;

        let agent_event = AgentEvent {
            session: ev.session.clone(),
            kind: kind.to_string(),
            at: ev.at,
            message: ev.message.clone(),
            notification_type: ev.notification_type.clone(),
            tool_name: ev.tool_name.clone(),
        };

        let activity = ActivityEvent {
            session: ev.session.clone(),
            kind: kind.to_string(),
            at: ev.at,
            message: ev.message.clone(),
        };

        let mut map = self.lock_inner();
        let state = map.entry(ev.session.clone()).or_default();

        // Update pending-prompt state.
        match kind {
            KIND_NOTIFICATION => {
                // notification_type:"permission_prompt" → awaiting input.
                // notification_type:"idle_prompt" (or unknown) → NOT awaiting.
                // §7.6: field verified (doc shape provisional but keyed correctly).
                let is_prompt = ev
                    .notification_type
                    .as_deref()
                    .map(|t| t == "permission_prompt")
                    // When the type is absent (pre-authed run / doc drift), leave
                    // pending unchanged — honest-uncertain.
                    .unwrap_or(false);
                if is_prompt {
                    state.pending = Some(PendingEntry {
                        message: ev.message.clone(),
                        since: ev.at,
                    });
                }
            },
            KIND_STOP | KIND_PROMPT_SUBMIT => {
                // Turn finished or new turn started → clear pending.
                state.pending = None;
            },
            _ => {},
        }

        // Append to ring buffer; evict oldest when full.
        if state.history.len() >= RING_CAPACITY {
            state.history.pop_front();
        }
        state.history.push_back(activity);

        // Global cap: drop the oldest entry from the busiest session.
        let total: usize = map.values().map(|s| s.history.len()).sum();
        if total > GLOBAL_RING_CAP {
            if let Some(busiest) = map.values_mut().max_by_key(|s| s.history.len()) {
                busiest.history.pop_front();
            }
        }

        Some(agent_event)
    }

    /// All sessions currently awaiting a permission prompt.
    pub fn pending_prompts(&self) -> Vec<PendingPrompt> {
        self.lock_inner()
            .iter()
            .filter_map(|(session, s)| {
                s.pending.as_ref().map(|p| PendingPrompt {
                    session: session.clone(),
                    message: p.message.clone(),
                    since: p.since,
                })
            })
            .collect()
    }

    /// Activity history for one session, or all sessions when `session` is `None`.
    pub fn activity_history(&self, session: Option<&str>) -> Vec<ActivityEvent> {
        let map = self.lock_inner();
        match session {
            Some(s) => map
                .get(s)
                .map(|st| st.history.iter().cloned().collect())
                .unwrap_or_default(),
            None => {
                let mut all: Vec<ActivityEvent> = map
                    .values()
                    .flat_map(|st| st.history.iter().cloned())
                    .collect();
                // Chronological order (oldest first).
                all.sort_by_key(|e| e.at);
                all
            },
        }
    }

    /// Clear a session's pending prompt (called after `respond_prompt` so the
    /// cleared state propagates even if the next hook line is slow).
    pub fn clear_pending(&self, session: &str) {
        let mut map = self.lock_inner();
        if let Some(state) = map.get_mut(session) {
            state.pending = None;
        }
    }

    /// Remove all state for a session (called when the session is killed).
    pub fn remove_session(&self, session: &str) {
        self.lock_inner().remove(session);
    }
}

/// Launch a long-lived bollard exec that tails the events dir and feeds
/// [`EventsTracker`]. Emits `codehub://agent-event` to the Tauri frontend for
/// each parsed line AND fires OS notifications for real await-input / turn-finish
/// events when the user has enabled them in Settings. Silently exits when the
/// container stops (the caller's lifecycle loop restarts it on the next
/// `ensure_runtime`).
///
/// The `config` store is read at event time (not captured by value) so a
/// notification toggle the user just changed takes effect immediately. Only REAL
/// hook events fire a notification — no synthetic timers.
///
/// The function returns immediately — the reconciler runs in a background spawn
/// on Tauri's managed runtime (the `setup` hook has no entered tokio runtime, so
/// a bare `tokio::spawn` would abort the app — see the CLAUDE.md spawner gotcha).
/// The dev bridge, which runs under `#[tokio::main]`, calls
/// [`reconcile_event_tailers_loop`] directly with `tokio::spawn` and does NOT
/// fire OS notifications.
///
/// Events live in each container's own `/tmp/codehub/events/` (container-local —
/// only `/config` is a shared mount), so the shared runtime tailer alone would
/// miss every per-workspace container. The reconciler fans a tailer out to each
/// live container instead (see [`reconcile_event_tailers_loop`]).
pub fn start_event_tailer(
    manager: Arc<crate::manager::LifecycleManager>,
    tracker: Arc<EventsTracker>,
    config: Arc<crate::config::ConfigStore>,
    app: tauri::AppHandle,
) {
    // Cutoff for OS notifications: only events stamped at/after the tailer starts
    // fire a toast. `tail -F` replays the last lines of each existing event file
    // before following (and does so again on every reconnect), so without this
    // gate app launch or a container restart would re-notify for stale, already
    // resolved permission prompts / turn finishes. In-app state still rebuilds
    // from the full replay — only the OS toast is suppressed for old lines.
    let started_at = now_ms();
    tauri::async_runtime::spawn(reconcile_event_tailers_loop(
        manager,
        tracker,
        move |event| {
            let _ = app.emit("codehub://agent-event", event);
            if event.at >= started_at {
                maybe_notify(&app, &config, event);
            }
        },
    ));
}

/// Interval between fleet reconciliations — how fast a newly-spawned per-workspace
/// container's events start being tailed. Matches the 5s tail-retry cadence.
const RECONCILE_INTERVAL: Duration = Duration::from_secs(5);

/// Fan an [`event_tailer_loop`] out across EVERY live CodeHub container so hook
/// events from per-workspace containers (`codehub-ws-<key>`) reach the same
/// [`EventsTracker`] / sink as the shared runtime's. Each container keeps its
/// events in its own container-local `/tmp/codehub/events/`, so one tailer on the
/// shared runtime would only ever see shared-runtime sessions.
///
/// Reconciles every [`RECONCILE_INTERVAL`]: the target set is the shared runtime
/// (always — it self-heals while down) plus every *running* workspace container
/// (`list_workspace_containers`, which returns empty when the per-workspace flag
/// is off — so this degrades to exactly the old single-tailer behaviour). New
/// containers get a tailer spawned; vanished/stopped ones get theirs aborted.
/// Tailers are keyed by container name and all share the cloned `on_event` sink.
///
/// The caller owns the OUTER spawn (Tauri's runtime vs `tokio` — see
/// [`start_event_tailer`]); the per-container tailers spawned INSIDE run under
/// whichever runtime is already entered by that outer task, so a bare
/// `tokio::spawn` here is safe in both contexts.
pub async fn reconcile_event_tailers_loop<F>(
    manager: Arc<crate::manager::LifecycleManager>,
    tracker: Arc<EventsTracker>,
    on_event: F,
) where
    F: Fn(&AgentEvent) + Send + Sync + Clone + 'static,
{
    // container name → its running tailer task.
    let mut active: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();

    loop {
        // Build the target set: shared runtime first (always tailed — `run_tail`
        // retries harmlessly while it is down), then each running workspace
        // container resolved BY KEY so its dedicated docker client is used.
        let shared = manager.default();
        let mut targets: Vec<(String, Arc<DockerClient>)> = vec![(
            shared.container_name.clone(),
            Arc::new(shared.docker_client()),
        )];
        // A transient daemon error must NOT tear down every per-workspace tailer:
        // an empty fleet would abort them all this cycle (churn) and drop their
        // events until respawn. On error, keep the current `active` set untouched
        // and retry next tick — the shared runtime tailer is unaffected either way.
        let workspaces = match manager.list_workspace_containers().await {
            Ok(list) => list,
            Err(e) => {
                tracing::debug!("fleet list failed ({e}); keeping current tailers");
                tokio::time::sleep(RECONCILE_INTERVAL).await;
                continue;
            },
        };
        for wc in workspaces {
            if wc.status.state == ContainerState::Running {
                let lc = manager.workspace_container(&wc.key);
                targets.push((wc.status.name.clone(), Arc::new(lc.docker_client())));
            }
        }

        // Drop tailers whose container is gone/stopped (frees the bollard exec).
        let wanted: std::collections::HashSet<&String> = targets.iter().map(|(n, _)| n).collect();
        active.retain(|name, handle| {
            let keep = wanted.contains(name);
            if !keep {
                handle.abort();
            }
            keep
        });

        // Spawn a tailer for any newly-seen container.
        for (name, docker) in targets {
            active.entry(name).or_insert_with(|| {
                let tracker = tracker.clone();
                let on_event = on_event.clone();
                tokio::spawn(event_tailer_loop(docker, tracker, on_event))
            });
        }

        tokio::time::sleep(RECONCILE_INTERVAL).await;
    }
}

/// Current wall-clock in epoch milliseconds, matching the `at` field the hook
/// scripts stamp on each event line.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Fire an OS notification for a single agent event when the matching Settings
/// flag is enabled. Honest: only `notification` (permission_prompt → await-input)
/// and `stop` (turn-finish) kinds notify, and only when the user opted in. The
/// session alias would require a registry lookup the sink does not hold, so the
/// body uses the tmux session name — a real identifier, never fabricated.
fn maybe_notify(app: &tauri::AppHandle, config: &crate::config::ConfigStore, event: &AgentEvent) {
    use tauri_plugin_notification::NotificationExt;

    let settings = config.get();

    // Map the normalized event to (enabled?, title). Await-input is a
    // permission_prompt Notification; turn-finish is a Stop.
    let title: Option<&str> = match event.kind.as_str() {
        KIND_NOTIFICATION
            if settings.notify_await_input
                && event.notification_type.as_deref() == Some("permission_prompt") =>
        {
            Some("Agent needs input")
        },
        KIND_STOP if settings.notify_turn_finish => Some("Agent finished"),
        _ => None,
    };

    let Some(title) = title else {
        return;
    };

    let mut builder = app
        .notification()
        .builder()
        .title(title)
        .body(&event.session);
    if settings.play_sound {
        // "default" asks the OS to play its standard notification sound.
        builder = builder.sound("default");
    }
    if let Err(e) = builder.show() {
        tracing::debug!("notification show failed: {e}");
    }
}

/// The retrying event-tailer loop with a caller-supplied per-event sink. Handles
/// a not-yet-ready container or an absent events dir (`tail -F` picks up files as
/// they appear). Transport-agnostic: the Tauri app passes a window-emit sink, the
/// dev bridge a WS-frame sink — one tail implementation, two transports. The
/// caller owns the spawn so each can use the runtime available in its context
/// (see [`start_event_tailer`]).
pub async fn event_tailer_loop<F>(
    docker: Arc<DockerClient>,
    tracker: Arc<EventsTracker>,
    on_event: F,
) where
    F: Fn(&AgentEvent) + Send + Sync + 'static,
{
    loop {
        if let Err(e) = run_tail(&docker, &tracker, &on_event).await {
            tracing::debug!("event tailer stopped ({e}), will retry in 5s");
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

/// One tail attach: drains the events stream until it ends/errors, feeding each
/// parsed line to the `EventsTracker` and handing every resulting `AgentEvent`
/// to `on_event`. Transport-agnostic — the Tauri app emits a window event, the
/// dev bridge forwards a WS frame; both share this body (see `event_tailer_loop`).
async fn run_tail<F: Fn(&AgentEvent)>(
    docker: &DockerClient,
    tracker: &EventsTracker,
    on_event: &F,
) -> Result<(), TailError> {
    // Ensure the events dir exists so the tail script's `cd` succeeds on a
    // brand-new container (the dir is created lazily by the hook on first event).
    // `mkdir -p` + a sentinel `.keep` is idempotent; best-effort — if it fails we
    // still attempt the tail (the script's `cd ... || exit 0` handles absence).
    let _ = docker
        .exec_capture_pub(vec![
            "sh",
            "-c",
            "mkdir -p /tmp/codehub/events && touch /tmp/codehub/events/.keep",
        ])
        .await;

    let exec = docker
        .docker
        .create_exec::<String>(
            &docker.container,
            CreateExecOptions {
                attach_stdout: Some(true),
                attach_stderr: Some(false), // suppress "no files match" noise
                cmd: Some(vec!["sh".into(), "-c".into(), TAIL_SCRIPT.into()]),
                env: Some(vec!["TMUX_TMPDIR=/tmp/codehub".into()]),
                ..Default::default()
            },
        )
        .await?;

    let started = docker
        .docker
        .start_exec(
            &exec.id,
            Some(StartExecOptions {
                detach: false,
                ..Default::default()
            }),
        )
        .await?;

    if let StartExecResults::Attached { mut output, .. } = started {
        let mut buf = String::new();
        while let Some(chunk) = output.next().await {
            match chunk {
                Ok(
                    bollard::container::LogOutput::StdOut { message }
                    | bollard::container::LogOutput::Console { message },
                ) => {
                    buf.push_str(&String::from_utf8_lossy(&message));
                    // Process complete lines.
                    while let Some(nl) = buf.find('\n') {
                        let line = buf[..nl].trim().to_string();
                        let _ = buf.drain(..=nl);
                        if line.is_empty() {
                            continue;
                        }
                        // tail -F emits "==> filename <==" headers; skip them.
                        if line.starts_with("==>") {
                            continue;
                        }
                        if let Some(event) = tracker.ingest(&line) {
                            on_event(&event);
                        }
                    }
                },
                Err(e) => {
                    return Err(Box::new(e));
                },
                _ => {},
            }
        }
    }

    Ok(())
}

// ── Accept/deny keystrokes per CLI ──────────────────────────────────────────
// Provisional per §7.6 (unverified — confirmed once a real permission gate fires
// with auth). These fire via `pty_write` to the session's pane (same transport
// as broadcast).

/// The keystroke(s) to approve a permission prompt for the given CLI binary.
/// Returns `None` for CLIs whose keystroke is unknown (e.g. antigravity).
pub fn accept_keystroke(cli_binary: &str) -> Option<&'static str> {
    match cli_binary {
        "claude" => Some("y\n"), // Claude Code: "y" + Enter to allow
        "codex" => Some("y\n"),  // Codex: "y" + Enter (provisional)
        _ => None,
    }
}

/// The keystroke(s) to deny a permission prompt for the given CLI binary.
pub fn deny_keystroke(cli_binary: &str) -> Option<&'static str> {
    match cli_binary {
        "claude" => Some("n\n"), // Claude Code: "n" + Enter to deny
        "codex" => Some("n\n"),  // Codex: "n" + Enter (provisional)
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_line(session: &str, kind: &str, notif_type: Option<&str>, msg: Option<&str>) -> String {
        let nt = notif_type
            .map(|t| format!(r#","notification_type":"{t}""#))
            .unwrap_or_default();
        let m = msg
            .map(|t| format!(r#","message":"{t}""#))
            .unwrap_or_default();
        format!(r#"{{"session":"{session}","kind":"{kind}","at":1000{nt}{m}}}"#)
    }

    #[test]
    fn permission_prompt_sets_pending() {
        let tracker = EventsTracker::new();
        let line = mk_line(
            "s1",
            "Notification",
            Some("permission_prompt"),
            Some("Allow?"),
        );
        let ev = tracker.ingest(&line).unwrap();
        assert_eq!(ev.kind, "notification");
        assert_eq!(ev.session, "s1");
        let pending = tracker.pending_prompts();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].session, "s1");
        assert_eq!(pending[0].message.as_deref(), Some("Allow?"));
    }

    #[test]
    fn idle_notification_does_not_set_pending() {
        let tracker = EventsTracker::new();
        let line = mk_line("s1", "Notification", Some("idle_prompt"), None);
        tracker.ingest(&line);
        assert!(tracker.pending_prompts().is_empty());
    }

    #[test]
    fn stop_clears_pending() {
        let tracker = EventsTracker::new();
        tracker.ingest(&mk_line(
            "s1",
            "Notification",
            Some("permission_prompt"),
            None,
        ));
        assert_eq!(tracker.pending_prompts().len(), 1);
        tracker.ingest(&mk_line("s1", "Stop", None, None));
        assert!(tracker.pending_prompts().is_empty());
    }

    #[test]
    fn activity_history_accumulates() {
        let tracker = EventsTracker::new();
        tracker.ingest(&mk_line("s1", "UserPromptSubmit", None, None));
        tracker.ingest(&mk_line("s1", "PreToolUse", None, None));
        tracker.ingest(&mk_line("s1", "Stop", None, None));
        let hist = tracker.activity_history(Some("s1"));
        assert_eq!(hist.len(), 3);
        assert_eq!(hist[0].kind, "prompt_submit");
        assert_eq!(hist[1].kind, "pre_tool");
        assert_eq!(hist[2].kind, "stop");
    }

    #[test]
    fn activity_history_none_returns_all_sessions_chronological() {
        let tracker = EventsTracker::new();
        // s2 event is timestamped earlier than s1.
        let line_s2 = r#"{"session":"s2","kind":"Stop","at":500}"#;
        let line_s1 = r#"{"session":"s1","kind":"Stop","at":1000}"#;
        tracker.ingest(line_s2);
        tracker.ingest(line_s1);
        let all = tracker.activity_history(None);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].at, 500);
        assert_eq!(all[1].at, 1000);
    }

    #[test]
    fn clear_pending_removes_entry() {
        let tracker = EventsTracker::new();
        tracker.ingest(&mk_line(
            "s1",
            "Notification",
            Some("permission_prompt"),
            None,
        ));
        tracker.clear_pending("s1");
        assert!(tracker.pending_prompts().is_empty());
    }

    #[test]
    fn unknown_kind_is_skipped() {
        let tracker = EventsTracker::new();
        let line = r#"{"session":"s1","kind":"UnknownFutureEvent","at":1000}"#;
        assert!(tracker.ingest(line).is_none());
    }

    #[test]
    fn malformed_line_is_skipped() {
        let tracker = EventsTracker::new();
        assert!(tracker.ingest("not json").is_none());
        assert!(tracker.ingest("").is_none());
    }

    #[test]
    fn accept_deny_keystrokes() {
        assert_eq!(accept_keystroke("claude"), Some("y\n"));
        assert_eq!(deny_keystroke("claude"), Some("n\n"));
        assert_eq!(accept_keystroke("codex"), Some("y\n"));
        assert!(accept_keystroke("antigravity").is_none());
    }
}
