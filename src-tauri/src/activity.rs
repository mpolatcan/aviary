//! Per-session activity signal, derived from pane output flow.
//!
//! This is the honest, CLI-agnostic foundation for "what is each agent doing
//! right now". The agent TUIs (Claude Code / Codex / Antigravity) stream output
//! continuously while they work — thinking spinners, token streaming, tool
//! output all produce bytes — and fall quiet when they finish a turn or wait for
//! input. So the presence of recent output is a robust proxy for "working", and
//! its absence for "idle/quiet", WITHOUT parsing any CLI-specific format.
//!
//! What this deliberately does NOT claim: it cannot tell *idle* apart from
//! *waiting-for-approval* apart from *done* (all three are simply "quiet"), and
//! it does not extract tokens / cost / turn counts — those live only inside each
//! CLI's own session and would need a per-CLI parser or the CLI's session files
//! (a separate effort; see BACKEND_PLAN.md). A TUI that animates while genuinely
//! idle could read as "working"; that is the known limit of an output-flow
//! signal and is preferred over fabricating a richer state we cannot observe.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

/// A session is "working" while output arrived within this window, else "idle".
/// Sized to bridge the normal gaps between a TUI's repaints during a turn
/// without latching on so long that a finished turn keeps reading as working.
const WORKING_GRACE_MS: u64 = 1500;

/// Coarse, observable activity state. Intentionally only two values — see the
/// module note on why we don't fabricate approve/done/error here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityState {
    /// Output arrived within the grace window — the agent is producing.
    Working,
    /// No output for longer than the grace window — quiet (idle / waiting / done).
    Idle,
}

/// One session's activity, as the frontend sees it. `idleMs` is how long since
/// the last output byte (0 while actively producing, or before any output);
/// `bytes` is the total output observed for the session since attach (a cheap,
/// real throughput hint). `cli` / `alias` are the agent identity registered at
/// session creation — they let a satellite view (the always-on-top companion,
/// which runs in its own webview and cannot read the main store) render the
/// agent glyph + name without re-deriving them. `claudeId` is the Claude
/// `--session-id` (or resumed id) the session launched with, so that satellite
/// view can read this session's own transcript for a live token tally
/// (`claude_session_usage`) — `None` for non-Claude agents. All `Option` so an
/// entry created by output before any label is registered still serializes
/// honestly.
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
}

#[derive(Default)]
struct Entry {
    /// `None` until the first output byte — a session can be registered (created)
    /// before it has produced anything, and that pre-output window reads as idle.
    last_output: Option<Instant>,
    bytes: u64,
    cli: Option<String>,
    alias: Option<String>,
    claude_id: Option<String>,
}

/// Shared, in-memory per-session activity. Fed from the pty output pump (via
/// [`mark`](ActivityTracker::mark)) and read by the `session_activity` command.
/// Uses a std `Mutex` because every critical section is a tiny synchronous map
/// op with no `.await` held across the lock.
#[derive(Default)]
pub struct ActivityTracker {
    inner: Mutex<HashMap<String, Entry>>,
}

impl ActivityTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record `len` output bytes for `session` at the current instant. Creates
    /// the entry on first output. A poisoned lock is recovered (the data is
    /// plain counters — a panic mid-update can't leave it logically corrupt).
    pub fn mark(&self, session: &str, len: usize) {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.entry(session.to_string()).or_default();
        entry.last_output = Some(Instant::now());
        entry.bytes = entry.bytes.saturating_add(len as u64);
    }

    /// Attach the agent identity (cli + display alias, and the Claude transcript
    /// id for Claude sessions) to a session. Called when the session is created
    /// so the activity snapshot can carry who each session is — not just its tmux
    /// name — and, for Claude, which transcript holds its live token tally.
    /// Pre-creates an idle entry if output hasn't started yet, so a freshly
    /// spawned agent shows up immediately.
    pub fn register(&self, session: &str, cli: &str, alias: &str, claude_id: Option<&str>) {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.entry(session.to_string()).or_default();
        entry.cli = Some(cli.to_string());
        entry.alias = Some(alias.to_string());
        entry.claude_id = claude_id.map(|s| s.to_string());
    }

    /// Forget a session (its tmux session was killed / pane detached). Keeps the
    /// snapshot from reporting activity for sessions that no longer exist.
    pub fn remove(&self, session: &str) {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(session);
    }

    /// Current activity for every tracked session, state derived at read time.
    pub fn snapshot(&self) -> Vec<SessionActivity> {
        let now = Instant::now();
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(session, e)| {
                // No output yet → idle, idle_ms 0 (unknown rather than fabricated).
                let idle_ms = e
                    .last_output
                    .map(|t| now.duration_since(t).as_millis() as u64)
                    .unwrap_or(0);
                let state = if e.last_output.is_some() && idle_ms < WORKING_GRACE_MS {
                    ActivityState::Working
                } else {
                    ActivityState::Idle
                };
                SessionActivity {
                    session: session.clone(),
                    state,
                    idle_ms,
                    bytes: e.bytes,
                    cli: e.cli.clone(),
                    alias: e.alias.clone(),
                    claude_id: e.claude_id.clone(),
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
        t.register("s1", "claude", "Claude 1", Some("abc-123"));
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
        // A non-Claude agent registers no transcript id.
        t.register("s1", "codex", "Codex 1", None);
        let snap = t.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].state, ActivityState::Idle);
        assert_eq!(snap[0].idle_ms, 0);
        assert_eq!(snap[0].bytes, 0);
        assert_eq!(snap[0].alias.as_deref(), Some("Codex 1"));
        assert_eq!(snap[0].claude_id, None);
    }
}
