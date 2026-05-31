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

// One CodeHub-managed per-workspace container: its workspace key + status.
// Backs the fleet / Workspaces inspector (list_workspace_containers).
export interface WorkspaceContainer {
  key: string;
  status: ContainerStatus;
}

export interface SessionInfo {
  name: string;
  windows: number;
  attached: boolean;
  // Unix epoch seconds the tmux session was created; 0 when unreported.
  created: number;
  // Workspace key of the per-workspace container this session lives in (from the
  // container's `codehub.workspace` label). Always present: every session lives
  // in a per-workspace container. Restore uses it as the session's routing
  // `containerKey`.
  workspace: string;
}

// The AI coding agents (version/key-probed, mode-aware). Distinct from `Cli`,
// which also includes the non-agent "shell" pane type.
export type AgentCli = "claude" | "codex" | "antigravity";
// Everything a session/pane can run: an agent, or a plain bash shell (Workspace
// screen's SHELL pane). Shell rides the same session machinery but has no
// permission modes and no version/key status.
export type Cli = AgentCli | "shell";
export type Mode = "standard" | "auto" | "yolo";

// Per-session activity derived from pane output flow. "working"
// = output within the grace window; "idle" = quiet (idle / waiting / done — the
// output signal can't distinguish those). idleMs = ms since last output; bytes =
// total output seen since attach. NOT tokens/cost — those need per-CLI capture.
export type ActivityState = "working" | "idle";
export type SessionStatusKind = "running" | "idle" | "awaiting" | "done" | "failed";
export type TurnOutcome = "completed" | "failed";

export interface SessionActivity {
  session: string;
  state: ActivityState;
  idleMs: number;
  bytes: number;
  cli: string | null;
  alias: string | null;
  claudeId: string | null;
  // Codex conversation/rollout uuid (notify thread-id), the per-session key for
  // codexSessionUsage. Codex's analog of claudeId; null until the first turn-finish.
  codexId: string | null;
  taskDescription: string | null;
  turnElapsedMs: number | null;
  sessionStatus: SessionStatusKind;
  failureReason: string | null;
  gitBranch: string | null;
  // Hook-driven turn telemetry (real, never inferred). turns/toolCalls stay 0
  // and seenHooks false for hook-less CLIs.
  turns: number;
  toolCalls: number;
  // Tool executing right now (PreToolUse → PostToolUse). Non-null ⇒ "running
  // <tool>"; null while running ⇒ "thinking".
  currentTool: string | null;
  // Outcome of the last finished turn + age, for the transient finished/failed
  // badge (see deriveLiveStatus in lib/activity.ts).
  lastOutcome: TurnOutcome | null;
  outcomeMsAgo: number | null;
  // True once any agent hook has fired: trust sessionStatus over byte-flow state.
  seenHooks: boolean;
}

// Tier-1 reads. docker_info backs the empty-state daemon pill;
// agent_versions / agent_key_status back the agent cards + Settings.
export interface DockerInfo {
  reachable: boolean;
  version: string | null;
  apiVersion: string | null;
}

// Installed container runtimes + daemon reachability (first-run hero).
export interface DockerRuntimeDetection {
  installed: string[];
  daemonRunning: boolean;
}

// Presence-only auth status. `present` indicates whether a credential exists.
// The backend never returns the secret value.
export interface KeyStatus {
  present: boolean;
  source: string;
  varName: string | null;
}

export interface AgentVersion {
  version: string | null;
}

// Container resource limits preset (config::ContainerSizing in the backend).
export interface ContainerSizing {
  label: string;
  cpuCount: number | null;
  memoryMb: number | null;
}

// One environment variable from a running container (auth secrets filtered out).
export interface EnvEntry {
  name: string;
  value: string;
}

// One git repository discovered under /workspace.
export interface RepoInfo {
  path: string;
  branch: string | null;
}

// One immediate subdirectory of a /workspace path (working-dir browser).
// `isRepo` is true when it holds a .git; `branch` is its current branch when
// known. The browser drills one level at a time, so repos at ANY depth are
// reachable (unlike RepoInfo discovery, capped at depth 2).
export interface DirEntry {
  name: string;
  isRepo: boolean;
  branch: string | null;
}

