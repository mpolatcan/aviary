//! Per-session activity signal, derived from pane output flow + hook events.
//!
//! The output-flow signal (bytes from the pty pump) gives coarse working/idle.
//! The hook-driven `SessionStatus` (set by events.rs from agent-native hooks)
//! adds richer states: Awaiting, Done, Failed. Both are real observations —
//! nothing is fabricated.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

/// A session is "working" while output arrived within this window, else "idle".
const WORKING_GRACE_MS: u64 = 1500;

/// Coarse, observable activity state from output flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityState {
    Working,
    Idle,
}

/// Richer session lifecycle status, driven by agent-native hook events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    #[default]
    Running,
    Idle,
    Awaiting,
    Done,
    Failed,
}

/// One session's activity snapshot as the frontend sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionActivity {
    pub session: String,
    pub state: ActivityState,
    pub idle_ms: u64,
    pub bytes: u64,
    pub cli: Option<String>,
    pub alias: Option<String>,
    pub claude_id: Option<String>,
    pub task_description: Option<String>,
    pub turn_elapsed_ms: Option<u64>,
    pub session_status: SessionStatus,
    pub failure_reason: Option<String>,
    pub git_branch: Option<String>,
}

#[derive(Default)]
struct Entry {
    last_output: Option<Instant>,
    bytes: u64,
    cli: Option<String>,
    alias: Option<String>,
    claude_id: Option<String>,
    task_description: Option<String>,
    turn_started_at: Option<Instant>,
    session_status: SessionStatus,
    failure_reason: Option<String>,
    git_branch: Option<String>,
}

/// Shared, in-memory per-session activity tracker.
#[derive(Default)]
pub struct ActivityTracker {
    inner: Mutex<HashMap<String, Entry>>,
}

