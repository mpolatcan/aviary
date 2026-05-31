use bollard::container::{
    ListContainersOptions, LogsOptions, MemoryStatsStats, StatsOptions, TopOptions,
};
use bollard::exec::{CreateExecOptions, ResizeExecOptions, StartExecOptions, StartExecResults};
use bollard::Docker;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DockerError {
    #[error("bollard: {0}")]
    Bollard(#[from] bollard::errors::Error),
    #[error("container not running: {0}")]
    ContainerDown(String),
    #[error("unknown CLI: {0}")]
    UnknownCli(String),
    #[error("path outside /workspace: {0}")]
    InvalidPath(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    /// An in-container command (git / the GitHub API) ran but reported a failure.
    /// Carries the tool's own message verbatim so the UI shows the real reason
    /// (e.g. "nothing to commit", "A pull request already exists") rather than a
    /// generic error. Used by the git-write ops (stage/commit/open-PR).
    #[error("{0}")]
    Command(String),
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionInfo {
    pub name: String,
    pub windows: u32,
    pub attached: bool,
    /// Unix epoch seconds when the tmux session was created (`session_created`).
    /// 0 when tmux didn't report it — the UI then omits the uptime rather than
    /// showing a bogus age.
    pub created: i64,
    /// Workspace key of the container this session lives in, read from the
    /// container's `codehub.workspace` label by `LifecycleManager::list_all_sessions`.
    /// Startup restore uses it to re-tie a session to its original workspace —
    /// it becomes the session's routing `containerKey` so kill/rename target the
    /// container the session actually lives in.
    #[serde(default)]
    pub workspace: Option<String>,
}

/// Installed version of a CLI inside the runtime container, as reported by
/// `<bin> --version`. `None` when the container is down or the probe fails.
#[derive(Debug, Serialize, Clone)]
pub struct AgentVersion {
    pub version: Option<String>,
}

/// One-shot resource snapshot for the runtime container, derived from bollard's
/// `docker.stats()` the same way the docker CLI computes them. Bytes are raw;
/// the UI formats them. Backs the Containers view gauge cards.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContainerStats {
    /// Container CPU as a percentage of total host capacity (can exceed 100 on
    /// multi-core), matching `docker stats`.
    pub cpu_pct: f64,
    pub mem_used: u64,
    pub mem_limit: u64,
    pub net_rx: u64,
    pub net_tx: u64,
    /// Total block-IO bytes (read + write) since container start.
    pub disk: u64,
}

/// Identity of the image the runtime container runs, from `docker inspect` +
/// `docker image inspect`. Backs the Containers view "Image" card. Every field
/// is `Option` so a missing value renders as an em-dash rather than a fake.
#[derive(Debug, Default, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    /// Image ID (`sha256:…`), as the container resolves it.
    pub id: Option<String>,
    /// First repo tag, e.g. `ghcr.io/.../codehub-runtime:0.1.2`.
    pub tag: Option<String>,
    /// First repo digest's `sha256:…` (registry content digest), if pulled.
    pub digest: Option<String>,
    /// Image build time, RFC 3339 as Docker reports it.
    pub created: Option<String>,
    /// On-disk image size in bytes.
    pub size: Option<i64>,
    pub arch: Option<String>,
    pub os: Option<String>,
}

/// Liveness facts about the runtime container, read from `docker inspect`'s
/// `State` block. Backs the Containers view hero (uptime + restart count).
/// Every field is `Option` so a missing value renders as an em-dash rather than
/// a fabricated zero.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHealth {
    /// `State.StartedAt`, RFC 3339, for the current run — the UI derives uptime
    /// from it. `None` when the container has never started (Docker reports a
    /// zero timestamp, which we drop rather than show as a bogus age).
    pub started_at: Option<String>,
    /// `RestartCount` — times Docker has auto-restarted the container.
    pub restart_count: Option<i64>,
    /// `State.Status` token: "running", "exited", "created", …
    pub status: Option<String>,
    /// `State.OOMKilled` — whether the last stop was an out-of-memory kill.
    pub oom_killed: Option<bool>,
}

/// One bind/volume mount of the runtime container, read from `docker inspect`.
/// `source` is the host-side path (or volume name); `destination` the in-container
/// path. Backs the Containers view "Mounts" card — the real host path behind
/// `/workspace` and `/config`, rather than a hardcoded guess.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MountInfo {
    pub source: String,
    pub destination: String,
    pub rw: bool,
    /// Mount kind as Docker reports it: "bind", "volume", "tmpfs", …
    pub kind: String,
}

/// One changed path in the `/workspace` working tree, from `git status
/// --porcelain`. `status` is the raw 2-char XY code (e.g. " M", "??", "A ").
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    pub status: String,
}

/// Working-tree state of the `/workspace` mount. `is_repo: false` covers both
/// "not a git repo" and "git unavailable" — the UI shows an honest note either
/// way rather than a fake clean tree. `files` is capped (see `git_status`).
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFile>,
    /// Total changed paths, even when `files` is truncated for display.
    pub total: u32,
}

/// One process running inside the runtime container, from `docker top` (host
/// `ps` against the container's PID namespace — no in-container `ps` needed).
/// Backs the Containers view "Processes" card. Fields are whatever the platform
/// `ps` reports; missing columns come back empty / `None` rather than fabricated.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: String,
    pub user: String,
    pub time: Option<String>,
    pub command: String,
}

/// One environment variable from a running container. Auth vars are filtered
/// out before returning to the frontend (no-secret-leaking contract).
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EnvEntry {
    pub name: String,
    pub value: String,
}

/// One git repository discovered under `/workspace` (by `.git` directory).
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub path: String,
    pub branch: Option<String>,
}

/// A transcript search result.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub session_id: String,
    pub title: Option<String>,
    pub snippet: String,
    pub at: Option<String>,
}

/// One commit from `git log` on `/workspace`. `hash` is the full SHA (the UI
/// shortens it); `relative` is git's human age ("2 hours ago"). Backs the
/// Dashboard "Recent commits" card.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub hash: String,
    pub author: String,
    pub relative: String,
    pub subject: String,
}

/// One entry in a `/workspace` directory listing (Files browser). `kind` is
/// "dir" | "file" | "link" | "other"; `size` is bytes (0 for directories). The
/// listing is non-recursive — the UI navigates one level at a time.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub kind: String,
    pub size: i64,
}

/// One immediate subdirectory of a `/workspace` path (working-dir browser).
/// `is_repo` is true when the folder holds a `.git`; `branch` is its current
/// branch when known. The browser drills one level at a time, so it reaches
/// repos at ANY depth — unlike [`RepoInfo`] discovery, which is capped at 2.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_repo: bool,
    pub branch: Option<String>,
}

/// Cumulative token counts. Every field is a real sum from the `usage` block of
/// `assistant` lines in Claude Code's session transcripts — never estimated.
#[derive(Debug, Serialize, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TokenTotals {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
}

/// Per-model usage rollup. `turns` counts model responses (assistant lines) seen
/// for this model. `priced` is false when no rate table entry matched the model,
/// in which case `est_cost_usd` is 0 and the tokens are reported as unpriced.
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub totals: TokenTotals,
    pub turns: u32,
    pub est_cost_usd: f64,
    pub priced: bool,
}

/// Per-day usage rollup (UTC date `YYYY-MM-DD` from each line's `timestamp`).
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    pub date: String,
    pub totals: TokenTotals,
    pub est_cost_usd: f64,
}

/// One model family's per-million-token rates, surfaced to the UI so the cost
/// estimate is transparent about the prices it used (and that they are an
/// estimate, not a billed figure).
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRate {
    pub family: String,
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    pub cache_write_per_mtok: f64,
    pub cache_read_per_mtok: f64,
}

/// Aggregate token analytics read from Claude Code's on-disk session transcripts
/// (`$CLAUDE_CONFIG_DIR/projects/**/*.jsonl`). Token counts and turn/session
/// counts are FACTUAL (straight from the transcripts). `est_cost_usd` is an
/// ESTIMATE: tokens × the published `rates` (as of `rates_as_of`), not a billed
/// amount. `unpriced_tokens` is the input+output token volume from models with
/// no rate-table match, excluded from the cost estimate.
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsage {
    pub sessions: u32,
    pub turns: u32,
    pub totals: TokenTotals,
    pub est_cost_usd: f64,
    pub by_model: Vec<ModelUsage>,
    pub by_day: Vec<DayUsage>,
    pub rates: Vec<ModelRate>,
    pub rates_as_of: String,
    pub unpriced_tokens: u64,
}

/// One past Claude Code conversation, reconstructed from its on-disk transcript
/// so it can be reopened with `claude --resume <id>`. Every field is FACTUAL:
/// `title` is the transcript's own `ai-title` (or, lacking one, its first user
/// prompt); `branch` is the recorded `gitBranch` (detached `HEAD` → `None`);
/// `turns` counts distinct user messages; timestamps are the transcript's. No
/// field is fabricated — a missing one is `None`/empty, never guessed.
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSession {
    pub id: String,
    pub title: String,
    pub branch: Option<String>,
    pub started: String,
    pub last_active: String,
    pub turns: u32,
    pub model: Option<String>,
    pub version: Option<String>,
    pub est_cost_usd: Option<f64>,
    pub total_tokens: Option<u64>,
}

/// Live per-session token counts for one Claude conversation, read from its own
/// transcript (`<sessionId>.jsonl`) so the Hub's pane header can show a real
/// running tally. All FACTUAL: `turns` is deduped model responses, `tokens_in`/
/// `tokens_out` are summed `usage` counts, `edits` is the count of file-editing
/// tool calls (Edit/Write/MultiEdit/NotebookEdit) the agent actually made,
/// `context_used` is the live context footprint (most recent turn's read size).
/// Claude-only — the id is the `--session-id` the session was launched with.
///
/// There is deliberately NO context-window maximum: the transcript never records
/// it, and it varies by model/CLI-version/tier (e.g. Opus 4.7 here runs a 1M
/// window with no flag, not the 200K one might assume). The UI shows the real
/// `context_used` count alone rather than a fabricated `used / max` ratio.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub turns: u32,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub edits: u32,
    /// Tokens the model read on its most recent turn (`input + cache_read +
    /// cache_creation`) — the live context footprint. 0 when no turn has usage.
    pub context_used: u64,
    /// The model's context-window size, for the UI gauge. The transcript records no
    /// window, so this is mapped from the model family (see `claude_context_window`).
    /// 0 for unknown models → the gauge shows an em-dash rather than a fake ratio.
    pub context_window: u64,
}

/// The Claude account the runtime is signed into, read from `oauthAccount` in
/// `~/.claude.json`. Identity only — every field is the user's own account
/// metadata that already lives on disk; NO token, secret, or billing detail is
/// surfaced. Each field is `Option` so a missing one renders as em-dash.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAccount {
    pub email: Option<String>,
    pub name: Option<String>,
    /// Subscription tier, prettified from `organizationType` (e.g.
    /// `claude_max` → "Max"); the raw value when unrecognized.
    pub plan: Option<String>,
    pub org: Option<String>,
    pub role: Option<String>,
}

/// One MCP server configured for the runtime's Claude, read from the
/// `mcpServers` maps in `~/.claude.json` (user + per-project scope) and the
/// workspace `.mcp.json` (shared). Identity only: `name`, `transport`, and a
/// non-secret `target` (the launch command for stdio, the URL for http/sse).
/// Secret-bearing fields (`env`, `headers`) are deliberately NEVER read or
/// surfaced — only what a server *is*, never its credentials.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    /// Where it's configured: "user", "project", or "shared".
    pub scope: String,
    /// "stdio" | "http" | "sse" | "unknown".
    pub transport: String,
    /// stdio launch command, or the http/sse URL. `None` when neither is set.
    /// Never includes args containing secrets — just the bare command/URL.
    pub target: Option<String>,
}

/// What the runtime's Claude is actually connected to: the signed-in account +
/// configured MCP servers. All FACTUAL, read from on-disk config; nothing is
/// fabricated and no credential is surfaced. Empty `mcp_servers` (the common
/// case) is reported honestly as "none configured" by the UI.
#[derive(Debug, Serialize, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeIntegrations {
    pub account: Option<ClaudeAccount>,
    pub mcp_servers: Vec<McpServer>,
}

/// One sub-agent definition read from `.claude/agents/<name>.md` (user scope in
/// `/config/claude/agents`, project scope in `/workspace/.claude/agents`). Every
/// field is FACTUAL, parsed from the file's YAML frontmatter (`name`,
/// `description`, `model`, `tools`); a missing key is `None`/empty, never
/// invented. Backs the Agent settings "Sub-agents" section.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubAgentInfo {
    pub name: String,
    pub description: Option<String>,
    pub model: Option<String>,
    pub tools: Vec<String>,
    /// "user" (`/config/claude`) or "project" (`/workspace/.claude`).
    pub scope: String,
}

/// One skill read from `.claude/skills/<name>/SKILL.md`. `name`/`description`
/// come from the file's frontmatter (falling back to the directory name);
/// FACTUAL only. Backs the Agent settings "Skills" section.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: Option<String>,
    pub scope: String,
}

/// One installed plugin, derived from the `enabledPlugins` map in
/// `~/.claude.json` (the `<plugin>@<marketplace>` keys). `enabled` reflects the
/// stored boolean. FACTUAL — no version/description is fabricated when the
/// catalog has none.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub name: String,
    pub marketplace: Option<String>,
    pub enabled: bool,
}

/// The runtime Claude's configurable surface, read from on-disk config
/// (`~/.claude.json`, `settings.json`, `.claude/agents`, `.claude/skills`,
/// `plugins/known_marketplaces.json`). All FACTUAL: the active `model`, the
/// default `permission_mode`, the literal allow/ask/deny permission rules, the
/// configured sub-agents/skills/plugins and installed marketplaces. Empty
/// collections are reported honestly (the UI shows a "none configured" state)
/// rather than filled with sample data. No credential is surfaced. Backs the
/// Agent settings detail screen.
#[derive(Debug, Serialize, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    /// The exact tool-rule strings from `settings.json` `permissions.allow`
    /// (e.g. `Read(/workspace/**)`, `Bash(git diff:*)`). Verbatim, never
    /// synthesized — the UI renders them read-only.
    pub permission_allow: Vec<String>,
    /// `permissions.ask` rules — tools that prompt before running.
    pub permission_ask: Vec<String>,
    /// `permissions.deny` rules — tools that are blocked outright.
    pub permission_deny: Vec<String>,
    pub subagents: Vec<SubAgentInfo>,
    pub skills: Vec<SkillInfo>,
    pub plugins: Vec<PluginInfo>,
    pub marketplaces: Vec<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Cli {
    Claude,
    Codex,
    Antigravity,
    /// Not an AI agent — a plain interactive `bash` shell in the container
    /// (Workspace screen's SHELL pane type). It rides the same tmux/pty session
    /// machinery as the agent CLIs; it just launches a shell and has no
    /// permission modes or version/key probing.
    Shell,
}

impl Cli {
    pub fn binary(self) -> &'static str {
        match self {
            Cli::Claude => "claude",
            Cli::Codex => "codex",
            Cli::Antigravity => "antigravity",
            Cli::Shell => "bash",
        }
    }

    pub fn executable(self) -> &'static str {
        match self {
            Cli::Claude => "/root/.local/bin/claude",
            _ => self.binary(),
        }
    }

    pub fn parse(s: &str) -> Result<Self, DockerError> {
        match s.to_ascii_lowercase().as_str() {
            "claude" | "claude-code" => Ok(Cli::Claude),
            "codex" | "openai" => Ok(Cli::Codex),
            "antigravity" | "google" => Ok(Cli::Antigravity),
            "shell" | "bash" => Ok(Cli::Shell),
            other => Err(DockerError::UnknownCli(other.into())),
        }
    }

    /// The canonical env var each CLI reads its credential from. Used to remap an
    /// account profile's (possibly custom-named) host var onto the name the CLI
    /// expects, per session. `Shell` has no credential.
    pub fn canonical_auth_var(self) -> Option<&'static str> {
        match self {
            Cli::Claude => Some("CLAUDE_CODE_OAUTH_TOKEN"),
            Cli::Codex => Some("OPENAI_API_KEY"),
            Cli::Antigravity => Some("GOOGLE_API_KEY"),
            Cli::Shell => None,
        }
    }

    /// Argv to launch the CLI under the given permission mode. The first element
    /// is the binary; the rest are mode flags. Flags are verified against each
    /// CLI's docs — YOLO variants are safe here because the runtime container is
    /// the sandbox boundary. Antigravity is unverified, so it ignores `mode`.
    pub fn launch_argv(self, mode: LaunchMode) -> Vec<&'static str> {
        let bin = self.executable();
        let mut argv = match (self, mode) {
            // Claude Code: `auto` uses the classifier to auto-approve safe tool calls
            // (incl. shell) while still blocking dangerous ones — a better Auto tier
            // than `acceptEdits`, which frees only edits and prompts on shell. `skip`
            // bypasses every guard.
            (Cli::Claude, LaunchMode::Auto) => vec![bin, "--permission-mode", "auto"],
            (Cli::Claude, LaunchMode::Yolo) => vec![bin, "--dangerously-skip-permissions"],
            // Codex sandbox: the runtime CONTAINER is the boundary, so we never use
            // Codex's own OS sandbox. `workspace-write`/`read-only` shell out to
            // bubblewrap, which can't create a user namespace inside the container
            // (`bwrap: No permissions to create a new namespace` — Docker's VM forbids
            // unprivileged userns, and installing bwrap wouldn't help) → EVERY tool
            // call fails. `danger-full-access` runs tools directly (no bwrap); the
            // approval policy is the only mode knob.
            //   Auto → never  : autonomous (auto-approve), the auto-run tier.
            //   Yolo → --yolo : bypass approvals + sandbox (alias for the above + no asks).
            (Cli::Codex, LaunchMode::Auto) => {
                vec![
                    bin,
                    "--sandbox",
                    "danger-full-access",
                    "--ask-for-approval",
                    "never",
                ]
            },
            (Cli::Codex, LaunchMode::Yolo) => vec![bin, "--yolo"],
            // Codex Standard: still no OS sandbox (bwrap is unavailable in-container),
            // but `on-request` asks before each command — Codex's recommended
            // interactive policy, and the cautious default tier. Asking fires the
            // PermissionRequest hook → the awaiting state.
            (Cli::Codex, LaunchMode::Standard) => {
                vec![
                    bin,
                    "--sandbox",
                    "danger-full-access",
                    "--ask-for-approval",
                    "on-request",
                ]
            },
            // Antigravity (all modes) launches the bare binary.
            _ => vec![bin],
        };
        // Codex agent-event hooks are delivered as launch-time `-c` overrides, NOT
        // via config.toml: Codex rewrites $CODEX_HOME/config.toml on first run
        // (trust + tui nux) and DROPS any baked `[[hooks.*]]`/`notify`, so a
        // file-seeded config silently vanishes and CodeHub sees zero Codex activity.
        // `-c` rides the argv (codex execs it directly — no shell/clobber) every
        // launch. `--dangerously-bypass-hook-trust` runs our own baked codehub-hook
        // commands without the interactive startup trust review (the container vets
        // the source). `notify` (turn-finish → Stop) is verified to fire; the
        // structured lifecycle hooks are delivered the same way for the interactive
        // session. See CODEX_HOOK_ARGS.
        if matches!(self, Cli::Codex) {
            argv.extend_from_slice(CODEX_HOOK_ARGS);
        }
        argv
    }
}

/// Permission posture a session is launched with. Maps to per-CLI flags in
/// [`Cli::launch_argv`].
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum LaunchMode {
    /// Agent asks before edits / commands (each CLI's default).
    #[default]
    Standard,
    /// Auto-accept edits inside the workspace, still sandboxed.
    Auto,
    /// Skip all approvals and sandbox — relies on the container as the boundary.
    Yolo,
}

impl LaunchMode {
    pub fn parse(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "auto" => LaunchMode::Auto,
            "yolo" => LaunchMode::Yolo,
            _ => LaunchMode::Standard,
        }
    }
}

/// Distinguishes a real `--version` line from a docker-exec failure that
/// `exec_capture` (which merges stdout+stderr) returns when a binary is absent,
/// e.g. `exec failed: ... executable file not found in $PATH`. A version string
/// always contains a digit and none of these error markers.
fn is_version_like(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    const MARKERS: [&str; 5] = [
        "exec failed",
        "not found",
        "no such file",
        "executable file",
        "permission denied",
    ];
    s.chars().any(|c| c.is_ascii_digit()) && !MARKERS.iter().any(|m| lower.contains(m))
}

/// A valid POSIX environment variable name (`[A-Za-z_][A-Za-z0-9_]*`). Account
/// profiles store an env var NAME to remap a session's credential by; this guards
/// against anything that could break out of the `${NAME}` expansion in the
/// session-launch shell. Enforced at profile-add time and again at launch.
pub fn is_env_name(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {},
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub const CONTAINER_PATH: &str =
    "/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// Codex agent-event hook config, injected on the launch argv (see `launch_argv`).
/// Each `-c key=value` value is inline TOML, parsed by Codex; `codehub-hook` is the
/// image-baked append script that writes `/tmp/codehub/events/$CODEHUB_SESSION.jsonl`
/// (which `events.rs` tails). Mirrors the Claude managed-settings hooks. `notify`
/// covers turn-finish (Stop); the `[[hooks.*]]` cover prompt/tool/approval/start.
/// `--dangerously-bypass-hook-trust` skips Codex's interactive startup trust review
/// for these (the container is a vetted source). Event names are Codex 0.135's.
const CODEX_HOOK_ARGS: &[&str] = &[
    "--dangerously-bypass-hook-trust",
    "-c",
    "notify=[\"/usr/local/bin/codehub-hook\",\"Stop\"]",
    "-c",
    "hooks.UserPromptSubmit=[{hooks=[{type=\"command\",command=\"/usr/local/bin/codehub-hook UserPromptSubmit\"}]}]",
    "-c",
    "hooks.PreToolUse=[{hooks=[{type=\"command\",command=\"/usr/local/bin/codehub-hook PreToolUse\"}]}]",
    "-c",
    "hooks.PostToolUse=[{hooks=[{type=\"command\",command=\"/usr/local/bin/codehub-hook PostToolUse\"}]}]",
    "-c",
    "hooks.PermissionRequest=[{hooks=[{type=\"command\",command=\"/usr/local/bin/codehub-hook Notification permission_prompt\"}]}]",
    "-c",
    "hooks.SessionStart=[{hooks=[{type=\"command\",command=\"/usr/local/bin/codehub-hook SessionStart\"}]}]",
];

pub const CLAUDE_CONFIG_DIR: &str = "/config/claude";
pub const CODEX_CONFIG_DIR: &str = "/config/codex";
pub const ANTIGRAVITY_CONFIG_DIR: &str = "/config/antigravity";

/// Baseline env every CodeHub runtime container/pane needs. Keeping this in
/// app code makes existing containers work even when they were created from an
/// older runtime image that did not yet bake these env vars in.
pub fn base_container_env() -> Vec<String> {
    vec![
        format!("PATH={CONTAINER_PATH}"),
        "HOME=/root".to_string(),
        "TMUX_TMPDIR=/tmp/codehub".to_string(),
        "IS_SANDBOX=1".to_string(),
        format!("CLAUDE_CONFIG_DIR={CLAUDE_CONFIG_DIR}"),
        // CODEX_HOME is the REAL Codex var (default ~/.codex) — auth.json + config.toml
        // live under it. Pin it to /config/codex (a container-local, image-baked dir
        // — /config is NOT mounted) so Codex reads the baked config.toml (its
        // structured hooks) and the login flow can capture auth.json from a known
        // path into the vault. CODEX_CONFIG_DIR is a no-op for Codex (back-compat).
        format!("CODEX_HOME={CODEX_CONFIG_DIR}"),
        format!("CODEX_CONFIG_DIR={CODEX_CONFIG_DIR}"),
        format!("ANTIGRAVITY_CONFIG_DIR={ANTIGRAVITY_CONFIG_DIR}"),
    ]
}

pub fn push_tmux_env(cmd: &mut Vec<String>, assignment: impl Into<String>) {
    cmd.push("-e".into());
    cmd.push(assignment.into());
}

pub fn push_base_tmux_env(cmd: &mut Vec<String>) {
    for env in base_container_env() {
        push_tmux_env(cmd, env);
    }
}

/// Single-quote a string for safe inclusion in a `sh -c` command. Any embedded
/// single quote is closed, escaped, and reopened (`'\''`). Used to quote the CLI
/// argv when it runs under the account-remap shell.
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn shell_join_quoted(argv: &[String]) -> String {
    argv.iter()
        .map(|a| shell_single_quote(a))
        .collect::<Vec<_>>()
        .join(" ")
}

fn account_launch_script(cli: Cli, canon: &str, src: &str, argv: &[String]) -> String {
    let launch = shell_join_quoted(argv);
    match cli {
        Cli::Claude => {
            let prefix = crate::auth::CLAUDE_AUTH_BUNDLE_PREFIX;
            let profile_dir = shell_single_quote(&format!("/config/claude-profiles/{src}"));
            let onboarding = crate::auth::claude_onboarding_patch_script("dir");
            format!(
                "if [ -n \"${{{src}:-}}\" ]; then case \"${{{src}}}\" in {prefix}*) dir={profile_dir}; mkdir -p \"$dir\"; chmod 700 \"$dir\"; if [ -f /config/claude/settings.json ] && [ ! -f \"$dir/settings.json\" ]; then cp /config/claude/settings.json \"$dir/settings.json\"; fi; payload=\"${{{src}#{prefix}}}\"; printf '%s' \"$payload\" | base64 -d | tar --no-same-owner -xzf - -C \"$dir\"; {onboarding} export CLAUDE_CONFIG_DIR=\"$dir\"; unset {src} payload ;; *) export {canon}=\"${{{src}}}\"; unset {src} ;; esac; fi; exec {launch}"
            )
        },
        Cli::Codex => format!(
            "if [ -n \"${{{src}:-}}\" ]; then case \"${{{src}}}\" in \\{{*|\\[*) mkdir -p /config/codex; umask 077; printf '%s' \"${{{src}}}\" > /config/codex/auth.json; unset {src} ;; *) export {canon}=\"${{{src}}}\"; unset {src} ;; esac; fi; exec {launch}"
        ),
        Cli::Antigravity => format!(
            "if [ -n \"${{{src}:-}}\" ]; then case \"${{{src}}}\" in \\{{*|\\[*) mkdir -p \"$HOME/.config/agy\"; umask 077; printf '%s' \"${{{src}}}\" > \"$HOME/.config/agy/credentials.json\"; unset {src} ;; *) export {canon}=\"${{{src}}}\"; unset {src} ;; esac; fi; exec {launch}"
        ),
        _ => format!("export {canon}=\"${{{src}}}\"; exec {launch}"),
    }
}

pub fn claude_profile_dir_for_env(src: &str) -> String {
    format!("/config/claude-profiles/{src}")
}

/// Per-profile `CODEX_HOME` for a vault profile's env name. Mirrors
/// [`claude_profile_dir_for_env`]: each subscription account gets its OWN Codex
/// home (auth.json + rollouts + config.toml) so two Codex accounts in one
/// workspace don't clobber the single shared `/config/codex/auth.json`. The base
/// `CODEX_HOME=/config/codex` stays the default for account-less (auto) panes.
pub fn codex_profile_dir_for_env(src: &str) -> String {
    format!("/config/codex-profiles/{src}")
}

pub struct TmuxSessionRequest<'a> {
    pub name: &'a str,
    pub cli: Cli,
    pub mode: LaunchMode,
    pub alias: &'a str,
    pub resume: Option<&'a str>,
    pub session_id: Option<&'a str>,
    /// Name of the source credential env var, never the credential value.
    pub account_var: Option<&'a str>,
    /// Non-secret pane env entries, such as a profile-specific config dir.
    pub session_env: &'a [String],
    /// Secret `KEY=value` entries used only for this Docker exec.
    pub account_env: &'a [String],
    /// In-container working directory the agent starts in (the tmux pane's
    /// start-directory). A path under `/workspace` (e.g. a repo subdir) so a
    /// multi-repo workspace can launch an agent scoped to one repo. `None` — or a
    /// path outside `/workspace` — leaves the container default (`/workspace`).
    pub cwd: Option<&'a str>,
}

