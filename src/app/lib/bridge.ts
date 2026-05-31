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
  // `?workspace=<key>` targets a per-workspace container; empty when absent.
  // Mirrors the kill route's query convention.
  const wsq = args.workspace ? `?workspace=${encodeURIComponent(String(args.workspace))}` : "";
  // Same key as `&workspace=…` for routes that already own a `?` (path/limit).
  const wsAmp = args.workspace ? `&workspace=${encodeURIComponent(String(args.workspace))}` : "";
  switch (cmd) {
    case "container_status":
      return jget(`/status${wsq}`) as Promise<T>;
    case "container_start":
      return jsend("POST", `/container-start${wsq}`) as Promise<T>;
    case "container_stop":
      return jsend("POST", `/container-stop${wsq}`) as Promise<T>;
    case "container_restart":
      return jsend("POST", `/container-restart${wsq}`) as Promise<T>;
    case "docker_info":
      return jget("/docker-info") as Promise<T>;
    case "detect_docker_runtime":
      return jget("/detect-docker-runtime") as Promise<T>;
    case "start_docker_app":
      return jsend("POST", "/start-docker-app", { runtime: args.runtime }) as Promise<T>;
    case "agent_key_status":
      return jget("/agent-key-status") as Promise<T>;
    case "agent_versions":
      return jget("/agent-versions") as Promise<T>;
    case "container_stats":
      return jget(`/container-stats${wsq}`) as Promise<T>;
    case "container_stats_history":
      return jget(`/container-stats-history${wsq}`) as Promise<T>;
    case "list_workspace_containers":
      return jget("/workspace-containers") as Promise<T>;
    case "remove_workspace_container":
      return jsend("DELETE", `/workspace-containers${wsq}`) as Promise<T>;
    case "container_logs": {
      // `tail` already occupies the `?` slot, so workspace joins with `&`.
      const ws = args.workspace ? `&workspace=${encodeURIComponent(String(args.workspace))}` : "";
      return jget(`/container-logs?tail=${args.tail ?? 200}${ws}`) as Promise<T>;
    }
    case "container_mounts":
      return jget(`/container-mounts${wsq}`) as Promise<T>;
    case "container_image":
      return jget(`/container-image${wsq}`) as Promise<T>;
    case "container_health":
      return jget(`/container-health${wsq}`) as Promise<T>;
    case "container_list_dir":
      return jget(
        `/container-list-dir?path=${encodeURIComponent(String(args.path ?? ""))}${wsAmp}`,
      ) as Promise<T>;
    case "container_browse_dirs":
      return jget(
        `/container-browse-dirs?path=${encodeURIComponent(String(args.path ?? ""))}${wsAmp}`,
      ) as Promise<T>;
    case "container_read_file":
      return jget(
        `/container-read-file?path=${encodeURIComponent(String(args.path ?? ""))}${wsAmp}`,
      ) as Promise<T>;
    case "container_git_status":
      return jget(`/container-git-status${wsq}`) as Promise<T>;
    case "container_git_diff":
      return jget(
        `/container-git-diff?path=${encodeURIComponent(String(args.path))}${wsAmp}`,
      ) as Promise<T>;
    case "app_info":
      return jget("/app-info") as Promise<T>;
    case "host_stats":
      return jget("/host-stats") as Promise<T>;
    case "runtime_versions":
      return jget(`/runtime-versions${wsq}`) as Promise<T>;
    case "get_config":
      return jget("/config") as Promise<T>;
    case "set_config":
      return jsend("PUT", "/config", args.config) as Promise<T>;
    case "add_prompt_template":
      return jsend("POST", "/prompt-templates", {
        name: args.name,
        prompt: args.prompt,
        cli: args.cli,
      }) as Promise<T>;
    case "remove_prompt_template":
      return jsend(
        "DELETE",
        `/prompt-templates?id=${encodeURIComponent(String(args.id))}`,
      ) as Promise<T>;
    // Tier-2 workspace picker. The native folder dialog can't run in a browser,
    // so pick_directory degrades to null (the UI offers a typed path instead).
    case "pick_directory":
      return null as T;
    case "set_workspace_dir":
      return jsend("PUT", "/workspace-dir", { path: args.path }) as Promise<T>;
    case "workspace_info":
      return jget(`/workspace-info${wsq}`) as Promise<T>;
    case "recreate_runtime":
      return jsend("POST", `/recreate-runtime${wsq}`) as Promise<T>;
    // Account profiles (keychain-backed).
    case "list_account_profiles":
      return jget("/account-profiles") as Promise<T>;
    case "add_account_profile":
      return jsend("POST", "/account-profiles", {
        agent: args.agent,
        label: args.label,
        var_name: args.varName,
        source: args.source,
      }) as Promise<T>;
    case "remove_account_profile":
      return jsend(
        "DELETE",
        `/account-profiles/${encodeURIComponent(String(args.id))}`,
      ) as Promise<T>;
    case "rename_account_profile":
      return jsend("PATCH", `/account-profiles/${encodeURIComponent(String(args.id))}`, {
        label: args.label,
      }) as Promise<T>;
    case "set_account_profile_enabled":
      return jsend("POST", `/account-profiles/${encodeURIComponent(String(args.id))}/enabled`, {
        enabled: args.enabled,
      }) as Promise<T>;
    case "backfill_account_emails":
      return jsend("POST", "/account-profiles/backfill-emails") as Promise<T>;
    // Vault: OS-keychain ops — Tauri-only, degrade to no-op in browser mode.
    case "vault_store_key":
    case "vault_delete_key":
    case "vault_initiate_oauth":
    case "vault_complete_login":
      return undefined as T;
    case "vault_has_key":
      return false as T;
    case "container_git_diff_all":
      return jget(`/container-git-diff-all${wsq}`) as Promise<T>;
    case "container_git_diff_staged":
      return jget(`/container-git-diff-staged${wsq}`) as Promise<T>;
    case "container_git_diff_unstaged":
      return jget(`/container-git-diff-unstaged${wsq}`) as Promise<T>;
    case "container_git_stage_all":
      return jsend("POST", `/container-git-stage-all${wsq}`) as Promise<T>;
    case "container_git_stage_file":
      return jsend("POST", "/container-git-stage-file", {
        path: args.path,
        workspace: args.workspace,
      }) as Promise<T>;
    case "container_git_unstage_file":
      return jsend("POST", "/container-git-unstage-file", {
        path: args.path,
        workspace: args.workspace,
      }) as Promise<T>;
    case "container_git_stage_hunk":
      return jsend("POST", "/container-git-stage-hunk", {
        patch: args.patch,
        workspace: args.workspace,
      }) as Promise<T>;
    case "set_agent_model":
      return jsend("POST", "/set-agent-model", {
        model: args.model,
        workspace: args.workspace,
      }) as Promise<T>;
    case "set_permission_mode":
      return jsend("POST", "/set-permission-mode", {
        mode: args.mode,
        workspace: args.workspace,
      }) as Promise<T>;
    case "set_permission_rules":
      return jsend("POST", "/set-permission-rules", {
        bucket: args.bucket,
        rules: args.rules,
        workspace: args.workspace,
      }) as Promise<T>;
    case "toggle_mcp_server":
      return jsend("POST", "/toggle-mcp-server", {
        name: args.name,
        enabled: args.enabled,
        workspace: args.workspace,
      }) as Promise<T>;
    case "container_git_commit":
      return jsend("POST", `/container-git-commit${wsq}`, { message: args.message }) as Promise<T>;
    case "container_git_open_pr":
      return jsend("POST", `/container-git-open-pr${wsq}`, {
        title: args.title,
        body: args.body,
      }) as Promise<T>;
    case "container_top":
      return jget(`/container-top${wsq}`) as Promise<T>;
    case "container_env":
      return jget(`/container-env${wsq}`) as Promise<T>;
    case "container_repos":
      return jget(`/container-repos${wsq}`) as Promise<T>;
    case "container_git_clone":
      return jsend("POST", "/container-git-clone", {
        url: args.url,
        workspace: args.workspace,
      }) as Promise<T>;
    case "stop_all_agents":
      return jsend("POST", `/stop-all-agents${wsq}`) as Promise<T>;
    case "rolling_usage": {
      const h = args.hours ? `?hours=${args.hours}` : "";
      return jget(`/rolling-usage${h}`) as Promise<T>;
    }
    case "container_git_log":
      return jget(`/container-git-log?limit=${args.limit ?? 12}${wsAmp}`) as Promise<T>;
    case "session_activity":
      return jget("/session-activity") as Promise<T>;
    // Phase-0 completion contract (stub backend; mirrors devserver.rs routes).
    case "pending_prompts":
      return jget("/pending-prompts") as Promise<T>;
    case "respond_prompt":
      return jsend("POST", "/respond-prompt", {
        session: args.session,
        allow: args.allow,
      }) as Promise<T>;
    case "session_activity_history":
      return jget(
        `/session-activity-history?session=${encodeURIComponent(String(args.session ?? ""))}`,
      ) as Promise<T>;
    case "codex_usage":
      return jget("/codex-usage") as Promise<T>;
    case "codex_sessions":
      return jget("/codex-sessions") as Promise<T>;
    case "codex_session_usage":
      return jget(`/codex-session-usage?id=${encodeURIComponent(String(args.id))}`) as Promise<T>;
    case "codex_rate_limits":
      return jget("/codex-rate-limits") as Promise<T>;
    case "github_status":
      return jget("/github-status") as Promise<T>;
    case "github_repos":
      return jget("/github-repos") as Promise<T>;
    case "github_repo_dir":
      return jsend("POST", "/github-repo-dir", {
        nameWithOwner: args.nameWithOwner,
      }) as Promise<T>;
    case "github_clone_into":
      return jsend("POST", "/github-clone-into", {
        workspace: args.workspace,
        nameWithOwner: args.nameWithOwner,
        target: args.target,
      }) as Promise<T>;
    case "check_update":
      return jget("/check-update") as Promise<T>;
    case "list_providers":
      return jget("/providers") as Promise<T>;
    case "add_provider":
      return jsend("POST", "/providers", {
        name: args.name,
        kind: args.kind,
        endpoint: args.endpoint,
        api_key_var: args.apiKeyVar,
        models: args.models,
        model: args.model,
        small_fast_model: args.smallFastModel,
      }) as Promise<T>;
    case "remove_provider":
      return jsend("DELETE", `/providers?id=${encodeURIComponent(String(args.id))}`) as Promise<T>;
    case "update_provider":
      return jsend("POST", "/providers/update", {
        id: args.id,
        name: args.name,
        endpoint: args.endpoint,
        enabled: args.enabled,
        models: args.models,
        model: args.model,
        small_fast_model: args.smallFastModel,
      }) as Promise<T>;
    case "set_provider_token":
      return jsend("POST", "/providers/token", {
        id: args.id,
        token: args.token,
      }) as Promise<T>;
    case "search_transcripts": {
      const params = new URLSearchParams({ query: String(args.query) });
      if (args.limit) params.set("limit", String(args.limit));
      if (args.workspace) params.set("workspace", String(args.workspace));
      return jget(`/search-transcripts?${params}`) as Promise<T>;
    }
    case "claude_usage":
      return jget("/claude-usage") as Promise<T>;
    case "claude_sessions":
      return jget("/claude-sessions") as Promise<T>;
    case "claude_integrations":
      return jget("/claude-integrations") as Promise<T>;
    case "claude_agent_config":
      return jget("/claude-agent-config") as Promise<T>;
    case "claude_session_usage":
      return jget(`/claude-session-usage?id=${encodeURIComponent(String(args.id))}`) as Promise<T>;
    case "list_sessions":
      return jget("/sessions") as Promise<T>;
    case "create_session":
      return jsend("POST", "/sessions", {
        name: args.name,
        cli: args.cli,
        mode: args.mode,
        alias: args.alias,
        resume: args.resume,
        session_id: args.sessionId,
        account: args.account,
        workspace: args.workspace,
        workspace_dir: args.workspaceDir,
        cwd: args.cwd,
      }) as Promise<T>;
    case "kill_session": {
      const ws = args.workspace ? `?workspace=${encodeURIComponent(String(args.workspace))}` : "";
      return jsend(
        "DELETE",
        `/sessions/${encodeURIComponent(String(args.name))}${ws}`,
      ) as Promise<T>;
    }
    case "rename_session":
      return jsend("POST", `/sessions/${encodeURIComponent(String(args.name))}/rename`, {
        alias: args.alias,
        workspace: args.workspace,
      }) as Promise<T>;
    case "attach_session":
      return jsend("POST", "/attach", {
        name: args.name,
        cols: args.cols,
        rows: args.rows,
        workspace: args.workspace,
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
    // The companion is a second always-on-top OS window — it only exists under
    // Tauri. Over the browser dev bridge these degrade to honest no-ops so the
    // trigger + companion route still render for inspection without a window
    // manager.
    case "open_companion":
    case "close_companion":
    case "focus_session_from_companion":
      return undefined as T;
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
