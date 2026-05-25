import { type UnlistenFn, invoke, listen } from "./bridge";

// Typed boundary over the Tauri commands (lib.rs) and lifecycle events. Backend
// is unchanged by the migration; this just gives the React app a typed surface.

export type ContainerState = "missing" | "stopped" | "starting" | "running" | "unreachable";

export interface ContainerStatus {
  state: ContainerState;
  id: string | null;
  image: string;
  name: string;
}

export interface SessionInfo {
  name: string;
  windows: number;
  attached: boolean;
  // Unix epoch seconds the tmux session was created; 0 when unreported.
  created: number;
}

// The AI coding agents (version/key-probed, mode-aware). Distinct from `Cli`,
// which also includes the non-agent "shell" pane type.
export type AgentCli = "claude" | "codex" | "antigravity";
// Everything a session/pane can run: an agent, or a plain bash shell (Workspace
// screen's SHELL pane). Shell rides the same session machinery but has no
// permission modes and no version/key status.
export type Cli = AgentCli | "shell";
export type Mode = "standard" | "auto" | "yolo";

// Per-session activity derived from pane output flow (BACKEND_PLAN.md). "working"
// = output within the grace window; "idle" = quiet (idle / waiting / done — the
// output signal can't distinguish those). idleMs = ms since last output; bytes =
// total output seen since attach. NOT tokens/cost — those need per-CLI capture.
export type ActivityState = "working" | "idle";
export interface SessionActivity {
  session: string;
  state: ActivityState;
  idleMs: number;
  bytes: number;
  // Agent identity registered at session creation (cli binary + display alias).
  // Null when output created the entry before a label was registered — the
  // always-on-top companion (its own webview, no access to the main store) reads
  // these to render the glyph + name; UI falls back when absent.
  cli: string | null;
  alias: string | null;
  // Claude `--session-id`/resumed id this session launched with, so a satellite
  // view (companion) can read its transcript for a live token tally. Null for
  // non-Claude agents (no transcript) or entries created by output before the
  // identity was registered.
  claudeId: string | null;
}

// Tier-1 reads (BACKEND_PLAN.md). docker_info backs the empty-state daemon pill;
// agent_versions / agent_key_status back the agent cards + Settings.
export interface DockerInfo {
  reachable: boolean;
  version: string | null;
  apiVersion: string | null;
}

// Presence-only auth status. `present` + `varName` (env var NAME) only — the
// backend never returns the secret value.
export interface KeyStatus {
  present: boolean;
  source: string;
  varName: string | null;
}

export interface AgentVersion {
  version: string | null;
}

// Persisted UI preferences (config::Settings in the backend). Mirrors the Rust
// struct field-for-field; every field is always present (the backend fills
// defaults), so this is never partial.
export interface AppSettings {
  // Appearance
  terminalFontSize: number;
  density: string;
  // Hub main-region layout: "tabs" | "grid" (the compare grid).
  hubLayout: string;
  // General
  confirmCloseRunningAgent: boolean;
  restoreSessionsOnLaunch: boolean;
  reopenLastWorkspace: boolean;
  // Agent defaults
  defaultAgent: Cli;
  // Workspace (Tier-2 repo picker). workspaceDir null → built-in default mount.
  workspaceDir: string | null;
  recentWorkspaces: string[];
  // Saved workspaces shown on the Welcome launcher (config::SavedWorkspace).
  // Name + dir pointers only — the container is always the shared runtime.
  savedWorkspaces: SavedWorkspace[];
  // Accounts (Tier-3, label-only — no secrets). Each maps an agent to a host
  // env var NAME; the value is never stored here.
  accountProfiles: AccountProfile[];
  // Notifications
  notifyAwaitInput: boolean;
  notifyTurnFinish: boolean;
  playSound: boolean;
}

// A user-saved workspace shown on the Welcome launcher (config::SavedWorkspace).
// A named pointer to a host repo dir; opening it points /workspace at `dir` and
// starts a tab. No per-workspace container — every workspace shares the runtime,
// so there is no size/cost field (honest: nothing to fabricate).
export interface SavedWorkspace {
  id: string;
  name: string;
  dir: string;
  pinned: boolean;
  // Epoch-ms of the last open, or null if not opened since it was saved.
  lastOpened: number | null;
}

