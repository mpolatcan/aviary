import { create } from "zustand";
import { SPEC_BY_CLI } from "./catalog";
import type { AgentVersion, Cli, ContainerStatus, DockerInfo, KeyStatus, Mode } from "./ipc";
import { ipc, onLifecycle, onLifecycleError } from "./ipc";
import * as registry from "./panes";
import {
  type LayoutNode,
  type SessionMeta,
  type SplitDir,
  type Workspace,
  firstLeaf,
  leafNode,
  leavesList,
  leavesOf,
  nid,
  removeLeaf,
  replaceLeaf,
  setRatio,
} from "./tree";

// Top-level view, switched from the sidebar nav. "hub" is the terminal grid;
// the rest are full-pane screens. hub/dashboard/containers/settings are live
// real-data screens; usage/resume/integrations are honest stubs whose real data
// needs backend CodeHub doesn't capture yet (see PlannedScreen + BACKEND_PLAN).
export type HubView =
  | "hub"
  | "dashboard"
  | "containers"
  | "settings"
  | "usage"
  | "resume"
  | "integrations";

interface CodeHubState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  sessionMeta: Record<string, SessionMeta>;
  status: ContainerStatus | null;
  error: string | null;
  view: HubView;
  // Session whose focused-detail view is open (terminal + workspace inspector),
  // or null for the normal view. Set from a pane's expand button; any sidebar
  // view switch or closing that session clears it.
  detailSession: string | null;

  // Tier-1 reads (BACKEND_PLAN.md), fetched once the runtime is reachable.
  // Presence/version metadata only — never secret values.
  dockerInfo: DockerInfo | null;
  keyStatus: Record<Cli, KeyStatus> | null;
  agentVersions: Record<Cli, AgentVersion> | null;

  // imperative bookkeeping (non-reactive counters)
  plateCounter: number;
  specimenCounter: number;
  bootstrapped: boolean;

  setStatus: (s: ContainerStatus) => void;
  setError: (msg: string) => void;
  setView: (v: HubView) => void;
  openDetail: (name: string) => void;
  closeDetail: () => void;
  newPlate: (cli: Cli, mode: Mode) => Promise<void>;
  splitSession: (target: string, dir: SplitDir, cli: Cli, mode: Mode) => Promise<void>;
  closeSession: (name: string) => Promise<void>;
  closeWorkspace: (id: string) => Promise<void>;
  closeAllSessions: () => Promise<void>;
  focusSession: (name: string) => void;
  switchWorkspace: (id: string) => void;
  renameSession: (name: string, alias: string) => void;
  commitRatio: (wsId: string, nodeId: number, ratio: number) => void;
}

function updateWs(list: Workspace[], id: string, fn: (w: Workspace) => Workspace): Workspace[] {
  return list.map((w) => (w.id === id ? fn(w) : w));
}

// Display alias for a session, e.g. "Owl 1". Shared by the session metadata and
// the tmux window name passed at create time, so both read identically.
function aliasFor(cli: Cli, num: number): string {
  return `${SPEC_BY_CLI[cli].alias} ${num}`;
}