#[derive(Clone)]
pub struct DockerClient {
    pub container: String,
    pub docker: Docker,
}

impl DockerClient {
    pub fn from_docker(docker: Docker, container: String) -> Self {
        Self { container, docker }
    }

    pub async fn is_running(&self) -> Result<bool, DockerError> {
        let mut filters = HashMap::new();
        filters.insert("name".to_string(), vec![self.container.clone()]);
        filters.insert("status".to_string(), vec!["running".to_string()]);

        let containers = self
            .docker
            .list_containers(Some(ListContainersOptions::<String> {
                all: false,
                filters,
                ..Default::default()
            }))
            .await?;
        Ok(!containers.is_empty())
    }

    /// Guard for running-only commands: returns `ContainerDown` when the runtime
    /// container is not up. Collapses the `is_running` check repeated by every
    /// command that requires a live container.
    async fn require_running(&self) -> Result<(), DockerError> {
        if self.is_running().await? {
            Ok(())
        } else {
            Err(DockerError::ContainerDown(self.container.clone()))
        }
    }

    /// Public alias used by `events.rs` for the event-dir setup exec. Merges
    /// stdout + stderr identically to the private version.
    pub async fn exec_capture_pub(&self, cmd: Vec<&str>) -> Result<String, DockerError> {
        self.exec_capture(cmd).await
    }

    async fn exec_capture(&self, cmd: Vec<&str>) -> Result<String, DockerError> {
        self.exec_capture_env(cmd, &[]).await
    }

    /// Like [`exec_capture`] but forwards additional `KEY=value` env entries into
    /// the exec. Used to hand a secret (e.g. `GITHUB_TOKEN`) to an in-container
    /// command without it ever appearing in the command's argv or a log: the
    /// value rides in the structured Docker exec `env` field (same channel as
    /// `TMUX_TMPDIR`), and the in-shell script references it by NAME only. The
    /// host process never has the secret on a command line.
    async fn exec_capture_env(
        &self,
        cmd: Vec<&str>,
        extra_env: &[String],
    ) -> Result<String, DockerError> {
        let mut env: Vec<String> = vec!["TMUX_TMPDIR=/tmp/codehub".into()];
        env.extend(extra_env.iter().cloned());
        let exec = self
            .docker
            .create_exec::<String>(
                &self.container,
                CreateExecOptions {
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    cmd: Some(cmd.into_iter().map(String::from).collect()),
                    env: Some(env),
                    ..Default::default()
                },
            )
            .await?;

        let started = self
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
                match chunk? {
                    bollard::container::LogOutput::StdOut { message }
                    | bollard::container::LogOutput::StdErr { message }
                    | bollard::container::LogOutput::Console { message } => {
                        buf.push_str(&String::from_utf8_lossy(&message));
                    },
                    _ => {},
                }
            }
            Ok(buf)
        } else {
            Ok(String::new())
        }
    }

    /// Like [`exec_capture_env`] but calls `on_line` for each line of stdout as
    /// it arrives, enabling real-time parsing of URLs / device codes from
    /// interactive CLI login flows. Also accumulates the full output and returns
    /// it. Aborts after `timeout`.
    pub async fn exec_stream_lines<F>(
        &self,
        cmd: Vec<&str>,
        timeout: std::time::Duration,
        mut on_line: F,
    ) -> Result<String, DockerError>
    where
        F: FnMut(&str),
    {
        let exec = self
            .docker
            .create_exec::<String>(
                &self.container,
                CreateExecOptions {
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    cmd: Some(cmd.into_iter().map(String::from).collect()),
                    env: Some(vec!["TMUX_TMPDIR=/tmp/codehub".into()]),
                    ..Default::default()
                },
            )
            .await?;

        let started = self
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
            let mut line_buf = String::new();
            let deadline = tokio::time::Instant::now() + timeout;

            loop {
                let chunk = tokio::time::timeout_at(deadline, output.next()).await;
                match chunk {
                    Err(_) => break,   // timeout
                    Ok(None) => break, // stream ended
                    Ok(Some(Err(e))) => return Err(e.into()),
                    Ok(Some(Ok(log))) => {
                        let text = match log {
                            bollard::container::LogOutput::StdOut { message }
                            | bollard::container::LogOutput::StdErr { message }
                            | bollard::container::LogOutput::Console { message } => {
                                String::from_utf8_lossy(&message).to_string()
                            },
                            _ => continue,
                        };
                        buf.push_str(&text);
                        line_buf.push_str(&text);
                        while let Some(pos) = line_buf.find('\n') {
                            let line = line_buf[..pos].trim_end_matches('\r').to_string();
                            on_line(&line);
                            line_buf = line_buf[pos + 1..].to_string();
                        }
                    },
                }
            }
            if !line_buf.is_empty() {
                on_line(line_buf.trim_end());
            }
            Ok(buf)
        } else {
            Ok(String::new())
        }
    }

    /// Probe each CLI's `--version` inside the container. Best-effort: a stopped
    /// container or a failing/absent binary yields `version: None` for that CLI
    /// rather than an error, so the caller always gets a full map.
    pub async fn agent_versions(&self) -> HashMap<String, AgentVersion> {
        let running = self.is_running().await.unwrap_or(false);
        let clis = [Cli::Claude, Cli::Codex, Cli::Antigravity];
        // Probe every CLI concurrently — three independent `--version` execs that
        // would otherwise serialize into three sequential container round-trips.
        let versions = futures_util::future::join_all(clis.iter().map(|cli| async move {
            if !running {
                return None;
            }
            self.exec_capture(vec![cli.executable(), "--version"])
                .await
                .ok()
                .map(|s| s.lines().next().unwrap_or_default().trim().to_string())
                .filter(|s| !s.is_empty())
                .filter(|s| is_version_like(s))
        }))
        .await;
        clis.iter()
            .zip(versions)
            .map(|(cli, version)| (cli.binary().to_string(), AgentVersion { version }))
            .collect()
    }

    pub async fn list_tmux_sessions(&self) -> Result<Vec<SessionInfo>, DockerError> {
        self.require_running().await?;

        let out = self
            .exec_capture(vec![
                "tmux",
                "list-sessions",
                "-F",
                "#{session_name}|#{session_windows}|#{session_attached}|#{session_created}",
            ])
            .await
            .unwrap_or_default();

        let mut sessions = Vec::new();
        for line in out.lines() {
            let parts: Vec<&str> = line.split('|').collect();
            if parts.len() >= 3 {
                sessions.push(SessionInfo {
                    name: parts[0].to_string(),
                    windows: parts[1].parse().unwrap_or(0),
                    attached: parts[2] != "0",
                    // `session_created` is epoch seconds; absent on older tmux → 0.
                    created: parts.get(3).and_then(|s| s.parse().ok()).unwrap_or(0),
                    // The shared listing has no workspace identity; the
                    // per-workspace lister stamps it from the container label.
                    workspace: None,
                });
            }
        }
        Ok(sessions)
    }

    pub async fn create_tmux_session(
        &self,
        request: TmuxSessionRequest<'_>,
    ) -> Result<(), DockerError> {
        let TmuxSessionRequest {
            name,
            cli,
            mode,
            alias,
            resume,
            session_id,
            account_var,
            session_env,
            account_env,
            cwd,
        } = request;
        // `-e IS_SANDBOX=1` marks the pane env as a recognized sandbox so Claude's
        // YOLO mode (--dangerously-skip-permissions) runs as root inside the
        // container instead of refusing. Pane-scoped, so it does not depend on the
        // long-running tmux server's environment. tmux treats trailing argv as the
        // session command; mode flags ride along.
        //
        // `-n <alias>` names the window with CodeHub's display alias (e.g. "Claude 1")
        // so the themed in-pane status bar reads it instead of the opaque session
        // id. The runtime tmux.conf disables auto/allow-rename so the launched CLI
        // can't clobber it. Falls back to the session name if alias is empty.
        let window = if alias.is_empty() { name } else { alias };
        let mut cmd: Vec<String> = ["tmux", "new-session", "-d", "-s"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        cmd.push(name.to_string());
        cmd.push("-n".into());
        cmd.push(window.to_string());
        // `-c <dir>` sets the pane's start directory so the agent launches in the
        // chosen repo/subdir. Confined to `/workspace` (a bad/escaping path is
        // dropped → container default), so this can never cd the agent outside
        // the mount.
        if let Some(dir) = cwd.and_then(|c| workspace_path(c).ok()) {
            cmd.push("-c".into());
            cmd.push(dir);
        }
        push_base_tmux_env(&mut cmd);
        // CODEHUB_SESSION is the session name (tmux key) exported per-pane so
        // the codehub-hook append script can route events to the right JSONL
        // file (§7.6). Verified to reach the hook process in the Phase-0 spike.
        push_tmux_env(&mut cmd, format!("CODEHUB_SESSION={name}"));
        for env in session_env {
            push_tmux_env(&mut cmd, env.clone());
        }
        if let Some(src) = account_var.filter(|src| is_env_name(src)) {
            // tmux sets a session var ONLY from `-e VAR=VALUE`; a bare `-e VAR` is a
            // no-op (it does NOT import the value from this exec's environment), which
            // silently left `${src}` empty in the launch wrapper. Push the full
            // assignment the wrapper reads from. The value lives only in this
            // container's tmux session env — the sandbox boundary. (Claude-bundle and
            // Codex use a pre-exec instead and leave account_var None, so they skip
            // this and never put a secret in the session env.)
            if let Some(assignment) = account_env
                .iter()
                .find(|e| e.split_once('=').map(|(k, _)| k == src).unwrap_or(false))
            {
                push_tmux_env(&mut cmd, assignment.clone());
            }
        }

        // Build the CLI argv (binary + mode flags + resume/session-id) as owned
        // strings so it can either run directly or be wrapped in a remap shell.
        let mut argv: Vec<String> = cli
            .launch_argv(mode)
            .into_iter()
            .map(String::from)
            .collect();
        // Resume reopens a specific past conversation by its transcript id
        // (`claude --resume <id>`). Only Claude persists resumable transcripts and
        // the Resume screen only offers Claude sessions, so this rides on Claude's
        // argv; `--resume` after the mode flags resolves the recorded session. The
        // id comes from the transcript filename (a UUID), never user free-text.
        if let (Cli::Claude, Some(id)) = (cli, resume) {
            argv.push("--resume".into());
            argv.push(id.to_string());
        } else if let (Cli::Claude, Some(id)) = (cli, session_id) {
            // Pin a fresh Claude conversation to a known UUID so its transcript
            // lands at a predictable path (`<id>.jsonl`); that lets the Hub read
            // back this session's own token tally (see `claude_session_usage`).
            // Resume already carries an id, so the two are mutually exclusive.
            argv.push("--session-id".into());
            argv.push(id.to_string());
        }

        // Account remap: when a non-default account was chosen, run the CLI under
        // a login shell that exports the canonical credential var FROM the
        // profile's host/vault var, referenced by NAME (`${SRC}`). The source var
        // is copied into the tmux pane by name with `-e SRC`, so the secret value
        // never appears in this command argv or `docker top`. Only applies when
        // the names actually differ and the source is a safe identifier.
        match (account_var, cli.canonical_auth_var()) {
            (Some(src), Some(canon)) if src != canon && is_env_name(src) => {
                let inner = account_launch_script(cli, canon, src, &argv);
                cmd.push("sh".into());
                cmd.push("-c".into());
                cmd.push(inner);
            },
            _ => cmd.extend(argv),
        }

        self.exec_capture_env(cmd.iter().map(String::as_str).collect(), account_env)
            .await?;
        Ok(())
    }

    /// Restore a Claude vault bundle into its profile directory before tmux starts.
    ///
    /// Tmux server environment is process-global and initialized from the first
    /// client that creates the server. Passing a new vault env by name to a later
    /// `tmux new-session` is therefore not reliable for multiple accounts inside
    /// one workspace container. This pre-materializes the non-secret profile
    /// directory through Docker's structured exec env, then the tmux pane only
    /// needs `CLAUDE_CONFIG_DIR=/config/claude-profiles/<profile>`.
    pub async fn restore_claude_bundle_from_env(
        &self,
        src: &str,
        account_env: &[String],
    ) -> Result<String, DockerError> {
        if !is_env_name(src) {
            return Err(DockerError::Command(format!(
                "invalid Claude profile env name: {src}"
            )));
        }
        let dir = claude_profile_dir_for_env(src);
        let prefix = crate::auth::CLAUDE_AUTH_BUNDLE_PREFIX;
        let onboarding = crate::auth::claude_onboarding_patch_script("dir");
        let script = format!(
            r#"set -eu
dir={dir}
secret="${{{src}:-}}"
if [ -z "$secret" ]; then
  echo "missing Claude vault bundle env {src}" >&2
  exit 1
fi
case "$secret" in
  {prefix}*) payload="${{secret#{prefix}}}" ;;
  *) echo "selected Claude vault entry is not a config bundle" >&2; exit 1 ;;
esac
mkdir -p "$dir"
chmod 700 "$dir"
if [ -f /config/claude/settings.json ] && [ ! -f "$dir/settings.json" ]; then
  cp /config/claude/settings.json "$dir/settings.json"
fi
# Conditional restore: NEVER roll a container's freshly-refreshed token back to the
# vault snapshot. Compare the incoming bundle's access-token expiry (epoch ms) to
# what's on disk; extract only when the container has no creds OR the bundle is newer.
inc=$(printf '%s' "$payload" | base64 -d | tar -xzO ./.credentials.json 2>/dev/null | jq -r '.claudeAiOauth.expiresAt // 0' 2>/dev/null || echo 0)
cur=0
if [ -f "$dir/.credentials.json" ]; then
  cur=$(jq -r '.claudeAiOauth.expiresAt // 0' "$dir/.credentials.json" 2>/dev/null || echo 0)
fi
case "$cur" in ''|*[!0-9]*) cur=0 ;; esac
case "$inc" in ''|*[!0-9]*) inc=0 ;; esac
if [ "$cur" -gt 0 ] && [ "$cur" -ge "$inc" ]; then
  : # container holds same-or-newer creds — keep them, don't overwrite
else
  printf '%s' "$payload" | base64 -d | tar --no-same-owner -xzf - -C "$dir"
