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

export const ipc = {
  containerStatus: () => invoke<ContainerStatus>("container_status"),
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
