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

        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
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
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
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
        let map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
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
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(state) = map.get_mut(session) {
            state.pending = None;
        }
    }

    /// Remove all state for a session (called when the session is killed).
    pub fn remove_session(&self, session: &str) {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(session);
    }
}

/// Launch a long-lived bollard exec that tails the events dir and feeds
/// [`EventsTracker`]. Emits `codehub://agent-event` to the Tauri frontend for
/// each parsed line. Silently exits when the container stops (the caller's
/// lifecycle loop restarts it on the next `ensure_runtime`).
///
/// The function returns immediately — the tail runs in a background `tokio::spawn`.
pub fn start_event_tailer(
    docker: Arc<DockerClient>,
    tracker: Arc<EventsTracker>,
    app: tauri::AppHandle,
) {
    tokio::spawn(async move {
        // Retry loop: on any error, wait briefly and try again. This handles
        // the case where the container isn't ready yet or the events dir doesn't
        // exist (tail -F creates the watch as soon as the file appears).
        loop {
            if let Err(e) = run_tail(docker.clone(), tracker.clone(), &app).await {
                tracing::debug!("event tailer stopped ({e}), will retry in 5s");
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}

async fn run_tail(
    docker: Arc<DockerClient>,
    tracker: Arc<EventsTracker>,
    app: &tauri::AppHandle,
) -> Result<(), TailError> {
    // Ensure the events dir exists before tailing so tail -F doesn't error on
    // an absent glob. `mkdir -p` + a sentinel `.keep` file is idempotent.
    // Best-effort: if this fails we still attempt the tail.
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
                cmd: Some(vec![
                    // Use sh -c so the glob expands inside the container, and
                    // `-F` keeps watching new files that arrive after startup.
                    "sh".into(),
                    "-c".into(),
                    "tail -F /tmp/codehub/events/.keep /tmp/codehub/events/*.jsonl 2>/dev/null"
                        .into(),
                ]),
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
                            let _ = app.emit("codehub://agent-event", &event);
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