fi
{onboarding}
unset secret payload {src}
"#,
            dir = shell_single_quote(&dir),
            src = src,
            prefix = prefix,
            onboarding = onboarding,
        );
        self.exec_capture_env(vec!["sh", "-c", &script], account_env)
            .await?;
        Ok(dir)
    }

    /// Materialize a Codex credential into `$CODEX_HOME/auth.json` before tmux
    /// starts, mirroring [`restore_claude_bundle_from_env`]. The secret is read
    /// from the exec ENVIRONMENT by name (never an argv), so it can't leak via
    /// `docker top` or the tmux session environment. This replaces the old
    /// account-remap shell wrapper for Codex, which relied on `tmux new-session
    /// -e VARNAME` *importing* the value from the exec env — tmux does NOT do that
    /// (only `-e VAR=VALUE` sets a var), so `${SRC}` was always empty in the pane
    /// and Codex launched unauthenticated (onboarding).
    ///
    /// A JSON secret (ChatGPT OAuth `auth.json`) is written verbatim; a bare API
    /// key is piped to `codex login --with-api-key` so Codex writes `auth.json` in
    /// its own format.
    ///
    /// Per-profile isolation: each vault account materializes into its OWN
    /// `CODEX_HOME` (`/config/codex-profiles/<src>`), mirroring Claude's
    /// per-profile config dir — so two Codex accounts in one workspace keep
    /// separate auth.json + rollouts instead of clobbering the shared
    /// `/config/codex`. Returns the home dir; the caller exports it as the pane's
    /// `CODEX_HOME` (overriding the base default).
    pub async fn restore_codex_auth_from_env(
        &self,
        src: &str,
        account_env: &[String],
    ) -> Result<String, DockerError> {
        if !is_env_name(src) {
            return Err(DockerError::Command(format!(
                "invalid Codex auth env name: {src}"
            )));
        }
        let dir = codex_profile_dir_for_env(src);
        let script = format!(
            r#"set -eu
PATH="{path}"
home={home}
secret="${{{src}:-}}"
if [ -z "$secret" ]; then
  echo "missing Codex auth env {src}" >&2
  exit 1
fi
mkdir -p "$home"
chmod 700 "$home"
# Seed config.toml forward so the isolated home carries the runtime's Codex
# config. Hooks/notify ride `-c` argv (CODEX_HOOK_ARGS) and OVERRIDE the same
# keys, so the copied file's hooks never double-fire; this just preserves any
# baked defaults + saves Codex a from-scratch first-run rewrite.
if [ -f {base}/config.toml ] && [ ! -f "$home/config.toml" ]; then
  cp {base}/config.toml "$home/config.toml"
fi
umask 077
case "$secret" in
  \{{*|\[*)
    # Conditional restore: don't roll a container's freshly-refreshed auth.json back
    # to the vault snapshot. Compare `last_refresh` (ISO-8601 UTC — lexicographic
    # order is chronological); write only when the container has none OR the snapshot
    # is newer. dash has no string `>`, so pick the later via `sort`.
    inc=$(printf '%s' "$secret" | jq -r '.last_refresh // ""' 2>/dev/null || echo "")
    cur=""
    [ -f "$home/auth.json" ] && cur=$(jq -r '.last_refresh // ""' "$home/auth.json" 2>/dev/null || echo "")
    if [ -n "$cur" ] && [ -n "$inc" ] \
       && [ "$(printf '%s\n%s\n' "$cur" "$inc" | sort | tail -n1)" = "$cur" ] \
       && [ "$cur" != "$inc" ]; then
      : # container holds a newer auth.json — keep it
    else
      printf '%s' "$secret" > "$home/auth.json"
    fi ;;
  *) printf '%s' "$secret" | CODEX_HOME="$home" codex login --with-api-key ;;
esac
unset secret {src}
"#,
            path = CONTAINER_PATH,
            home = shell_single_quote(&dir),
            base = CODEX_CONFIG_DIR,
            src = src,
        );
        self.exec_capture_env(vec!["sh", "-c", &script], account_env)
            .await?;
        Ok(dir)
    }

    /// Decode the signed-in account's email from a vault credential `secret`,
    /// without re-login — used to backfill profiles signed in before the email
    /// was captured. The secret rides in the exec ENV by name (never an argv, so
    /// it can't leak via `docker top`), and the decode runs container-side
    /// because the host can't crack it dep-free: Claude's is a tar+gzip bundle,
    /// Codex's email is a base64url JWT claim — `base64`/`tar`/`jq` all live in
    /// the runtime image. Identity only; `None` on any miss (wrong agent, not a
    /// recognizable credential, no email field).
    pub async fn read_account_email_from_secret(
        &self,
        agent: &str,
        secret: &str,
    ) -> Option<String> {
        let prefix = crate::auth::CLAUDE_AUTH_BUNDLE_PREFIX;
        let body = match agent {
            // Strip the bundle prefix, base64-decode, stream just `.claude.json`
            // out of the tar, read `oauthAccount.emailAddress`.
            "claude" => format!(
                r#"case "$secret" in
  {prefix}*) payload="${{secret#{prefix}}}" ;;
  *) exit 0 ;;
esac
printf '%s' "$payload" | base64 -d 2>/dev/null | tar -xzO ./.claude.json 2>/dev/null | jq -r '.oauthAccount.emailAddress // empty' 2>/dev/null || true"#,
                prefix = prefix,
            ),
            // Pull the id_token JWT, base64url→base64 + pad its payload, decode,
            // read the email claim (or the OpenAI profile claim some tokens use).
            "codex" => {
                r#"tok=$(printf '%s' "$secret" | jq -r '.tokens.id_token // empty' 2>/dev/null)
[ -n "$tok" ] || exit 0
payload=$(printf '%s' "$tok" | cut -d. -f2 | tr '_-' '/+')
case $(( ${#payload} % 4 )) in 2) payload="${payload}==";; 3) payload="${payload}=";; esac
printf '%s' "$payload" | base64 -d 2>/dev/null \
  | jq -r '.email // (."https://api.openai.com/profile".email) // empty' 2>/dev/null || true"#
                    .to_string()
            },
            _ => return None,
        };
        let script = format!(
            r#"PATH="{path}"
secret="${{CODEHUB_EMAIL_SECRET:-}}"
[ -n "$secret" ] || exit 0
{body}
unset secret CODEHUB_EMAIL_SECRET payload tok"#,
            path = CONTAINER_PATH,
            body = body,
        );
        let env = vec![format!("CODEHUB_EMAIL_SECRET={secret}")];
        let out = self
            .exec_capture_env(vec!["sh", "-c", &script], &env)
            .await
            .ok()?;
        let email = out.trim();
        if email.is_empty() || !email.contains('@') {
            None
        } else {
            Some(email.to_string())
        }
    }

    pub async fn kill_tmux_session(&self, name: &str) -> Result<(), DockerError> {
        self.exec_capture(vec!["tmux", "kill-session", "-t", name])
            .await?;
        Ok(())
    }

    /// Rename a session's window so the themed in-pane status bar (which renders
    /// the window name `#W`) reflects an alias the user edited in the UI. Each
    /// CodeHub session has exactly one window, so `-t <name>` resolves it.
    pub async fn rename_tmux_window(&self, name: &str, alias: &str) -> Result<(), DockerError> {
        self.exec_capture(vec!["tmux", "rename-window", "-t", name, alias])
            .await?;
        Ok(())
    }

    pub async fn attach_exec(
        &self,
        session: &str,
        cols: u16,
        rows: u16,
    ) -> Result<AttachHandles, DockerError> {
        let exec = self
            .docker
            .create_exec::<String>(
                &self.container,
                CreateExecOptions {
                    attach_stdin: Some(true),
                    attach_stdout: Some(true),
                    attach_stderr: Some(true),
                    tty: Some(true),
                    cmd: Some(vec![
                        "tmux".into(),
                        "-u".into(),
                        "attach-session".into(),
                        "-t".into(),
                        session.into(),
                    ]),
                    env: Some(vec![
                        "TERM=xterm-256color".into(),
                        "LANG=C.UTF-8".into(),
                        "LC_ALL=C.UTF-8".into(),
                        "TMUX_TMPDIR=/tmp/codehub".into(),
                    ]),
                    ..Default::default()
                },
            )
            .await?;

        let started = self
            .docker
            .start_exec(
                &exec.id,
                Some(StartExecOptions {
                    detach: false,
                    tty: true,
                    output_capacity: None,
                }),
            )
            .await?;

        match started {
            StartExecResults::Attached { output, input } => {
                self.docker
                    .resize_exec(
                        &exec.id,
                        ResizeExecOptions {
                            height: rows,
                            width: cols,
                        },
                    )
                    .await?;
                Ok(AttachHandles {
                    exec_id: exec.id,
                    output,
                    input,
                })
            },
            StartExecResults::Detached => Err(DockerError::ContainerDown(
                "exec detached unexpectedly".into(),
            )),
        }
    }

    pub async fn resize_exec(
        &self,
        exec_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), DockerError> {
        match self
            .docker
            .resize_exec(
                exec_id,
                ResizeExecOptions {
                    height: rows,
                    width: cols,
                },
            )
            .await
        {
            Ok(()) => Ok(()),
            // Fast-exiting CLIs can finish between attach and the first xterm fit.
            // Resizing an already-gone exec is harmless and should not surface as
            // a UI/backend error.
            Err(bollard::errors::Error::DockerResponseServerError {
                status_code: 404,
                message,
            }) if message.contains("process does not exist") => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// One-shot CPU / memory / net / disk snapshot. `stream: false` returns a
    /// single reading whose `precpu_stats` the daemon fills from its own prior
    /// sample, so the CPU delta is valid (a `one_shot` read zeroes precpu and
    /// can't). Errors when the container is down so the caller leaves the gauges
    /// blank rather than showing zeros.
    pub async fn stats(&self) -> Result<ContainerStats, DockerError> {
        self.require_running().await?;
        let s = self
            .docker
            .stats(
                &self.container,
                Some(StatsOptions {
                    stream: false,
                    one_shot: false,
                }),
            )
            .next()
            .await
            .ok_or_else(|| DockerError::ContainerDown(self.container.clone()))??;

        // CPU% per the docker formula: container-usage delta over system delta,
        // scaled by the number of online cores.
        let cpu_delta =
            s.cpu_stats.cpu_usage.total_usage as f64 - s.precpu_stats.cpu_usage.total_usage as f64;
        let sys_delta = s.cpu_stats.system_cpu_usage.unwrap_or(0) as f64
            - s.precpu_stats.system_cpu_usage.unwrap_or(0) as f64;
        let online = s
            .cpu_stats
            .online_cpus
            .or_else(|| {
                s.cpu_stats
                    .cpu_usage
                    .percpu_usage
                    .as_ref()
                    .map(|v| v.len() as u64)
            })
            .unwrap_or(1) as f64;
        let cpu_pct = if sys_delta > 0.0 && cpu_delta > 0.0 {
            (cpu_delta / sys_delta) * online * 100.0
        } else {
            0.0
        };

        // Memory: usage minus inactive file-cache, matching `docker stats`.
        let usage = s.memory_stats.usage.unwrap_or(0);
        let inactive = match s.memory_stats.stats {
            Some(MemoryStatsStats::V1(v)) => v.total_inactive_file,
            Some(MemoryStatsStats::V2(v)) => v.inactive_file,
            None => 0,
        };
        let mem_used = usage.saturating_sub(inactive);
        let mem_limit = s.memory_stats.limit.unwrap_or(0);

        // Net + disk: sum across interfaces / block devices.
        let (mut net_rx, mut net_tx) = (0u64, 0u64);
        if let Some(nets) = &s.networks {
            for n in nets.values() {
                net_rx += n.rx_bytes;
                net_tx += n.tx_bytes;
            }
        }
        let mut disk = 0u64;
        if let Some(entries) = &s.blkio_stats.io_service_bytes_recursive {
            for e in entries {
                let op = e.op.to_ascii_lowercase();
                if op == "read" || op == "write" {
                    disk += e.value;
                }
            }
        }

        Ok(ContainerStats {
            cpu_pct,
            mem_used,
            mem_limit,
            net_rx,
            net_tx,
            disk,
        })
    }

    /// Last `tail` lines of the runtime container's stdout+stderr (the `docker
    /// logs` tail), newest last. One-shot, not a follow stream — the Containers
    /// view re-polls. Errors when the container is down so the panel stays on its
    /// honest placeholder rather than showing a stale tail.
    pub async fn logs(&self, tail: u32) -> Result<Vec<String>, DockerError> {
        self.require_running().await?;
        let mut stream = self.docker.logs(
            &self.container,
            Some(LogsOptions::<String> {
                stdout: true,
                stderr: true,
                timestamps: false,
                tail: tail.to_string(),
                ..Default::default()
            }),
        );
        // Logs arrive as framed chunks that align to neither lines nor UTF-8
        // boundaries (a glyph can straddle two frames), so accumulate the raw
        // bytes and decode once at the end before splitting into lines.
        let mut buf: Vec<u8> = Vec::new();
        while let Some(chunk) = stream.next().await {
            buf.extend_from_slice(chunk?.into_bytes().as_ref());
        }
        Ok(String::from_utf8_lossy(&buf)
            .lines()
            .map(str::to_string)
            .collect())
    }

    /// The runtime container's bind/volume mounts, from `docker inspect`. Unlike
    /// the lifecycle config (which only knows what it *requested*), this reports
    /// what the container is actually running with. Errors when the container is
    /// missing; an empty list is valid (no mounts).
    pub async fn mounts(&self) -> Result<Vec<MountInfo>, DockerError> {
        let info = self.docker.inspect_container(&self.container, None).await?;
        Ok(info
            .mounts
            .unwrap_or_default()
            .into_iter()
            .filter_map(|m| {
                // A mount with no destination is meaningless to show; skip it.
                let destination = m.destination?;
                Some(MountInfo {
                    source: m.source.unwrap_or_default(),
                    destination,
                    rw: m.rw.unwrap_or(true),
                    // Display is the serde-rename-faithful token ("bind", "volume",
                    // …); fall back to "bind" only if the type is absent.
                    kind: m
                        .typ
                        .map(|t| t.to_string())
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| "bind".to_string()),
                })
            })
            .collect())
    }

    /// Identity of the image the runtime container runs (Containers view "Image"
    /// card): resolves the container's image ref via `inspect_container`, then
    /// `inspect_image` for tag/digest/created/size/arch/os. Like [`mounts`], this
    /// reads the actual container (no `is_running` gate) so it works for a stopped
    /// container too; errors only when the container/image can't be inspected, in
    /// which case the UI leaves the card em-dashed.
    pub async fn image_info(&self) -> Result<ImageInfo, DockerError> {
        let container = self.docker.inspect_container(&self.container, None).await?;
        // The container's resolved image (an id, `sha256:…`); fall back to the
        // configured image name if the id field is absent.
        let image_ref = container
            .image
            .or_else(|| container.config.and_then(|c| c.image))
            .ok_or_else(|| DockerError::ContainerDown(self.container.clone()))?;
        let img = self.docker.inspect_image(&image_ref).await?;
        // `repo_digests` entries look like `repo@sha256:…`; keep just the digest.
        let digest = img
            .repo_digests
            .and_then(|d| d.into_iter().next())
            .and_then(|rd| rd.rsplit_once('@').map(|(_, sha)| sha.to_string()));
        Ok(ImageInfo {
            id: img.id,
            tag: img.repo_tags.and_then(|t| t.into_iter().next()),
            digest,
            created: img.created,
            size: img.size,
            arch: img.architecture,
            os: img.os,
        })
    }

    /// Liveness of the runtime container (Containers view hero): started-at,
    /// restart count, status and OOM flag from `inspect_container`'s `State`.
    /// Like [`mounts`] and [`image_info`] this reads the real container with no
    /// `is_running` gate (a stopped container still has a `State`); it errors
    /// only when the container can't be inspected.
    pub async fn health(&self) -> Result<RuntimeHealth, DockerError> {
        let info = self.docker.inspect_container(&self.container, None).await?;
        let state = info.state;
        Ok(RuntimeHealth {
            // Docker reports the zero timestamp for a never-started container;
            // treat that (and an empty string) as "no uptime" rather than 1-AD.
            started_at: state
                .as_ref()
                .and_then(|s| s.started_at.clone())
                .filter(|s| !s.is_empty() && s != "0001-01-01T00:00:00Z"),
            restart_count: info.restart_count,
            status: state.as_ref().and_then(|s| s.status).map(|s| s.to_string()),
            oom_killed: state.as_ref().and_then(|s| s.oom_killed),
        })
    }

    /// Working-tree status of the `/workspace` mount via
    /// `git status --porcelain=v1 --branch`. Errors only when the container is
    /// down; "not a git repo" and "git not installed" both come back as
    /// `is_repo: false` so the UI shows an honest note rather than a fake-clean
    /// tree. `files` is capped at [`GIT_FILES_CAP`]; `total` is the full count.
    pub async fn git_status(&self) -> Result<GitStatus, DockerError> {
        self.require_running().await?;
        let raw = self
            .exec_capture(vec![
                "git",
                "-C",
                "/workspace",
                // Don't octal-escape non-ASCII paths; we still unquote the
                // double-quoted form (spaces, control chars) in the parser.
                "-c",
                "core.quotePath=false",
                "status",
                "--porcelain=v1",
                "--branch",
            ])
            .await?;
        Ok(parse_git_status(&raw))
    }

    /// Unified diff for one `/workspace` path. Tries `diff HEAD -- <path>` first
    /// (captures staged + unstaged changes to a tracked file vs the last
    /// commit); if that yields nothing — a brand-new untracked file, or a repo
    /// with no commits yet — falls back to `diff --no-index /dev/null <path>` so
    /// the new file shows as all-added. `path` is passed after `--` so it can
    /// never be read as an option. Errors only when the container is down.
    pub async fn git_diff(&self, path: &str) -> Result<String, DockerError> {
        self.require_running().await?;
        let tracked = self
            .exec_capture(vec![
                "git",
                "-C",
                "/workspace",
                "-c",
                "core.quotePath=false",
                "diff",
                "--no-color",
                "HEAD",
                "--",
                path,
            ])
            .await?;
        // A real tracked-file diff starts with "diff --git"; anything else
        // (empty, or a "fatal: bad revision HEAD" on a commit-less repo) means
        // fall through to the untracked/new-file path.
        if tracked.contains("diff --git") {
            return Ok(tracked);
        }
        let untracked = self
            .exec_capture(vec![
                "git",
                "-C",
                "/workspace",
                "-c",
                "core.quotePath=false",
                "diff",
                "--no-color",
                "--no-index",
                "--",
                "/dev/null",
                path,
            ])
            .await?;
        Ok(untracked)
    }

    /// Combined unified diff of every tracked change in `/workspace` vs the last
    /// commit (`diff HEAD`, no pathspec) — the "review everything this agent
    /// changed" view. Untracked files are not included (they're not in `HEAD`);
    /// the per-file `git_diff` handles those. Output without a `diff --git`
    /// marker (clean tree, or a `fatal: bad revision HEAD` on a commit-less repo)
    /// comes back as an empty string so the UI shows an honest empty state.
    /// Errors only when the container is down.
    pub async fn git_diff_all(&self) -> Result<String, DockerError> {
        self.require_running().await?;
        let out = self
            .exec_capture(vec![
                "git",
                "-C",
                "/workspace",
                "-c",
                "core.quotePath=false",
                "diff",
                "--no-color",
                "HEAD",
            ])
            .await?;
        if out.contains("diff --git") {
            Ok(out)
        } else {
            Ok(String::new())
        }
    }

    /// Unified diff of the staged changes in `/workspace` (`git diff --cached`):
    /// what a `git commit` right now would record. Backs the session-detail
    /// inspector's "Staged" filter. Empty string when nothing is staged (or a
    /// commit-less repo). Errors only when the container is down.
    pub async fn git_diff_staged(&self) -> Result<String, DockerError> {
        self.require_running().await?;
        let out = self
            .exec_capture(vec![
                "git",
                "-C",
                "/workspace",
                "-c",
                "core.quotePath=false",
                "diff",
                "--no-color",
                "--cached",
            ])
            .await?;
        Ok(if out.contains("diff --git") {
            out
        } else {
            String::new()
        })
    }

    /// Unified diff of the unstaged changes to tracked files in `/workspace`
    /// (`git diff`, no `--cached`): working tree vs the index. Backs the
    /// "Unstaged" filter. Untracked files are not included (they have no index
    /// entry); the rail's per-file `git_diff` covers those. Empty string when the
    /// tracked tree matches the index. Errors only when the container is down.
    pub async fn git_diff_unstaged(&self) -> Result<String, DockerError> {
        self.require_running().await?;
        let out = self
            .exec_capture(vec![
                "git",
                "-C",
                "/workspace",
                "-c",
                "core.quotePath=false",
                "diff",
                "--no-color",
            ])
            .await?;
        Ok(if out.contains("diff --git") {
            out
        } else {
            String::new()
        })
    }

    /// Stage every change in `/workspace` (`git add -A`) — new, modified, and
    /// deleted paths. Backs the session-detail "Stage all" action. Returns Ok on
    /// success; surfaces git's own message (verbatim) as the error otherwise (e.g.
    /// "not a git repository"). `add` is silent on success, so any non-empty
    /// output is treated as a failure. Errors only when the container is down.
    pub async fn git_stage_all(&self) -> Result<(), DockerError> {
        self.require_running().await?;
        let out = self
            .exec_capture(vec!["git", "-C", "/workspace", "add", "-A"])
            .await?;
        let out = out.trim();
        if out.is_empty() {
            Ok(())
        } else {
            Err(DockerError::Command(out.to_string()))
        }
    }

    /// Commit the staged changes in `/workspace` with `message` (`git commit -m`).
    /// The message is passed as a discrete argv element — never through a shell —
    /// so it can't be misread as an option or injected. On success returns git's
    /// summary line (e.g. "[main a1b2c3d] subject"); on failure (nothing staged,
    /// no committer identity configured, not a repo) returns git's own words so
    /// the UI can show the real reason rather than a generic error. Identity is
    /// NOT fabricated — an unconfigured `user.name`/`user.email` surfaces git's
    /// "Please tell me who you are" verbatim. Errors only when the container is
    /// down.
    pub async fn git_commit(&self, message: &str) -> Result<String, DockerError> {
        self.require_running().await?;
        let out = self
            .exec_capture(vec!["git", "-C", "/workspace", "commit", "-m", message])
            .await?;
        // exec_capture merges stdout+stderr without an exit code, so classify by
        // git's success line rather than scanning for failure substrings: a
        // successful commit prints "[<branch> <short-hash>] <subject>" (and
        // "[<branch> (root-commit) <hash>] …" for the first commit). Anchoring on
        // that bracketed prefix — which carries a >=7-char hex hash — avoids a
        // false failure when the commit *subject* itself contains "error:" /
        // "fatal:" (e.g. committing a message like "fix: error: handling").
        let committed = out.lines().any(|line| commit_success_line(line.trim()));
        if committed {
            Ok(out.trim().to_string())
        } else {
            Err(DockerError::Command(out.trim().to_string()))
        }
    }

    /// Open a GitHub pull request for the current `/workspace` branch.
    ///
    /// There is no `gh` CLI in the runtime image, so this drives the GitHub REST
    /// API directly (mirroring [`github_status`](Self::github_status)): the
    /// `GITHUB_TOKEN` is referenced by NAME inside an in-container `sh -c` — it
    /// never appears in the Rust argv or a log. Two steps:
    ///   1. Preflight (in-container): resolve the current branch, the `origin`
    ///      owner/repo slug, and the repo's default base branch. Any missing
    ///      precondition (no token, detached HEAD, no `origin`, not a repo) comes
    ///      back as an honest `ERR*` marker and is mapped to a descriptive error —
    ///      nothing is fabricated.
    ///   2. Push the branch (`git push -u origin HEAD`, authed via an in-shell
    ///      credential helper that reads `$GITHUB_TOKEN` — token never in argv),
    ///      then `POST /repos/<slug>/pulls`. `title`/`body` are serialized to JSON
    ///      in Rust (proper escaping) and handed to the script as a positional arg
    ///      (`$1`), so they're never shell-parsed.
    ///
    /// Returns the new PR's `html_url` on success. Errors when the container is
    /// down; every other failure (no token, push rejected, API error) is a
    /// descriptive `Command` error carrying GitHub's / git's own message.
    pub async fn git_open_pr(
        &self,
        title: &str,
        body: &str,
        token: &str,
    ) -> Result<String, DockerError> {
        self.require_running().await?;
        const VAR: &str = "GITHUB_TOKEN";
        // `token` is the resolved credential (vault or host env), passed by the
        // caller. It's forwarded into each exec via the structured `env` field
        // (never argv/logs) — `exec_capture` does not otherwise propagate it, so
        // the in-shell `${GITHUB_TOKEN}` reference would be empty without this.
        if token.is_empty() {
            return Err(DockerError::Command(
                "no GitHub token — connect GitHub in Source control to open a PR".into(),
            ));
        }
        let token_env = vec![format!("{VAR}={token}")];

        // Step 1 — preflight. Token referenced by name in-container only.
        let pre = self
            .exec_capture_env(
                vec![
                    "sh",
                    "-c",
                    r#"cd /workspace 2>/dev/null || { echo ERRNOWS; exit 0; }
b=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || { echo ERRNOREPO; exit 0; }
[ "$b" = HEAD ] && { echo ERRDETACHED; exit 0; }
u=$(git remote get-url origin 2>/dev/null) || { echo ERRNOORIGIN; exit 0; }
slug=$(printf %s "$u" | sed -E 's#^.*github.com[:/]##; s#\.git$##')
[ -z "$slug" ] && { echo ERRNOORIGIN; exit 0; }
base=$(curl -s -f -H "Authorization: token ${GITHUB_TOKEN}" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$slug" 2>/dev/null | sed -n 's/.*"default_branch": *"\([^"]*\)".*/\1/p' | head -1)
[ -z "$base" ] && base=main
printf 'OK\n%s\n%s\n%s\n' "$b" "$slug" "$base""#,
                ],
                &token_env,
            )
            .await?;
        let mut lines = pre.lines();
        match lines.next().map(str::trim) {
            Some("OK") => {},
            Some("ERRNOWS") => return Err(DockerError::Command("no /workspace in runtime".into())),
            Some("ERRNOREPO") => {
                return Err(DockerError::Command(
                    "/workspace is not a git repository".into(),
                ))
            },
            Some("ERRDETACHED") => {
                return Err(DockerError::Command(
                    "detached HEAD — check out a branch before opening a PR".into(),
                ))
            },
            Some("ERRNOORIGIN") => {
                return Err(DockerError::Command(
                    "no GitHub `origin` remote on /workspace".into(),
                ))
            },
            other => {
                return Err(DockerError::Command(format!(
                    "PR preflight failed: {}",
                    other.unwrap_or("").trim()
                )))
            },
        }
        let branch = lines.next().unwrap_or("").trim();
        let slug = lines.next().unwrap_or("").trim();
        let base = lines.next().unwrap_or("main").trim();
        if branch.is_empty() || slug.is_empty() {
            return Err(DockerError::Command("could not resolve branch/repo".into()));
        }
        if branch == base {
            return Err(DockerError::Command(format!(
                "current branch is the base branch ({base}) — nothing to PR"
            )));
        }

        // JSON built in Rust → proper escaping of user-supplied title/body.
        let payload = serde_json::json!({
            "title": title,
            "head": branch,
            "base": base,
            "body": body,
        })
        .to_string();

        // Step 2 — push + create. slug/json are positional args ($2/$1), never
        // shell-parsed; the token is only ever an in-shell env reference (incl.
        // the credential helper, so it never reaches git's argv either).
        let out = self
            .exec_capture_env(
                vec![
                    "sh",
                    "-c",
                    r#"cd /workspace || { echo ERRNOWS; exit 0; }
git -c credential.helper='!f(){ echo username=x-access-token; echo "password=${GITHUB_TOKEN}"; };f' push -u origin HEAD >/dev/null 2>&1 || { echo ERRPUSH; exit 0; }
printf %s "$1" > /tmp/codehub-pr.json
curl -s -X POST -H "Authorization: token ${GITHUB_TOKEN}" -H "Accept: application/vnd.github+json" -d @/tmp/codehub-pr.json "https://api.github.com/repos/$2/pulls"
rm -f /tmp/codehub-pr.json"#,
                    "sh",
                    &payload,
                    slug,
                ],
                &token_env,
            )
            .await?;
        let out = out.trim();
        if out.starts_with("ERRPUSH") {
            return Err(DockerError::Command(format!(
                "could not push `{branch}` to origin (auth or remote rejected)"
            )));
        }
        match serde_json::from_str::<serde_json::Value>(out) {
            Ok(v) => {
                if let Some(url) = v.get("html_url").and_then(|u| u.as_str()) {
                    Ok(url.to_string())
                } else {
                    // GitHub error body: surface its `message` (e.g. "A pull
                    // request already exists", "Validation Failed").
                    let msg = v
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("GitHub rejected the pull request");
                    Err(DockerError::Command(msg.to_string()))
                }
            },
            Err(_) => Err(DockerError::Command(
                "unexpected response from GitHub when creating the PR".into(),
            )),
        }
    }

    /// Processes running inside the runtime container, via `docker top` (default
    /// `ps` args). Uses the host's `ps` against the container PID namespace, so
    /// it works even on a minimal image with no `ps` of its own. Column layout
    /// varies by platform, so `parse_top` maps by title rather than by position.
    /// Errors only when the container is down.
    pub async fn top(&self) -> Result<Vec<ProcessInfo>, DockerError> {
        self.require_running().await?;
        let resp = self
            .docker
            .top_processes(&self.container, None::<TopOptions<String>>)
            .await?;
        let titles = resp.titles.unwrap_or_default();
        let rows = resp.processes.unwrap_or_default();
        Ok(parse_top(&titles, &rows))
    }

    /// Recent commits on the `/workspace` working tree (Dashboard "Recent
    /// commits"). Fields are joined by US (\x1f) and split in `parse_git_log` so
    /// a subject with spaces stays intact. `limit` is clamped to `GIT_LOG_CAP`.
    /// Not-a-repo / no-commits-yet come back as an empty list (the UI shows an
    /// honest note); errors only when the container is down.
    pub async fn git_log(&self, limit: u32) -> Result<Vec<CommitInfo>, DockerError> {
        self.require_running().await?;
        let n = format!("-n{}", limit.clamp(1, GIT_LOG_CAP));
        let raw = self
            .exec_capture(vec![
                "git",
                "-C",
                "/workspace",
                "-c",
                "core.quotePath=false",
                "log",
                "--no-color",
                &n,
                "--pretty=format:%H%x1f%an%x1f%ar%x1f%s",
            ])
            .await?;
        Ok(parse_git_log(&raw))
    }

    /// Non-recursive listing of a `/workspace` directory (Files browser). `path`
    /// is confined to `/workspace` ([`workspace_path`] rejects traversal); empty
    /// → the workspace root. Uses `find -maxdepth 1` with a `%y\t%s\t%f` format
    /// (type / size / name) so the output is unambiguous regardless of locale,
    /// unlike parsing `ls`. Capped at [`DIR_ENTRIES_CAP`]. Errors when the
    /// container is down or the path escapes the workspace.
    pub async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>, DockerError> {
        self.require_running().await?;
        let dir = workspace_path(path)?;
        let raw = self
            .exec_capture(vec![
                "find",
                &dir,
                "-maxdepth",
                "1",
                "-mindepth",
                "1",
                "-printf",
                "%y\t%s\t%f\n",
            ])
            .await?;
        Ok(parse_find(&raw))
    }

    /// Immediate subdirectories of a `/workspace` path, each flagged if it is a
    /// git repo (with its branch). Powers the agent-pane working-directory
    /// browser: a multi-repo mount nests repos arbitrarily deep, so the user
    /// drills the tree one level at a time instead of relying on the depth-2
    /// [`container_repos`](Self::container_repos) discovery. One `bash` pass, so
    /// a level costs a single exec. Capped at [`DIR_ENTRIES_CAP`].
    pub async fn browse_dirs(&self, path: &str) -> Result<Vec<DirEntry>, DockerError> {
        self.require_running().await?;
        let dir = workspace_path(path)?;
        // For each immediate child directory print `R|D<TAB>branch<TAB>name`:
        // `R` when it holds a `.git` (with its branch), else `D`. stderr is
        // dropped so a `git` call on a non-repo can't pollute the listing. `*/`
        // skips dotfiles; the `[ -d ]` guard handles the no-match literal glob.
        let script = "cd \"$1\" 2>/dev/null || exit 0; for d in */; do [ -d \"$d\" ] || continue; n=\"${d%/}\"; if [ -e \"$n/.git\" ]; then b=$(git -C \"$n\" branch --show-current 2>/dev/null); printf 'R\\t%s\\t%s\\n' \"$b\" \"$n\"; else printf 'D\\t\\t%s\\n' \"$n\"; fi; done";
        let raw = self
            .exec_capture(vec!["bash", "-c", script, "_", &dir])
            .await?;
        Ok(parse_browse_dirs(&raw))
    }

    /// First [`FILE_READ_CAP`] bytes of a `/workspace` file (Files browser
    /// preview). `path` is confined to `/workspace`. `head -c` caps the read at
    /// the source so a huge file never streams into memory; the bytes are
    /// returned UTF-8-lossy (binary files show replacement chars — the UI notes
    /// the cap). Errors when the container is down or the path escapes.
    pub async fn read_file(&self, path: &str) -> Result<String, DockerError> {
        self.require_running().await?;
        let file = workspace_path(path)?;
        // `workspace_path` only validates the path *text*; `head` would still
        // follow a symlink (or a symlinked parent dir) that points out of the
        // mount. Resolve the real path in-container and re-confine it so the
        // `/workspace` guarantee holds for the bytes actually read, not just the
        // requested name. `-m` canonicalizes without requiring the file to exist
        // (a missing file then fails at the `head` below, as before).
        let canonical = self
            .exec_capture(vec!["readlink", "-m", "--", &file])
            .await?;
        let canonical = canonical.trim();
        if canonical.is_empty() {
            return Err(DockerError::InvalidPath(file));
        }
        let real = workspace_path(canonical)?;
        let cap = FILE_READ_CAP.to_string();
        // `--` ends option parsing so a path starting with `-` is still a path.
        self.exec_capture(vec!["head", "-c", &cap, "--", &real])
            .await
    }

    /// Aggregate token-usage analytics from Claude Code's on-disk session
    /// transcripts under `$CLAUDE_CONFIG_DIR/projects/**/*.jsonl` (the runtime
    /// pins `CLAUDE_CONFIG_DIR=/config/claude`, on the persistent `/config`
    /// mount). Concatenates every transcript — each JSONL line carries its own
    /// `sessionId`, so file boundaries don't matter — and folds the `usage`
    /// blocks of `assistant` lines into real token totals plus an estimated cost
    /// (see [`parse_claude_usage`]). Errors only when the container is down; a
    /// missing `projects` dir yields an all-zero report, not an error.
    /// Concatenate every Claude transcript JSONL under the projects dir — the
    /// shared on-disk source for both [`claude_usage`](Self::claude_usage) and
    /// [`claude_sessions`](Self::claude_sessions). `find … -exec cat {} +` batches
    /// the reads; transcripts are newline-terminated JSONL so concatenation never
    /// fuses two lines. `2>/dev/null` + `|| true` keep a missing projects dir from
    /// erroring — the parser simply sees no input. Routed through `sh -c` for the
    /// glob/redirect. Errors only when the container is down.
    async fn cat_all_transcripts(&self) -> Result<String, DockerError> {
        self.require_running().await?;
        self.exec_capture(vec![
            "sh",
            "-c",
            "find /config/claude/projects /config/claude-profiles/*/projects -type f -name '*.jsonl' -exec cat {} + 2>/dev/null || true",
        ])
        .await
    }

    pub async fn claude_usage(&self) -> Result<ClaudeUsage, DockerError> {
        Ok(parse_claude_usage(&self.cat_all_transcripts().await?))
    }

    /// List past Claude Code conversations from their on-disk transcripts (same
    /// source as [`claude_usage`]) so they can be reopened with `--resume`. Each
    /// distinct `sessionId` becomes one [`ClaudeSession`]; see [`parse_claude_sessions`]
    /// for how title/branch/turns are derived. Errors only when the container is
    /// down; a missing `projects` dir yields an empty list, not an error.
    pub async fn claude_sessions(&self) -> Result<Vec<ClaudeSession>, DockerError> {
        Ok(parse_claude_sessions(&self.cat_all_transcripts().await?))
    }

    /// Live token tally for one Claude session, read from its own transcript
    /// (`<id>.jsonl`, where `id` is the `--session-id` it was launched with).
    /// `None` when the id is not a plausible session id (defensive: it is
    /// interpolated into a path) or the transcript has no usable usage data yet
    /// (a brand-new session that hasn't responded). Errors only when the
    /// container is down. Reuses the deduped fold from [`parse_claude_usage`].
    pub async fn claude_session_usage(
        &self,
        id: &str,
    ) -> Result<Option<SessionUsage>, DockerError> {
        if !is_session_id(id) {
            return Ok(None);
        }
        self.require_running().await?;
        // `id` is validated to `[0-9A-Za-z-]`, so it is safe to interpolate into
        // this fixed `find` expression. Account-backed Claude sessions may use a
        // per-profile config dir under `/config/claude-profiles`. The project dir
        // is slugged from the agent's CWD (`/workspace/foo` → `-workspace-foo`),
        // so match the id under ANY project dir — a sub-dir agent's transcript is
        // NOT under `-workspace`. The id is a unique uuid, so this can't collide.
        let script = format!(
            "find /config/claude/projects /config/claude-profiles/*/projects -path '*/projects/*/{id}.jsonl' -exec cat {{}} + 2>/dev/null || true"
        );
        let raw = self.exec_capture(vec!["sh", "-c", &script]).await?;
        let u = parse_claude_usage(&raw);
        // turns == 0 means no usable response yet → report nothing (em-dash).
        // edits is read from the same assistant lines, so reporting it only
        // alongside a real turn keeps the two counts in step.
        if u.turns == 0 {
            return Ok(None);
        }
        Ok(Some(SessionUsage {
            turns: u.turns,
            tokens_in: u.totals.input,
            tokens_out: u.totals.output,
            edits: count_session_edits(&raw),
            context_used: latest_context_used(&raw),
            context_window: latest_claude_model(&raw)
                .map(|m| claude_context_window(&m))
                .unwrap_or(0),
        }))
    }

    /// What the runtime's Claude is connected to (Integrations view): the
    /// signed-in account + configured MCP servers, read from `~/.claude.json`
    /// and the workspace `.mcp.json`. Both files are `cat`'d as plain argv (no
    /// shell, fixed paths); a missing `.mcp.json` just yields a non-JSON read
    /// that the parser ignores. Identity only — no credential is surfaced.
    pub async fn claude_integrations(&self) -> Result<ClaudeIntegrations, DockerError> {
        self.require_running().await?;
        let cfg = self
            .exec_capture(vec!["cat", "/config/claude/.claude.json"])
            .await
            .unwrap_or_default();
        let mcp = self
            .exec_capture(vec!["cat", "/workspace/.mcp.json"])
            .await
            .unwrap_or_default();
        Ok(parse_claude_integrations(&cfg, &mcp))
    }

    /// The runtime Claude's configurable surface (Agent settings detail), read
    /// entirely from on-disk config. Active model + default permission mode come
    /// from `~/.claude.json` and `settings.json`; sub-agents and skills are read
    /// from the `.claude/agents` and `.claude/skills` trees (user + project
    /// scope); plugins + marketplaces from the plugins config. Every read is
    /// best-effort: a missing file just contributes nothing, so the result is
    /// always a valid (possibly-empty) [`AgentConfig`] rather than an error.
    /// Errors only when the container is down. Identity/config only — no secret.
    pub async fn claude_agent_config(&self) -> Result<AgentConfig, DockerError> {
        self.require_running().await?;
        let cfg = self
            .exec_capture(vec!["cat", "/config/claude/.claude.json"])
            .await
            .unwrap_or_default();
        let settings = self
            .exec_capture(vec!["cat", "/config/claude/settings.json"])
            .await
            .unwrap_or_default();
        let marketplaces = self
            .exec_capture(vec![
                "cat",
                "/config/claude/plugins/known_marketplaces.json",
            ])
            .await
            .unwrap_or_default();
        // Concatenate every agent .md (user + project scope) with a delimiter
        // line carrying the path, so one read covers both scopes and the parser
        // can attribute each file. Missing dirs are silenced by `2>/dev/null`.
        let agents_raw = self
            .exec_capture(vec![
                "sh",
                "-c",
                "for f in /config/claude/agents/*.md /workspace/.claude/agents/*.md; do [ -f \"$f\" ] && printf '===CODEHUB-FILE:%s===\\n' \"$f\" && cat \"$f\"; done 2>/dev/null || true",
            ])
            .await
            .unwrap_or_default();
        let skills_raw = self
            .exec_capture(vec![
                "sh",
                "-c",
                "for f in /config/claude/skills/*/SKILL.md /workspace/.claude/skills/*/SKILL.md; do [ -f \"$f\" ] && printf '===CODEHUB-FILE:%s===\\n' \"$f\" && cat \"$f\"; done 2>/dev/null || true",
            ])
            .await
            .unwrap_or_default();
        Ok(parse_agent_config(
            &cfg,
            &settings,
            &agents_raw,
            &skills_raw,
            &marketplaces,
        ))
    }

    // ── Codex usage reader ───────────────────────────────────────────────────

    /// Aggregate token analytics read from Codex's on-disk rollout files
    /// (`/config/codex/sessions/**/rollout-*.jsonl`). Mirrors the Claude usage
    /// surface but uses Codex's per-turn `token_count` event payload. Errors only
    /// when the container is down; a missing sessions dir yields an all-zero report.
    pub async fn codex_usage(&self) -> Result<crate::types::CodexUsage, DockerError> {
        Ok(parse_codex_usage(&self.cat_all_rollouts().await?))
    }

    /// Concatenate every Codex rollout JSONL under the sessions dir — the shared
    /// on-disk source for both [`codex_usage`](Self::codex_usage) and
    /// [`codex_sessions`](Self::codex_sessions). Same batched-`cat`,
    /// newline-safe, error-swallowing shape as
    /// [`cat_all_transcripts`](Self::cat_all_transcripts). Errors only when down.
    async fn cat_all_rollouts(&self) -> Result<String, DockerError> {
        self.require_running().await?;
        self.exec_capture(vec![
            "sh",
            "-c",
            "find /config/codex/sessions /config/codex-profiles/*/sessions -type f -name 'rollout-*.jsonl' -exec cat {} + 2>/dev/null || true",
        ])
        .await
    }

    // ── GitHub connector ────────────────────────────────────────────────────
    // Status + repos moved HOST-side (vault::github_fetch_*) so they work with no
    // workspace container running. `git_open_pr` below stays in-container (it
    // needs the workspace's git tree); it takes the resolved token as an arg.

    /// Past Codex conversations from rollout files (Resume view), newest first.
    pub async fn codex_sessions(&self) -> Result<Vec<crate::types::CodexSession>, DockerError> {
        Ok(parse_codex_sessions(&self.cat_all_rollouts().await?))
    }

    /// Live per-session Codex tally from the session's OWN rollout file. `id` is the
    /// Codex conversation/rollout uuid (the notify `thread-id`, captured per session
    /// via codehub-hook → `activity::codex_id`). Rollouts are named
    /// `rollout-<ts>-<uuid>.jsonl`, so this matches the one file carrying that uuid.
    /// `None` when there is no usable data yet.
    pub async fn codex_session_usage(
        &self,
        id: &str,
    ) -> Result<Option<crate::types::CodexSessionUsage>, DockerError> {
        // Guard against glob/path injection: a rollout uuid is alphanumeric + dashes
        // only (no slash, no dot — so `*` and `..` can't be smuggled into the glob).
        if id.is_empty()
            || id.len() > 64
            || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return Ok(None);
        }
        self.require_running().await?;
        let pattern = format!(
            "find /config/codex/sessions /config/codex-profiles/*/sessions -type f -name 'rollout-*{id}.jsonl' -exec cat {{}} + 2>/dev/null || true"
        );
        let raw = self.exec_capture(vec!["sh", "-c", &pattern]).await?;
        Ok(codex_session_usage_from_raw(&raw))
    }

    /// Codex rate-limit / plan meters from the latest rollout file entry.
    /// `None` when no data is on disk.
    pub async fn codex_rate_limits(
        &self,
    ) -> Result<Option<crate::types::CodexRateLimits>, DockerError> {
        self.require_running().await?;
        // Read only the most recent rollout file (sorted by name, last = newest).
        let raw = self
            .exec_capture(vec![
                "sh",
                "-c",
                "f=$(find /config/codex/sessions /config/codex-profiles/*/sessions -type f -name 'rollout-*.jsonl' 2>/dev/null | sort | tail -1); [ -n \"$f\" ] && cat \"$f\" || true",
            ])
            .await?;
        Ok(extract_codex_rate_limits(&raw))
    }

    /// List environment variables in the container, filtering out auth secrets.
    pub async fn container_env(&self) -> Result<Vec<EnvEntry>, DockerError> {
        self.require_running().await?;
        let raw = self.exec_capture(vec!["env"]).await?;
        let secret_vars: std::collections::HashSet<&str> = [
            "CLAUDE_CODE_OAUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "GOOGLE_API_KEY",
            "GEMINI_API_KEY",
            "GITHUB_TOKEN",
        ]
        .into_iter()
        .collect();
        Ok(raw
            .lines()
            .filter_map(|line| {
                let (name, value) = line.split_once('=')?;
                if secret_vars.contains(name) || name.starts_with("CODEHUB_VAULT_") {
                    None
                } else {
                    Some(EnvEntry {
                        name: name.to_string(),
                        value: value.to_string(),
                    })
                }
            })
            .collect())
    }

    /// Discover git repos under `/workspace` (max depth 2).
    pub async fn container_repos(&self) -> Result<Vec<RepoInfo>, DockerError> {
        self.require_running().await?;
        let raw = self
            .exec_capture(vec![
                "find",
                "/workspace",
                "-maxdepth",
                "2",
                "-name",
                ".git",
                "-type",
                "d",
            ])
            .await?;
        let mut repos = Vec::new();
        for line in raw.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let repo_path = line.strip_suffix("/.git").unwrap_or(line);
            let branch = self
                .exec_capture(vec!["git", "-C", repo_path, "branch", "--show-current"])
                .await
                .ok()
                .and_then(|b| {
                    let b = b.trim().to_string();
                    if b.is_empty() {
                        None
                    } else {
                        Some(b)
                    }
                });
            repos.push(RepoInfo {
                path: repo_path.to_string(),
                branch,
            });
        }
        Ok(repos)
    }

    /// Clone a GitHub repo (`owner/repo`) into `target` (an in-container path under
    /// `/workspace`, which is host-bind-mounted so the files persist) using `gh`,
    /// with the token passed via the exec env (`GH_TOKEN`) so it never appears in
    /// argv or a log — the same structured-env channel `exec_capture_env` uses for
    /// other secrets. The cloned `origin` keeps the clean `https://github.com/...`
    /// URL (gh doesn't embed the token). Caller MUST pre-validate both args to
    /// `[A-Za-z0-9._/-]` (they ride an `sh -c` string). Idempotent: an existing
    /// `<target>/.git` short-circuits to Ok. Returns `target` on success; a non-OK
    /// clone surfaces gh's combined output as the error.
    pub async fn github_clone(
        &self,
        name_with_owner: &str,
        token: &str,
        target: &str,
    ) -> Result<String, DockerError> {
        self.require_running().await?;
        let valid = |s: &str| {
            !s.is_empty()
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
        };
        if !name_with_owner.contains('/') || !valid(name_with_owner) {
            return Err(DockerError::Command(
                "invalid repo: expected owner/repo".into(),
            ));
        }
        if !target.starts_with("/workspace") || !valid(target) {
            return Err(DockerError::Command("invalid clone target".into()));
        }
        // exec_capture_env returns combined output, not an exit code, so an explicit
        // sentinel is the reliable success signal. A pre-existing checkout is reused.
        let script = format!(
            "if [ -d {target}/.git ]; then echo __CLONE_OK__; \
             else gh repo clone {name_with_owner} {target} 2>&1 && echo __CLONE_OK__; fi"
        );
        let env = vec![format!("GH_TOKEN={token}")];
        let output = self
            .exec_capture_env(vec!["sh", "-c", &script], &env)
            .await?;
        if output.contains("__CLONE_OK__") {
            Ok(target.to_string())
        } else {
            Err(DockerError::Command(output))
        }
    }

    /// Clone a git repo by URL into `/workspace/<repo-name>`.
    pub async fn git_clone(&self, url: &str) -> Result<String, DockerError> {
        self.require_running().await?;
        if url.is_empty()
            || !(url.starts_with("https://")
                || url.starts_with("http://")
                || url.starts_with("git@")
                || url.starts_with("ssh://"))
        {
            return Err(DockerError::Command(
                "invalid git URL: must start with https://, http://, git@, or ssh://".into(),
            ));
        }
        let output = self
            .exec_capture(vec!["git", "-C", "/workspace", "clone", url])
            .await?;
        let cloned_dir = url
            .rsplit('/')
            .next()
            .unwrap_or("repo")
            .strip_suffix(".git")
            .unwrap_or(url.rsplit('/').next().unwrap_or("repo"));
        let path = format!("/workspace/{cloned_dir}");
        if output.contains("fatal:") {
            Err(DockerError::Command(output))
        } else {
            Ok(path)
        }
    }

    /// Runtime tool versions (node, tmux, git) from inside the container.
    pub async fn runtime_versions(&self) -> Result<crate::lifecycle::RuntimeVersions, DockerError> {
        self.require_running().await?;
        let (node, tmux, git) = tokio::join!(
            self.exec_capture(vec!["node", "--version"]),
            self.exec_capture(vec!["tmux", "-V"]),
            self.exec_capture(vec!["git", "--version"]),
        );
        let clean = |r: Result<String, DockerError>| {
            r.ok().and_then(|s| {
                let s = s.trim().to_string();
                if s.is_empty() || s.contains("not found") {
                    None
                } else {
                    Some(s)
                }
            })
        };
        Ok(crate::lifecycle::RuntimeVersions {
            node: clean(node),
            tmux: clean(tmux),
            git: clean(git),
        })
    }

    /// Search transcripts for a query string. Returns matching session ids + snippets.
    pub async fn search_transcripts(
        &self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<SearchHit>, DockerError> {
        self.require_running().await?;
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let safe_query = shell_single_quote(query);
        let cmd = format!(
            "grep -r -i -l {} /root/.claude/projects/ --include='*.jsonl' 2>/dev/null | head -{}",
            safe_query, limit
        );
        let raw = self.exec_capture(vec!["sh", "-c", &cmd]).await?;
        let mut hits = Vec::new();
        for path in raw.lines() {
            let path = path.trim();
            if path.is_empty() {
                continue;
            }
            let session_id = path
                .rsplit('/')
                .next()
                .unwrap_or(path)
                .strip_suffix(".jsonl")
                .unwrap_or(path)
                .to_string();
            let snippet_cmd = format!(
                "grep -i -m1 {} {} 2>/dev/null | head -c 200",
                safe_query,
                shell_single_quote(path)
            );
            let snippet = self
                .exec_capture(vec!["sh", "-c", &snippet_cmd])
                .await
                .unwrap_or_default()
                .trim()
                .to_string();
            hits.push(SearchHit {
                session_id,
                title: None,
                snippet,
                at: None,
            });
        }
        Ok(hits)
    }

    /// Stage a single file by path.
    pub async fn git_stage_file(&self, path: &str) -> Result<(), DockerError> {
        let safe = workspace_path(path)?;
        self.require_running().await?;
        let out = self
            .exec_capture(vec!["git", "-C", "/workspace", "add", "--", &safe])
            .await?;
        let out = out.trim();
        if out.is_empty() {
            Ok(())
        } else {
            Err(DockerError::Command(out.to_string()))
        }
    }

    /// Unstage a single file.
    pub async fn git_unstage_file(&self, path: &str) -> Result<(), DockerError> {
        let safe = workspace_path(path)?;
        self.require_running().await?;
        let out = self
            .exec_capture(vec![
                "git",
                "-C",
                "/workspace",
                "reset",
                "HEAD",
                "--",
                &safe,
            ])
            .await?;
        // reset prints the unstaged path — not an error.
        let _ = out;
        Ok(())
    }

    /// Apply a patch to the staging area (per-hunk staging).
    pub async fn git_stage_hunk(&self, patch: &str) -> Result<(), DockerError> {
        self.require_running().await?;
        let tmp = "/tmp/codehub-stage-hunk.patch";
        let write_cmd = format!(
            "cat > {} << 'CODEHUB_PATCH_EOF'\n{}\nCODEHUB_PATCH_EOF",
            tmp, patch
        );
        self.exec_capture(vec!["sh", "-c", &write_cmd]).await?;
        let out = self
            .exec_capture(vec!["git", "-C", "/workspace", "apply", "--cached", tmp])
            .await?;
        let _ = self.exec_capture(vec!["rm", "-f", tmp]).await;
        let out = out.trim();
        if out.is_empty() || !out.contains("error") {
            Ok(())
        } else {
            Err(DockerError::Command(out.to_string()))
        }
    }

    /// Set Claude Code's active model in the container's settings.
    pub async fn set_claude_model(&self, model: &str) -> Result<(), DockerError> {
        self.require_running().await?;
        let cmd = format!(
            r#"f=/root/.claude/settings.json; [ -f "$f" ] && contents=$(cat "$f") || contents='{{}}'; echo "$contents" | jq --arg m '{}' '.model = $m' > "$f""#,
            shell_single_quote(model)
        );
        self.exec_capture(vec!["sh", "-c", &cmd]).await?;
        Ok(())
    }

    /// Set Claude Code's default permission mode.
    pub async fn set_permission_mode(&self, mode: &str) -> Result<(), DockerError> {
        self.require_running().await?;
        let cmd = format!(
            r#"f=/root/.claude/settings.json; [ -f "$f" ] && contents=$(cat "$f") || contents='{{}}'; echo "$contents" | jq --arg m '{}' '.permissions.defaultMode = $m' > "$f""#,
            shell_single_quote(mode)
        );
        self.exec_capture(vec!["sh", "-c", &cmd]).await?;
        Ok(())
    }

    /// Set Claude Code's permission rules for a bucket (allow/ask/deny).
    pub async fn set_permission_rules(
        &self,
        bucket: &str,
        rules: &[String],
    ) -> Result<(), DockerError> {
        self.require_running().await?;
        if !["allow", "ask", "deny"].contains(&bucket) {
            return Err(DockerError::Command(format!(
                "invalid permission bucket: {bucket}"
            )));
        }
        let json_arr = serde_json::to_string(rules).unwrap_or_else(|_| "[]".into());
        let cmd = format!(
            r#"f=/root/.claude/settings.json; [ -f "$f" ] && contents=$(cat "$f") || contents='{{}}'; echo "$contents" | jq --argjson r '{}' '.permissions.{} = $r' > "$f""#,
            shell_single_quote(&json_arr),
            bucket
        );
        self.exec_capture(vec!["sh", "-c", &cmd]).await?;
        Ok(())
    }

    /// Toggle an MCP server's enabled state in Claude Code config.
    pub async fn toggle_mcp_server(&self, name: &str, enabled: bool) -> Result<(), DockerError> {
        self.require_running().await?;
        let disabled_val = if enabled { "false" } else { "true" };
        let cmd = format!(
            r#"f=/root/.claude/settings.json; [ -f "$f" ] && contents=$(cat "$f") || contents='{{}}'; echo "$contents" | jq --arg n '{}' --argjson d {} '.mcpServers[$n].disabled = $d' > "$f""#,
            shell_single_quote(name),
            disabled_val
        );
        self.exec_capture(vec!["sh", "-c", &cmd]).await?;
        Ok(())
    }
}

/// Scope label for a `.claude` config path: "project" under `/workspace`, else
/// "user" (the `/config/claude` home).
fn scope_for_path(path: &str) -> String {
    if path.starts_with("/workspace/") {
        "project".to_string()
    } else {
        "user".to_string()
    }
}

/// Parse a markdown file's leading YAML frontmatter (the block delimited by a
/// `---` line at the very top and the next `---`) into key→value strings. Only
/// scalar `key: value` lines are read; nested structures collapse to their raw
/// text. Returns an empty map when there is no frontmatter. Deliberately tiny —
/// we read only a handful of known keys and never execute or fully parse YAML.
fn parse_frontmatter(body: &str) -> std::collections::HashMap<String, String> {
    use std::collections::HashMap;
    let mut map = HashMap::new();
    let mut lines = body.lines();
    // Frontmatter must start on the first non-empty line with a `---` fence.
    let mut started = false;
    for line in lines.by_ref() {
        if line.trim().is_empty() {
            continue;
        }
        started = line.trim() == "---";
        break;
    }
    if !started {
        return map;
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim().to_string();
            let val = v.trim().trim_matches(['"', '\'']).to_string();
            if !key.is_empty() {
                map.insert(key, val);
            }
        }
    }
    map
}

/// Split a frontmatter `tools` value into individual tool names. Accepts a YAML
/// inline array (`[Read, Edit]`) or a comma/space-separated list (`Read, Edit`).
fn parse_tools_field(raw: &str) -> Vec<String> {
    raw.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split([',', ' '])
        .map(|t| t.trim().trim_matches(['"', '\'']))
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

/// Split a `===CODEHUB-FILE:<path>===\n<body>` bundle (as emitted by the agent/
/// skill `cat` loops) into `(path, body)` pairs. The delimiter is unique enough
/// that real file content can't forge it.
fn split_file_bundle(raw: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for chunk in raw.split("===CODEHUB-FILE:") {
        let chunk = chunk.trim_start_matches('\n');
        if chunk.is_empty() {
            continue;
        }
        let Some((path_line, body)) = chunk.split_once('\n') else {
            continue;
        };
        let path = path_line.trim_end_matches("===").trim();
        if path.is_empty() {
            continue;
        }
        out.push((path.to_string(), body.to_string()));
    }
    out
}

/// File stem of a `/a/b/name.md` path (no dir, no extension). Used as the
/// fallback sub-agent name when the frontmatter omits one.
fn file_stem(path: &str) -> String {
    path.rsplit('/')
        .next()
        .unwrap_or(path)
        .trim_end_matches(".md")
        .to_string()
}

/// Parent directory name of a `.../skills/<name>/SKILL.md` path — the skill's
/// name when the frontmatter omits one.
fn skill_dir_name(path: &str) -> String {
    path.rsplit('/').nth(1).unwrap_or("skill").to_string()
}

/// Fold the on-disk config reads into an [`AgentConfig`]. Pulled out of the async
/// method so the parsing is unit-testable without a container. Every field is
/// derived from real input; absent input yields empty/None, never sample data.
fn parse_agent_config(
    cfg: &str,
    settings: &str,
    agents_raw: &str,
    skills_raw: &str,
    marketplaces_raw: &str,
) -> AgentConfig {
    let cfg: serde_json::Value = serde_json::from_str(cfg).unwrap_or_default();
    let settings: serde_json::Value = serde_json::from_str(settings).unwrap_or_default();

    let model = cfg
        .get("model")
        .and_then(|m| m.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let permission_mode = settings
        .get("permissions")
        .and_then(|p| p.get("defaultMode"))
        .and_then(|m| m.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    // Literal permission rules, verbatim from `permissions.{allow,ask,deny}`.
    // Each is an array of tool-rule strings; a missing/non-array bucket yields an
    // empty list (the UI shows "no rules"), never invented entries.
    let rules = |bucket: &str| -> Vec<String> {
        settings
            .get("permissions")
            .and_then(|p| p.get(bucket))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    let permission_allow = rules("allow");
    let permission_ask = rules("ask");
    let permission_deny = rules("deny");

    // Sub-agents: one card per `.claude/agents/*.md`, frontmatter-parsed.
    let mut subagents: Vec<SubAgentInfo> = split_file_bundle(agents_raw)
        .into_iter()
        .map(|(path, body)| {
            let fm = parse_frontmatter(&body);
            let name = fm
                .get("name")
                .filter(|s| !s.is_empty())
                .cloned()
                .unwrap_or_else(|| file_stem(&path));
            SubAgentInfo {
                name,
                description: fm.get("description").filter(|s| !s.is_empty()).cloned(),
                model: fm.get("model").filter(|s| !s.is_empty()).cloned(),
                tools: fm
                    .get("tools")
                    .map(|t| parse_tools_field(t))
                    .unwrap_or_default(),
                scope: scope_for_path(&path),
            }
        })
        .collect();
    subagents.sort_by(|a, b| a.scope.cmp(&b.scope).then(a.name.cmp(&b.name)));

    // Skills: one per `.claude/skills/*/SKILL.md`.
    let mut skills: Vec<SkillInfo> = split_file_bundle(skills_raw)
        .into_iter()
        .map(|(path, body)| {
            let fm = parse_frontmatter(&body);
            let name = fm
                .get("name")
                .filter(|s| !s.is_empty())
                .cloned()
                .unwrap_or_else(|| skill_dir_name(&path));
            SkillInfo {
                name,
                description: fm.get("description").filter(|s| !s.is_empty()).cloned(),
                scope: scope_for_path(&path),
            }
        })
        .collect();
    skills.sort_by(|a, b| a.scope.cmp(&b.scope).then(a.name.cmp(&b.name)));

    // Plugins: the `enabledPlugins` map keys are `<plugin>@<marketplace>`.
    let mut plugins: Vec<PluginInfo> = cfg
        .get("enabledPlugins")
        .and_then(|p| p.as_object())
        .map(|map| {
            map.iter()
                .map(|(key, val)| {
                    let (name, marketplace) = key
                        .split_once('@')
                        .map(|(n, m)| (n.to_string(), Some(m.to_string())))
                        .unwrap_or_else(|| (key.clone(), None));
                    PluginInfo {
                        name,
                        marketplace,
                        enabled: val.as_bool().unwrap_or(false),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    plugins.sort_by(|a, b| a.name.cmp(&b.name));

    // Installed marketplaces: the top-level keys of known_marketplaces.json.
    let marketplaces_json: serde_json::Value =
        serde_json::from_str(marketplaces_raw).unwrap_or_default();
    let mut marketplaces: Vec<String> = marketplaces_json
        .as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    marketplaces.sort();

    AgentConfig {
        model,
        permission_mode,
        permission_allow,
        permission_ask,
        permission_deny,
        subagents,
        skills,
        plugins,
        marketplaces,
    }
}

/// Prettify Claude's `organizationType` into a plan label: `claude_max` → "Max",
/// `claude_pro` → "Pro", etc. Falls back to the raw value (so an unrecognized
/// tier is shown as-is, never dropped or guessed).
fn pretty_plan(org_type: &str) -> String {
    match org_type {
        "claude_max" => "Max".to_string(),
        "claude_pro" => "Pro".to_string(),
        "claude_team" => "Team".to_string(),
        "claude_enterprise" => "Enterprise".to_string(),
        "claude_free" => "Free".to_string(),
        other => other.to_string(),
    }
}

/// Map one MCP server JSON definition to a non-secret [`McpServer`]. Reads only
/// `type`/`command`/`url`; `env` and `headers` (which carry tokens) are never
/// touched. Transport is the explicit `type` when present, else inferred from
/// whether a `command` (stdio) or `url` (http) is set.
fn mcp_server_from(name: &str, scope: &str, def: &serde_json::Value) -> McpServer {
    let command = def.get("command").and_then(|c| c.as_str());
    let url = def.get("url").and_then(|u| u.as_str());
    let transport = def
        .get("type")
        .and_then(|t| t.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if command.is_some() {
                "stdio".to_string()
            } else if url.is_some() {
                "http".to_string()
            } else {
                "unknown".to_string()
            }
        });
    McpServer {
        name: name.to_string(),
        scope: scope.to_string(),
        transport,
        target: command.or(url).map(str::to_string),
    }
}

/// Collect the `mcpServers` object at `val[key...]` into [`McpServer`]s tagged
/// with `scope`. A missing or non-object node yields nothing.
fn collect_mcp(servers: Option<&serde_json::Value>, scope: &str, out: &mut Vec<McpServer>) {
    if let Some(map) = servers.and_then(|s| s.as_object()) {
        for (name, def) in map {
            out.push(mcp_server_from(name, scope, def));
        }
    }
}

/// Parse `~/.claude.json` (`cfg`) + the workspace `.mcp.json` (`mcp`) into a
/// [`ClaudeIntegrations`]. The account comes from `oauthAccount` (identity
/// fields only); MCP servers are merged from user scope (`cfg.mcpServers`),
/// project scope (`cfg.projects["/workspace"].mcpServers`), and shared scope
/// (`mcp.mcpServers`), sorted by scope then name. Non-JSON / missing input
/// yields an empty result rather than failing.
fn parse_claude_integrations(cfg: &str, mcp: &str) -> ClaudeIntegrations {
    let cfg: serde_json::Value = serde_json::from_str(cfg).unwrap_or_default();

    let account = cfg.get("oauthAccount").and_then(|oa| {
        let s = |k: &str| oa.get(k).and_then(|v| v.as_str()).map(str::to_string);
        let acct = ClaudeAccount {
            email: s("emailAddress"),
            name: s("displayName"),
            plan: oa
                .get("organizationType")
                .and_then(|v| v.as_str())
                .map(pretty_plan),
            org: s("organizationName"),
            role: s("organizationRole"),
        };
        // Drop an all-empty account (oauthAccount present but unrecognized).
        let empty = acct.email.is_none()
            && acct.name.is_none()
            && acct.plan.is_none()
            && acct.org.is_none()
            && acct.role.is_none();
        (!empty).then_some(acct)
    });

    let mut mcp_servers = Vec::new();
    collect_mcp(cfg.get("mcpServers"), "user", &mut mcp_servers);
    collect_mcp(
        cfg.get("projects")
            .and_then(|p| p.get("/workspace"))
            .and_then(|w| w.get("mcpServers")),
        "project",
        &mut mcp_servers,
    );
    let mcp: serde_json::Value = serde_json::from_str(mcp).unwrap_or_default();
    collect_mcp(mcp.get("mcpServers"), "shared", &mut mcp_servers);
    mcp_servers.sort_by(|a, b| a.scope.cmp(&b.scope).then(a.name.cmp(&b.name)));

    ClaudeIntegrations {
        account,
        mcp_servers,
    }
}

/// Whether `id` is a plausible Claude session id (a UUID, but we accept any
/// non-empty `[0-9A-Za-z-]` string up to 64 chars). This is a hard gate before
/// the id is interpolated into a transcript path — it rejects `..`, `/`, and any
/// shell metacharacter, so [`DockerClient::claude_session_usage`] can never be
/// steered outside the transcripts directory.
fn is_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Tool names that mutate a file in the workspace. Counting these `tool_use`
/// blocks gives a real "edits" tally for a session — what the agent actually
/// changed, not a guess. Read/Bash/Grep/etc. are reads or shell and are not
/// counted (a `sed` inside Bash can't be reliably attributed, so we only count
/// the explicit edit tools rather than over-claim).
const EDIT_TOOLS: &[&str] = &["Edit", "Write", "MultiEdit", "NotebookEdit"];

/// Count file-editing tool calls in one Claude transcript. Scans `assistant`
/// lines for `message.content[]` `tool_use` blocks whose `name` is an
/// [`EDIT_TOOLS`] entry. Deduped by `(message.id, requestId)` exactly as
/// [`parse_claude_usage`] dedupes turns, so a resumed/replayed transcript does
/// not double-count edits. Multiple edit tool calls within one response each
/// count. Unparseable lines are skipped (under-count over corruption).
fn count_session_edits(raw: &str) -> u32 {
    use std::collections::HashSet;
    let mut seen: HashSet<String> = HashSet::new();
    let mut edits: u32 = 0;
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let msg = v.get("message");
        if let Some(id) = msg.and_then(|m| m.get("id")).and_then(|i| i.as_str()) {
            let req = v.get("requestId").and_then(|r| r.as_str()).unwrap_or("");
            if !seen.insert(format!("{id}\u{1f}{req}")) {
                continue;
            }
        }
        let Some(content) = msg
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        else {
            continue;
        };
        for block in content {
            if block.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
                continue;
            }
            if let Some(name) = block.get("name").and_then(|n| n.as_str()) {
                if EDIT_TOOLS.contains(&name) {
                    edits += 1;
                }
            }
        }
    }
    edits
}

/// Current context footprint of a Claude session: the input size of its most
/// recent model response (`input_tokens + cache_read_input_tokens +
/// cache_creation_input_tokens` — the tokens the model read to produce that
/// turn). This is the live "ctx" the pane header shows. Output tokens are
/// excluded: they are this turn's generation, not part of the read context (they
/// fold into the NEXT turn's input). The transcript is chronological, so the LAST
/// assistant line with usage is the current state — no dedup needed (replayed
/// history precedes freshly-appended turns). Returns 0 when no assistant turn
/// carries usage. No window maximum is derived: it is not in the transcript and
/// varies by model/CLI-version/tier, so the UI shows this count alone rather than
/// a fabricated ratio (see [`SessionUsage`]).
fn latest_context_used(raw: &str) -> u64 {
    let mut used = 0u64;
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let Some(usage) = v.get("message").and_then(|m| m.get("usage")) else {
            continue;
        };
        let tok = |k: &str| usage.get(k).and_then(|n| n.as_u64()).unwrap_or(0);
        // Overwrite each turn → ends holding the last (most recent) one.
        used = tok("input_tokens")
            + tok("cache_read_input_tokens")
            + tok("cache_creation_input_tokens");
    }
    used
}

/// The most recent `message.model` in a Claude transcript (last assistant line
/// with a non-empty model). `None` when no model is recorded — drives the
/// context-window lookup.
fn latest_claude_model(raw: &str) -> Option<String> {
    let mut model: Option<String> = None;
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if let Some(m) = v
            .get("message")
            .and_then(|m| m.get("model"))
            .and_then(|m| m.as_str())
            .filter(|s| !s.is_empty())
        {
            model = Some(m.to_string());
        }
    }
    model
}

/// Map a Claude model id to its context-window size for the UI gauge. The
/// transcript records NO window (it varies by model/tier), so this is a best-known
/// lookup, NOT ground truth: Claude 4.x Opus/Sonnet expose a 1M window, Haiku 200K.
/// Unknown models → 0 so the gauge shows an em-dash instead of guessing. Keep in
/// step with the families CodeHub actually launches (`catalog.ts`).
fn claude_context_window(model: &str) -> u64 {
    // Match the model FAMILY, ignoring date/tier suffixes (`claude-opus-4-8`,
    // `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`, …).
    if model.contains("opus-4") || model.contains("sonnet-4") {
        1_000_000
    } else if model.contains("haiku") {
        200_000
    } else {
        0
    }
}

/// Normalize and confine a browser path to `/workspace`. Empty → the workspace
/// root. Rejects any `..` component (and anything not under `/workspace`) so the
/// Files browser can never read outside the mount.
fn workspace_path(path: &str) -> Result<String, DockerError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok("/workspace".to_string());
    }
    let invalid = trimmed != "/workspace" && !trimmed.starts_with("/workspace/")
        || trimmed.split('/').any(|seg| seg == "..");
    if invalid {
        return Err(DockerError::InvalidPath(trimmed.to_string()));
    }
    Ok(trimmed.to_string())
}

/// Parse `find -printf '%y\t%s\t%f\n'` output into [`FileEntry`] rows. Each line
/// is `type<TAB>size<TAB>name`; `type` is find's single char (d/f/l/…). Lines
/// that don't split into three fields are skipped. Capped at [`DIR_ENTRIES_CAP`].
/// A name containing a literal newline (pathological) splits across lines and is
/// dropped rather than mis-parsed — the listing under-reports, never corrupts.
fn parse_find(raw: &str) -> Vec<FileEntry> {
    raw.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let ty = parts.next()?;
            let size = parts.next()?;
            let name = parts.next()?;
            if name.is_empty() {
                return None;
            }
            let kind = match ty {
                "d" => "dir",
                "f" => "file",
                "l" => "link",
                _ => "other",
            };
            Some(FileEntry {
                name: name.to_string(),
                kind: kind.to_string(),
                size: size.parse().unwrap_or(0),
            })
        })
        .take(DIR_ENTRIES_CAP)
        .collect()
}

/// Parse `browse_dirs` output: each line is `R|D<TAB>branch<TAB>name`. `R` = git
/// repo, `D` = plain dir; branch is empty for `D` (and for a repo on a detached
/// HEAD). Lines that don't split into three fields are skipped. Sorted by name,
/// capped at [`DIR_ENTRIES_CAP`].
fn parse_browse_dirs(raw: &str) -> Vec<DirEntry> {
    let mut out: Vec<DirEntry> = raw
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let tag = parts.next()?;
            let branch = parts.next()?;
            let name = parts.next()?;
            if name.is_empty() {
                return None;
            }
            Some(DirEntry {
                name: name.to_string(),
                is_repo: tag == "R",
                branch: (!branch.is_empty()).then(|| branch.to_string()),
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out.truncate(DIR_ENTRIES_CAP);
    out
}

/// Cap on changed paths returned to the UI; the rail only renders a short list.
const GIT_FILES_CAP: usize = 200;

/// Upper bound on commits a single `git_log` call will return.
const GIT_LOG_CAP: u32 = 50;

/// Cap on entries returned for one directory listing (Files browser).
const DIR_ENTRIES_CAP: usize = 500;

/// Cap on bytes returned for a file preview (Files browser): 256 KiB.
const FILE_READ_CAP: usize = 262_144;

/// As-of label for [`USAGE_RATES`]. Surfaced to the UI so the cost estimate is
/// honest about how current its prices are.
const RATES_AS_OF: &str = "2026-05";

/// Published per-million-token list prices (USD) by Claude model family, used
/// only to ESTIMATE cost from real token counts. Tuple is
/// `(family, input, output, cache_write_5m, cache_read)`. A model whose name
/// contains none of these families is left unpriced (its tokens are reported
/// under `unpriced_tokens` and excluded from the estimate). Update alongside
/// [`RATES_AS_OF`] when Anthropic's pricing changes.
const USAGE_RATES: &[(&str, f64, f64, f64, f64)] = &[
    ("opus", 15.0, 75.0, 18.75, 1.50),
    ("sonnet", 3.0, 15.0, 3.75, 0.30),
    ("haiku", 1.0, 5.0, 1.25, 0.10),
];

/// Match a transcript model id (e.g. `claude-opus-4-7`) to its rate row by
/// family substring. Returns `(input, output, cache_write, cache_read)` per Mtok.
fn model_rate(model: &str) -> Option<(f64, f64, f64, f64)> {
    USAGE_RATES
        .iter()
        .find(|(family, ..)| model.contains(family))
        .map(|&(_, i, o, cw, cr)| (i, o, cw, cr))
}

/// Estimated USD cost for one usage block at the given rates (per Mtok).
fn estimate_cost(t: &TokenTotals, rate: (f64, f64, f64, f64)) -> f64 {
    let (ri, ro, rcw, rcr) = rate;
    (t.input as f64 * ri
        + t.output as f64 * ro
        + t.cache_creation as f64 * rcw
        + t.cache_read as f64 * rcr)
        / 1_000_000.0
}

/// Running per-bucket accumulator (one per model and per day) folded by
/// [`parse_claude_usage`], then flattened into the serialized rollups.
#[derive(Default)]
struct UsageBucket {
    totals: TokenTotals,
    turns: u32,
    est_cost_usd: f64,
    priced: bool,
}

impl UsageBucket {
    fn add(&mut self, t: &TokenTotals, cost: f64, priced: bool) {
        self.totals.input += t.input;
        self.totals.output += t.output;
        self.totals.cache_read += t.cache_read;
        self.totals.cache_creation += t.cache_creation;
        self.est_cost_usd += cost;
        // A bucket counts as priced if any contribution to it was priced.
        self.priced |= priced;
    }
}

/// Fold concatenated Claude Code transcripts (JSONL, one event per line) into a
/// [`ClaudeUsage`] rollup. Distinct `sessionId`s are counted as sessions; each
/// `assistant` line is one turn and contributes its `message.usage` token counts
/// to the global, per-model, and per-day (UTC `timestamp[..10]`) totals. Cost is
/// estimated per line from [`USAGE_RATES`]; unpriced models contribute their
/// input+output tokens to `unpriced_tokens` and nothing to the estimate.
/// Unparseable or non-object lines are skipped, so partial/garbled input
/// under-reports rather than failing.
fn parse_claude_usage(raw: &str) -> ClaudeUsage {
    use std::collections::{BTreeMap, HashSet};

    let mut sessions: HashSet<String> = HashSet::new();
    // Dedup key for assistant lines: a resumed/forked/compacted session replays
    // earlier messages into a new transcript, so the same model response (same
    // `message.id` + `requestId`) recurs across files. Counting each occurrence
    // would inflate turns + tokens + the cost estimate — breaking the "factual"
    // contract. We fold each response once. (Distinct `sessionId`s still each
    // count as a session: a resume IS a real new session, just with replayed
    // history.) Lines without a `message.id` are never deduped (no safe key).
    let mut seen: HashSet<String> = HashSet::new();
    let mut global = UsageBucket::default();
    let mut by_model: BTreeMap<String, UsageBucket> = BTreeMap::new();
    let mut by_day: BTreeMap<String, UsageBucket> = BTreeMap::new();
    let mut unpriced_tokens: u64 = 0;

    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if let Some(sid) = v.get("sessionId").and_then(|s| s.as_str()) {
            sessions.insert(sid.to_string());
        }
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let msg = v.get("message");
        // Skip a replayed duplicate before any accumulation.
        if let Some(id) = msg.and_then(|m| m.get("id")).and_then(|i| i.as_str()) {
            let req = v.get("requestId").and_then(|r| r.as_str()).unwrap_or("");
            if !seen.insert(format!("{id}\u{1f}{req}")) {
                continue;
            }
        }
        let usage = msg.and_then(|m| m.get("usage"));
        let Some(usage) = usage else { continue };
        let tok = |k: &str| usage.get(k).and_then(|n| n.as_u64()).unwrap_or(0);
        let totals = TokenTotals {
            input: tok("input_tokens"),
            output: tok("output_tokens"),
            cache_read: tok("cache_read_input_tokens"),
            cache_creation: tok("cache_creation_input_tokens"),
        };
        let model = msg
            .and_then(|m| m.get("model"))
            .and_then(|m| m.as_str())
            .unwrap_or("unknown")
            .to_string();
        let rate = model_rate(&model);
        let priced = rate.is_some();
        let cost = rate.map(|r| estimate_cost(&totals, r)).unwrap_or(0.0);
        if !priced {
            unpriced_tokens += totals.input + totals.output;
        }

        global.add(&totals, cost, priced);
        global.turns += 1;
        let m = by_model.entry(model).or_default();
        m.add(&totals, cost, priced);
        m.turns += 1;

        if let Some(date) = v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .filter(|t| t.len() >= 10)
            .map(|t| t[..10].to_string())
        {
            by_day.entry(date).or_default().add(&totals, cost, priced);
        }
    }

    let mut by_model: Vec<ModelUsage> = by_model
        .into_iter()
        .map(|(model, b)| ModelUsage {
            model,
            totals: b.totals,
            turns: b.turns,
            est_cost_usd: b.est_cost_usd,
            priced: b.priced,
        })
        .collect();
    // Heaviest spenders first; the UI shows a short ranked list.
    by_model.sort_by(|a, b| b.est_cost_usd.total_cmp(&a.est_cost_usd));

    let by_day: Vec<DayUsage> = by_day
        .into_iter()
        .map(|(date, b)| DayUsage {
            date,
            totals: b.totals,
            est_cost_usd: b.est_cost_usd,
        })
        .collect();

    let rates = USAGE_RATES
        .iter()
        .map(|&(family, i, o, cw, cr)| ModelRate {
            family: family.to_string(),
            input_per_mtok: i,
            output_per_mtok: o,
            cache_write_per_mtok: cw,
            cache_read_per_mtok: cr,
        })
        .collect();

    ClaudeUsage {
        sessions: sessions.len() as u32,
        turns: global.turns,
        totals: global.totals,
        est_cost_usd: global.est_cost_usd,
        by_model,
        by_day,
        rates,
        rates_as_of: RATES_AS_OF.to_string(),
        unpriced_tokens,
    }
}

/// Cap on past sessions returned to the Resume screen.
const SESSIONS_CAP: usize = 200;

/// Per-session accumulator folded by [`parse_claude_sessions`], one per
/// `sessionId`, then flattened into a [`ClaudeSession`].
#[derive(Default)]
struct SessionAcc {
    ai_title: Option<String>,
    first_prompt: Option<String>,
    branch: Option<String>,
    version: Option<String>,
    model: Option<String>,
    started: Option<String>,
    last_active: Option<String>,
    /// Distinct user-message uuids — a resumed transcript replays earlier user
    /// turns, so we dedupe by uuid to keep `turns` factual.
    turn_uuids: std::collections::HashSet<String>,
    /// Accumulated token totals for per-session cost estimation.
    totals: TokenTotals,
}

/// Claude Code injects its own wrapper text into the user role for slash
/// commands, hooks and caveats (e.g. `<local-command-caveat>…`). These are not
/// the human's prompt, so they make poor titles — we skip them when picking the
/// first-prompt fallback and use the first genuinely-typed prompt instead.
fn is_synthetic_prompt(text: &str) -> bool {
    const WRAPPERS: [&str; 6] = [
        "<local-command-",
        "<command-name>",
        "<command-message>",
        "<command-args>",
        "<bash-input>",
        "<user-prompt-submit-hook>",
    ];
    WRAPPERS.iter().any(|w| text.starts_with(w))
}

/// Extract a human-readable prompt from a Claude `message.content`, which is
/// either a string (simple prompt) or an array of typed blocks (text /
/// tool_result / …). Returns the first real text, trimmed; `None` if there is no
/// textual content (e.g. a pure tool result) or it is only Claude's own
/// command/hook wrapper boilerplate — so a title is never invented or boilerplate.
fn content_text(content: &serde_json::Value) -> Option<String> {
    let pick = |t: &str| {
        let t = t.trim();
        (!t.is_empty() && !is_synthetic_prompt(t)).then(|| t.to_string())
    };
    if let Some(s) = content.as_str() {
        return pick(s);
    }
    if let Some(arr) = content.as_array() {
        for block in arr {
            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                if let Some(text) = pick(t) {
                    return Some(text);
                }
            }
        }
    }
    None
}

/// Fold concatenated Claude Code transcripts (JSONL) into one [`ClaudeSession`]
/// per distinct `sessionId`, newest activity first. `title` prefers the
/// transcript's `ai-title`, falling back to its first user prompt, then a
/// placeholder. `branch` is the recorded `gitBranch` with detached `HEAD`
/// dropped to `None`. `turns` counts distinct user messages (deduped by uuid so
/// replayed history in a resumed transcript doesn't inflate it). Unparseable
/// lines are skipped, so garbled input under-reports rather than failing.
fn parse_claude_sessions(raw: &str) -> Vec<ClaudeSession> {
    use std::collections::HashMap;

    let mut acc: HashMap<String, SessionAcc> = HashMap::new();

    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(sid) = v.get("sessionId").and_then(|s| s.as_str()) else {
            continue;
        };
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let entry = acc.entry(sid.to_string()).or_default();

        // ai-title lines carry no timestamp; capture the title and move on.
        if ty == "ai-title" {
            if let Some(t) = v.get("aiTitle").and_then(|t| t.as_str()) {
                let t = t.trim();
                if !t.is_empty() {
                    entry.ai_title = Some(t.to_string());
                }
            }
            continue;
        }

        // Track the conversation's active window from any timestamped line.
        if let Some(ts) = v.get("timestamp").and_then(|t| t.as_str()) {
            if entry.started.as_deref().is_none_or(|s| ts < s) {
                entry.started = Some(ts.to_string());
            }
            if entry.last_active.as_deref().is_none_or(|s| ts > s) {
                entry.last_active = Some(ts.to_string());
            }
        }

        // gitBranch / version ride on user lines; keep the last seen non-empty
        // (both are effectively constant within a session, so order is moot).
        // Detached HEAD is not a real branch name → leave as None.
        if let Some(b) = v.get("gitBranch").and_then(|b| b.as_str()) {
            if !b.is_empty() && b != "HEAD" {
                entry.branch = Some(b.to_string());
            }
        }
        if let Some(ver) = v.get("version").and_then(|s| s.as_str()) {
            if !ver.is_empty() {
                entry.version = Some(ver.to_string());
            }
        }

        match ty {
            "user" => {
                if let Some(uuid) = v.get("uuid").and_then(|u| u.as_str()) {
                    entry.turn_uuids.insert(uuid.to_string());
                }
                if entry.first_prompt.is_none() {
                    if let Some(text) = v
                        .get("message")
                        .and_then(|m| m.get("content"))
                        .and_then(content_text)
                    {
                        entry.first_prompt = Some(text);
                    }
                }
            },
            "assistant" => {
                if let Some(m) = v
                    .get("message")
                    .and_then(|m| m.get("model"))
                    .and_then(|m| m.as_str())
                {
                    entry.model = Some(m.to_string());
                }
                if let Some(u) = v.get("message").and_then(|m| m.get("usage")) {
                    let inp = u.get("input_tokens").and_then(|n| n.as_u64()).unwrap_or(0);
                    let out = u.get("output_tokens").and_then(|n| n.as_u64()).unwrap_or(0);
                    let cr = u
                        .get("cache_read_input_tokens")
                        .and_then(|n| n.as_u64())
                        .unwrap_or(0);
                    let cw = u
                        .get("cache_creation_input_tokens")
                        .and_then(|n| n.as_u64())
                        .unwrap_or(0);
                    entry.totals.input += inp;
                    entry.totals.output += out;
                    entry.totals.cache_read += cr;
                    entry.totals.cache_creation += cw;
                }
            },
            _ => {},
        }
    }

    let mut sessions: Vec<ClaudeSession> = acc
        .into_iter()
        .map(|(id, a)| {
            // Title: real ai-title, else first user prompt (one line, clipped),
            // else an honest placeholder — never invented.
            let title = a
                .ai_title
                .or_else(|| a.first_prompt.map(|p| clip_title(&p)))
                .unwrap_or_else(|| "Untitled session".to_string());
            let last_active = a.last_active.clone().unwrap_or_default();
            let total_tok =
                a.totals.input + a.totals.output + a.totals.cache_read + a.totals.cache_creation;
            let est_cost = a
                .model
                .as_deref()
                .and_then(model_rate)
                .map(|r| estimate_cost(&a.totals, r));
            ClaudeSession {
                id,
                title,
                branch: a.branch,
                started: a.started.unwrap_or_default(),
                last_active,
                turns: a.turn_uuids.len() as u32,
                model: a.model,
                version: a.version,
                est_cost_usd: est_cost,
                total_tokens: if total_tok > 0 { Some(total_tok) } else { None },
            }
        })
        .collect();

    // Most recently active first; the UI shows a ranked, capped list.
    sessions.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    sessions.truncate(SESSIONS_CAP);
    sessions
}

/// Collapse a user prompt to a single-line title: first line, whitespace
/// normalized, clipped to a sane length so a long paste can't dominate the list.
fn clip_title(prompt: &str) -> String {
    let one_line = prompt.split('\n').next().unwrap_or(prompt);
    let normalized = one_line.split_whitespace().collect::<Vec<_>>().join(" ");
    const MAX: usize = 80;
    if normalized.chars().count() > MAX {
        let head: String = normalized.chars().take(MAX).collect();
        format!("{head}…")
    } else {
        normalized
    }
}

// ── Codex rollout file parser ────────────────────────────────────────────────
// Codex writes per-session rollout files under $CODEX_HOME (pinned to
// `/config/codex`): `/config/codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`.
// Each file contains one JSON object per line representing an event.
//
// Relevant event types (field `event_msg`):
// - `token_count`: `payload.info.last_token_usage` (this-turn delta) +
//   `payload.info.total_token_usage` (session cumulative). Each has:
//   input / cached_input / output / reasoning_output / total.
//   Also: `payload.rate_limits { primary/secondary: {used_percent,
//   window_minutes, resets_at}, plan_type }`.
// - `task_started` / `task_complete`: `turn_id`, `duration_ms`,
//   `time_to_first_token_ms`, `model_context_window`.
// - `turn_context`: per-turn `model` + `effort`.
//
// Unknown event types are skipped; malformed lines are skipped (under-count
// over corruption — honesty contract).

/// Codex model rate table: (family_substring, input_per_mtok, output_per_mtok).
/// Codex doesn't report cache rates, so we use input/output only.
const CODEX_RATES: &[(&str, f64, f64)] = &[
    ("gpt-4o", 2.50, 10.0),
    ("gpt-4-turbo", 10.0, 30.0),
    ("gpt-4", 30.0, 60.0),
    ("o4-mini", 1.10, 4.40),
    ("o3-mini", 1.10, 4.40),
    ("o3", 10.0, 40.0),
    ("o1-mini", 3.0, 12.0),
    ("o1", 15.0, 60.0),
    ("gpt-3.5", 0.50, 1.50),
];
const CODEX_RATES_AS_OF: &str = "2026-05";

fn codex_model_rate(model: &str) -> Option<(f64, f64)> {
    CODEX_RATES
        .iter()
        .find(|(family, ..)| model.contains(family))
        .map(|&(_, i, o)| (i, o))
}

fn codex_estimate_cost(t: &crate::types::CodexTokenTotals, rate: (f64, f64)) -> f64 {
    let (ri, ro) = rate;
    (t.input as f64 * ri + t.output as f64 * ro) / 1_000_000.0
}

/// Per-session accumulator for the Codex fold.
#[derive(Default)]
struct CodexSessionAcc {
    session_id: String,
    title: Option<String>,
    branch: Option<String>,
    model: Option<String>,
    version: Option<String>,
    started: Option<String>,
    last_active: Option<String>,
    turns: u64,
    /// Cumulative totals from the LAST `token_count` line's `total_token_usage`.
    cumulative: crate::types::CodexTokenTotals,
}

/// Fold the per-session fields shared by both Codex passes — the timestamp
/// window (`started`/`last_active`), the active `model`, the turn count
/// (`task_complete`), and the title (`task_started`) — from one rollout JSONL
/// value into its accumulator. [`parse_codex_usage`] layers `token_count` cost
/// accounting on top in the same loop; [`parse_codex_sessions`] needs only this.
fn codex_acc_common(acc: &mut CodexSessionAcc, v: &serde_json::Value) {
    if let Some(ts) = v.get("timestamp").and_then(|t| t.as_str()) {
        if acc.started.as_deref().is_none_or(|s| ts < s) {
            acc.started = Some(ts.to_string());
        }
        if acc.last_active.as_deref().is_none_or(|s| ts > s) {
            acc.last_active = Some(ts.to_string());
        }
    }

    let Some(payload) = v.get("payload") else {
        return;
    };

    // Codex 0.135 envelopes every rollout line under a top-level `type`; the session
    // header (`session_meta`), per-turn config (`turn_context`) and the events
    // (`event_msg`, with `payload.type` the kind + `*_tokens` counts) are SEPARATE
    // lines, not fields on one. Older Codex flattened them — see `codex_line_sid` for
    // the matching session-id migration.
    match v.get("type").and_then(|t| t.as_str()) {
        Some("session_meta") => {
            if let Some(ver) = payload
                .get("cli_version")
                .and_then(|s| s.as_str())
                .filter(|s| !s.is_empty())
            {
                acc.version = Some(ver.to_string());
            }
            if let Some(branch) = payload
                .get("git")
                .and_then(|g| g.get("branch"))
                .and_then(|s| s.as_str())
                .filter(|s| !s.is_empty())
            {
                acc.branch = Some(branch.to_string());
            }
        },
        Some("turn_context") => {
            if let Some(model) = payload
                .get("model")
                .and_then(|m| m.as_str())
                .filter(|s| !s.is_empty())
            {
                acc.model = Some(model.to_string());
            }
        },
        Some("event_msg") => match payload.get("type").and_then(|t| t.as_str()) {
            Some("task_complete") => acc.turns = acc.turns.saturating_add(1),
            // Session title = first real user prompt; `task_started` no longer carries
            // the task text in 0.135.
            Some("user_message") if acc.title.is_none() => {
                if let Some(t) = payload
                    .get("message")
                    .and_then(|m| m.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    acc.title = Some(clip_title(t));
                }
            },
            Some("token_count") => {
                let tok = |obj: &serde_json::Value, k: &str| {
                    obj.get(k).and_then(|n| n.as_u64()).unwrap_or(0)
                };
                if let Some(total) = payload.get("info").and_then(|i| i.get("total_token_usage")) {
                    acc.cumulative = crate::types::CodexTokenTotals {
                        input: tok(total, "input_tokens"),
                        cached_input: tok(total, "cached_input_tokens"),
                        output: tok(total, "output_tokens"),
                        reasoning_output: tok(total, "reasoning_output_tokens"),
                    };
                }
            },
            _ => {},
        },
        _ => {},
    }
}

/// Resolve which Codex session a rollout line belongs to. Codex 0.135 writes the id
/// once — in the `session_meta` line's `payload.id` — instead of stamping every line
/// with `session_id`. Carry it forward from the last `session_meta`: rollouts are
/// catted whole and contiguously ([`cat_all_rollouts`](DockerClient::cat_all_rollouts)),
/// so every line trails its own file's meta. None before any meta (malformed stream).
fn codex_line_sid(v: &serde_json::Value, current: &mut Option<String>) -> Option<String> {
    if v.get("type").and_then(|t| t.as_str()) == Some("session_meta") {
        if let Some(id) = v
            .get("payload")
            .and_then(|p| p.get("id"))
            .and_then(|s| s.as_str())
            .filter(|s| !s.is_empty())
        {
            *current = Some(id.to_string());
        }
    }
    current.clone()
}

/// Fold concatenated Codex rollout JSONL into a [`CodexUsage`] aggregate.
/// Each rollout file maps to one session; the session id is the filename UUID.
/// All token counts are FACTUAL from the on-disk data; cost is an estimate.
fn parse_codex_usage(raw: &str) -> crate::types::CodexUsage {
    use std::collections::BTreeMap;

    let mut session_accs: BTreeMap<String, CodexSessionAcc> = BTreeMap::new();
    let mut by_model: BTreeMap<String, (crate::types::CodexTokenTotals, u64)> = BTreeMap::new();
    // (CodexTokenTotals, est_cost_usd) accumulated per UTC day.
    let mut by_day: BTreeMap<String, (crate::types::CodexTokenTotals, f64)> = BTreeMap::new();

    // Session id is written once per rollout (in `session_meta`); carry it forward.
    let mut current_sid: Option<String> = None;

    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };

        let Some(sid) = codex_line_sid(&v, &mut current_sid) else {
            continue;
        };

        let acc = session_accs
            .entry(sid.clone())
            .or_insert_with(|| CodexSessionAcc {
                session_id: sid.clone(),
                ..Default::default()
            });

        // Shared per-session fields (timestamp window, model, turns, title, and the
        // cumulative `total_token_usage` session total).
        codex_acc_common(acc, &v);

        // Usage-only: fold this turn's token DELTA (`last_token_usage`) into per-model
        // / per-day cost. The cumulative session total is handled by codex_acc_common.
        let is_token_count = v.get("type").and_then(|t| t.as_str()) == Some("event_msg")
            && v.get("payload")
                .and_then(|p| p.get("type"))
                .and_then(|t| t.as_str())
                == Some("token_count");
        if is_token_count {
            let tok =
                |obj: &serde_json::Value, k: &str| obj.get(k).and_then(|n| n.as_u64()).unwrap_or(0);
            if let Some(last) = v
                .get("payload")
                .and_then(|p| p.get("info"))
                .and_then(|i| i.get("last_token_usage"))
            {
                let delta = crate::types::CodexTokenTotals {
                    input: tok(last, "input_tokens"),
                    cached_input: tok(last, "cached_input_tokens"),
                    output: tok(last, "output_tokens"),
                    reasoning_output: tok(last, "reasoning_output_tokens"),
                };
                let model_key = acc.model.clone().unwrap_or_else(|| "unknown".to_string());
                let rate = codex_model_rate(&model_key);
                let delta_cost = rate.map(|r| codex_estimate_cost(&delta, r)).unwrap_or(0.0);
                let me = by_model.entry(model_key).or_default();
                me.0.input += delta.input;
                me.0.cached_input += delta.cached_input;
                me.0.output += delta.output;
                me.0.reasoning_output += delta.reasoning_output;
                me.1 += 1;

                if let Some(date) = v
                    .get("timestamp")
                    .and_then(|t| t.as_str())
                    .filter(|t| t.len() >= 10)
                    .map(|t| t[..10].to_string())
                {
                    let de = by_day.entry(date).or_default();
                    de.0.input += delta.input;
                    de.0.cached_input += delta.cached_input;
                    de.0.output += delta.output;
                    de.0.reasoning_output += delta.reasoning_output;
                    de.1 += delta_cost;
                }
            }
        }
    }

    // Flatten accumulators into output structs.
    let mut total_sessions = 0u64;
    let mut total_turns = 0u64;
    let mut global_totals = crate::types::CodexTokenTotals::default();
    let mut total_cost = 0.0f64;
    let mut unpriced_tokens = 0u64;

    for acc in session_accs.values() {
        total_sessions += 1;
        total_turns += acc.turns;
        global_totals.input += acc.cumulative.input;
        global_totals.cached_input += acc.cumulative.cached_input;
        global_totals.output += acc.cumulative.output;
        global_totals.reasoning_output += acc.cumulative.reasoning_output;
    }

    let by_model: Vec<crate::types::CodexModelUsage> = by_model
        .into_iter()
        .map(|(model, (totals, turns))| {
            let rate = codex_model_rate(&model);
            let priced = rate.is_some();
            let est_cost_usd = rate.map(|r| codex_estimate_cost(&totals, r)).unwrap_or(0.0);
            if !priced {
                unpriced_tokens += totals.input + totals.output;
            }
            total_cost += est_cost_usd;
            crate::types::CodexModelUsage {
                model,
                totals,
                turns,
                est_cost_usd,
                priced,
            }
        })
        .collect();

    // Sort heaviest spenders first.
    let mut by_model = by_model;
    by_model.sort_by(|a, b| b.est_cost_usd.total_cmp(&a.est_cost_usd));

    let by_day: Vec<crate::types::CodexDayUsage> = by_day
        .into_iter()
        .map(
            |(date, (totals, est_cost_usd))| crate::types::CodexDayUsage {
                date,
                totals,
                est_cost_usd,
            },
        )
        .collect();

    let rates: Vec<crate::types::CodexModelRate> = CODEX_RATES
        .iter()
        .map(|&(family, i, o)| crate::types::CodexModelRate {
            family: family.to_string(),
            input_per_mtok: i,
            output_per_mtok: o,
        })
        .collect();

    crate::types::CodexUsage {
        sessions: total_sessions,
        turns: total_turns,
        totals: global_totals,
        est_cost_usd: total_cost,
        by_model,
        by_day,
        rates,
        rates_as_of: CODEX_RATES_AS_OF.to_string(),
        unpriced_tokens,
    }
}

