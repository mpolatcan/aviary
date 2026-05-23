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
    /// Hub main-region layout: "tabs" (per-workspace split grid) | "grid" (2×2
    /// compare grid tiling every live session). Persisted so the chosen layout
    /// survives a reload.
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

    // — Notifications (consumed by the desktop-notification work) —
    #[serde(default = "default_true")]
    pub notify_await_input: bool,
    #[serde(default)]
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
}
