//! Shared IPC response types for the Phase-0 completion contract
//! (COMPLETION_PLAN.md §3.2).
//!
//! Defined here (rather than in lib.rs) so both `lib.rs` (Tauri commands) and
//! `events.rs` (hook subsystem) can import them without circular dependency.
//! `devserver.rs` already imports them from `crate::` — it now gets them via
//! `crate::types::*`, re-exported from `crate::` by `lib.rs`.

use serde::Serialize;

/// A session currently awaiting user input (← agent-native hooks, §7).
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PendingPrompt {
    pub session: String,
    pub message: Option<String>,
    /// Unix epoch ms the prompt was raised.
    pub since: i64,
}

/// One entry in a session's activity/turn history ring buffer.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEvent {
    pub session: String,
    /// Normalized event kind (matches AgentEventKind in ipc.ts).
    pub kind: String,
    /// Unix epoch ms the event was observed.
    pub at: i64,
    pub message: Option<String>,
}

/// Live agent-native hook event (Claude `hooks` / Codex `notify`), normalized.
/// Emitted as `codehub://agent-event`.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub session: String,
    pub kind: String,
    pub at: i64,
    pub message: Option<String>,
    pub notification_type: Option<String>,
    pub tool_name: Option<String>,
}

/// Codex token split (cached-input + reasoning-output reported separately).
#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexTokenTotals {
    pub input: u64,
    pub cached_input: u64,
    pub output: u64,
    pub reasoning_output: u64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelUsage {
    pub model: String,
    pub totals: CodexTokenTotals,
    pub turns: u64,
    pub est_cost_usd: f64,
    pub priced: bool,
}

/// One day's Codex usage rollup.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodexDayUsage {
    pub date: String,
    pub totals: CodexTokenTotals,
    pub est_cost_usd: f64,
}

/// Per-model rate table entry for Codex (mirrors Claude's ModelRate).
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelRate {
    pub family: String,
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
}

/// Aggregate Codex token analytics — mirrors the claude* usage surface.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsage {
    pub sessions: u64,
    pub turns: u64,
    pub totals: CodexTokenTotals,
    pub est_cost_usd: f64,
    pub by_model: Vec<CodexModelUsage>,
    pub by_day: Vec<CodexDayUsage>,
    pub rates: Vec<CodexModelRate>,
    pub rates_as_of: String,
    pub unpriced_tokens: u64,
}

/// One past Codex conversation from its rollout file (Resume view).
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodexSession {
    pub id: String,
    pub title: String,
    pub branch: Option<String>,
    pub started: String,
    pub last_active: String,
    pub turns: u64,
    pub model: Option<String>,
    pub version: Option<String>,
}

/// Live per-session Codex tally from its rollout file.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodexSessionUsage {
    pub turns: u64,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub edits: u64,
    pub context_used: u64,
}

/// Codex rate-limit / plan meters (the on-disk quota source). Every field
/// nullable → em-dash when absent.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateLimits {
    pub primary_used_pct: Option<f64>,
    pub primary_window_minutes: Option<u64>,
    pub primary_resets_at: Option<String>,
    pub secondary_used_pct: Option<f64>,
    pub secondary_window_minutes: Option<u64>,
    pub secondary_resets_at: Option<String>,
    pub plan_type: Option<String>,
}

/// GitHub connection (Integrations). Presence-only auth — the token value is
/// NEVER read or returned.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    pub connected: bool,
    pub var_name: String,
    pub login: Option<String>,
    pub scopes: Vec<String>,
    pub token_expiry: Option<String>,
}

/// One repo visible to the connected GitHub account.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepo {
    pub name_with_owner: String,
    pub default_branch: Option<String>,
    pub open_prs: Option<u64>,
    pub private: bool,
}

/// App update check (Settings → About). `available` null when up to date.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current: String,
    pub available: Option<String>,
    pub notes: Option<String>,
}