/// Fold concatenated Codex rollout JSONL into a list of sessions.
fn parse_codex_sessions(raw: &str) -> Vec<crate::types::CodexSession> {
    use std::collections::HashMap;

    let mut accs: HashMap<String, CodexSessionAcc> = HashMap::new();

    // Session id is written once per rollout (in `session_meta`); carry it forward.
    let mut current_sid: Option<String> = None;

    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };

        let Some(sid) = codex_line_sid(&v, &mut current_sid) else {
            continue;
        };

        let acc = accs.entry(sid.clone()).or_insert_with(|| CodexSessionAcc {
            session_id: sid.clone(),
            ..Default::default()
        });

        codex_acc_common(acc, &v);
    }

    let mut sessions: Vec<crate::types::CodexSession> = accs
        .into_values()
        .map(|a| {
            let total_tok = a.cumulative.input
                + a.cumulative.cached_input
                + a.cumulative.output
                + a.cumulative.reasoning_output;
            let est_cost = a
                .model
                .as_deref()
                .and_then(codex_model_rate)
                .map(|r| codex_estimate_cost(&a.cumulative, r));
            crate::types::CodexSession {
                id: a.session_id,
                title: a.title.unwrap_or_else(|| "Untitled session".to_string()),
                branch: a.branch,
                started: a.started.unwrap_or_default(),
                last_active: a.last_active.clone().unwrap_or_default(),
                turns: a.turns,
                model: a.model,
                version: a.version,
                est_cost_usd: est_cost,
                total_tokens: if total_tok > 0 { Some(total_tok) } else { None },
            }
        })
        .collect();

    sessions.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    const CODEX_SESSIONS_CAP: usize = 200;
    sessions.truncate(CODEX_SESSIONS_CAP);
    sessions
}