// Persisted UI preferences (config::Settings in the backend). Mirrors the Rust
// struct field-for-field; every field is always present (the backend fills
// defaults), so this is never partial.
// A registered model provider (Agent Settings), with live token presence.
// Mirrors the backend `ModelProviderStatus`. The secret token itself is never
// sent over IPC — only `hasToken` (whether one is stored in the vault).
export interface ModelProvider {
  id: string;
  name: string;
  kind: string;
  endpoint: string | null;
  apiKeyVar: string | null;
  models: string[];
  /** Primary model id injected into the harness (ANTHROPIC_MODEL / model). */
  model: string | null;
  /** Background / small-fast model id (ANTHROPIC_SMALL_FAST_MODEL). */
  smallFastModel: string | null;
  enabled: boolean;
  /** A secret token is stored in the keychain vault for this provider. */
  hasToken: boolean;
}

// A saved prompt template for the spawn dialog.
export interface PromptTemplate {
  id: string;
  name: string;
  prompt: string;
  cli: string | null;
}

// Companion avatar preferences, persisted to disk via AppSettings.companion.
export interface CompanionPrefs {
  show: boolean;
  hideWhenFocused: boolean;
  clickThrough: boolean;
  snapToEdges: boolean;
  bubbleOnHover: boolean;
  character: string;
  size: string;
}

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
  // Name + dir pointers only — each opens in its own per-workspace container.
  savedWorkspaces: SavedWorkspace[];
  // Accounts (Tier-3, label-only — no secrets). Each maps an agent to a
  // keychain-backed credential.
  accountProfiles: AccountProfile[];
  // Notifications
  notifyAwaitInput: boolean;
  notifyTurnFinish: boolean;
  playSound: boolean;
  // Ambient surface (macOS Dynamic Island / companion window). Default on.
  showCompanion: boolean;
  // Container sizing
  defaultSizing: ContainerSizing;
  // Agent behaviour
  autoApproveSafe: boolean;
  approveWrites: boolean;
  costBudgetPerTurn: number | null;
  contextBudget: number | null;
  defaultModelPerAgent: Record<string, string>;
  // Updates
  autoUpdate: boolean;
  // Lifecycle
  idleTimeoutMinutes: number | null;
  // Per-session notification mute list
  mutedSessions: string[];
  // Model providers
  providers: ModelProvider[];
  // Prompt templates
  promptTemplates: PromptTemplate[];
  // Companion avatar preferences
  companion: CompanionPrefs;
}

// A user-saved workspace shown on the Welcome launcher (config::SavedWorkspace).
// A named pointer to a host repo dir; opening it points /workspace at `dir` and
// starts a tab in its own per-workspace container.
export interface SavedWorkspace {
  id: string;
  name: string;
  dir: string;
  pinned: boolean;
  // Epoch-ms of the last open, or null if not opened since it was saved.
  lastOpened: number | null;
  // Epoch-ms the workspace was created, or null for entries saved before this
  // field existed. Disambiguates two workspaces that share a name.
  createdAt?: number | null;
  // Per-workspace container resource limits override.
  sizing?: ContainerSizing | null;
  // Additional host directories to mount alongside /workspace. Each mounts at
  // /workspace/<basename> (backend multi-mount in lifecycle.rs::ensure_container).
  additionalDirs?: string[];
}

// An account profile (config::AccountProfile). Supports two credential models:
// Credential source: "env" (legacy) or "vault" (OS keychain).
export interface AccountProfile {
  id: string;
  agent: string;
  label: string;
  source: "env" | "vault";
  varName: string | null;
  // Whether the profile is offered at spawn (user-toggleable; disabled profiles
  // are kept but hidden from the account picker).
  enabled: boolean;
}

// An account profile plus whether its credential is available right now.
// Account profile with live presence check.
export interface AccountProfileStatus extends AccountProfile {
  present: boolean;
}

// OAuth flow result, emitted by the backend on completion.
export interface OAuthResult {
  profileId: string;
  provider: string;
  success: boolean;
  error?: string;
}