// A label-only account profile (config::AccountProfile). `varName` is the NAME
// of a host env var holding that account's credential — never the value.
export interface AccountProfile {
  id: string;
  agent: string;
  label: string;
  varName: string;
}

// An account profile plus whether its host env var is present right now
// (presence-only, like KeyStatus — the value is never read).
export interface AccountProfileStatus extends AccountProfile {
  present: boolean;
}

// Configured-vs-mounted /workspace dir + whether the runtime needs recreating to
// apply a change (the bind-mount source is fixed at container create-time).
export interface WorkspaceInfo {
  effective: string;
  mounted: string | null;
  needsRecreate: boolean;
}

// Build + host platform identity (Settings → About). All compile-time / runtime
// constants from the backend — no update check, nothing fabricated.
export interface AppInfo {
  name: string;
  version: string;
  os: string;
  arch: string;
  family: string;
}

// One-shot resource snapshot of the runtime container (Containers view gauges).
// Bytes are raw; the UI formats. Errors when the container is down — callers
// leave the gauges blank rather than show zeros.
export interface ContainerStats {
  cpuPct: number;
  memUsed: number;
  memLimit: number;
  netRx: number;
  netTx: number;
  disk: number;
}

// Identity of the runtime container's image (Containers view Image card). Every
// field is nullable — a missing value renders as em-dash, never a fake. `size`
// is bytes; `created` is RFC 3339; `tag`/`digest` may be absent for a
// locally-built (untagged / never-pushed) image.
export interface ImageInfo {
  id: string | null;
  tag: string | null;
  digest: string | null;
  created: string | null;
  size: number | null;
  arch: string | null;
  os: string | null;
}

// Liveness of the runtime container (Containers view hero), from `docker
// inspect`'s State block. `startedAt` is RFC 3339 (the UI derives uptime from
// it); every field is nullable so a missing value renders as em-dash.
export interface RuntimeHealth {
  startedAt: string | null;
  restartCount: number | null;
  status: string | null;
  oomKilled: boolean | null;
}

// One entry in a /workspace directory listing (Files browser). `kind` is
// "dir" | "file" | "link" | "other"; `size` is bytes (0 for directories).
export interface FileEntry {
  name: string;
  kind: string;
  size: number;
}

// One bind/volume mount of the runtime container, from `docker inspect`.
// `source` is the host path, `destination` the in-container path.
export interface MountInfo {
  source: string;
  destination: string;
  rw: boolean;
  kind: string;
}

// One changed path in /workspace, from `git status --porcelain`. `status` is
// the raw 2-char XY code (e.g. " M", "??", "A ").
export interface GitFile {
  path: string;
  status: string;
}

// One process in the runtime container, from `docker top`. Fields are whatever
// the platform `ps` reports; `time` is absent when that column is missing.
export interface ProcessInfo {
  pid: string;
  user: string;
  time: string | null;
  command: string;
}

// One commit from `git log` on /workspace. `hash` is the full SHA (UI shortens);
// `relative` is git's human age ("2 hours ago").
export interface CommitInfo {
  hash: string;
  author: string;
  relative: string;
  subject: string;
}

// Working-tree state of /workspace. `isRepo: false` when it's not a git repo
// (or git is unavailable). `files` is capped server-side; `total` is the full
// count.
export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  total: number;
}

// Cumulative token counts; every field is a real sum from Claude Code session
// transcripts (never estimated).
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

// Per-model usage rollup. `priced` is false when no rate-table entry matched the
// model — then `estCostUsd` is 0 and its tokens count toward `unpricedTokens`.
export interface ModelUsage {
  model: string;
  totals: TokenTotals;
  turns: number;
  estCostUsd: number;
  priced: boolean;
}

// Per-day usage rollup (UTC `YYYY-MM-DD`).
export interface DayUsage {
  date: string;
  totals: TokenTotals;
  estCostUsd: number;
}

// One model family's per-million-token rates, surfaced so the cost estimate is
// transparent about the prices it used.
export interface ModelRate {
  family: string;
  inputPerMtok: number;
  outputPerMtok: number;
  cacheWritePerMtok: number;
  cacheReadPerMtok: number;
}