/// Derive per-session Codex tally from a single rollout file.
fn codex_session_usage_from_raw(raw: &str) -> Option<crate::types::CodexSessionUsage> {
    let mut turns = 0u64;
    let mut tokens_in = 0u64;
    let mut tokens_out = 0u64;
    let mut context_used = 0u64;
    let mut context_window = 0u64;
    let mut saw_tokens = false;

    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        // Codex rollout lines are enveloped: a top-level `type` ("event_msg",
        // "response_item", "session_meta", …) wraps a `payload` whose own `type` is
        // the event kind, and token fields are `*_tokens`. Older Codex used a flat
        // top-level `event_msg` field with `input`/`output` keys; 0.135+ nests it —
        // keying off the old shape silently matched nothing (turns stayed 0 → None →
        // the whole per-pane strip read blank).
        if v.get("type").and_then(|t| t.as_str()) != Some("event_msg") {
            continue;
        }
        let Some(payload) = v.get("payload") else {
            continue;
        };
        match payload.get("type").and_then(|t| t.as_str()) {
            Some("task_complete") => turns += 1,
            Some("task_started") => {
                // The model context window rides task_started — last turn wins.
                if let Some(w) = payload.get("model_context_window").and_then(|n| n.as_u64()) {
                    context_window = w;
                }
            },
            Some("token_count") => {
                let Some(info) = payload.get("info") else {
                    continue;
                };
                let tok = |obj: Option<&serde_json::Value>, k: &str| {
                    obj.and_then(|o| o.get(k))
                        .and_then(|n| n.as_u64())
                        .unwrap_or(0)
                };
                // Cumulative session totals (Codex already accumulates these) — the
                // last token_count line wins.
                let total = info.get("total_token_usage");
                tokens_in = tok(total, "input_tokens");
                tokens_out = tok(total, "output_tokens");
                // Live context footprint = most recent turn's prompt size (parity
                // with Claude's `latest_context_used`); `input_tokens` already folds
                // in the cached portion.
                context_used = tok(info.get("last_token_usage"), "input_tokens");
                saw_tokens = true;
            },
            _ => {},
        }
    }

    // Surface as soon as there's a usable signal — a session mid-first-turn has
    // token_count lines but no task_complete yet.
    if turns == 0 && !saw_tokens {
        return None;
    }
    Some(crate::types::CodexSessionUsage {
        turns,
        tokens_in,
        tokens_out,
        // Codex doesn't log file-edit counts in rollout files; report 0 (factual
        // absence rather than fabrication).
        edits: 0,
        context_used,
        context_window,
    })
}

