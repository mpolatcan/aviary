//! Persistent app settings — the "Tier-2 config store" referenced throughout
//! the codebase. A single JSON file (`settings.json`) in the app-data dir,
//! loaded once at startup and written through on every change.
//!
//! These are CodeHub UI preferences, deliberately separate from the runtime
//! container's `config/` mount (agent auth lives there, owned by the CLIs).
//! Every field carries a `#[serde(default)]` so an older or hand-edited file
//! that is missing keys still loads — unknown keys are ignored, missing ones
//! fall back to the default.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

fn default_font_size() -> u16 {
    13
}
fn default_density() -> String {
    "comfortable".into()
}
fn default_agent() -> String {
    "claude".into()
}
fn default_hub_layout() -> String {
    "tabs".into()
}
fn default_true() -> bool {
    true
}

/// A named account a session can launch under. **Label-only — no secret is ever
/// stored here.** `var_name` is the NAME of a host environment variable that
/// holds that account's credential (e.g. `CLAUDE_CODE_OAUTH_TOKEN` for the
/// default, or `CLAUDE_TOKEN_WORK` for a second login the user exports). The
/// value lives only in the host environment; CodeHub forwards it into the
/// container at create-time and remaps the CLI's canonical var by NAME per
/// session (see `docker::DockerClient::create_tmux_session`), so the secret never
/// reaches a command line, log, or `docker top`. This honors the env-only
/// credential decision recorded in BACKEND_PLAN.md.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfile {
    /// Stable opaque id (generated on add); used to select the profile at spawn.
    pub id: String,
    /// Which agent this account is for: "claude" | "codex" | "antigravity".
    pub agent: String,
    /// Human label shown in the spawn dialog (e.g. "Work", "Personal").
    pub label: String,
    /// NAME of the host env var holding the credential. Never the value.
    pub var_name: String,
}

/// An account profile plus whether its host env var is currently present.
/// Presence-only (`std::env::var(..).is_ok()`) — the value is NEVER read,
/// returned, or logged, exactly like `lifecycle::agent_key_status`.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfileStatus {
    pub id: String,
    pub agent: String,
    pub label: String,
    /// NAME of the host env var holding the credential. Never the value.
    pub var_name: String,
    /// Whether that env var is present on the host right now.
    pub present: bool,
}

/// Map stored profiles to their live presence status. Presence probe only —
/// `is_ok()` never binds the secret value.
pub fn profile_statuses(profiles: Vec<AccountProfile>) -> Vec<AccountProfileStatus> {
    profiles
        .into_iter()
        .map(|p| {
            let present = std::env::var(&p.var_name).is_ok();
            AccountProfileStatus {
                id: p.id,
                agent: p.agent,
                label: p.label,
                var_name: p.var_name,
                present,
            }
        })
        .collect()
}

/// A user-saved workspace shown on the Welcome launcher: a named pointer to a
/// host repo directory. Opening one creates/ensures a per-workspace container
/// (`codehub-ws-<key>`) with `/workspace` bound to its `dir` and starts a tab.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedWorkspace {
    /// Stable opaque id (generated on create).
    pub id: String,
    /// Human name shown on the launcher card.
    pub name: String,
    /// Host directory bound at `/workspace` when this workspace is opened.
    pub dir: String,
    /// Pinned to the top of the launcher.
    #[serde(default)]
    pub pinned: bool,
    /// Epoch-ms of the last time it was opened (`None` = not opened since saved).
    #[serde(default)]
    pub last_opened: Option<i64>,
}