// GitHub device-flow code, emitted for user display.
export interface DeviceCodeInfo {
  profileId: string;
  userCode: string;
  verificationUri: string;
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
  commitHash: string | null;
  buildDate: string | null;
}

export interface HostStats {
  memoryTotal: number;
  memoryAvailable: number;
  diskTotal: number;
  diskAvailable: number;
}

export interface RuntimeVersions {
  node: string | null;
  tmux: string | null;
  git: string | null;
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
  estCostUsd: number | null;
  totalTokens: number | null;
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
  // (input + cache).
  contextUsed: number;
  // Context-window size for the gauge, mapped from the model family (the
  // transcript records no window). 0 for unknown models → gauge shows an em-dash.
  contextWindow: number;
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

// ── Phase-0 completion contract ────────────────────────
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
  estCostUsd: number | null;
  totalTokens: number | null;
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
  // Context-window size for the gauge (Codex's `model_context_window`). 0 until a
  // turn has started → gauge shows an em-dash.
  contextWindow: number;
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

// GitHub connection (Integrations). Presence-only auth check.
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
// One stats sample in the sparkline ring buffer (Container Inspector).
export interface StatsPoint {
  at: number;
  cpuPct: number;
  memUsed: number;
  netRxRate: number;
  netTxRate: number;
}

// Rolling token + cost usage for a time window (Dashboard 24h strip).
export interface RollingUsage {
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
  windowHours: number;
}

// A transcript search result (Command Palette).
export interface SearchHit {
  sessionId: string;
  title: string | null;
  snippet: string;
  at: string | null;
}

export interface UpdateStatus {
  current: string;
  available: string | null;
  notes: string | null;
}

export const ipc = {
  // `workspace` (per-workspace-container key) targets a workspace's container.
  containerStatus: (workspace?: string) =>
    invoke<ContainerStatus>("container_status", { workspace }),
  // Workspace lifecycle controls. Each returns the post-action ContainerStatus
  // and also emits codehub://lifecycle, so the store updates either way. start
  // is safe; stop/restart kill every running session (the UI confirms first).
  containerStart: (workspace?: string) => invoke<ContainerStatus>("container_start", { workspace }),
  containerStop: (workspace?: string) => invoke<ContainerStatus>("container_stop", { workspace }),
  containerRestart: (workspace?: string) =>
    invoke<ContainerStatus>("container_restart", { workspace }),
  // Per-workspace-container fleet: enumerate managed containers (key + status)
  // and remove one by key (Prune / explicit delete — kills its sessions).
  listWorkspaceContainers: () => invoke<WorkspaceContainer[]>("list_workspace_containers"),
  removeWorkspaceContainer: (workspace: string) =>
    invoke<void>("remove_workspace_container", { workspace }),
  dockerInfo: () => invoke<DockerInfo>("docker_info"),
  detectDockerRuntime: () => invoke<DockerRuntimeDetection>("detect_docker_runtime"),
  startDockerApp: (runtime: string) => invoke<void>("start_docker_app", { runtime }),
  // Build + host platform identity for Settings → About.
  appInfo: () => invoke<AppInfo>("app_info"),
  hostStats: () => invoke<HostStats>("host_stats"),
  runtimeVersions: (workspace?: string) =>
    invoke<RuntimeVersions>("runtime_versions", { workspace }),
  // Persisted UI preferences (Settings screen), backed by settings.json in the
  // app-data dir. getConfig returns the current snapshot; setConfig writes the
  // whole object and echoes back what landed.
  getConfig: () => invoke<AppSettings>("get_config"),
  setConfig: (config: AppSettings) => invoke<AppSettings>("set_config", { config }),
  addPromptTemplate: (name: string, prompt: string, cli?: string) =>
    invoke<PromptTemplate[]>("add_prompt_template", { name, prompt, cli }),
  removePromptTemplate: (id: string) => invoke<PromptTemplate[]>("remove_prompt_template", { id }),
  // Tier-2 workspace/repo picker. pickDirectory opens the native folder dialog
  // (null on cancel, or in browser-mode where there's no native dialog).
  // setWorkspaceDir validates + persists the choice (echoes the stored config);
  // workspaceInfo reports configured-vs-mounted + needs-recreate; recreateRuntime
  // rebuilds the container to apply a changed mount (kills sessions — confirm first).
  pickDirectory: () => invoke<string | null>("pick_directory"),
  setWorkspaceDir: (path: string) => invoke<AppSettings>("set_workspace_dir", { path }),
  workspaceInfo: (workspace?: string) => invoke<WorkspaceInfo>("workspace_info", { workspace }),
  recreateRuntime: (workspace: string) =>
    invoke<ContainerStatus>("recreate_runtime", { workspace }),
  // Account profiles (keychain-backed). list/add/remove/rename return the
  // full updated list with live presence per profile.
  listAccountProfiles: () => invoke<AccountProfileStatus[]>("list_account_profiles"),
  addAccountProfile: (agent: string, label: string, varName?: string, source?: "env" | "vault") =>
    invoke<AccountProfileStatus[]>("add_account_profile", { agent, label, varName, source }),
  removeAccountProfile: (id: string) =>
    invoke<AccountProfileStatus[]>("remove_account_profile", { id }),
  renameAccountProfile: (id: string, label: string) =>
    invoke<AccountProfileStatus[]>("rename_account_profile", { id, label }),
  setAccountProfileEnabled: (id: string, enabled: boolean) =>
    invoke<AccountProfileStatus[]>("set_account_profile_enabled", { id, enabled }),
  // Vault: OS-keychain credential management for built-in agents + GitHub.
  // vaultStoreKey is the ONLY method that accepts a secret over IPC (paste flow).
  // No method ever returns a secret value.
  vaultStoreKey: (profileId: string, secret: string) =>
    invoke<void>("vault_store_key", { profileId, secret }),
  vaultDeleteKey: (profileId: string) => invoke<void>("vault_delete_key", { profileId }),
  vaultHasKey: (profileId: string) => invoke<boolean>("vault_has_key", { profileId }),
  vaultInitiateOauth: (provider: string, profileId: string) =>
    invoke<{ sessionName?: string; workspace?: string; provider: string; profileId: string }>(
      "vault_initiate_oauth",
      { provider, profileId },
    ),
  vaultCompleteLogin: (
    provider: string,
    profileId: string,
    workspace: string,
    sessionName: string,
  ) => invoke<void>("vault_complete_login", { provider, profileId, workspace, sessionName }),
  // Agent-only maps (the backend probes claude/codex/antigravity; shell has no
  // version or key to report). The backend ALWAYS emits exactly these three
  // AgentCli keys (lifecycle::agent_key_status / docker::agent_versions build a
  // fixed 3-entry map), so the non-partial Record<AgentCli, …> is an accurate
  // contract — keep it in sync if a fourth CLI is ever added (Cli-enum 4-point).
  agentKeyStatus: () => invoke<Record<AgentCli, KeyStatus>>("agent_key_status"),
  agentVersions: () => invoke<Record<AgentCli, AgentVersion>>("agent_versions"),
  containerStats: (workspace?: string) => invoke<ContainerStats>("container_stats", { workspace }),
  containerStatsHistory: (workspace: string) =>
    invoke<StatsPoint[]>("container_stats_history", { workspace }),
  // Tail of a container's log; defaults to 200 lines server-side. `workspace`
  // targets the workspace's container.
  containerLogs: (tail?: number, workspace?: string) =>
    invoke<string[]>("container_logs", { tail, workspace }),
  // Real bind/volume mounts of a container (host paths).
  containerMounts: (workspace?: string) => invoke<MountInfo[]>("container_mounts", { workspace }),
  // Identity of a container's image (tag/digest/created/size/arch/os).
  containerImage: (workspace?: string) => invoke<ImageInfo>("container_image", { workspace }),
  // Liveness of a container (started-at/restart count/status/OOM).
  containerHealth: (workspace?: string) => invoke<RuntimeHealth>("container_health", { workspace }),
  // Non-recursive listing of a /workspace directory (empty path → root).
  // `workspace` targets the workspace's container.
  containerListDir: (path: string, workspace?: string) =>
    invoke<FileEntry[]>("container_list_dir", { path, workspace }),
  // Immediate subdirectories of a /workspace path, each flagged if it's a git
  // repo (working-dir picker for agent spawn). Empty path → the mount root.
  containerBrowseDirs: (path: string, workspace?: string) =>
    invoke<DirEntry[]>("container_browse_dirs", { path, workspace }),
  // First 256 KiB of a /workspace file, UTF-8-lossy (Files browser preview).
  containerReadFile: (path: string, workspace?: string) =>
    invoke<string>("container_read_file", { path, workspace }),
  // Working-tree status of /workspace (branch + changed files).
  containerGitStatus: (workspace?: string) =>
    invoke<GitStatus>("container_git_status", { workspace }),
  // Unified diff for one /workspace path (raw `git diff` text).
  containerGitDiff: (path: string, workspace?: string) =>
    invoke<string>("container_git_diff", { path, workspace }),
  // Combined diff of every tracked /workspace change (`git diff HEAD`); the
  // "review all" view. Empty string when the tree is clean.
  containerGitDiffAll: (workspace?: string) =>
    invoke<string>("container_git_diff_all", { workspace }),
  // Staged-only diff (`git diff --cached`) — session-detail "Staged" filter.
  containerGitDiffStaged: (workspace?: string) =>
    invoke<string>("container_git_diff_staged", { workspace }),
  // Unstaged diff of tracked files (`git diff`) — "Unstaged" filter.
  containerGitDiffUnstaged: (workspace?: string) =>
    invoke<string>("container_git_diff_unstaged", { workspace }),
  // Stage every /workspace change (`git add -A`). Throws git's message on failure.
  containerGitStageAll: (workspace?: string) =>
    invoke<void>("container_git_stage_all", { workspace }),
  containerGitStageFile: (path: string, workspace: string) =>
    invoke<void>("container_git_stage_file", { path, workspace }),
  containerGitUnstageFile: (path: string, workspace: string) =>
    invoke<void>("container_git_unstage_file", { path, workspace }),
  containerGitStageHunk: (patch: string, workspace: string) =>
    invoke<void>("container_git_stage_hunk", { patch, workspace }),
  // Commit staged changes (`git commit -m`); resolves to git's summary line, or
  // rejects with git's verbatim message (nothing staged / no identity / not a repo).
  containerGitCommit: (message: string, workspace?: string) =>
    invoke<string>("container_git_commit", { message, workspace }),
  // Push the current branch + open a GitHub PR; resolves to the PR URL, or
  // rejects with an honest reason (no token/remote/branch, or GitHub's message).
  containerGitOpenPr: (title: string, body: string, workspace?: string) =>
    invoke<string>("container_git_open_pr", { title, body, workspace }),
  // Processes running inside a container (`docker top`). `workspace` targets
  // the workspace's container.
  containerTop: (workspace?: string) => invoke<ProcessInfo[]>("container_top", { workspace }),
  // Environment variables in a container (auth secrets filtered out).
  containerEnv: (workspace: string) => invoke<EnvEntry[]>("container_env", { workspace }),
  // Git repositories discovered under /workspace.
  containerRepos: (workspace: string) => invoke<RepoInfo[]>("container_repos", { workspace }),
  // Clone a git repo by URL into /workspace.
  containerGitClone: (url: string, workspace: string) =>
    invoke<string>("container_git_clone", { url, workspace }),
  // Recent commits on /workspace (`git log`); defaults to 12 server-side.
  containerGitLog: (limit?: number, workspace?: string) =>
    invoke<CommitInfo[]>("container_git_log", { limit, workspace }),
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
  setAgentModel: (model: string, workspace: string) =>
    invoke<AgentConfig>("set_agent_model", { model, workspace }),
  setPermissionMode: (mode: string, workspace: string) =>
    invoke<AgentConfig>("set_permission_mode", { mode, workspace }),
  setPermissionRules: (bucket: string, rules: string[], workspace: string) =>
    invoke<AgentConfig>("set_permission_rules", { bucket, rules, workspace }),
  toggleMcpServer: (name: string, enabled: boolean, workspace: string) =>
    invoke<ClaudeIntegrations>("toggle_mcp_server", { name, enabled, workspace }),
  listSessions: () => invoke<SessionInfo[]>("list_sessions"),
  // `resume` (a Claude transcript id) relaunches that conversation with
  // `claude --resume <id>`. `sessionId` pins a fresh Claude session to a known
  // UUID (`--session-id`) so its transcript can be read back. Mutually exclusive.
  // `account` (Tier-3) is an account-profile id; the backend resolves it to that
  // profile's credential from the vault and injects it for this session.
  // Absent → auto-select.
  // `workspace` is the per-workspace-container key: the session is created in
  // that workspace's own container (lazily ensured), with `workspaceDir` bound
  // at /workspace on first create. attach/kill/rename must pass the SAME
  // `workspace` so they target the container the session actually lives in.
  createSession: (
    name: string,
    cli: Cli,
    mode: Mode,
    alias: string,
    resume?: string,
    sessionId?: string,
    account?: string,
    workspace?: string,
    workspaceDir?: string,
    // In-container working directory (a path under /workspace, e.g. a repo
    // subdir) the agent's pane starts in. Absent → /workspace.
    cwd?: string,
    taskDescription?: string,
  ) =>
    invoke<void>("create_session", {
      name,
      cli,
      mode,
      alias,
      resume,
      sessionId,
      account,
      workspace,
      workspaceDir,
      cwd,
      taskDescription,
    }),
  killSession: (name: string, workspace?: string) =>
    invoke<void>("kill_session", { name, workspace }),
  stopAllAgents: (workspace: string) => invoke<void>("stop_all_agents", { workspace }),
  rollingUsage: (hours?: number) => invoke<RollingUsage>("rolling_usage", { hours }),
  renameSession: (name: string, alias: string, workspace?: string) =>
    invoke<void>("rename_session", { name, alias, workspace }),
  attachSession: (name: string, cols: number, rows: number, workspace?: string) =>
    invoke<string>("attach_session", { name, cols, rows, workspace }),
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
  searchTranscripts: (query: string, limit?: number, workspace?: string) =>
    invoke<SearchHit[]>("search_transcripts", { query, limit, workspace }),
  listProviders: () => invoke<ModelProvider[]>("list_providers"),
  addProvider: (
    name: string,
    kind: string,
    endpoint?: string,
    apiKeyVar?: string,
    models?: string[],
    model?: string,
    smallFastModel?: string,
  ) =>
    invoke<ModelProvider[]>("add_provider", {
      name,
      kind,
      endpoint,
      apiKeyVar,
      models,
      model,
      smallFastModel,
    }),
  removeProvider: (id: string) => invoke<ModelProvider[]>("remove_provider", { id }),
  updateProvider: (
    id: string,
    name?: string,
    endpoint?: string,
    enabled?: boolean,
    models?: string[],
    model?: string,
    smallFastModel?: string,
  ) =>
    invoke<ModelProvider[]>("update_provider", {
      id,
      name,
      endpoint,
      enabled,
      models,
      model,
      smallFastModel,
    }),
  // Store/clear a provider's secret token in the keychain vault (empty clears).
  setProviderToken: (id: string, token: string) =>
    invoke<ModelProvider[]>("set_provider_token", { id, token }),
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

// OAuth flow completed (success or failure). Fires for both Claude and GitHub.
export function onOAuthComplete(cb: (result: OAuthResult) => void): Promise<UnlistenFn> {
  return listen<OAuthResult>("codehub://oauth-complete", (e) => cb(e.payload));
}

// GitHub device-flow code ready for user display.
export function onOAuthDeviceCode(cb: (info: DeviceCodeInfo) => void): Promise<UnlistenFn> {
  return listen<DeviceCodeInfo>("codehub://oauth-device-code", (e) => cb(e.payload));
}

// Container-mediated login progress (URL, device code, waiting, success, error).
export interface AuthProgress {
  profileId: string;
  provider: string;
  stage: "starting" | "url" | "device_code" | "waiting" | "success" | "error";
  url?: string;
  userCode?: string;
  message?: string;
}

export function onAuthProgress(cb: (p: AuthProgress) => void): Promise<UnlistenFn> {
  return listen<AuthProgress>("codehub://auth-progress", (e) => cb(e.payload));
}