/// Extract the most recent `rate_limits` block from a Codex rollout file.
fn extract_codex_rate_limits(raw: &str) -> Option<crate::types::CodexRateLimits> {
    let mut last_rl: Option<crate::types::CodexRateLimits> = None;

    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        // Codex 0.135 envelope: `type:"event_msg"` + `payload.type:"token_count"`
        // (older Codex used a flat top-level `event_msg` field). `rate_limits` rides
        // the same token_count payload, alongside `info`.
        if v.get("type").and_then(|t| t.as_str()) != Some("event_msg")
            || v.get("payload")
                .and_then(|p| p.get("type"))
                .and_then(|t| t.as_str())
                != Some("token_count")
        {
            continue;
        }
        let rl = match v.get("payload").and_then(|p| p.get("rate_limits")) {
            Some(r) => r,
            None => continue,
        };

        let primary = rl.get("primary");
        let secondary = rl.get("secondary");
        let plan_type = rl
            .get("plan_type")
            .and_then(|p| p.as_str())
            .map(String::from);

        let f64_field = |obj: Option<&serde_json::Value>, k: &str| obj?.get(k)?.as_f64();
        let u64_field = |obj: Option<&serde_json::Value>, k: &str| obj?.get(k)?.as_u64();
        // `resets_at` is an epoch number in real rollouts (older fixtures used an
        // RFC3339 string) — accept either, surfacing the epoch as a string so a real
        // value reaches the UI instead of null.
        let resets_field = |obj: Option<&serde_json::Value>| -> Option<String> {
            let r = obj?.get("resets_at")?;
            r.as_str()
                .map(String::from)
                .or_else(|| r.as_u64().map(|n| n.to_string()))
        };

        last_rl = Some(crate::types::CodexRateLimits {
            primary_used_pct: f64_field(primary, "used_percent"),
            primary_window_minutes: u64_field(primary, "window_minutes"),
            primary_resets_at: resets_field(primary),
            secondary_used_pct: f64_field(secondary, "used_percent"),
            secondary_window_minutes: u64_field(secondary, "window_minutes"),
            secondary_resets_at: resets_field(secondary),
            plan_type,
        });
    }

    last_rl
}