/// All persisted preferences. Serialized to the frontend (and the dev bridge) as
/// camelCase to match the rest of the IPC surface.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    // — Appearance —
    /// xterm font size in px, applied to every pane.
    #[serde(default = "default_font_size")]
    pub terminal_font_size: u16,
    /// "comfortable" | "compact" (consumed once the compact layout pass lands).
    #[serde(default = "default_density")]
    pub density: String,
    /// Hub main-region layout, historically "tabs" | "grid". The grid (compare)
    /// layout + its toggle were removed in the design-fidelity pass, so the UI no
    /// longer reads this — but it is RETAINED to keep the wholesale config
    /// round-trip intact for users who already have it in settings.json. Do not
    /// delete (that would drop the key on read-modify-write); reuse it if a layout
    /// choice returns.
    #[serde(default = "default_hub_layout")]
    pub hub_layout: String,

    // — General —
    /// Ask before ⌘W / the close button kills a session whose agent is working.
    #[serde(default = "default_true")]
    pub confirm_close_running_agent: bool,
    /// Reattach to surviving tmux sessions on launch (consumed by boot lifecycle).
    #[serde(default = "default_true")]
    pub restore_sessions_on_launch: bool,
    /// Reopen the last active workspace tab on launch.
    #[serde(default = "default_true")]
    pub reopen_last_workspace: bool,

    // — Agent defaults —
    /// CLI pre-selected in the launcher (⌘N). One of the `Cli` ids.
    #[serde(default = "default_agent")]
    pub default_agent: String,

    // — Workspace (Tier-2 repo picker) —
    /// Host directory bind-mounted at `/workspace`. `None` → the built-in
    /// per-user default (`app_data/workspace`). Changing it requires recreating
    /// the runtime container (the mount source is fixed at create-time), surfaced
    /// in the UI as a "restart runtime to apply" affordance.
    #[serde(default)]
    pub workspace_dir: Option<String>,
    /// Recently-selected workspace directories (MRU, newest first, capped).
    #[serde(default)]
    pub recent_workspaces: Vec<String>,
    /// User-saved workspaces shown on the Welcome launcher (name + dir pointers;
    /// the container is always the shared runtime). Mutated through `set_config`.
    #[serde(default)]
    pub saved_workspaces: Vec<SavedWorkspace>,

    // — Accounts (Tier-3, label-only — no secrets stored, see AccountProfile) —
    /// Named per-agent accounts the spawn dialog offers. Each maps to a host
    /// env var NAME, never a credential value.
    #[serde(default)]
    pub account_profiles: Vec<AccountProfile>,

    // — Notifications (consumed by the desktop-notification work) —
    #[serde(default = "default_true")]
    pub notify_await_input: bool,
    #[serde(default = "default_true")]
    pub notify_turn_finish: bool,
    #[serde(default)]
    pub play_sound: bool,
}

impl Default for Settings {
    fn default() -> Self {
        // Route through serde so the defaults live in exactly one place.
        serde_json::from_str("{}").expect("empty object yields defaults")
    }
}

/// Thread-safe, write-through settings store backed by a JSON file.
pub struct ConfigStore {
    path: PathBuf,
    inner: Mutex<Settings>,
}

impl ConfigStore {
    /// Load from `path`, falling back to defaults when the file is absent or
    /// unparseable (a corrupt file should never block startup).
    pub fn load(path: PathBuf) -> Self {
        let inner = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| match serde_json::from_str::<Settings>(&s) {
                Ok(cfg) => Some(cfg),
                Err(e) => {
                    tracing::warn!("settings.json unparseable ({e}); using defaults");
                    None
                },
            })
            .unwrap_or_default();
        Self {
            path,
            inner: Mutex::new(inner),
        }
    }

    /// Current settings snapshot.
    pub fn get(&self) -> Settings {
        self.inner.lock().expect("config mutex").clone()
    }

    /// Replace the whole settings object: persist to disk first, then update the
    /// in-memory cache so a failed write leaves the cache untouched.
    pub fn set(&self, next: Settings) -> Result<Settings, String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, json).map_err(|e| e.to_string())?;
        *self.inner.lock().expect("config mutex") = next.clone();
        Ok(next)
    }

    /// Record the chosen workspace directory and bump it to the front of the MRU
    /// recents list (deduped, capped). Persists and returns the full settings.
    /// Caller is responsible for validating the path exists.
    pub fn set_workspace_dir(&self, dir: String) -> Result<Settings, String> {
        let mut next = self.get();
        next.recent_workspaces.retain(|p| p != &dir);
        next.recent_workspaces.insert(0, dir.clone());
        next.recent_workspaces.truncate(MAX_RECENT_WORKSPACES);
        next.workspace_dir = Some(dir);
        self.set(next)
    }

    /// Append a label-only account profile (no secret) and persist.
    pub fn add_account_profile(&self, profile: AccountProfile) -> Result<Settings, String> {
        let mut next = self.get();
        next.account_profiles.push(profile);
        self.set(next)
    }

    /// Remove the account profile with `id` and persist. Removing a missing id is
    /// a no-op (still re-persists for idempotency).
    pub fn remove_account_profile(&self, id: &str) -> Result<Settings, String> {
        let mut next = self.get();
        next.account_profiles.retain(|p| p.id != id);
        self.set(next)
    }
}

/// Cap on the MRU workspace-recents list.
const MAX_RECENT_WORKSPACES: usize = 8;
