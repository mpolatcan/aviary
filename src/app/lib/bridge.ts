// Transport shim. Inside the Tauri webview we use the real IPC; in a plain
// browser (Vite dev, for UI inspection / screenshots) we route the same command
// + event surface to the dev-server bridge (src-tauri/src/devserver.rs) over
// REST + a WebSocket, proxied same-origin at /__bridge (see vite.config.ts).
//
// Everything that talks to the backend imports `invoke` / `listen` from here
// instead of `@tauri-apps/api` directly, so neither the store nor terminal.ts
// needs to know which transport is live.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { type UnlistenFn, listen as tauriListen } from "@tauri-apps/api/event";

export type { UnlistenFn };

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const BRIDGE = "/__bridge";

type Args = Record<string, unknown>;

async function body(res: Response): Promise<unknown> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  if (res.status === 204) return undefined;
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

function jget(path: string): Promise<unknown> {
  return fetch(`${BRIDGE}${path}`).then(body);
}
function jsend(method: string, path: string, payload?: unknown): Promise<unknown> {
  return fetch(`${BRIDGE}${path}`, {
    method,
    headers: payload === undefined ? undefined : { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }).then(body);
}

// Maps each Tauri command to its REST equivalent. Kept in lock-step with the
// routes in devserver.rs and the `#[tauri::command]`s in lib.rs.
async function httpInvoke<T>(cmd: string, args: Args = {}): Promise<T> {
  const id = encodeURIComponent(String(args.paneId ?? ""));
  switch (cmd) {
    case "container_status":
      return jget("/status") as Promise<T>;
    case "docker_info":
      return jget("/docker-info") as Promise<T>;
    case "agent_key_status":
      return jget("/agent-key-status") as Promise<T>;
    case "agent_versions":
      return jget("/agent-versions") as Promise<T>;
    case "container_stats":
      return jget("/container-stats") as Promise<T>;
    case "container_logs":
      return jget(`/container-logs?tail=${args.tail ?? 200}`) as Promise<T>;
    case "container_mounts":
      return jget("/container-mounts") as Promise<T>;
    case "container_git_status":
      return jget("/container-git-status") as Promise<T>;
    case "container_git_diff":
      return jget(
        `/container-git-diff?path=${encodeURIComponent(String(args.path))}`,
      ) as Promise<T>;
    case "container_top":
      return jget("/container-top") as Promise<T>;
    case "container_git_log":
      return jget(`/container-git-log?limit=${args.limit ?? 12}`) as Promise<T>;
    case "list_sessions":
      return jget("/sessions") as Promise<T>;
    case "create_session":
      return jsend("POST", "/sessions", {
        name: args.name,
        cli: args.cli,
        mode: args.mode,
        alias: args.alias,
      }) as Promise<T>;
    case "kill_session":
      return jsend("DELETE", `/sessions/${encodeURIComponent(String(args.name))}`) as Promise<T>;
    case "rename_session":
      return jsend("POST", `/sessions/${encodeURIComponent(String(args.name))}/rename`, {
        alias: args.alias,
      }) as Promise<T>;
    case "attach_session":
      return jsend("POST", "/attach", {
        name: args.name,
        cols: args.cols,
        rows: args.rows,
      }) as Promise<T>;
    case "pty_write":
      return jsend("POST", `/panes/${id}/write`, { data: args.data }) as Promise<T>;
    case "pty_resize":
      return jsend("POST", `/panes/${id}/resize`, {
        cols: args.cols,
        rows: args.rows,
      }) as Promise<T>;
    case "detach_session":
      return jsend("DELETE", `/panes/${id}`) as Promise<T>;
    default:
      throw new Error(`bridge: unmapped command ${cmd}`);
  }
}

// One shared WebSocket fans every `{event, payload}` frame out to the listeners
// registered for that exact event string — the same strings the Tauri build
// emits (`pty://data/<id>`, `codehub://lifecycle`, …).
type Frame = { payload: unknown };
const listeners = new Map<string, Set<(e: Frame) => void>>();
let socket: WebSocket | null = null;

function ensureSocket() {
  if (socket || isTauri) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}${BRIDGE}/events`);
  ws.onmessage = (ev) => {
    try {
      const { event, payload } = JSON.parse(ev.data);
      const set = listeners.get(event);
      if (set) for (const cb of set) cb({ payload });
    } catch {
      // ignore malformed frame
    }
  };
  ws.onclose = () => {
    socket = null;
    // Reconnect so listeners survive a dev-server restart.
    setTimeout(ensureSocket, 1000);
  };
  socket = ws;
}

function browserListen<T>(event: string, cb: (e: { payload: T }) => void): Promise<UnlistenFn> {
  ensureSocket();
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  const wrapped = (e: Frame) => cb({ payload: e.payload as T });
  set.add(wrapped);
  return Promise.resolve(() => {
    set?.delete(wrapped);
  });
}

// Connect eagerly in browser mode so the dev server has a subscriber before the
// first attach starts streaming pane output.
if (!isTauri) ensureSocket();

export const invoke = (isTauri ? tauriInvoke : httpInvoke) as typeof tauriInvoke;
export const listen = (isTauri ? tauriListen : browserListen) as typeof tauriListen;