export const useStore = create<CodeHubState>((set, get) => {
  const isRunning = () => get().status?.state === "running";

  const uniqueName = (cli: Cli): string => {
    const next = get().specimenCounter + 1;
    set({ specimenCounter: next });
    return `${cli}-${Date.now().toString(36)}-${next.toString(36)}`;
  };

  const registerMeta = (name: string, cli: Cli, mode: Mode, workspaceId: string) => {
    const num = get().specimenCounter;
    const meta: SessionMeta = {
      cli,
      num,
      alias: aliasFor(cli, num),
      mode,
      workspaceId,
    };
    set((s) => ({ sessionMeta: { ...s.sessionMeta, [name]: meta } }));
  };

  return {
    workspaces: [],
    activeWorkspaceId: null,
    sessionMeta: {},
    status: null,
    error: null,
    view: "hub",
    detailSession: null,
    dockerInfo: null,
    keyStatus: null,
    agentVersions: null,
    plateCounter: 0,
    specimenCounter: 0,
    bootstrapped: false,

    setStatus: (status) => {
      set({ status, error: null });
      if (status.state === "running" && !get().bootstrapped) {
        set({ bootstrapped: true });
        void bootstrap(get, set, registerMeta);
      }
    },

    setError: (msg) => set({ error: msg }),

    // Switching to a top-level view leaves any open session-detail view.
    setView: (view) => set({ view, detailSession: null }),

    openDetail: (name) => {
      if (get().sessionMeta[name]) set({ detailSession: name });
    },
    closeDetail: () => set({ detailSession: null }),

    newPlate: async (cli, mode) => {
      if (!isRunning()) return;
      const name = uniqueName(cli);
      await ipc.createSession(name, cli, mode, aliasFor(cli, get().specimenCounter));
      await registry.spawnPane(name);

      const plate = get().plateCounter + 1;
      const ws: Workspace = {
        id: `ws-${plate}-${Date.now().toString(36)}`,
        plate,
        root: leafNode(name),
        focused: name,
      };
      registerMeta(name, cli, mode, ws.id);
      set((s) => ({
        plateCounter: plate,
        workspaces: [...s.workspaces, ws],
        activeWorkspaceId: ws.id,
      }));
    },

    splitSession: async (target, dir, cli, mode) => {
      if (!isRunning()) return;
      const ws = get().workspaces.find((w) => w.id === get().sessionMeta[target]?.workspaceId);
      if (!ws || !ws.root) return;
      const name = uniqueName(cli);
      await ipc.createSession(name, cli, mode, aliasFor(cli, get().specimenCounter));
      await registry.spawnPane(name);
      registerMeta(name, cli, mode, ws.id);

      set((s) => ({
        workspaces: updateWs(s.workspaces, ws.id, (w) => ({
          ...w,
          root: w.root
            ? replaceLeaf(w.root, target, (lf) => ({
                kind: "split",
                id: nid(),
                dir,
                ratio: 0.5,
                a: lf,
                b: leafNode(name),
              }))
            : leafNode(name),
          focused: name,
        })),
      }));
    },

    // Close one session. tmux is killed FIRST, then the pane is detached/disposed
    // (see CLAUDE.md / TEST_SCENARIOS S3/S5/S7/S8) so no resize/write can race a
    // dying pane.
    closeSession: async (name) => {
      const meta = get().sessionMeta[name];
      try {
        await ipc.killSession(name);
      } catch (e) {
        console.warn(`kill_session(${name}) failed:`, e);
      }
      await registry.destroyPane(name);

      set((s) => {
        const sessionMeta = { ...s.sessionMeta };
        delete sessionMeta[name];
        // A closed session can't have an open detail view.
        return { sessionMeta, detailSession: s.detailSession === name ? null : s.detailSession };
      });

      if (!meta) return;
      const ws = get().workspaces.find((w) => w.id === meta.workspaceId);
      if (!ws) return;
      const nextRoot = ws.root ? removeLeaf(ws.root, name) : null;
      if (!nextRoot) {
        removeWorkspace(get, set, ws.id);
        return;
      }
      set((s) => ({
        workspaces: updateWs(s.workspaces, ws.id, (w) => ({
          ...w,
          root: nextRoot,
          focused: w.focused === name ? firstLeaf(nextRoot) : w.focused,
        })),
      }));
    },

    closeWorkspace: async (id) => {
      const ws = get().workspaces.find((w) => w.id === id);
      if (!ws || !ws.root) {
        removeWorkspace(get, set, id);
        return;
      }
      for (const session of leavesList(ws.root)) {
        try {
          await ipc.killSession(session);
        } catch (e) {
          console.warn(`kill_session(${session}) failed:`, e);
        }
        await registry.destroyPane(session);
        set((s) => {
          const sessionMeta = { ...s.sessionMeta };
          delete sessionMeta[session];
          // A closed session can't have an open detail view (matches closeSession).
          return {
            sessionMeta,
            detailSession: s.detailSession === session ? null : s.detailSession,
          };
        });
      }
      removeWorkspace(get, set, id);
    },

    // Stop-all (Settings danger zone). Kills every session in every workspace;
    // closeWorkspace already SIGTERMs each session and persists tmux scrollback.
    // Snapshot the ids first — closeWorkspace mutates the workspace list.
    closeAllSessions: async () => {
      for (const id of get().workspaces.map((w) => w.id)) {
        await get().closeWorkspace(id);
      }
    },

    focusSession: (name) => {
      const meta = get().sessionMeta[name];
      if (!meta) return;
      set((s) => ({
        activeWorkspaceId: meta.workspaceId,
        workspaces: updateWs(s.workspaces, meta.workspaceId, (w) => ({ ...w, focused: name })),
      }));
      registry.focus(name);
    },

    switchWorkspace: (id) => {
      if (get().activeWorkspaceId === id) return;
      // Switching tabs leaves any open session-detail view (same contract as
      // setView) — otherwise the sidebar tab click is a silent no-op behind it.
      set({ activeWorkspaceId: id, detailSession: null });
    },

    renameSession: (name, alias) => {
      const next = alias.trim();
      if (!next) return;
      let changed = false;
      set((s) => {
        const meta = s.sessionMeta[name];
        if (!meta || meta.alias === next) return {};
        changed = true;
        return { sessionMeta: { ...s.sessionMeta, [name]: { ...meta, alias: next } } };
      });
      // Mirror the alias onto the tmux window name so the in-pane status bar
      // (#W) updates too. Best-effort: a backend failure must not roll back the
      // UI rename the user just made.
      if (changed) {
        void ipc.renameSession(name, next).catch((e) => {
          console.warn(`rename_session(${name}) failed:`, e);
        });
      }
    },

    commitRatio: (wsId, nodeId, ratio) => {
      set((s) => ({
        workspaces: updateWs(s.workspaces, wsId, (w) => ({
          ...w,
          root: w.root ? setRatio(w.root, nodeId, ratio) : w.root,
        })),
      }));
    },
  };
});