// Aggregate token analytics from Claude Code's on-disk session transcripts.
// Token + turn + session counts are FACTUAL; `estCostUsd` is an ESTIMATE
// (tokens × `rates`, as of `ratesAsOf`), not a billed amount. `unpricedTokens`
// is input+output volume from models with no rate match, excluded from the cost.
export interface ClaudeUsage {
  sessions: number;
  turns: number;
  totals: TokenTotals;
  estCostUsd: number;
  byModel: ModelUsage[];
  byDay: DayUsage[];
  rates: ModelRate[];
  ratesAsOf: string;
  unpricedTokens: number;
}

// One past Claude conversation reconstructed from its on-disk transcript, for the
// Resume screen. All factual: title is the transcript's own ai-title (or first
// user prompt); branch is the recorded gitBranch (null when detached); turns is
// the distinct user-message count; timestamps are RFC3339 strings.
export interface ClaudeSession {
  id: string;
  title: string;
  branch: string | null;
  started: string;
  lastActive: string;
  turns: number;
  model: string | null;
  version: string | null;
}

// Live per-session token tally for one Claude conversation, read from its own
// transcript (the `--session-id` it was launched with). All factual; null when
// there is no usable data yet (a session that hasn't responded).
export interface SessionUsage {
  turns: number;
  tokensIn: number;
  tokensOut: number;
  // Count of file-editing tool calls (Edit/Write/MultiEdit/NotebookEdit) the
  // agent made this session — a real tally, not a guess.
  edits: number;
  // Live context footprint: tokens the model read on its most recent turn
  // (input + cache). No window maximum — the transcript never records it and it
  // varies by model/version/tier, so the UI shows this count alone, never a
  // fabricated used/max ratio.
  contextUsed: number;
}

// The Claude account the runtime is signed into (Integrations view), read from
// `oauthAccount` in ~/.claude.json. Identity only — every field is the user's
// own account metadata already on disk; no token/secret/billing is included.
// Each field may be null (renders as em-dash).
export interface ClaudeAccount {
  email: string | null;
  name: string | null;
  // Subscription tier, prettified from organizationType (e.g. "Max").
  plan: string | null;
  org: string | null;
  role: string | null;
}

// One configured MCP server (Integrations view). Identity only: name, transport
// and a non-secret target (stdio launch command or http/sse URL). Secret-bearing
// fields (env, headers) are never read by the backend, so never appear here.
export interface McpServer {
  name: string;
  // Where it's configured: "user", "project", or "shared".
  scope: string;
  // "stdio" | "http" | "sse" | "unknown".
  transport: string;
  target: string | null;
}

// What the runtime's Claude is connected to: signed-in account + configured MCP
// servers. All factual from on-disk config. Empty mcpServers (the common case)
// is the honest truth — the UI shows a "none configured" state, not a fake.
export interface ClaudeIntegrations {
  account: ClaudeAccount | null;
  mcpServers: McpServer[];
}

// One sub-agent from `.claude/agents/<name>.md` (Agent settings). All factual —
// parsed from the file's YAML frontmatter; absent keys are null/empty.
export interface SubAgentInfo {
  name: string;
  description: string | null;
  model: string | null;
  tools: string[];
  // "user" (~/.claude) or "project" (/workspace/.claude).
  scope: string;
}

// One skill from `.claude/skills/<name>/SKILL.md` (Agent settings).
export interface SkillInfo {
  name: string;
  description: string | null;
  scope: string;
}

// One installed plugin, from the `enabledPlugins` map in ~/.claude.json.
export interface PluginInfo {
  name: string;
  marketplace: string | null;
  enabled: boolean;
}

// The runtime Claude's configurable surface (Agent settings detail): active
// model + default permission mode + the literal allow/ask/deny permission rules
// + sub-agents/skills/plugins/marketplaces, all read from on-disk config. Empty
// collections are the honest truth — the UI shows "none configured", never
// sample data.
export interface AgentConfig {
  model: string | null;
  permissionMode: string | null;
  // Verbatim tool-rule strings from settings.json permissions.{allow,ask,deny}
  // (e.g. "Read(/workspace/**)", "Bash(git push:*)"). Rendered read-only.
  permissionAllow: string[];
  permissionAsk: string[];
  permissionDeny: string[];
  subagents: SubAgentInfo[];
  skills: SkillInfo[];
  plugins: PluginInfo[];
  marketplaces: string[];
}