impl ActivityTracker {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock_inner(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Record output bytes. Tracks turn start on idle→working transition.
    pub fn mark(&self, session: &str, len: usize) {
        let mut map = self.lock_inner();
        let entry = map.entry(session.to_string()).or_default();
        let was_idle = entry
            .last_output
            .map(|t| t.elapsed().as_millis() as u64 >= WORKING_GRACE_MS)
            .unwrap_or(true);
        entry.last_output = Some(Instant::now());
        entry.bytes = entry.bytes.saturating_add(len as u64);
        if was_idle {
            entry.turn_started_at = Some(Instant::now());
        }
    }

    /// Attach agent identity at session creation.
    pub fn register(
        &self,
        session: &str,
        cli: &str,
        alias: &str,
        claude_id: Option<&str>,
        git_branch: Option<&str>,
        task_description: Option<&str>,
    ) {
        let mut map = self.lock_inner();
        let entry = map.entry(session.to_string()).or_default();
        entry.cli = Some(cli.to_string());
        entry.alias = Some(alias.to_string());
        entry.claude_id = claude_id.map(|s| s.to_string());
        entry.git_branch = git_branch.map(|s| s.to_string());
        entry.task_description = task_description.map(|s| s.to_string());
    }

    /// Update session status from hook events.
    pub fn set_status(&self, session: &str, status: SessionStatus, reason: Option<String>) {
        let mut map = self.lock_inner();
        if let Some(entry) = map.get_mut(session) {
            entry.session_status = status;
            if reason.is_some() {
                entry.failure_reason = reason;
            }
        }
    }

    /// Forget a session.
    pub fn remove(&self, session: &str) {
        self.lock_inner().remove(session);
    }

    /// Current activity for every tracked session.
    pub fn snapshot(&self) -> Vec<SessionActivity> {
        let now = Instant::now();
        self.lock_inner()
            .iter()
            .map(|(session, e)| {
                let idle_ms = e
                    .last_output
                    .map(|t| now.duration_since(t).as_millis() as u64)
                    .unwrap_or(0);
                let state = if e.last_output.is_some() && idle_ms < WORKING_GRACE_MS {
                    ActivityState::Working
                } else {
                    ActivityState::Idle
                };
                let turn_elapsed_ms = e
                    .turn_started_at
                    .map(|t| now.duration_since(t).as_millis() as u64);
                SessionActivity {
                    session: session.clone(),
                    state,
                    idle_ms,
                    bytes: e.bytes,
                    cli: e.cli.clone(),
                    alias: e.alias.clone(),
                    claude_id: e.claude_id.clone(),
                    task_description: e.task_description.clone(),
                    turn_elapsed_ms,
                    session_status: e.session_status,
                    failure_reason: e.failure_reason.clone(),
                    git_branch: e.git_branch.clone(),
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;
    use std::time::Duration;

    #[test]
    fn fresh_output_is_working() {
        let t = ActivityTracker::new();
        t.mark("s1", 10);
        let snap = t.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].state, ActivityState::Working);
        assert_eq!(snap[0].bytes, 10);
        assert!(snap[0].idle_ms < WORKING_GRACE_MS);
    }

    #[test]
    fn bytes_accumulate_across_marks() {
        let t = ActivityTracker::new();
        t.mark("s1", 10);
        t.mark("s1", 5);
        assert_eq!(t.snapshot()[0].bytes, 15);
    }

    #[test]
    fn goes_idle_after_grace_window() {
        let t = ActivityTracker::new();
        t.mark("s1", 1);
        sleep(Duration::from_millis(WORKING_GRACE_MS + 200));
        let snap = t.snapshot();
        assert_eq!(snap[0].state, ActivityState::Idle);
        assert!(snap[0].idle_ms >= WORKING_GRACE_MS);
    }

    #[test]
    fn remove_drops_the_session() {
        let t = ActivityTracker::new();
        t.mark("s1", 1);
        t.remove("s1");
        assert!(t.snapshot().is_empty());
    }

    #[test]
    fn register_attaches_identity_and_survives_output() {
        let t = ActivityTracker::new();
        t.register("s1", "claude", "Claude 1", Some("abc-123"), None, None);
        t.mark("s1", 7);
        let snap = t.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].cli.as_deref(), Some("claude"));
        assert_eq!(snap[0].alias.as_deref(), Some("Claude 1"));
        assert_eq!(snap[0].claude_id.as_deref(), Some("abc-123"));
        assert_eq!(snap[0].bytes, 7);
        assert_eq!(snap[0].state, ActivityState::Working);
    }

    #[test]
    fn registered_but_silent_session_is_idle() {
        let t = ActivityTracker::new();
        t.register("s1", "codex", "Codex 1", None, None, None);
        let snap = t.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].state, ActivityState::Idle);
        assert_eq!(snap[0].idle_ms, 0);
        assert_eq!(snap[0].bytes, 0);
        assert_eq!(snap[0].alias.as_deref(), Some("Codex 1"));
        assert_eq!(snap[0].claude_id, None);
    }

    #[test]
    fn set_status_updates_session() {
        let t = ActivityTracker::new();
        t.register("s1", "claude", "Claude 1", None, None, None);
        t.set_status("s1", SessionStatus::Awaiting, None);
        assert_eq!(t.snapshot()[0].session_status, SessionStatus::Awaiting);
        t.set_status("s1", SessionStatus::Failed, Some("OOM".into()));
        let snap = t.snapshot();
        assert_eq!(snap[0].session_status, SessionStatus::Failed);
        assert_eq!(snap[0].failure_reason.as_deref(), Some("OOM"));
    }

    #[test]
    fn turn_elapsed_tracks_working_transition() {
        let t = ActivityTracker::new();
        t.mark("s1", 1);
        let snap = t.snapshot();
        assert!(snap[0].turn_elapsed_ms.is_some());
        assert!(snap[0].turn_elapsed_ms.unwrap() < 100);
    }

    #[test]
    fn register_with_branch_and_task() {
        let t = ActivityTracker::new();
        t.register(
            "s1",
            "claude",
            "Claude 1",
            None,
            Some("feat/auth"),
            Some("Fix login"),
        );
        let snap = t.snapshot();
        assert_eq!(snap[0].git_branch.as_deref(), Some("feat/auth"));
        assert_eq!(snap[0].task_description.as_deref(), Some("Fix login"));
    }
}
