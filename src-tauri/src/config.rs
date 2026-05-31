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
/// - `Vault`: credential stored in the encrypted vault, keyed by the profile's
///   id. CodeHub reads it from the vault at container-create time and injects it
///   as an env var.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "source", rename_all = "camelCase")]
pub enum CredentialSource {
    /// Credential from a host env var (NAME only, never value).
    #[serde(rename = "env")]
    Env {
        #[serde(rename = "varName")]
        var_name: String,
    },
    /// Credential stored in the encrypted vault.
    #[serde(rename = "vault")]
    Vault,
}

/// A named account a session can launch under. Supports two credential models:
///
/// 1. **Env-backed** (legacy): `var_name` is the NAME of a host env var.
///    CodeHub forwards the value into the container but never stores it.
/// 2. **Vault-backed** (new): the secret lives in the encrypted vault, keyed by
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
    /// Whether this credential is offered at spawn. Disabled profiles are kept
    /// (and their secret stays in the vault) but never appear in the spawn
    /// dialog's account picker. Defaults to true for back-compat.
    #[serde(default = "default_true")]
    pub enabled: bool,
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
        // Absent in older settings.json → enabled (back-compat default).
        let enabled = obj.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);

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
            enabled,
            credential,
        })
    }
}

/// An account profile plus live presence status.
/// For env-backed: whether the host env var is present.
/// For vault-backed: whether the vault entry exists.
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
    /// Whether the profile is offered at spawn (user-toggleable).
    pub enabled: bool,
}

/// Map stored profiles to their live presence status.
/// For env-backed: presence-probes the host env var (value never bound).
/// For vault-backed: checks vault metadata without decrypting the secret, so
/// missing profiles can be shown accurately without touching credential bytes.
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
                enabled: p.enabled,
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
    /// Epoch-ms the workspace was created. `None` for pre-existing entries saved
    /// before this field landed (the UI falls back to "—"). Distinguishes two
    /// workspaces that happen to share a name.
    #[serde(default)]
    pub created_at: Option<i64>,
    /// Per-workspace container resource limits override.
    #[serde(default)]
    pub sizing: Option<ContainerSizing>,
    /// Extra host directories bind-mounted alongside `dir`. Each is mounted at
    /// `/workspace/<basename>` inside the container (the primary `dir` stays at
    /// `/workspace`), so one workspace can hold several repos. Resolved at
    /// container-create time in `Lifecycle::ensure_container`.
    #[serde(default)]
    pub additional_dirs: Vec<String>,
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
    /// Master enable for the always-on-top ambient surface — the macOS Dynamic
    /// Island (native NSPanel) or the companion window elsewhere. Default on:
    /// the island shows on launch and auto-pops on agent events. Turning this off
    /// hides it and suppresses the auto-pop.
    #[serde(default = "default_true")]
    pub show_companion: bool,

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

/// A registered model provider (Agent Settings screen). When a session is
/// launched under a provider, CodeHub injects its endpoint + model + vault-stored
/// token into the pane as the Claude/OpenAI harness env vars (see
/// [`provider_session_env`]). The secret token itself is NOT stored here — it
/// lives in the encrypted vault, keyed by the provider `id` (same as a
/// vault-backed account profile), and is read just-in-time at session create.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelProvider {
    pub id: String,
    pub name: String,
    /// "anthropic" | "openai-compatible" | "openrouter" | "bedrock" | "vertex".
    /// Drives which harness env vars get injected (see [`provider_session_env`]).
    pub kind: String,
    pub endpoint: Option<String>,
    /// Legacy: env var NAME for auth (no secret). Retained for back-compat with
    /// older settings.json; the token now lives in the vault keyed by `id`.
    pub api_key_var: Option<String>,
    pub models: Vec<String>,
    /// Primary model id sent to the harness (e.g. `glm-4.6`, `MiniMax-M2`).
    #[serde(default)]
    pub model: Option<String>,
    /// Background / small-fast model id (e.g. Claude's `ANTHROPIC_SMALL_FAST_MODEL`).
    #[serde(default)]
    pub small_fast_model: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// A model provider plus live token presence (whether a secret is stored in the
