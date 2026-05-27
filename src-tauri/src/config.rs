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
use std::collections::HashMap;
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
fn default_character() -> String {
    "glyph".into()
}
fn default_companion_size() -> String {
    "M".into()
}

/// Where an account profile's credential lives.
///
/// - `Env`: credential comes from a host environment variable by NAME (the
///   legacy model — CodeHub never stores the value, only forwards it).
/// - `Vault`: credential stored in the OS keychain, keyed by the profile's id.
///   CodeHub reads it from the vault at container-create time and injects it as
///   an env var.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "source", rename_all = "camelCase")]
pub enum CredentialSource {
    /// Credential from a host env var (NAME only, never value).
    #[serde(rename = "env")]
    Env {
        #[serde(rename = "varName")]
        var_name: String,
    },
    /// Credential stored in the OS keychain vault.
    #[serde(rename = "vault")]
    Vault,
}

/// A named account a session can launch under. Supports two credential models:
///
/// 1. **Env-backed** (legacy): `var_name` is the NAME of a host env var.
///    CodeHub forwards the value into the container but never stores it.
/// 2. **Vault-backed** (new): the secret lives in the OS keychain, keyed by
///    the profile id. CodeHub reads it at container-create time.
///
/// The `credential` field is a tagged union that serializes as `{ "source":
/// "env", "varName": "..." }` or `{ "source": "vault" }`, flattened into the
/// profile object.
///
/// **Backward compat**: old settings.json files have `{ "varName": "..." }`
/// without a `source` field. The custom `Deserialize` impl below handles this
/// by treating profiles with `varName` but no `source` as `Env`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfile {
    pub id: String,
    /// "claude" | "codex" | "antigravity" | "github".
    pub agent: String,
    pub label: String,
    #[serde(flatten)]
    pub credential: CredentialSource,
}

impl AccountProfile {
    pub fn var_name(&self) -> Option<&str> {
        match &self.credential {
            CredentialSource::Env { var_name } => Some(var_name),
            CredentialSource::Vault => None,
        }
    }

    pub fn is_vault(&self) -> bool {
        matches!(self.credential, CredentialSource::Vault)
    }
}

/// Shell-safe env var used to carry one vault-backed profile into a tmux pane.
/// Profile ids are UUIDs with hyphens, so they cannot be used verbatim in
/// `${VAR}` expansions.
pub fn vault_env_name(profile_id: &str) -> String {
    let mut out = String::from("CODEHUB_VAULT_");
    for c in profile_id.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_uppercase());
        } else {
            out.push('_');
        }
    }
    if out == "CODEHUB_VAULT_" {
        out.push_str("PROFILE");
    }
    out
}

/// Custom deserializer for backward compatibility. Old format:
/// `{ "id": "...", "agent": "...", "label": "...", "varName": "..." }`
/// New format adds `"source": "env"` or `"source": "vault"`.
/// If `source` is absent but `varName` is present → `Env`.
impl<'de> Deserialize<'de> for AccountProfile {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = serde_json::Value::deserialize(d)?;
        let obj = v
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("expected object"))?;

        let id = obj
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let agent = obj
            .get("agent")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let label = obj
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let credential = match obj.get("source").and_then(|v| v.as_str()) {
            Some("vault") => CredentialSource::Vault,
            Some("env") | None => {
                let var_name = obj
                    .get("varName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                CredentialSource::Env { var_name }
            },
            Some(other) => {
                return Err(serde::de::Error::custom(format!("unknown source: {other}")));
            },
        };

        Ok(AccountProfile {
            id,
            agent,
            label,
            credential,
        })
    }
}

/// An account profile plus live presence status.
/// For env-backed: whether the host env var is present.
/// For vault-backed: whether the keychain entry exists.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfileStatus {
    pub id: String,
    pub agent: String,
    pub label: String,
    /// "env" | "vault".
    pub source: String,
    /// NAME of the host env var (env-backed only; null for vault).
    pub var_name: Option<String>,
    /// Whether the credential is available right now.
    pub present: bool,
}