type Get = () => CodeHubState;
type Set = (partial: Partial<CodeHubState> | ((s: CodeHubState) => Partial<CodeHubState>)) => void;

function removeWorkspace(get: Get, set: Set, id: string) {
  const list = get().workspaces;
  const idx = list.findIndex((w) => w.id === id);
  if (idx === -1) return;
  const next = list.filter((w) => w.id !== id);
  const wasActive = get().activeWorkspaceId === id;
  const nextActive = wasActive
    ? (next[idx]?.id ?? next[idx - 1]?.id ?? null)
    : get().activeWorkspaceId;
  set({ workspaces: next, activeWorkspaceId: nextActive });
}

async function bootstrap(
  get: Get,
  set: Set,
  registerMeta: (name: string, cli: Cli, mode: Mode, workspaceId: string) => void,
) {
  // Tier-1 reads (BACKEND_PLAN.md): daemon info, per-CLI version + key presence.
  // Best-effort and independent of session bootstrap — a failure must not block
  // session restore, so each is caught on its own.
  void ipc
    .dockerInfo()
    .then((dockerInfo) => set({ dockerInfo }))
    .catch((e) => console.warn("docker_info failed", e));
  void ipc
    .agentKeyStatus()
    .then((keyStatus) => set({ keyStatus }))
    .catch((e) => console.warn("agent_key_status failed", e));
  void ipc
    .agentVersions()
    .then((agentVersions) => set({ agentVersions }))
    .catch((e) => console.warn("agent_versions failed", e));

  try {
    const sessions = await ipc.listSessions();
    for (const s of sessions) {
      const cli =
        (["claude", "codex", "antigravity"] as Cli[]).find((c) => s.name.startsWith(c)) ?? "claude";
      await registry.spawnPane(s.name);
      const plate = get().plateCounter + 1;
      const ws: Workspace = {
        id: `ws-${plate}-${Date.now().toString(36)}`,
        plate,
        root: leafNode(s.name),
        focused: s.name,
      };
      set((st) => ({
        plateCounter: plate,
        specimenCounter: st.specimenCounter + 1,
        workspaces: [...st.workspaces, ws],
        activeWorkspaceId: st.activeWorkspaceId ?? ws.id,
      }));
      // Mode of a pre-existing tmux session is unknown; show it as Standard.
      registerMeta(s.name, cli, "standard", ws.id);
    }
  } catch (e) {
    console.error("list_sessions failed", e);
  }
}

// Initial container_status fetch + live lifecycle subscription, wired into the
// store. Idempotent (module guard) so StrictMode's double-invoke is harmless;
// listeners are app-lifetime singletons, so no teardown.
let lifecycleStarted = false;
export async function initLifecycle(): Promise<void> {
  if (lifecycleStarted) return;
  lifecycleStarted = true;
  const { setStatus, setError } = useStore.getState();
  void onLifecycle(setStatus);
  void onLifecycleError(setError);
  try {
    setStatus(await ipc.containerStatus());
  } catch {
    setError("unreachable");
  }
}

// Convenience selectors.
export function activeWorkspace(s: CodeHubState): Workspace | undefined {
  return s.workspaces.find((w) => w.id === s.activeWorkspaceId);
}

export { leavesList, leavesOf };
export type { LayoutNode };
