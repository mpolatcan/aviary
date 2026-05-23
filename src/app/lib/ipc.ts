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
  // Notifications
  notifyAwaitInput: boolean;
  notifyTurnFinish: boolean;
  playSound: boolean;
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
// model + default permission mode + sub-agents/skills/plugins/marketplaces, all
// read from on-disk config. Empty collections are the honest truth — the UI
// shows "none configured", never sample data.
export interface AgentConfig {
  model: string | null;
  permissionMode: string | null;
  subagents: SubAgentInfo[];
  skills: SkillInfo[];
  plugins: PluginInfo[];
  marketplaces: string[];
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
  // Agent-only maps (the backend probes claude/codex/antigravity; shell has no
  // version or key to report).
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
  createSession: (
    name: string,
    cli: Cli,
    mode: Mode,
    alias: string,
    resume?: string,
    sessionId?: string,
  ) => invoke<void>("create_session", { name, cli, mode, alias, resume, sessionId }),
  killSession: (name: string) => invoke<void>("kill_session", { name }),
  renameSession: (name: string, alias: string) => invoke<void>("rename_session", { name, alias }),
  attachSession: (name: string, cols: number, rows: number) =>
    invoke<string>("attach_session", { name, cols, rows }),
  ptyWrite: (paneId: string, data: string) => invoke<void>("pty_write", { paneId, data }),
  ptyResize: (paneId: string, cols: number, rows: number) =>
    invoke<void>("pty_resize", { paneId, cols, rows }),
  detachSession: (paneId: string) => invoke<void>("detach_session", { paneId }),
  // Always-on-top companion window (P5). open/close/query the floating monitor;
  // focusSessionFromCompanion raises the main window + emits codehub://focus-session.
  // No-ops over the dev bridge — a second OS window only exists under Tauri.
  openCompanion: () => invoke<void>("open_companion"),
  closeCompanion: () => invoke<void>("close_companion"),
  companionOpen: () => invoke<boolean>("companion_open"),
  focusSessionFromCompanion: (name: string) =>
    invoke<void>("focus_session_from_companion", { name }),
} as const;

export function onLifecycle(cb: (s: ContainerStatus) => void): Promise<UnlistenFn> {
  return listen<ContainerStatus>("codehub://lifecycle", (e) => cb(e.payload));
}

export function onLifecycleError(cb: (msg: string) => void): Promise<UnlistenFn> {
  return listen<string>("codehub://lifecycle-error", (e) => cb(e.payload));
}