/// Map stored profiles to their live presence status.
/// For env-backed: presence-probes the host env var (value never bound).
/// For vault-backed: checks keychain metadata without reading the secret, so
/// missing profiles can be shown accurately without prompting for access.
pub fn profile_statuses(
    profiles: Vec<AccountProfile>,
    vault: Option<&crate::vault::Vault>,
) -> Vec<AccountProfileStatus> {
    profiles
        .into_iter()
        .map(|p| {
            let (source, var_name, present) = match &p.credential {
                CredentialSource::Env { var_name } => {
                    let present = std::env::var(var_name).is_ok();
                    ("env".to_string(), Some(var_name.clone()), present)
                },
                CredentialSource::Vault => {
                    let present = vault.map(|v| v.exists(&p.id)).unwrap_or(false);
                    ("vault".to_string(), None, present)
                },
            };
            AccountProfileStatus {
                id: p.id,
                agent: p.agent,
                label: p.label,
                source,
                var_name,
                present,
            }
        })
        .collect()
}

/// Container resource limits preset.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContainerSizing {
    /// Human label: "xs" | "s" | "m" | "l".
    #[serde(default = "default_sizing_label")]
    pub label: String,
    /// Fractional vCPU count (e.g. 1.0, 2.0, 4.0).
    #[serde(default)]
    pub cpu_count: Option<f64>,
    /// Memory cap in MiB (e.g. 2048, 4096, 8192).
    #[serde(default)]
    pub memory_mb: Option<u64>,
}

fn default_sizing_label() -> String {
    "m".into()
}

impl Default for ContainerSizing {
    fn default() -> Self {
        Self {
            label: "m".into(),
            cpu_count: Some(2.0),
            memory_mb: Some(4096),
        }
    }
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
    /// Per-workspace container resource limits override.
    #[serde(default)]
    pub sizing: Option<ContainerSizing>,
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

    // — Container sizing —
    #[serde(default)]
    pub default_sizing: ContainerSizing,

    // — Agent behaviour —
    #[serde(default)]
    pub auto_approve_safe: bool,
    #[serde(default)]
    pub approve_writes: bool,
    #[serde(default)]
    pub cost_budget_per_turn: Option<f64>,
    #[serde(default)]
    pub context_budget: Option<u64>,
    /// Per-agent default model override, keyed by CLI id ("claude", "codex").
    #[serde(default)]
    pub default_model_per_agent: HashMap<String, String>,

    // — Updates —
    #[serde(default = "default_true")]
    pub auto_update: bool,

    // — Lifecycle —
    #[serde(default)]
    pub idle_timeout_minutes: Option<u64>,

    // — Per-session notification mute list —
    #[serde(default)]
    pub muted_sessions: Vec<String>,

    // — Model providers —
    #[serde(default)]
    pub providers: Vec<ModelProvider>,

    // — Prompt templates —
    #[serde(default)]
    pub prompt_templates: Vec<PromptTemplate>,

    // — Companion avatar preferences —
    #[serde(default)]
    pub companion: CompanionPrefs,
}

/// A saved prompt template for the spawn dialog.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplate {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub cli: Option<String>,
}

/// A registered model provider (Agent Settings screen).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelProvider {
    pub id: String,
    pub name: String,
    /// "openai-compatible" | "bedrock" | "vertex" | "ollama".
    pub kind: String,
    pub endpoint: Option<String>,
    /// Env var NAME for auth (no secret stored).
    pub api_key_var: Option<String>,
    pub models: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// Preferences for the always-on-top companion avatar window. Persisted to disk
/// via the main `Settings` object so they survive across sessions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionPrefs {
    #[serde(default = "default_true")]
    pub show: bool,
    #[serde(default)]
    pub hide_when_focused: bool,
    #[serde(default)]
    pub click_through: bool,
    #[serde(default)]
    pub snap_to_edges: bool,
    #[serde(default = "default_true")]
    pub bubble_on_hover: bool,
    #[serde(default = "default_character")]
    pub character: String,
    #[serde(default = "default_companion_size")]
    pub size: String,
}

impl Default for CompanionPrefs {
    fn default() -> Self {
        serde_json::from_str("{}").expect("empty object yields defaults")
    }
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