/// vault for it). Mirrors the [`AccountProfile`] → [`AccountProfileStatus`] split
/// so the read path can report presence without ever exposing the secret.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelProviderStatus {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub endpoint: Option<String>,
    pub api_key_var: Option<String>,
    pub models: Vec<String>,
    pub model: Option<String>,
    pub small_fast_model: Option<String>,
    pub enabled: bool,
    /// A secret token is stored in the vault for this provider.
    pub has_token: bool,
}

/// Map stored providers to their token presence (metadata-only vault check, no
/// secret decrypted). `vault` is `None` in the dev bridge — every provider then
/// reports `has_token: false`.
pub fn provider_statuses(
    providers: Vec<ModelProvider>,
    vault: Option<&crate::vault::Vault>,
) -> Vec<ModelProviderStatus> {
    providers
        .into_iter()
        .map(|p| {
            let has_token = vault.map(|v| v.exists(&p.id)).unwrap_or(false);
            ModelProviderStatus {
                id: p.id,
                name: p.name,
                kind: p.kind,
                endpoint: p.endpoint,
                api_key_var: p.api_key_var,
                models: p.models,
                model: p.model,
                small_fast_model: p.small_fast_model,
                enabled: p.enabled,
                has_token,
            }
        })
        .collect()
}

/// Build the harness env assignments that point a CLI at this provider, given the
/// resolved secret `token`. These are injected as pane env (`-e KEY=value`) at
/// `tmux new-session`, so the agent picks them up exactly as if the user had
/// exported them. Returns empty for kinds that can't be wired with a bare token
/// (bedrock/vertex use cloud creds; openrouter needs an Anthropic-compatible
/// router proxy) — those are surfaced in the UI but not launch-wired.
pub fn provider_session_env(provider: &ModelProvider, token: &str) -> Vec<String> {
    let endpoint = provider.endpoint.as_deref().unwrap_or("").trim();
    let primary = provider
        .model
        .as_deref()
        .or_else(|| provider.models.first().map(String::as_str));
    let mut out = Vec::new();
    match provider.kind.as_str() {
        "anthropic" | "anthropic-compatible" => {
            if !endpoint.is_empty() {
                out.push(format!("ANTHROPIC_BASE_URL={endpoint}"));
            }
            out.push(format!("ANTHROPIC_AUTH_TOKEN={token}"));
            if let Some(m) = primary {
                out.push(format!("ANTHROPIC_MODEL={m}"));
            }
            if let Some(m) = provider.small_fast_model.as_deref() {
                out.push(format!("ANTHROPIC_SMALL_FAST_MODEL={m}"));
            }
        },
        "openai" | "openai-compatible" => {
            if !endpoint.is_empty() {
                out.push(format!("OPENAI_BASE_URL={endpoint}"));
            }
            out.push(format!("OPENAI_API_KEY={token}"));
        },
        // Not launch-wired: cloud-credential or router-proxy providers.
        _ => {},
    }
    out
}

/// Whether a provider of this `kind` can be launch-wired from a stored token
/// alone. The UI uses the mirror of this to gate the "selectable in spawn dialog"
/// affordance (openrouter / bedrock / vertex stay catalog-only for now).
pub fn provider_kind_launchable(kind: &str) -> bool {
    matches!(
        kind,
        "anthropic" | "anthropic-compatible" | "openai" | "openai-compatible"
    )
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

    /// Rename an account profile's label. Returns error if the profile doesn't
    /// exist or the label is empty.
    pub fn rename_account_profile(&self, id: &str, label: &str) -> Result<Settings, String> {
        let label = label.trim();
        if label.is_empty() {
            return Err("label must not be empty".into());
        }
        let mut next = self.get();
        let profile = next
            .account_profiles
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("no profile with id {id}"))?;
        profile.label = label.to_string();
        self.set(next)
    }

    /// Enable or disable an account profile. A disabled profile is kept (secret
    /// retained) but filtered out of the spawn picker. Errors if the id is unknown.
    pub fn set_account_profile_enabled(&self, id: &str, enabled: bool) -> Result<Settings, String> {
        let mut next = self.get();
        let profile = next
            .account_profiles
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("no profile with id {id}"))?;
        profile.enabled = enabled;
        self.set(next)
    }
}

/// Cap on the MRU workspace-recents list.
const MAX_RECENT_WORKSPACES: usize = 8;
