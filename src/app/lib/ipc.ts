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

export type Cli = "claude" | "codex" | "antigravity";
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

export const ipc = {
  containerStatus: () => invoke<ContainerStatus>("container_status"),
  dockerInfo: () => invoke<DockerInfo>("docker_info"),
  // Build + host platform identity for Settings → About.
  appInfo: () => invoke<AppInfo>("app_info"),
  agentKeyStatus: () => invoke<Record<Cli, KeyStatus>>("agent_key_status"),
  agentVersions: () => invoke<Record<Cli, AgentVersion>>("agent_versions"),
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
  listSessions: () => invoke<SessionInfo[]>("list_sessions"),
  createSession: (name: string, cli: Cli, mode: Mode, alias: string) =>
    invoke<void>("create_session", { name, cli, mode, alias }),
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