// ── Phase-0 completion contract (COMPLETION_PLAN.md) ────────────────────────
// New surface for the parallel fleet. Shapes are frozen; backend fns are stubs
// until the BE track fills them. Honesty contract holds: absent data → null /
// empty / em-dash, never fabricated.

// Live agent-native hook event (Claude `hooks` / Codex `notify`), normalized
// from the raw in-container event stream (§7). `kind` is the normalized event;
// optional fields carry what that kind provides (verified shapes in §7.6).
export type AgentEventKind =
  | "session_start"
  | "prompt_submit"
  | "pre_tool"
  | "post_tool"
  | "notification"
  | "stop"
  | "stop_failure"
  | "session_end";
export interface AgentEvent {
  // tmux session name (correlated via the CODEHUB_SESSION env, §7.3).
  session: string;
  kind: AgentEventKind;
  // Unix epoch ms the event was observed.
  at: number;
  // notification/stop message or error text; null when the kind carries none.
  message: string | null;
  // For kind "notification": the typed Notification subtype
  // ("permission_prompt" | "idle_prompt" | "auth_success" | …) — drives the
  // awaiting-input vs idle distinction with no message parsing (§7.6).
  notificationType: string | null;
  // For kind "pre_tool"/"post_tool": the tool that ran (Bash/Edit/Write/…).
  toolName: string | null;
}

// A session currently awaiting user input (a permission_prompt Notification with
// no resolving event yet). `since` is epoch ms the prompt was raised.
export interface PendingPrompt {
  session: string;
  message: string | null;
  since: number;
}

// One entry in a session's activity/turn history ring buffer (Hub ActivityRail
// feed + Dashboard chart). Mirrors AgentEvent but persisted as history.
export interface ActivityEvent {
  session: string;
  kind: AgentEventKind;
  at: number;
  message: string | null;
}

// Codex token split (it reports cached-input + reasoning-output separately, so
// it can't reuse Claude's TokenTotals). Every field a real sum from the rollout
// file's token_count records (never estimated).
export interface CodexTokenTotals {
  input: number;
  cachedInput: number;
  output: number;
  reasoningOutput: number;
}

export interface CodexModelUsage {
  model: string;
  totals: CodexTokenTotals;
  turns: number;
  estCostUsd: number;
  priced: boolean;
}

// One day's Codex usage rollup. Distinct from Claude's DayUsage because Codex
// carries the cached-input / reasoning-output split (CodexTokenTotals).
export interface CodexDayUsage {
  date: string;
  totals: CodexTokenTotals;
  estCostUsd: number;
}

// One model family's Codex per-million-token rates. Distinct from Claude's
// ModelRate: Codex's rate card has no separate cache-write/read prices, so the
// backend (CodexModelRate) sends only input/output — never the cache fields.
export interface CodexModelRate {
  family: string;
  inputPerMtok: number;
  outputPerMtok: number;
}

// Aggregate Codex token analytics from ~/.codex/sessions/**/rollout-*.jsonl.
// Token/turn/session counts FACTUAL; estCostUsd ESTIMATED (tokens × rates).
export interface CodexUsage {
  sessions: number;
  turns: number;
  totals: CodexTokenTotals;
  estCostUsd: number;
  byModel: CodexModelUsage[];
  byDay: CodexDayUsage[];
  rates: CodexModelRate[];
  ratesAsOf: string;
  unpricedTokens: number;
}

// One past Codex conversation from its rollout file (Resume view). Mirrors
// ClaudeSession. `turns` = distinct task_started count.
export interface CodexSession {
  id: string;
  title: string;
  branch: string | null;
  started: string;
  lastActive: string;
  turns: number;
  model: string | null;
  version: string | null;
}