/// Parse the GitHub `/user/repos` JSON response into [`GithubRepo`] entries.
/// Unknown / malformed responses → empty list (honest). `pub(crate)` so the
/// host-side fetch in `vault` reuses the same parser.
pub(crate) fn parse_github_repos(raw: &str) -> Vec<crate::types::GithubRepo> {
    // SECURITY: this function must never include any token value in its output.
    // It only reads repo metadata (name, branch, visibility) — no credentials.
    let Ok(arr) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let Some(arr) = arr.as_array() else {
        return Vec::new();
    };

    arr.iter()
        .filter_map(|r| {
            let full_name = r.get("full_name")?.as_str()?.to_string();
            let default_branch = r
                .get("default_branch")
                .and_then(|b| b.as_str())
                .map(String::from);
            let private = r.get("private").and_then(|p| p.as_bool()).unwrap_or(false);
            Some(crate::types::GithubRepo {
                name_with_owner: full_name,
                default_branch,
                // open_prs requires a separate API call per repo — too expensive
                // for a repo list; leave as None (factual absence).
                open_prs: None,
                private,
            })
        })
        .collect()
}

/// Does this line look like `git commit`'s success summary
/// (`[<branch> <short-hash>] <subject>`, or `[<branch> (root-commit) <hash>] …`)?
/// True when a bracketed prefix at the line start contains a token that is a
/// hex hash of 7 or more chars. Used by [`git_commit`](DockerClient::git_commit)
/// to detect success without misreading a subject containing words like "error:".
fn commit_success_line(line: &str) -> bool {
    if !line.starts_with('[') {
        return false;
    }
    let Some(end) = line.find(']') else {
        return false;
    };
    line[1..end]
        .split_whitespace()
        .any(|w| w.len() >= 7 && w.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Parse the US-delimited `git log` output (one commit per line,
/// `hash\x1fauthor\x1frelative\x1fsubject`). Lines without all four fields —
/// notably a `fatal:` error on a non-repo, or the empty output of a commit-less
/// repo — are skipped, so callers get an empty list rather than garbage rows.
fn parse_git_log(raw: &str) -> Vec<CommitInfo> {
    raw.lines()
        .filter_map(|line| {
            let mut f = line.split('\u{1f}');
            let hash = f.next()?;
            let author = f.next()?;
            let relative = f.next()?;
            let subject = f.next()?;
            if hash.is_empty() {
                return None;
            }
            Some(CommitInfo {
                hash: hash.to_string(),
                author: author.to_string(),
                relative: relative.to_string(),
                subject: subject.to_string(),
            })
        })
        .collect()
}

/// Parse `git status --porcelain=v1 --branch` output. Pulled out of the async
/// method so the line-handling can be unit-tested without a container.
fn parse_git_status(raw: &str) -> GitStatus {
    // exec_capture merges stdout+stderr, so git's own errors land here. Treat
    // "not a repo" / "git missing" as a non-repo rather than a hard error.
    let lower = raw.to_ascii_lowercase();
    if lower.contains("fatal:") || lower.contains("not found") || lower.contains("no such file") {
        return GitStatus {
            is_repo: false,
            branch: None,
            ahead: 0,
            behind: 0,
            files: Vec::new(),
            total: 0,
        };
    }

    let mut branch = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut files = Vec::new();
    let mut total = 0;

    for line in raw.lines() {
        // The `## ` header line carries branch + ahead/behind tracking info.
        if let Some(rest) = line.strip_prefix("## ") {
            let name_part = rest.split("...").next().unwrap_or(rest);
            let name = name_part
                .strip_prefix("No commits yet on ")
                .unwrap_or(name_part)
                .split_whitespace()
                .next()
                .unwrap_or("");
            // "HEAD (no branch)" → detached; leave branch None.
            if !name.is_empty() && name != "HEAD" {
                branch = Some(name.to_string());
            }
            if let Some(inner) = rest
                .split_once('[')
                .and_then(|(_, b)| b.split_once(']'))
                .map(|(inner, _)| inner)
            {
                ahead = parse_track(inner, "ahead");
                behind = parse_track(inner, "behind");
            }
            continue;
        }
        // Each change is `XY <path>` — 2 status chars, a space, then the path.
        if line.len() < 3 {
            continue;
        }
        total += 1;
        if files.len() < GIT_FILES_CAP {
            let status = line[..2].to_string();
            let raw_path = &line[3..];
            // Rename/copy renders as "old -> new"; keep the new path. rsplit so
            // a ` -> ` inside the old path can't steal the split.
            let path_field = raw_path
                .rsplit_once(" -> ")
                .map(|(_, new)| new)
                .unwrap_or(raw_path);
            files.push(GitFile {
                path: unquote_git_path(path_field),
                status,
            });
        }
    }

    GitStatus {
        is_repo: true,
        branch,
        ahead,
        behind,
        files,
        total,
    }
}

/// Pull `ahead`/`behind` counts out of a porcelain bracket like
/// "ahead 1, behind 2".
fn parse_track(inner: &str, key: &str) -> u32 {
    inner
        .split(',')
        .find_map(|seg| {
            seg.trim()
                .strip_prefix(key)
                .and_then(|n| n.trim().parse().ok())
        })
        .unwrap_or(0)
}

/// Index of the first title matching any of `names` (case-insensitive). Lets
/// `parse_top` find a column by name regardless of the platform `ps` layout.
fn col(titles: &[String], names: &[&str]) -> Option<usize> {
    titles
        .iter()
        .position(|t| names.iter().any(|n| t.eq_ignore_ascii_case(n)))
}

/// Map a `docker top` response (titles + rows) to `ProcessInfo`, locating each
/// field by column title. `CMD`/`COMMAND` falls back to the last column (where
/// `ps` always puts the command). Pulled out of the async method so it can be
/// unit-tested without a container.
fn parse_top(titles: &[String], rows: &[Vec<String>]) -> Vec<ProcessInfo> {
    let pid_i = col(titles, &["PID"]);
    let user_i = col(titles, &["USER", "UID"]);
    let time_i = col(titles, &["TIME"]);
    let cmd_i = col(titles, &["CMD", "COMMAND"]);
    rows.iter()
        .filter_map(|r| {
            let at = |i: Option<usize>| i.and_then(|i| r.get(i)).cloned();
            let command = at(cmd_i).or_else(|| r.last().cloned()).unwrap_or_default();
            let pid = at(pid_i).unwrap_or_default();
            // Skip a wholly empty row (defensive against odd ps output).
            if pid.is_empty() && command.is_empty() {
                return None;
            }
            Some(ProcessInfo {
                pid,
                user: at(user_i).unwrap_or_default(),
                time: at(time_i),
                command,
            })
        })
        .collect()
}

/// Undo git's porcelain path quoting. With `core.quotePath=false` non-ASCII is
/// already raw, so only paths with spaces / control chars / quotes arrive in
/// the `"..."` form; strip the quotes and unescape the common C-escapes. A path
/// that isn't quoted is returned unchanged.
fn unquote_git_path(s: &str) -> String {
    let bytes = s.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'"' || bytes[bytes.len() - 1] != b'"' {
        return s.to_string();
    }
    let inner = &s[1..s.len() - 1];
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            // Unknown escape: keep it verbatim rather than dropping data.
            Some(other) => {
                out.push('\\');
                out.push(other);
            },
            None => out.push('\\'),
        }
    }
    out
}

pub struct AttachHandles {
    pub exec_id: String,
    pub output: std::pin::Pin<
        Box<
            dyn futures_util::Stream<
                    Item = Result<bollard::container::LogOutput, bollard::errors::Error>,
                > + Send,
        >,
    >,
    pub input: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send>>,
}

#[cfg(test)]
mod tests {
    use super::{
        account_launch_script, clip_title, commit_success_line, count_session_edits, is_env_name,
        is_session_id, is_synthetic_prompt, is_version_like, latest_context_used,
        parse_agent_config, parse_browse_dirs, parse_claude_integrations, parse_claude_sessions,
        parse_claude_usage, parse_find, parse_frontmatter, parse_git_log, parse_git_status,
        parse_tools_field, parse_top, workspace_path, Cli,
    };

    #[test]
    fn commit_success_line_anchors_on_hash_not_subject() {
        // Real success lines.
        assert!(commit_success_line("[main a1b2c3d] add feature"));
        assert!(commit_success_line(
            "[master (root-commit) 0fedcba] initial"
        ));
        // A subject containing error words must NOT be mistaken for failure: the
        // success line is still detected by its bracketed hash.
        assert!(commit_success_line("[main 1234567] fix: error: handling"));
        // Genuine failures have no bracketed hash prefix.
        assert!(!commit_success_line(
            "nothing to commit, working tree clean"
        ));
        assert!(!commit_success_line(
            "fatal: not a git repository (or any of the parent directories): .git"
        ));
        assert!(!commit_success_line(
            "Author identity unknown\n*** Please tell me who you are."
        ));
        assert!(!commit_success_line(""));
        // A bracketed prefix without a hash-like token is not a success line.
        assert!(!commit_success_line("[note] not a commit"));
    }

    #[test]
    fn version_like_accepts_real_versions_rejects_exec_errors() {
        assert!(is_version_like("2.1.148 (Claude Code)"));
        assert!(is_version_like("codex-cli 0.132.0"));
        // docker-exec failure text for an absent binary
        assert!(!is_version_like(
            "exec failed: unable to start container process: exec: \"antigravity\": executable file not found in $PATH"
        ));
        // no digits → not a version
        assert!(!is_version_like("command not found"));
        assert!(!is_version_like(""));
    }

    #[test]
    fn codex_vault_launch_script_restores_oauth_json_or_exports_key() {
        let argv = vec!["codex".to_string(), "--yolo".to_string()];
        let script =
            account_launch_script(Cli::Codex, "OPENAI_API_KEY", "CODEHUB_VAULT_profile", &argv);

        assert!(script.contains("/config/codex/auth.json"));
        assert!(script.contains("export OPENAI_API_KEY=\"${CODEHUB_VAULT_profile}\""));
        assert!(script.contains("unset CODEHUB_VAULT_profile"));
        assert!(script.contains("exec 'codex' '--yolo'"));
    }

    #[test]
    fn claude_vault_launch_script_restores_auth_bundle_to_profile_dir() {
        let argv = vec![
            "/root/.local/bin/claude".to_string(),
            "--session-id".to_string(),
            "abc".to_string(),
        ];
        let script = account_launch_script(
            Cli::Claude,
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CODEHUB_VAULT_profile",
            &argv,
        );

        assert!(script.contains(crate::auth::CLAUDE_AUTH_BUNDLE_PREFIX));
        assert!(script.contains("/config/claude-profiles/CODEHUB_VAULT_profile"));
        assert!(script.contains("hasCompletedOnboarding = true"));
        assert!(script.contains("hasTrustDialogAccepted: true"));
        assert!(script.contains("export CLAUDE_CONFIG_DIR=\"$dir\""));
        assert!(script.contains("unset CODEHUB_VAULT_profile payload"));
        assert!(script.contains("exec '/root/.local/bin/claude' '--session-id' 'abc'"));
    }

    #[test]
    fn git_status_parses_branch_tracking_and_changes() {
        let raw = "## main...origin/main [ahead 2, behind 1]\n\
                    M src/app.rs\n\
                   ?? new_file.txt\n\
                   R  old.rs -> renamed.rs\n";
        let s = parse_git_status(raw);
        assert!(s.is_repo);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.ahead, 2);
        assert_eq!(s.behind, 1);
        assert_eq!(s.total, 3);
        assert_eq!(s.files.len(), 3);
        // Rename keeps the new path.
        assert_eq!(s.files[2].path, "renamed.rs");
        assert_eq!(s.files[2].status, "R ");
    }

    #[test]
    fn git_status_handles_clean_tree_and_no_upstream() {
        let s = parse_git_status("## feature/x\n");
        assert!(s.is_repo);
        assert_eq!(s.branch.as_deref(), Some("feature/x"));
        assert_eq!(s.ahead, 0);
        assert_eq!(s.behind, 0);
        assert_eq!(s.total, 0);
        assert!(s.files.is_empty());
    }

    #[test]
    fn git_status_unquotes_paths_with_spaces_and_renames() {
        // Paths with spaces arrive double-quoted even with core.quotePath=false.
        let raw = "## main\n\
                   ?? \"weird name.txt\"\n\
                   R  \"old name.rs\" -> \"new name.rs\"\n";
        let s = parse_git_status(raw);
        assert_eq!(s.files.len(), 2);
        assert_eq!(s.files[0].path, "weird name.txt");
        // Rename keeps the (unquoted) new path.
        assert_eq!(s.files[1].path, "new name.rs");
    }

    #[test]
    fn git_status_reports_non_repo() {
        let s = parse_git_status(
            "fatal: not a git repository (or any of the parent directories): .git\n",
        );
        assert!(!s.is_repo);
        assert!(s.branch.is_none());
        assert_eq!(s.total, 0);
    }

    #[test]
    fn top_maps_columns_by_title() {
        // Linux `docker top` default layout (UID-style USER column, CMD last).
        let titles: Vec<String> = ["UID", "PID", "PPID", "C", "STIME", "TTY", "TIME", "CMD"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let row = |cells: &[&str]| cells.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let rows = vec![
            row(&[
                "root",
                "1",
                "0",
                "0",
                "10:00",
                "?",
                "00:00:01",
                "tmux new-session",
            ]),
            row(&[
                "node",
                "42",
                "1",
                "2",
                "10:01",
                "pts/0",
                "00:00:09",
                "node /usr/bin/claude",
            ]),
        ];
        let procs = parse_top(&titles, &rows);
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[0].pid, "1");
        assert_eq!(procs[0].user, "root");
        assert_eq!(procs[0].time.as_deref(), Some("00:00:01"));
        assert_eq!(procs[0].command, "tmux new-session");
        assert_eq!(procs[1].command, "node /usr/bin/claude");
    }

    #[test]
    fn git_log_parses_us_delimited_commits() {
        let raw = "abc123\u{1f}Ada\u{1f}2 hours ago\u{1f}feat: add the thing\n\
                   def456\u{1f}Grace\u{1f}3 days ago\u{1f}fix: spaces, commas: kept\n";
        let commits = parse_git_log(raw);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].hash, "abc123");
        assert_eq!(commits[0].author, "Ada");
        assert_eq!(commits[0].relative, "2 hours ago");
        assert_eq!(commits[0].subject, "feat: add the thing");
        // A subject with its own separators survives intact.
        assert_eq!(commits[1].subject, "fix: spaces, commas: kept");
    }

    #[test]
    fn git_log_skips_non_commit_lines() {
        // fatal error (non-repo) and a blank line produce no rows.
        let raw = "fatal: not a git repository\n\n";
        assert!(parse_git_log(raw).is_empty());
    }

    #[test]
    fn top_falls_back_to_last_column_for_command() {
        // A layout with no CMD/COMMAND title still recovers the command from the
        // final column, and a column-less TIME comes back as None.
        let titles: Vec<String> = ["PID", "USER"].iter().map(|s| s.to_string()).collect();
        let rows = vec![vec!["7".to_string(), "app".to_string()]];
        let procs = parse_top(&titles, &rows);
        assert_eq!(procs.len(), 1);
        assert_eq!(procs[0].pid, "7");
        assert_eq!(procs[0].command, "app");
        assert!(procs[0].time.is_none());
    }

    #[test]
    fn find_parses_type_size_name() {
        // `%y\t%s\t%f` rows → typed entries; a malformed line is skipped, and a
        // name with spaces survives (splitn(3) keeps the remainder intact).
        let raw = "d\t4096\tsrc\nf\t128\tREADME.md\nf\t0\tmy notes.txt\nbogus line\n";
        let entries = parse_find(raw);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].kind, "dir");
        assert_eq!(entries[0].name, "src");
        assert_eq!(entries[1].kind, "file");
        assert_eq!(entries[1].size, 128);
        assert_eq!(entries[2].name, "my notes.txt");
    }

    #[test]
    fn browse_dirs_flags_repos_and_sorts() {
        // `R` rows carry a branch; `D` rows don't. A repo on detached HEAD has an
        // empty branch field → None. Output is sorted by name; malformed dropped.
        let raw = "R\tmain\trepoB\nD\t\tassets\nR\t\tdetached\nbogus\n";
        let dirs = parse_browse_dirs(raw);
        assert_eq!(dirs.len(), 3);
        assert_eq!(dirs[0].name, "assets");
        assert!(!dirs[0].is_repo);
        assert_eq!(dirs[1].name, "detached");
        assert!(dirs[1].is_repo);
        assert_eq!(dirs[1].branch, None);
        assert_eq!(dirs[2].name, "repoB");
        assert_eq!(dirs[2].branch.as_deref(), Some("main"));
    }

    #[test]
    fn workspace_path_confines_to_workspace() {
        assert_eq!(workspace_path("").unwrap(), "/workspace");
        assert_eq!(workspace_path("/workspace").unwrap(), "/workspace");
        assert_eq!(workspace_path("/workspace/src").unwrap(), "/workspace/src");
        // Traversal and escapes are rejected.
        assert!(workspace_path("/workspace/../etc/passwd").is_err());
        assert!(workspace_path("/etc/passwd").is_err());
        assert!(workspace_path("/workspaceevil").is_err());
    }

    #[test]
    fn claude_usage_sums_real_tokens_and_counts_sessions_turns() {
        // Two sessions; non-assistant lines contribute only their sessionId.
        let raw = concat!(
            r#"{"type":"user","sessionId":"s1","message":{"content":"hi"}}"#,
            "\n",
            r#"{"type":"assistant","sessionId":"s1","timestamp":"2026-05-22T12:00:00.000Z","message":{"model":"claude-opus-4-7","usage":{"input_tokens":100,"output_tokens":200,"cache_read_input_tokens":1000,"cache_creation_input_tokens":50}}}"#,
            "\n",
            r#"{"type":"assistant","sessionId":"s2","timestamp":"2026-05-23T09:00:00.000Z","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":20}}}"#,
            "\n",
            "not json at all\n",
            "\n",
        );
        let u = parse_claude_usage(raw);
        assert_eq!(u.sessions, 2);
        assert_eq!(u.turns, 2); // two assistant lines
        assert_eq!(u.totals.input, 110);
        assert_eq!(u.totals.output, 220);
        assert_eq!(u.totals.cache_read, 1000);
        assert_eq!(u.totals.cache_creation, 50);
        // Opus: 100*15 + 200*75 + 50*18.75 + 1000*1.50 per Mtok.
        let opus = (100.0 * 15.0 + 200.0 * 75.0 + 50.0 * 18.75 + 1000.0 * 1.50) / 1_000_000.0;
        let sonnet = (10.0 * 3.0 + 20.0 * 15.0) / 1_000_000.0;
        assert!((u.est_cost_usd - (opus + sonnet)).abs() < 1e-12);
        assert_eq!(u.by_day.len(), 2); // grouped by UTC date
        assert_eq!(u.by_model.len(), 2);
        assert_eq!(u.unpriced_tokens, 0);
        assert_eq!(u.rates_as_of, "2026-05");
    }

    #[test]
    fn claude_usage_flags_unpriced_models_without_fabricating_cost() {
        let raw = concat!(
            r#"{"type":"assistant","sessionId":"s1","timestamp":"2026-05-22T12:00:00.000Z","message":{"model":"some-future-model-x","usage":{"input_tokens":40,"output_tokens":60}}}"#,
            "\n",
        );
        let u = parse_claude_usage(raw);
        assert_eq!(u.turns, 1);
        assert_eq!(u.totals.input, 40);
        assert_eq!(u.est_cost_usd, 0.0); // no rate → no estimate, never guessed
        assert_eq!(u.unpriced_tokens, 100); // input + output
        assert_eq!(u.by_model.len(), 1);
        assert!(!u.by_model[0].priced);
    }

    #[test]
    fn claude_usage_dedupes_replayed_assistant_lines() {
        // The same response (message.id + requestId) replayed into a resumed
        // session's transcript must be counted once, not twice.
        let one = r#"{"type":"assistant","sessionId":"s1","requestId":"req-1","timestamp":"2026-05-22T12:00:00.000Z","message":{"id":"msg_abc","model":"claude-opus-4-7","usage":{"input_tokens":100,"output_tokens":200}}}"#;
        // s2 resumes s1 and replays msg_abc, then adds a genuinely new response.
        let two = r#"{"type":"assistant","sessionId":"s2","requestId":"req-2","timestamp":"2026-05-23T12:00:00.000Z","message":{"id":"msg_def","model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":20}}}"#;
        let raw = format!("{one}\n{one}\n{two}\n");
        let u = parse_claude_usage(&raw);
        // Two distinct sessions (s1, s2) even though one line was a replay.
        assert_eq!(u.sessions, 2);
        // Replayed msg_abc counted once → 2 unique turns, not 3.
        assert_eq!(u.turns, 2);
        assert_eq!(u.totals.input, 110);
        assert_eq!(u.totals.output, 220);
        // Only the genuinely-new line lands on the second day.
        assert_eq!(u.by_day.len(), 2);
    }

    #[test]
    fn claude_usage_empty_input_is_all_zero_not_error() {
        let u = parse_claude_usage("");
        assert_eq!(u.sessions, 0);
        assert_eq!(u.turns, 0);
        assert_eq!(u.totals, super::TokenTotals::default());
        assert_eq!(u.est_cost_usd, 0.0);
        assert!(u.by_model.is_empty());
        assert!(u.by_day.is_empty());
        // Rate table is always surfaced for UI transparency.
        assert_eq!(u.rates.len(), 3);
    }

    #[test]
    fn claude_sessions_groups_by_id_newest_first_with_real_metadata() {
        // s-old: a titled session on a branch with two distinct user turns.
        let old = [
            r#"{"type":"user","sessionId":"s-old","uuid":"u1","timestamp":"2026-05-20T10:00:00.000Z","gitBranch":"feat/login","version":"2.1.145","message":{"role":"user","content":"first prompt"}}"#,
            r#"{"type":"assistant","sessionId":"s-old","timestamp":"2026-05-20T10:00:05.000Z","message":{"model":"claude-opus-4-7"}}"#,
            r#"{"type":"user","sessionId":"s-old","uuid":"u2","timestamp":"2026-05-20T10:01:00.000Z","gitBranch":"feat/login","message":{"role":"user","content":"second prompt"}}"#,
            r#"{"type":"ai-title","sessionId":"s-old","aiTitle":"Wire up login"}"#,
        ]
        .join("\n");
        // s-new: more recent, detached HEAD (→ no branch), title falls back to
        // the first user prompt, and one user turn is replayed (same uuid).
        let new = [
            r#"{"type":"user","sessionId":"s-new","uuid":"v1","timestamp":"2026-05-22T09:00:00.000Z","gitBranch":"HEAD","message":{"role":"user","content":"  Fix the flaky test  "}}"#,
            r#"{"type":"user","sessionId":"s-new","uuid":"v1","timestamp":"2026-05-22T09:00:00.000Z","gitBranch":"HEAD","message":{"role":"user","content":"Fix the flaky test"}}"#,
        ]
        .join("\n");
        let raw = format!("{old}\n{new}\n");
        let sessions = parse_claude_sessions(&raw);

        assert_eq!(sessions.len(), 2);
        // Newest activity first.
        assert_eq!(sessions[0].id, "s-new");
        assert_eq!(sessions[1].id, "s-old");

        // s-new: no ai-title → first prompt (trimmed) is the title; replayed
        // turn deduped by uuid → 1; detached HEAD → no branch; no assistant line
        // → no model.
        assert_eq!(sessions[0].title, "Fix the flaky test");
        assert_eq!(sessions[0].turns, 1);
        assert_eq!(sessions[0].branch, None);
        assert_eq!(sessions[0].model, None);

        // s-old: real ai-title wins over the prompt; two distinct turns; branch
        // and model recorded; window spans first→last timestamp.
        assert_eq!(sessions[1].title, "Wire up login");
        assert_eq!(sessions[1].turns, 2);
        assert_eq!(sessions[1].branch.as_deref(), Some("feat/login"));
        assert_eq!(sessions[1].model.as_deref(), Some("claude-opus-4-7"));
        assert_eq!(sessions[1].version.as_deref(), Some("2.1.145"));
        assert_eq!(sessions[1].started, "2026-05-20T10:00:00.000Z");
        assert_eq!(sessions[1].last_active, "2026-05-20T10:01:00.000Z");
    }

    #[test]
    fn claude_sessions_empty_input_is_empty_list_not_error() {
        assert!(parse_claude_sessions("").is_empty());
    }

    #[test]
    fn session_id_guard_rejects_path_and_shell_metacharacters() {
        assert!(is_session_id("32ed84f6-5897-4434-9028-41d44f2fdb25"));
        assert!(is_session_id("abc123"));
        // Anything that could escape the transcripts dir or reach the shell.
        assert!(!is_session_id(""));
        assert!(!is_session_id("../../etc/passwd"));
        assert!(!is_session_id("a/b"));
        assert!(!is_session_id("a.jsonl"));
        assert!(!is_session_id("id; rm -rf /"));
        assert!(!is_session_id(&"x".repeat(65)));
    }

    #[test]
    fn count_session_edits_counts_edit_tools_deduped() {
        // One response with an Edit + a Read (only Edit counts) and a second
        // response (different id) with a Write + a MultiEdit. A replay of the
        // first line must not double-count. Non-assistant + plain text lines
        // contribute nothing.
        let edit_read = r#"{"type":"assistant","requestId":"r1","message":{"id":"m1","content":[{"type":"text","text":"ok"},{"type":"tool_use","name":"Edit","input":{}},{"type":"tool_use","name":"Read","input":{}}]}}"#;
        let write_multi = r#"{"type":"assistant","requestId":"r2","message":{"id":"m2","content":[{"type":"tool_use","name":"Write","input":{}},{"type":"tool_use","name":"MultiEdit","input":{}}]}}"#;
        let user = r#"{"type":"user","message":{"content":"hi"}}"#;
        let text_only = r#"{"type":"assistant","requestId":"r3","message":{"id":"m3","content":[{"type":"text","text":"done"}]}}"#;
        let raw = format!("{edit_read}\n{write_multi}\n{user}\n{text_only}\n{edit_read}\n");
        // Edit(1) + Write(1) + MultiEdit(1) = 3; the replayed first line is deduped.
        assert_eq!(count_session_edits(&raw), 3);
        assert_eq!(count_session_edits(""), 0);
    }

    #[test]
    fn latest_context_used_is_last_turn_input_footprint() {
        // Two turns; the ctx stat tracks the most recent one. Used = input +
        // cache_read + cache_creation (output excluded — it's generation, not
        // read context). Last assistant line wins regardless of earlier turns.
        let raw = [
            r#"{"type":"assistant","message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":999,"cache_read_input_tokens":100,"cache_creation_input_tokens":5}}}"#,
            r#"{"type":"user","message":{"content":"more"}}"#,
            r#"{"type":"assistant","message":{"model":"claude-opus-4-7","usage":{"input_tokens":20,"output_tokens":7,"cache_read_input_tokens":3000,"cache_creation_input_tokens":80}}}"#,
        ]
        .join("\n");
        // 20 + 3000 + 80 = 3100; output (7) ignored.
        assert_eq!(latest_context_used(&raw), 3100);

        // No assistant turn with usage → 0.
        assert_eq!(latest_context_used(""), 0);
        assert_eq!(
            latest_context_used(r#"{"type":"user","message":{"content":"hi"}}"#),
            0
        );
    }

    #[test]
    fn parse_claude_integrations_reads_account_and_mcp_redacting_secrets() {
        let cfg = r#"{
            "oauthAccount": {
                "emailAddress": "dev@example.com",
                "displayName": "Dev User",
                "organizationType": "claude_max",
                "organizationName": "Acme",
                "organizationRole": "admin"
            },
            "mcpServers": {
                "github": {"type":"http","url":"https://mcp.example.com","headers":{"Authorization":"Bearer SECRET"}}
            },
            "projects": {
                "/workspace": {
                    "mcpServers": {
                        "local-fs": {"command":"npx","args":["-y","fs-server"],"env":{"TOKEN":"SECRET"}}
                    }
                }
            }
        }"#;
        let mcp = r#"{"mcpServers":{"shared-db":{"type":"sse","url":"https://sse.example.com"}}}"#;
        let i = parse_claude_integrations(cfg, mcp);

        let acct = i.account.clone().expect("account present");
        assert_eq!(acct.email.as_deref(), Some("dev@example.com"));
        assert_eq!(acct.name.as_deref(), Some("Dev User"));
        assert_eq!(acct.plan.as_deref(), Some("Max")); // claude_max prettified
        assert_eq!(acct.org.as_deref(), Some("Acme"));
        assert_eq!(acct.role.as_deref(), Some("admin"));

        // Three servers, sorted by scope (project < shared < user) then name.
        assert_eq!(i.mcp_servers.len(), 3);
        assert_eq!(i.mcp_servers[0].name, "local-fs");
        assert_eq!(i.mcp_servers[0].scope, "project");
        assert_eq!(i.mcp_servers[0].transport, "stdio"); // inferred from command
        assert_eq!(i.mcp_servers[0].target.as_deref(), Some("npx"));
        assert_eq!(i.mcp_servers[1].name, "shared-db");
        assert_eq!(i.mcp_servers[1].scope, "shared");
        assert_eq!(i.mcp_servers[1].transport, "sse");
        assert_eq!(i.mcp_servers[2].name, "github");
        assert_eq!(i.mcp_servers[2].scope, "user");
        assert_eq!(i.mcp_servers[2].transport, "http");

        // No secret value ever appears in the serialized output.
        let json = serde_json::to_string(&i).unwrap();
        assert!(!json.contains("SECRET"));
        assert!(!json.contains("Authorization"));
        assert!(!json.contains("TOKEN"));

        // Empty / non-JSON input → empty result, no panic, no account.
        let empty = parse_claude_integrations("", "");
        assert!(empty.account.is_none());
        assert!(empty.mcp_servers.is_empty());
        let garbage = parse_claude_integrations("cat: no such file", "{not json");
        assert!(garbage.account.is_none());
        assert!(garbage.mcp_servers.is_empty());
    }

    #[test]
    fn claude_sessions_skips_command_wrapper_for_title() {
        assert!(is_synthetic_prompt("<local-command-caveat>Caveat: …"));
        assert!(is_synthetic_prompt("<command-name>/clear"));
        assert!(!is_synthetic_prompt("fix the parser bug"));
        // First user line is Claude's own caveat wrapper; the title should fall
        // through to the next genuinely-typed prompt, not the boilerplate.
        let raw = [
            r#"{"type":"user","sessionId":"s","uuid":"a","timestamp":"2026-05-22T09:00:00.000Z","message":{"role":"user","content":"<local-command-caveat>Caveat: messages below were generated…"}}"#,
            r#"{"type":"user","sessionId":"s","uuid":"b","timestamp":"2026-05-22T09:00:01.000Z","message":{"role":"user","content":"refactor the auth middleware"}}"#,
        ]
        .join("\n");
        let sessions = parse_claude_sessions(&raw);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title, "refactor the auth middleware");
        assert_eq!(sessions[0].turns, 2);
    }

    #[test]
    fn frontmatter_and_tools_parse() {
        let md = "---\nname: code-reviewer\ndescription: \"Reviews diffs\"\nmodel: sonnet-4.7\ntools: [Read, Grep, Bash]\n---\nbody text here";
        let fm = parse_frontmatter(md);
        assert_eq!(fm.get("name").map(String::as_str), Some("code-reviewer"));
        assert_eq!(
            fm.get("description").map(String::as_str),
            Some("Reviews diffs")
        );
        assert_eq!(fm.get("model").map(String::as_str), Some("sonnet-4.7"));
        assert_eq!(
            parse_tools_field(fm.get("tools").unwrap()),
            vec!["Read", "Grep", "Bash"]
        );
        // Comma list (no brackets) also works.
        assert_eq!(parse_tools_field("Read, Edit"), vec!["Read", "Edit"]);
        // No frontmatter → empty.
        assert!(parse_frontmatter("just a plain file").is_empty());
    }

    #[test]
    fn agent_config_reads_real_fields_and_empty_is_honest() {
        let cfg = r#"{
            "model": "claude-opus-4-7",
            "enabledPlugins": { "eslint@official": true, "prettier@official": false }
        }"#;
        let settings = r#"{"permissions":{"defaultMode":"auto","allow":["Read(/workspace/**)","Edit(/workspace/**)"],"ask":["Bash(git push:*)"],"deny":["Read(./secrets/**)"]},"theme":"dark"}"#;
        let agents = "===CODEHUB-FILE:/config/claude/agents/reviewer.md===\n---\nname: reviewer\ndescription: Reviews code\nmodel: sonnet-4.7\ntools: [Read, Grep]\n---\nprompt\n===CODEHUB-FILE:/workspace/.claude/agents/tester.md===\n---\ndescription: Writes tests\n---\nx";
        let skills = "===CODEHUB-FILE:/config/claude/skills/write-commit/SKILL.md===\n---\nname: write-commit\ndescription: git commit helper\n---\nbody";
        let marketplaces = r#"{"claude-plugins-official":{"source":{}}}"#;
        let c = parse_agent_config(cfg, settings, agents, skills, marketplaces);

        assert_eq!(c.model.as_deref(), Some("claude-opus-4-7"));
        assert_eq!(c.permission_mode.as_deref(), Some("auto"));
        // Permission rules surfaced verbatim, bucketed.
        assert_eq!(
            c.permission_allow,
            vec!["Read(/workspace/**)", "Edit(/workspace/**)"]
        );
        assert_eq!(c.permission_ask, vec!["Bash(git push:*)"]);
        assert_eq!(c.permission_deny, vec!["Read(./secrets/**)"]);
        // Two sub-agents, sorted project < user; the project one falls back to
        // its file stem for the name (no frontmatter `name`).
        assert_eq!(c.subagents.len(), 2);
        assert_eq!(c.subagents[0].scope, "project");
        assert_eq!(c.subagents[0].name, "tester");
        assert_eq!(c.subagents[1].name, "reviewer");
        assert_eq!(c.subagents[1].tools, vec!["Read", "Grep"]);
        assert_eq!(c.skills.len(), 1);
        assert_eq!(c.skills[0].name, "write-commit");
        // Plugins: both enabled+disabled surfaced with their marketplace split.
        assert_eq!(c.plugins.len(), 2);
        assert_eq!(c.plugins[0].name, "eslint");
        assert_eq!(c.plugins[0].marketplace.as_deref(), Some("official"));
        assert!(c.plugins[0].enabled);
        assert!(!c.plugins[1].enabled);
        assert_eq!(c.marketplaces, vec!["claude-plugins-official"]);

        // Empty input → an all-empty config, never sample data.
        let empty = parse_agent_config("", "", "", "", "");
        assert_eq!(empty, super::AgentConfig::default());
    }

    #[test]
    fn clip_title_collapses_and_clips() {
        // Multi-line + extra whitespace → single normalized line.
        assert_eq!(clip_title("  hello\nworld  "), "hello");
        assert_eq!(clip_title("a   b\t c"), "a b c");
        // Over the cap gets an ellipsis.
        let long = "x".repeat(200);
        let clipped = clip_title(&long);
        assert!(clipped.ends_with('…'));
        assert_eq!(clipped.chars().count(), 81); // 80 + ellipsis
    }

    #[test]
    fn env_name_validation_guards_remap() {
        // Valid POSIX env identifiers.
        assert!(is_env_name("CLAUDE_CODE_OAUTH_TOKEN"));
        assert!(is_env_name("_x"));
        assert!(is_env_name("A1_B2"));
        // Anything that could break out of the `${NAME}` expansion is rejected.
        assert!(!is_env_name("")); // empty
        assert!(!is_env_name("1ABC")); // leading digit
        assert!(!is_env_name("A B")); // space
        assert!(!is_env_name("A}B")); // brace
        assert!(!is_env_name("A$(x)")); // command substitution chars
        assert!(!is_env_name("A-B")); // dash
    }

    #[test]
    fn shell_single_quote_neutralizes_quotes() {
        assert_eq!(super::shell_single_quote("claude"), "'claude'");
        // An embedded single quote is closed/escaped/reopened, so the result is
        // inert when pasted into a `sh -c` command line.
        assert_eq!(super::shell_single_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn canonical_auth_var_per_cli() {
        assert_eq!(
            Cli::Claude.canonical_auth_var(),
            Some("CLAUDE_CODE_OAUTH_TOKEN")
        );
        assert_eq!(Cli::Codex.canonical_auth_var(), Some("OPENAI_API_KEY"));
        assert_eq!(
            Cli::Antigravity.canonical_auth_var(),
            Some("GOOGLE_API_KEY")
        );
        assert_eq!(Cli::Shell.canonical_auth_var(), None);
    }

    // ── Codex parser tests ───────────────────────────────────────────────────

    use super::{
        codex_session_usage_from_raw, extract_codex_rate_limits, parse_codex_sessions,
        parse_codex_usage, parse_github_repos,
    };

    // Codex 0.135 rollout lines: a top-level `type` envelope, the session id only in
    // `session_meta`, the model only in `turn_context`, events under `event_msg` with
    // `payload.type` the kind and `*_tokens` counts. Tests stitch these in order.
    fn codex_session_meta_line(session_id: &str, ts: &str, branch: &str) -> String {
        serde_json::json!({
            "timestamp": ts,
            "type": "session_meta",
            "payload": { "id": session_id, "cli_version": "0.135.0", "git": { "branch": branch } }
        })
        .to_string()
    }

    fn codex_turn_context_line(ts: &str, model: &str) -> String {
        serde_json::json!({
            "timestamp": ts,
            "type": "turn_context",
            "payload": { "model": model }
        })
        .to_string()
    }

    fn codex_token_count_line(
        ts: &str,
        last_input: u64,
        last_output: u64,
        total_input: u64,
        total_output: u64,
    ) -> String {
        serde_json::json!({
            "timestamp": ts,
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "last_token_usage": {
                        "input_tokens": last_input,
                        "cached_input_tokens": 0u64,
                        "output_tokens": last_output,
                        "reasoning_output_tokens": 0u64,
                        "total_tokens": last_input + last_output
                    },
                    "total_token_usage": {
                        "input_tokens": total_input,
                        "cached_input_tokens": 0u64,
                        "output_tokens": total_output,
                        "reasoning_output_tokens": 0u64,
                        "total_tokens": total_input + total_output
                    }
                },
                "rate_limits": {
                    "primary": {
                        "used_percent": 42.5,
                        "window_minutes": 60u64,
                        "resets_at": "2026-05-24T10:00:00Z"
                    },
                    "plan_type": "pro"
                }
            }
        })
        .to_string()
    }

    fn codex_task_complete_line(ts: &str) -> String {
        serde_json::json!({
            "timestamp": ts,
            "type": "event_msg",
            "payload": { "type": "task_complete" }
        })
        .to_string()
    }

    fn codex_user_message_line(ts: &str, message: &str) -> String {
        serde_json::json!({
            "timestamp": ts,
            "type": "event_msg",
            "payload": { "type": "user_message", "message": message }
        })
        .to_string()
    }

    #[test]
    fn codex_usage_sums_real_tokens_and_counts_sessions_turns() {
        let raw = [
            codex_session_meta_line("s1", "2026-05-22T12:00:00Z", "main"),
            codex_turn_context_line("2026-05-22T12:00:00Z", "gpt-4o"),
            codex_token_count_line("2026-05-22T12:00:00Z", 100, 200, 100, 200),
            codex_task_complete_line("2026-05-22T12:00:01Z"),
            codex_session_meta_line("s2", "2026-05-23T09:00:00Z", "main"),
            codex_turn_context_line("2026-05-23T09:00:00Z", "o4-mini"),
            codex_token_count_line("2026-05-23T09:00:00Z", 10, 20, 10, 20),
            codex_task_complete_line("2026-05-23T09:00:01Z"),
        ]
        .join("\n");
        let u = parse_codex_usage(&raw);
        assert_eq!(u.sessions, 2);
        assert_eq!(u.turns, 2);
        // global totals: cumulative from each session's last token_count
        assert_eq!(u.totals.input, 110); // 100 + 10
        assert_eq!(u.totals.output, 220); // 200 + 20
                                          // cost should be > 0 for priced models
        assert!(u.est_cost_usd > 0.0);
        assert_eq!(u.rates_as_of, "2026-05");
        assert!(!u.rates.is_empty());
        assert_eq!(u.unpriced_tokens, 0);
    }

    #[test]
    fn codex_usage_empty_input_is_all_zero_not_error() {
        let u = parse_codex_usage("");
        assert_eq!(u.sessions, 0);
        assert_eq!(u.turns, 0);
        assert_eq!(u.totals.input, 0);
        assert_eq!(u.est_cost_usd, 0.0);
        assert!(u.by_model.is_empty());
        assert!(u.by_day.is_empty());
        // Rate table always surfaced for transparency.
        assert!(!u.rates.is_empty());
    }

    #[test]
    fn codex_usage_flags_unpriced_models_without_fabricating_cost() {
        let raw = [
            codex_session_meta_line("s1", "2026-05-22T12:00:00Z", "main"),
            codex_turn_context_line("2026-05-22T12:00:00Z", "future-model-xyz"),
            codex_token_count_line("2026-05-22T12:00:00Z", 40, 60, 40, 60),
        ]
        .join("\n");
        let u = parse_codex_usage(&raw);
        assert_eq!(u.est_cost_usd, 0.0);
        assert_eq!(u.unpriced_tokens, 100); // input + output
        assert!(!u.by_model[0].priced);
    }

    #[test]
    fn codex_sessions_groups_by_id_newest_first() {
        let raw = [
            codex_session_meta_line("s-old", "2026-05-20T10:00:00Z", "main"),
            codex_user_message_line("2026-05-20T10:00:30Z", "Fix the bug"),
            codex_task_complete_line("2026-05-20T10:01:00Z"),
            codex_session_meta_line("s-new", "2026-05-22T09:00:00Z", "main"),
            codex_user_message_line("2026-05-22T09:00:30Z", "Add tests"),
            codex_task_complete_line("2026-05-22T09:02:00Z"),
        ]
        .join("\n");
        let sessions = parse_codex_sessions(&raw);
        assert_eq!(sessions.len(), 2);
        // Newest first.
        assert_eq!(sessions[0].id, "s-new");
        assert_eq!(sessions[0].title, "Add tests");
        assert_eq!(sessions[0].turns, 1);
        assert_eq!(sessions[1].id, "s-old");
        assert_eq!(sessions[1].title, "Fix the bug");
        assert_eq!(sessions[1].turns, 1);
    }

    #[test]
    fn codex_session_usage_from_raw_returns_none_on_empty() {
        assert!(codex_session_usage_from_raw("").is_none());
    }

    #[test]
    fn claude_context_window_maps_family_to_window() {
        assert_eq!(super::claude_context_window("claude-opus-4-8"), 1_000_000);
        assert_eq!(super::claude_context_window("claude-sonnet-4-6"), 1_000_000);
        assert_eq!(
            super::claude_context_window("claude-haiku-4-5-20251001"),
            200_000
        );
        // Unknown family → 0 so the gauge shows an em-dash, not a guess.
        assert_eq!(super::claude_context_window("claude-3-5-sonnet"), 0);
        assert_eq!(super::claude_context_window(""), 0);
    }

    #[test]
    fn latest_claude_model_reads_last_assistant_model() {
        let raw = concat!(
            r#"{"type":"assistant","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":1}}}"#,
            "\n",
            r#"{"type":"user","message":{"content":"hi"}}"#,
            "\n",
            r#"{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":2}}}"#,
            "\n",
        );
        assert_eq!(
            super::latest_claude_model(raw).as_deref(),
            Some("claude-opus-4-8")
        );
        assert_eq!(super::latest_claude_model(""), None);
    }

    #[test]
    fn codex_session_usage_counts_turns_and_tokens() {
        // Real Codex 0.135 rollout shape: enveloped `type:"event_msg"` + `payload.type`,
        // `*_tokens` field names. total_token_usage is cumulative (→ tokens_in/out),
        // last_token_usage is this-turn (→ context_used footprint).
        let raw = concat!(
            r#"{"type":"session_meta","payload":{"id":"019e75ea"}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"task_started","model_context_window":258400}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":200},"last_token_usage":{"input_tokens":60,"cached_input_tokens":20,"output_tokens":30}}}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#,
            "\n",
        );
        let usage = codex_session_usage_from_raw(raw).unwrap();
        assert_eq!(usage.turns, 1);
        assert_eq!(usage.tokens_in, 100);
        assert_eq!(usage.tokens_out, 200);
        assert_eq!(usage.context_used, 60);
        assert_eq!(usage.context_window, 258_400);
        assert_eq!(usage.edits, 0);
    }

    #[test]
    fn codex_session_usage_surfaces_before_first_task_complete() {
        // Mid-first-turn: token_count seen, no task_complete yet → still report.
        let raw = concat!(
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":42,"output_tokens":7},"last_token_usage":{"input_tokens":42,"output_tokens":7}}}}"#,
            "\n",
        );
        let usage = codex_session_usage_from_raw(raw).unwrap();
        assert_eq!(usage.turns, 0);
        assert_eq!(usage.tokens_in, 42);
        assert_eq!(usage.context_used, 42);
    }

    #[test]
    fn extract_codex_rate_limits_reads_primary_fields() {
        let line = codex_token_count_line("2026-05-22T12:00:00Z", 10, 20, 10, 20);
        let rl = extract_codex_rate_limits(&line).unwrap();
        assert!((rl.primary_used_pct.unwrap() - 42.5).abs() < 1e-9);
        assert_eq!(rl.primary_window_minutes, Some(60));
        assert_eq!(
            rl.primary_resets_at.as_deref(),
            Some("2026-05-24T10:00:00Z")
        );
        assert_eq!(rl.plan_type.as_deref(), Some("pro"));
    }

    #[test]
    fn extract_codex_rate_limits_returns_none_on_empty() {
        assert!(extract_codex_rate_limits("").is_none());
    }

    // ── GitHub parser tests ─────────────────────────────────────────────────

    #[test]
    fn parse_github_repos_extracts_name_branch_visibility() {
        let json = r#"[
            {"full_name":"acme/app","default_branch":"main","private":false},
            {"full_name":"acme/secret","default_branch":"master","private":true}
        ]"#;
        let repos = parse_github_repos(json);
        assert_eq!(repos.len(), 2);
        assert_eq!(repos[0].name_with_owner, "acme/app");
        assert_eq!(repos[0].default_branch.as_deref(), Some("main"));
        assert!(!repos[0].private);
        assert_eq!(repos[1].name_with_owner, "acme/secret");
        assert!(repos[1].private);
        // open_prs always None (no per-repo API call)
        assert!(repos[0].open_prs.is_none());
    }

    #[test]
    fn parse_github_repos_returns_empty_on_error_response() {
        // GitHub returns {"message":"Bad credentials"} when token is bad.
        let json = r#"{"message":"Bad credentials"}"#;
        let repos = parse_github_repos(json);
        assert!(repos.is_empty());
    }

    #[test]
    fn parse_github_repos_never_includes_token_value() {
        // Verify the output NEVER includes token-looking strings, even if the
        // input somehow contained one (defence-in-depth: the parser only reads
        // repo metadata fields, never arbitrary response keys).
        let fake_token = "ghp_AAABBBCCCDDDEEEFFFGGGHHHIII";
        let json = format!(
            r#"[{{"full_name":"a/b","default_branch":"main","private":false,"token":"{fake_token}"}}]"#
        );
        let repos = parse_github_repos(&json);
        assert_eq!(repos.len(), 1);
        // Serialize the output and confirm the fake token string is absent.
        let serialized = serde_json::to_string(&repos).unwrap();
        assert!(
            !serialized.contains(fake_token),
            "token value leaked into output"
        );
    }
}
