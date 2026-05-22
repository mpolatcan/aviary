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
}

export type Cli = "claude" | "codex" | "antigravity";
export type Mode = "standard" | "auto" | "yolo";

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

// One bind/volume mount of the runtime container, from `docker inspect`.
// `source` is the host path, `destination` the in-container path.
export interface MountInfo {
  source: string;
  destination: string;
  rw: boolean;
  kind: string;
}

export const ipc = {
  containerStatus: () => invoke<ContainerStatus>("container_status"),
  dockerInfo: () => invoke<DockerInfo>("docker_info"),
  agentKeyStatus: () => invoke<Record<Cli, KeyStatus>>("agent_key_status"),
  agentVersions: () => invoke<Record<Cli, AgentVersion>>("agent_versions"),
  containerStats: () => invoke<ContainerStats>("container_stats"),
  // Tail of the runtime container log; defaults to 200 lines server-side.
  containerLogs: (tail?: number) => invoke<string[]>("container_logs", { tail }),
  // Real bind/volume mounts of the runtime container (host paths).
  containerMounts: () => invoke<MountInfo[]>("container_mounts"),
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
} as const;

export function onLifecycle(cb: (s: ContainerStatus) => void): Promise<UnlistenFn> {
  return listen<ContainerStatus>("codehub://lifecycle", (e) => cb(e.payload));
}

export function onLifecycleError(cb: (msg: string) => void): Promise<UnlistenFn> {
  return listen<string>("codehub://lifecycle-error", (e) => cb(e.payload));
}