// Live per-session Codex tally from its rollout file. `edits` is 0 when Codex's
// patch events aren't counted (honest, not faked). contextUsed = the latest
// token_count's input+cached (model_context_window is also on disk if needed).
export interface CodexSessionUsage {
  turns: number;
  tokensIn: number;
  tokensOut: number;
  edits: number;
  contextUsed: number;
}

// Codex rate-limit / plan meters — the ONE on-disk quota source (latest
// token_count line's `rate_limits` + `plan_type`). NO billing API. Every field
// nullable → em-dash when absent. resetsAt is RFC3339 (or epoch — TBD by parser).
export interface CodexRateLimits {
  primaryUsedPct: number | null;
  primaryWindowMinutes: number | null;
  primaryResetsAt: string | null;
  secondaryUsedPct: number | null;
  secondaryWindowMinutes: number | null;
  secondaryResetsAt: string | null;
  planType: string | null;
}

// GitHub connection (Integrations). Presence-only auth: `connected` reflects the
// host env var (e.g. GITHUB_TOKEN) being set — the value is NEVER read/returned.
// login/scopes/tokenExpiry come from the GitHub API when reachable, else null.
export interface GithubStatus {
  connected: boolean;
  varName: string;
  login: string | null;
  scopes: string[];
  tokenExpiry: string | null;
}

// One repo visible to the connected GitHub account (Integrations repo list).
export interface GithubRepo {
  nameWithOwner: string;
  defaultBranch: string | null;
  openPrs: number | null;
  private: boolean;
}

// App update check (Settings → About). `available` null when up to date; the UI
// shows an install affordance only when a newer version is present.
export interface UpdateStatus {
  current: string;
  available: string | null;
  notes: string | null;
}

export const ipc = {
  containerStatus: () => invoke<ContainerStatus>("container_status"),
  // Runtime lifecycle controls. Each returns the post-action ContainerStatus and
  // also emits codehub://lifecycle, so the store updates either way. start is
  // safe; stop/restart kill every running session (the UI confirms first).
  containerStart: () => invoke<ContainerStatus>("container_start"),
  containerStop: () => invoke<ContainerStatus>("container_stop"),
  containerRestart: () => invoke<ContainerStatus>("container_restart"),
  dockerInfo: () => invoke<DockerInfo>("docker_info"),
  // Build + host platform identity for Settings → About.
  appInfo: () => invoke<AppInfo>("app_info"),
  // Persisted UI preferences (Settings screen), backed by settings.json in the
  // app-data dir. getConfig returns the current snapshot; setConfig writes the
  // whole object and echoes back what landed.
  getConfig: () => invoke<AppSettings>("get_config"),
  setConfig: (config: AppSettings) => invoke<AppSettings>("set_config", { config }),
  // Tier-2 workspace/repo picker. pickDirectory opens the native folder dialog
  // (null on cancel, or in browser-mode where there's no native dialog).
  // setWorkspaceDir validates + persists the choice (echoes the stored config);
  // workspaceInfo reports configured-vs-mounted + needs-recreate; recreateRuntime
  // rebuilds the container to apply a changed mount (kills sessions — confirm first).
  pickDirectory: () => invoke<string | null>("pick_directory"),
  setWorkspaceDir: (path: string) => invoke<AppSettings>("set_workspace_dir", { path }),
  workspaceInfo: () => invoke<WorkspaceInfo>("workspace_info"),
  recreateRuntime: () => invoke<ContainerStatus>("recreate_runtime"),
  // Tier-3 label-only account profiles (no secrets). list/add/remove each return
  // the full updated list with live host-env presence per profile.
  listAccountProfiles: () => invoke<AccountProfileStatus[]>("list_account_profiles"),
  addAccountProfile: (agent: AgentCli, label: string, varName: string) =>
    invoke<AccountProfileStatus[]>("add_account_profile", { agent, label, varName }),
  removeAccountProfile: (id: string) =>
    invoke<AccountProfileStatus[]>("remove_account_profile", { id }),
  // Agent-only maps (the backend probes claude/codex/antigravity; shell has no
  // version or key to report). The backend ALWAYS emits exactly these three
  // AgentCli keys (lifecycle::agent_key_status / docker::agent_versions build a
  // fixed 3-entry map), so the non-partial Record<AgentCli, …> is an accurate
  // contract — keep it in sync if a fourth CLI is ever added (Cli-enum 4-point).
  agentKeyStatus: () => invoke<Record<AgentCli, KeyStatus>>("agent_key_status"),
  agentVersions: () => invoke<Record<AgentCli, AgentVersion>>("agent_versions"),
  containerStats: () => invoke<ContainerStats>("container_stats"),
  // Tail of the runtime container log; defaults to 200 lines server-side.
  containerLogs: (tail?: number) => invoke<string[]>("container_logs", { tail }),
  // Real bind/volume mounts of the runtime container (host paths).
  containerMounts: () => invoke<MountInfo[]>("container_mounts"),
  // Identity of the runtime container's image (tag/digest/created/size/arch/os).
  containerImage: () => invoke<ImageInfo>("container_image"),
  // Liveness of the runtime container (started-at/restart count/status/OOM).
  containerHealth: () => invoke<RuntimeHealth>("container_health"),
  // Non-recursive listing of a /workspace directory (empty path → root).
  containerListDir: (path: string) => invoke<FileEntry[]>("container_list_dir", { path }),
  // First 256 KiB of a /workspace file, UTF-8-lossy (Files browser preview).
  containerReadFile: (path: string) => invoke<string>("container_read_file", { path }),
  // Working-tree status of /workspace (branch + changed files).
  containerGitStatus: () => invoke<GitStatus>("container_git_status"),
  // Unified diff for one /workspace path (raw `git diff` text).
  containerGitDiff: (path: string) => invoke<string>("container_git_diff", { path }),
  // Combined diff of every tracked /workspace change (`git diff HEAD`); the
  // "review all" view. Empty string when the tree is clean.
  containerGitDiffAll: () => invoke<string>("container_git_diff_all"),
  // Processes running inside the runtime container (`docker top`).
  containerTop: () => invoke<ProcessInfo[]>("container_top"),
  // Recent commits on /workspace (`git log`); defaults to 12 server-side.
  containerGitLog: (limit?: number) => invoke<CommitInfo[]>("container_git_log", { limit }),
  // Per-session working/idle activity from output flow (polled by the Hub).
  sessionActivity: () => invoke<SessionActivity[]>("session_activity"),
  // Token analytics from Claude Code session transcripts (Usage view): real
  // token/turn/session counts + an estimated cost.
  claudeUsage: () => invoke<ClaudeUsage>("claude_usage"),
  // Past Claude conversations from on-disk transcripts (Resume view), newest
  // first; each can be reopened via createSession's `resume` arg.
  claudeSessions: () => invoke<ClaudeSession[]>("claude_sessions"),
  // Live token tally for one Claude session (the `--session-id`/resumed id it
  // was launched with); null when no usable data yet. Backs the pane header.
  claudeSessionUsage: (id: string) => invoke<SessionUsage | null>("claude_session_usage", { id }),
  // What the runtime's Claude is connected to (Integrations view): signed-in
  // account + configured MCP servers, read from on-disk config. Identity only.
  claudeIntegrations: () => invoke<ClaudeIntegrations>("claude_integrations"),
  // The runtime Claude's configurable surface (Agent settings detail): active
  // model + permission mode + sub-agents/skills/plugins/marketplaces, all read
  // from on-disk config. Factual; empty collections render as honest empty states.
  claudeAgentConfig: () => invoke<AgentConfig>("claude_agent_config"),
  listSessions: () => invoke<SessionInfo[]>("list_sessions"),
  // `resume` (a Claude transcript id) relaunches that conversation with
  // `claude --resume <id>`. `sessionId` pins a fresh Claude session to a known
  // UUID (`--session-id`) so its transcript can be read back. Mutually exclusive.
  // `account` (Tier-3) is an account-profile id; the backend resolves it to that
  // profile's host env var NAME and remaps the CLI's credential var onto it for
  // this session. Absent → the default (canonical host env).
  createSession: (
    name: string,
    cli: Cli,
    mode: Mode,
    alias: string,
    resume?: string,
    sessionId?: string,
    account?: string,
  ) => invoke<void>("create_session", { name, cli, mode, alias, resume, sessionId, account }),
  killSession: (name: string) => invoke<void>("kill_session", { name }),
  renameSession: (name: string, alias: string) => invoke<void>("rename_session", { name, alias }),
  attachSession: (name: string, cols: number, rows: number) =>
    invoke<string>("attach_session", { name, cols, rows }),
  ptyWrite: (paneId: string, data: string) => invoke<void>("pty_write", { paneId, data }),
  ptyResize: (paneId: string, cols: number, rows: number) =>
    invoke<void>("pty_resize", { paneId, cols, rows }),
  detachSession: (paneId: string) => invoke<void>("detach_session", { paneId }),
  // Always-on-top companion window (P5). open/close the floating monitor;
  // focusSessionFromCompanion raises the main window + emits codehub://focus-session.
  // No-ops over the dev bridge — a second OS window only exists under Tauri.
  openCompanion: () => invoke<void>("open_companion"),
  closeCompanion: () => invoke<void>("close_companion"),
  focusSessionFromCompanion: (name: string) =>
    invoke<void>("focus_session_from_companion", { name }),
  // ── Phase-0 completion contract (stubs until the BE track lands) ──────────
  // Sessions awaiting user input right now (← agent-native hooks, §7). Real for
  // Claude/Codex; Antigravity always empty.
  pendingPrompts: () => invoke<PendingPrompt[]>("pending_prompts"),
  // Answer a pending prompt by writing the accept/deny keystroke to that pane's
  // pty (same transport as broadcast — it IS a simulated keypress).
  respondPrompt: (session: string, allow: boolean) =>
    invoke<void>("respond_prompt", { session, allow }),
  // Activity/turn history ring buffer (Hub ActivityRail + Dashboard chart). All
  // sessions when `session` omitted.
  sessionActivityHistory: (session?: string) =>
    invoke<ActivityEvent[]>("session_activity_history", { session }),
  // Codex usage analytics from rollout files — mirrors the claude* surface.
  codexUsage: () => invoke<CodexUsage>("codex_usage"),
  codexSessions: () => invoke<CodexSession[]>("codex_sessions"),
  // Live per-session Codex tally (parity with claudeSessionUsage). Backend is
  // real + tested, but no UI consumer yet: wiring the pane-header tally for a
  // Codex session needs a per-session rollout id on SessionMeta (the deferred
  // "codexId on SessionMeta" item) — claudeSessionUsage has claudeId, Codex has
  // no equivalent tracked at create-time. Kept (not removed) as ready parity.
  codexSessionUsage: (id: string) =>
    invoke<CodexSessionUsage | null>("codex_session_usage", { id }),
  // Codex rate-limit / plan meters (on-disk quota source). Null when no data.
  codexRateLimits: () => invoke<CodexRateLimits | null>("codex_rate_limits"),
  // GitHub connection (Integrations). PAT presence-only; value never read.
  githubStatus: () => invoke<GithubStatus>("github_status"),
  githubRepos: () => invoke<GithubRepo[]>("github_repos"),
  // App update check (Settings → About).
  checkUpdate: () => invoke<UpdateStatus>("check_update"),
} as const;

// Live agent-native hook events (§7). Fires per normalized event; the store fans
// these into pending-prompt + activity-history slices and toast/bell UI.
export function onAgentEvent(cb: (e: AgentEvent) => void): Promise<UnlistenFn> {
  return listen<AgentEvent>("codehub://agent-event", (e) => cb(e.payload));
}

// Main window raised by the companion's focus jump (P5). The Hub focuses the
// named session when this fires.
export function onFocusSession(cb: (name: string) => void): Promise<UnlistenFn> {
  return listen<string>("codehub://focus-session", (e) => cb(e.payload));
}

export function onLifecycle(cb: (s: ContainerStatus) => void): Promise<UnlistenFn> {
  return listen<ContainerStatus>("codehub://lifecycle", (e) => cb(e.payload));
}

export function onLifecycleError(cb: (msg: string) => void): Promise<UnlistenFn> {
  return listen<string>("codehub://lifecycle-error", (e) => cb(e.payload));
}
