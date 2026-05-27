import { create } from "zustand";
import { SPEC_BY_CLI } from "./catalog";
import type {
  AccountProfileStatus,
  ActivityEvent,
  AgentCli,
  AgentVersion,
  AppSettings,
  Cli,
  CodexRateLimits,
  CodexSession,
  CodexUsage,
  ContainerStats,
  ContainerStatus,
  DockerInfo,
  GitStatus,
  GithubRepo,
  GithubStatus,
  KeyStatus,
  Mode,
  PendingPrompt,
  SavedWorkspace,
  SessionActivity,
  SessionInfo,
  UpdateStatus,
  WorkspaceInfo,
} from "./ipc";
import { ipc, onLifecycle, onLifecycleError } from "./ipc";
import { useOverlay } from "./overlay";
import * as registry from "./panes";
import {
  type LayoutNode,
  MAX_GROUP_PANES,
  type SessionMeta,
  type SplitDir,
  type Workspace,
  activeGroup,
  findGroupOf,
  firstLeaf,
  leafNode,
  leavesList,
  leavesOf,
  makeGroup,
  moveLeaf,
  nid,
  removeLeaf,
  replaceLeaf,
  setRatio,
  swapLeaves,
  updateGroup,
  workspaceLeaves,
} from "./tree";

// Top-level view, switched from the sidebar nav. "hub" is the terminal grid;
// the rest are full-pane screens. Resume is no longer a view — it's a docked
// drawer over the hub (useOverlay.resume). Integrations is no longer a view
// either — it's a Settings pane (settingsSection === "integrations"), reached by
// deep-linking into Settings.
export type HubView = "hub" | "dashboard" | "containers" | "settings" | "usage";

interface CodeHubState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  sessionMeta: Record<string, SessionMeta>;
  status: ContainerStatus | null;
  error: string | null;
  view: HubView;
  // Selected Settings sub-pane (NAV_GROUPS key in Settings.tsx). Lifted to the
  // store so other surfaces can deep-link into a pane — e.g. the sidebar's
  // "Integrations" entry and Welcome's "From GitHub" card open Settings with the
  // integrations pane already selected.
  settingsSection: string;
  // Sidebar collapsed to the 52px icon rail (design AppSidebar) — toggled by the
  // header chevron or ⌘B. Transient (not persisted); defaults expanded.
  sidebarCollapsed: boolean;
  // Session whose focused-detail view is open (terminal + workspace inspector),
  // or null for the normal view. Set from a pane's expand button; any sidebar
  // view switch or closing that session clears it.
  detailSession: string | null;
  // One docked utility shell per workspace container. These are real tmux
  // sessions mounted in the Hub's bottom Shell panel, not leaves in the split
  // pane grid.
  utilityShells: Record<string, string>;
  // Live per-session working/idle activity (session_activity), keyed by session
  // name. Polled by the Hub while the runtime is up; empty when down.
  sessionActivity: Record<string, SessionActivity>;
  // Live cpu/mem/net/disk snapshot of the runtime (container_stats), polled once
  // app-wide while the runtime is up (useContainerStatsPoll) and shared by every
  // surface that shows resource gauges. Null while down / before the first read
  // → headers render honest em-dashes, never zeros. Centralized deliberately: a
  // single docker `stats` call (~1-2s, stream:false) feeds all consumers instead
  // of each screen polling independently and contending on the daemon.
  containerStats: ContainerStats | null;
  // Live /workspace git status (branch + ahead/behind + uncommitted count),
  // polled app-wide while the runtime is up (useGitStatusPoll). Shared by the
  // activity rail's Changes list and the Hub meta strip so they don't each poll
  // container_git_status independently. Null while down / before first read.
  gitStatus: GitStatus | null;

  // Tier-1 reads (BACKEND_PLAN.md), fetched once the runtime is reachable.
  // Presence/version metadata only — never secret values.
  dockerInfo: DockerInfo | null;
  keyStatus: Record<AgentCli, KeyStatus> | null;
  agentVersions: Record<AgentCli, AgentVersion> | null;

  // Persisted UI preferences (settings.json). Null until the first load resolves;
  // the Settings screen reads + writes it through updateConfig.
  config: AppSettings | null;

  // Tier-2 workspace picker: configured-vs-mounted /workspace + needs-recreate.
  // Null until first load. Tier-3 account profiles (label-only, with live host-env
  // presence), loaded for the Settings + spawn dialog account picker.
  workspaceInfo: WorkspaceInfo | null;
  accountProfiles: AccountProfileStatus[];

  // ── Phase-0 completion contract (COMPLETION_PLAN.md) ──────────────────────
  // New slices for the parallel fleet. Backend fns are stubs (honest-empty)
  // until the BE track lands, so these stay empty/null until then. NOT wired
  // into bootstrap polling here — the fleet wires each load where it's used.
  // Sessions awaiting user input right now (pending_prompts).
  pendingPrompts: PendingPrompt[];
  // Activity/turn history ring buffer (session_activity_history).
  activityHistory: ActivityEvent[];
  // Codex usage analytics + sessions + rate-limit meters (mirrors claude*).
  codexUsage: CodexUsage | null;
  codexSessions: CodexSession[];
  codexRateLimits: CodexRateLimits | null;
  // GitHub connection (presence-only) + visible repos (Integrations).
  githubStatus: GithubStatus | null;
  githubRepos: GithubRepo[];
  // App update check (Settings → About).
  updateStatus: UpdateStatus | null;

  // imperative bookkeeping (non-reactive counters)
  plateCounter: number;
  sessionCounter: number;
  bootstrapped: boolean;

  setStatus: (s: ContainerStatus) => void;
  setError: (msg: string) => void;
  // Runtime lifecycle controls (Containers screen + empty-state). start is safe;
  // stopRuntime/restartRuntime kill every running session — callers confirm first.
  startRuntime: () => Promise<void>;
  stopRuntime: () => Promise<void>;
  restartRuntime: () => Promise<void>;
  setView: (v: HubView) => void;
  setSettingsSection: (key: string) => void;
  toggleSidebar: () => void;
  openDetail: (name: string) => void;
  closeDetail: () => void;
  setSessionActivity: (list: SessionActivity[]) => void;
  setContainerStats: (s: ContainerStats | null) => void;
  setGitStatus: (g: GitStatus | null) => void;
  ensureDockedShell: () => Promise<string | null>;
  newPlate: (
    cli: Cli,
    mode: Mode,
    resume?: string,
    initialPrompt?: string,
    account?: string,
    workspaceMeta?: { title?: string; dir?: string; savedWorkspaceId?: string },
  ) => Promise<void>;
  splitSession: (
    target: string,
    dir: SplitDir,
    cli: Cli,
    mode: Mode,
    initialPrompt?: string,
    account?: string,
  ) => Promise<void>;
  closeSession: (name: string) => Promise<void>;
  closeWorkspace: (id: string) => Promise<void>;
  closeAllSessions: () => Promise<void>;
  focusSession: (name: string) => void;
  switchWorkspace: (id: string) => void;
  renameSession: (name: string, alias: string) => void;
  commitRatio: (wsId: string, nodeId: number, ratio: number) => void;
  // Drag-to-rearrange within the active group's grid (design hub-states
  // HubStateDragging). swapPanes exchanges two panes' slots; movePane removes the
  // dragged pane and re-splits the target's slot in `dir` (before=leading side).
  // Neither kills a tmux session — pure tree reshape, xterm surfaces survive.
  swapPanes: (wsId: string, a: string, b: string) => void;
  movePane: (wsId: string, session: string, target: string, dir: SplitDir, before: boolean) => void;

  // ── Pane groups within a workspace (design GroupsBar / GroupGrid) ──────────
  // Groups are frontend-only organisation over the flat tmux session set; they
  // own their own split tree + focus. addGroup appends an empty group and makes
  // it active (its grid shows the empty-state CTA until addPaneToGroup runs);
  // it returns the new group's id so callers can immediately spawn into it.
  addGroup: (wsId: string) => string;
  closeGroup: (wsId: string, groupId: string) => Promise<void>;
  renameGroup: (wsId: string, groupId: string, name: string) => void;
  setGroupColor: (wsId: string, groupId: string, color: string) => void;
  setActiveGroup: (wsId: string, groupId: string) => void;
  // Spawn the first pane into an empty group (the group-grid empty-state CTA).
  addPaneToGroup: (
    wsId: string,
    groupId: string,
    cli: Cli,
    mode: Mode,
    initialPrompt?: string,
    account?: string,
  ) => Promise<void>;
  loadConfig: () => Promise<void>;
  // Merge a patch into the persisted settings. Optimistic: applies locally, then
  // writes through to the backend; reverts on failure.
  updateConfig: (patch: Partial<AppSettings>) => Promise<void>;

  // Tier-2 workspace picker.
  loadWorkspaceInfo: () => Promise<void>;
  // Open the native folder dialog and persist the choice. Returns true when the
  // workspace dir changed (the caller surfaces "restart runtime to apply").
  pickWorkspaceDir: () => Promise<boolean>;
  // Persist an already-known path (e.g. an MRU recents click).
  selectWorkspaceDir: (path: string) => Promise<void>;
  // Remove + recreate the runtime so a changed mount applies (kills sessions).
  recreateRuntime: () => Promise<void>;

  // Saved workspaces (Welcome launcher). Persisted through updateConfig — a saved
  // workspace is a name + dir pointer; each opens in its own per-workspace
  // container. saveWorkspace returns the new id. openSavedWorkspace touches lastOpened and
  // points the /workspace mount at its dir (the caller then opens the spawn
  // launcher to start the first agent).
  saveWorkspace: (name: string, dir: string) => Promise<string>;
  removeSavedWorkspace: (id: string) => Promise<void>;
  toggleWorkspacePin: (id: string) => Promise<void>;
  openSavedWorkspace: (id: string) => Promise<void>;

  // Tier-3 account profiles (label-only).
  loadAccountProfiles: () => Promise<void>;
  // Add a profile. Throws (string) on validation failure so the UI shows it.
  addAccountProfile: (
    agent: string,
    label: string,
    varName?: string,
    source?: "env" | "vault",
  ) => Promise<void>;
  removeAccountProfile: (id: string) => Promise<void>;

  // Phase-0 completion contract load actions (best-effort, mirror the existing
  // load* pattern). Each catches its own failure so it can't block callers.
  loadPendingPrompts: () => Promise<void>;
  loadActivityHistory: (session?: string) => Promise<void>;
  loadCodexUsage: () => Promise<void>;
  loadCodexSessions: () => Promise<void>;
  loadCodexRateLimits: () => Promise<void>;
  loadGithubStatus: () => Promise<void>;
  loadGithubRepos: () => Promise<void>;
  loadUpdateStatus: () => Promise<void>;
}

function updateWs(list: Workspace[], id: string, fn: (w: Workspace) => Workspace): Workspace[] {
  return list.map((w) => (w.id === id ? fn(w) : w));
}

// Clear transient pane-grid overlays (focus mode, in-flight drag) that are
// scoped to the active group. Called on every group/workspace switch so a
// maximized pane or a stuck drop-overlay can't bleed into the view we move to.
function resetGridOverlays() {
  const o = useOverlay.getState();
  if (o.focusMode) o.setFocusMode(false);
  if (o.dragSession) o.setDragSession(null);
}

// Display alias for a session, e.g. "Claude 1". Shared by the session metadata and
// the tmux window name passed at create time, so both read identically.
function aliasFor(cli: Cli, num: number): string {
  return `${SPEC_BY_CLI[cli].alias} ${num}`;
}

// Pre-fill a freshly-spawned pane's agent input with the spawn dialog's initial
// prompt. Typed, NOT submitted (no trailing Enter) — matches the design (the
// prompt sits in the input awaiting the user's review) and sidesteps the race
// against the CLI's own startup before its input box is ready. Fire-and-forget
// on a short delay so it never blocks session creation.
function prefillPrompt(name: string, prompt?: string) {
  const text = prompt?.trim();
  if (!text) return;
  setTimeout(() => {
    const pane = registry.getPane(name);
    if (pane) void ipc.ptyWrite(pane.paneId, text);
  }, 1200);
}

export const useStore = create<CodeHubState>((set, get) => {
  const isRunning = () => get().status?.state === "running";
  const pendingUtilityShells = new Map<string, Promise<string | null>>();

  const uniqueName = (cli: Cli): string => {
    const next = get().sessionCounter + 1;
    set({ sessionCounter: next });
    return `${cli}-${Date.now().toString(36)}-${next.toString(36)}`;
  };

  const registerMeta = (
    name: string,
    cli: Cli,
    mode: Mode,
    workspaceId: string,
    groupId: string,
    containerKey: string,
    claudeId?: string,
  ) => {
    const num = get().sessionCounter;
    const meta: SessionMeta = {
      cli,
      num,
      alias: aliasFor(cli, num),
      mode,
      workspaceId,
      groupId,
      claudeId,
      containerKey,
    };
    set((s) => ({ sessionMeta: { ...s.sessionMeta, [name]: meta } }));
  };

  const destroySessionRecord = async (name: string, containerKey?: string) => {
    const meta = get().sessionMeta[name];
    try {
      await ipc.killSession(name, containerKey ?? meta?.containerKey);
    } catch (e) {
      console.warn(`kill_session(${name}) failed:`, e);
    }
    await registry.destroyPane(name);
    set((s) => {
      const sessionMeta = { ...s.sessionMeta };
      delete sessionMeta[name];
      const utilityShells = Object.fromEntries(
        Object.entries(s.utilityShells).filter(([, session]) => session !== name),
      );
      return {
        sessionMeta,
        utilityShells,
        detailSession: s.detailSession === name ? null : s.detailSession,
      };
    });
  };

  // Conversation id to correlate a Claude session with its on-disk transcript:
  // the resumed id when resuming, else a fresh UUID we pin via `--session-id`.
  // Non-Claude CLIs persist no such transcript, so they have none.
  const claudeIdFor = (cli: Cli, resume?: string): string | undefined =>
    cli === "claude" ? (resume ?? crypto.randomUUID()) : undefined;

  return {
    workspaces: [],
    activeWorkspaceId: null,
    sessionMeta: {},
    status: null,
    error: null,
    view: "hub",
    settingsSection: "general",
    sidebarCollapsed: false,
    detailSession: null,
    utilityShells: {},
    sessionActivity: {},
    containerStats: null,
    gitStatus: null,
    dockerInfo: null,
    keyStatus: null,
    agentVersions: null,
    config: null,
    workspaceInfo: null,
    accountProfiles: [],
    // Phase-0 completion contract slices (empty/null until the fleet loads them).
    pendingPrompts: [],
    activityHistory: [],
    codexUsage: null,
    codexSessions: [],
    codexRateLimits: null,
    githubStatus: null,
    githubRepos: [],
    updateStatus: null,
    plateCounter: 0,
    sessionCounter: 0,
    bootstrapped: false,

    setStatus: (status) => {
      set({ status, error: null });
      if (status.state === "running" && !get().bootstrapped) {
        set({ bootstrapped: true });
        void bootstrap(get, set, registerMeta);
      }
    },

    setError: (msg) => set({ error: msg }),

    // Each backend control returns the post-action status (and emits
    // codehub://lifecycle); we setStatus from the return for an immediate update,
    // idempotent with the lifecycle event. stop/restart tear down the container,
    // so session panes get their exit event and the bootstrap re-runs on next
    // start. All three route through the ACTIVE workspace's containerKey so they
    // target the correct per-workspace container.
    startRuntime: async () => {
      const ws = get().workspaces.find((w) => w.id === get().activeWorkspaceId);
      const workspace = ws?.containerKey;
      try {
        get().setStatus(await ipc.containerStart(workspace));
      } catch (e) {
        set({ error: `start runtime failed: ${e}` });
      }
    },
    stopRuntime: async () => {
      const ws = get().workspaces.find((w) => w.id === get().activeWorkspaceId);
      const workspace = ws?.containerKey;
      try {
        get().setStatus(await ipc.containerStop(workspace));
      } catch (e) {
        set({ error: `stop runtime failed: ${e}` });
      }
    },
    restartRuntime: async () => {
      const ws = get().workspaces.find((w) => w.id === get().activeWorkspaceId);
      const workspace = ws?.containerKey;
      try {
        get().setStatus(await ipc.containerRestart(workspace));
      } catch (e) {
        set({ error: `restart runtime failed: ${e}` });
      }
    },

    // Switching to a top-level view leaves any open session-detail view.
    setView: (view) => set({ view, detailSession: null }),

    // Deep-link a Settings sub-pane (the caller usually also setView("settings")).
    setSettingsSection: (settingsSection) => set({ settingsSection }),
    toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

    openDetail: (name) => {
      if (get().sessionMeta[name]) set({ detailSession: name });
    },
    closeDetail: () => set({ detailSession: null }),

    setSessionActivity: (list) => {
      const next: Record<string, SessionActivity> = {};
      for (const a of list) next[a.session] = a;
      set({ sessionActivity: next });
    },

    setContainerStats: (containerStats) => set({ containerStats }),

    setGitStatus: (gitStatus) => set({ gitStatus }),

    ensureDockedShell: async () => {
      if (!isRunning()) return null;
      const ws = get().workspaces.find((w) => w.id === get().activeWorkspaceId);
      if (!ws) return null;
      const existing = get().utilityShells[ws.containerKey];
      if (existing && get().sessionMeta[existing]) {
        if (!registry.getPane(existing)) await registry.spawnPane(existing, ws.containerKey);
        return existing;
      }
      const pending = pendingUtilityShells.get(ws.containerKey);
      if (pending) return pending;

      const create = (async () => {
        const current = get().utilityShells[ws.containerKey];
        if (current && get().sessionMeta[current]) {
          if (!registry.getPane(current)) await registry.spawnPane(current, ws.containerKey);
          return current;
        }

        const name = uniqueName("shell");
        await ipc.createSession(
          name,
          "shell",
          "standard",
          aliasFor("shell", get().sessionCounter),
          undefined,
          undefined,
          undefined,
          ws.containerKey,
        );
        await registry.spawnPane(name, ws.containerKey);
        registerMeta(name, "shell", "standard", ws.id, ws.activeGroupId, ws.containerKey);
        set((s) => ({
          utilityShells: { ...s.utilityShells, [ws.containerKey]: name },
        }));
        return name;
      })().finally(() => {
        pendingUtilityShells.delete(ws.containerKey);
      });

      pendingUtilityShells.set(ws.containerKey, create);
      return create;
    },

    newPlate: async (cli, mode, resume, initialPrompt, account, workspaceMeta) => {
      const name = uniqueName(cli);
      const claudeId = claudeIdFor(cli, resume);
      // A resume carries its id via --resume; a fresh Claude session pins a new
      // one via --session-id (same value, so we can read its transcript back).
      const sessionId = resume ? undefined : claudeId;
      // The workspace id is computed up front so it can be passed as the
      // per-workspace-container key to createSession/attach: every session in
      // this tab lives in one container (`codehub-ws-<id>`).
      const plate = get().plateCounter + 1;
      const wsId = `ws-${plate}-${Date.now().toString(36)}`;
      const containerKey = wsId;
      await ipc.createSession(
        name,
        cli,
        mode,
        aliasFor(cli, get().sessionCounter),
        resume,
        sessionId,
        account,
        containerKey,
        workspaceMeta?.dir,
      );
      await registry.spawnPane(name, containerKey);
      prefillPrompt(name, initialPrompt);

      const group = makeGroup("Group 1", leafNode(name), name);
      const ws: Workspace = {
        id: wsId,
        plate,
        title: workspaceMeta?.title,
        dir: workspaceMeta?.dir,
        savedWorkspaceId: workspaceMeta?.savedWorkspaceId,
        groups: [group],
        activeGroupId: group.id,
        // Container keyed by the workspace id (= what we created/attached with).
        // Splits + later panes route by this.
        containerKey,
      };
      registerMeta(name, cli, mode, ws.id, group.id, containerKey, claudeId);
      const status = await ipc.containerStatus(containerKey).catch(() => null);
      // New tab becomes active — clear focus mode / drag from the old workspace.
      resetGridOverlays();
      set((s) => ({
        plateCounter: plate,
        workspaces: [...s.workspaces, ws],
        activeWorkspaceId: ws.id,
        status: status ?? s.status,
        error: status ? null : s.error,
        // Avoid a restore pass duplicating the just-created session/workspace.
        bootstrapped: status?.state === "running" ? true : s.bootstrapped,
      }));
    },

    splitSession: async (target, dir, cli, mode, initialPrompt, account) => {
      if (!isRunning()) return;
      const ws = get().workspaces.find((w) => w.id === get().sessionMeta[target]?.workspaceId);
      const grp = ws && findGroupOf(ws, target);
      if (!ws || !grp || !grp.root) return;
      if (leavesList(grp.root).length >= MAX_GROUP_PANES) return;
      const name = uniqueName(cli);
      const claudeId = claudeIdFor(cli);
      // Route to the workspace's container, not `ws.id` — they differ for a
      // restored workspace (fresh `ws.id`, original key kept on the workspace).
      // Splitting must land the new pane in the same container as its siblings.
      const containerKey = ws.containerKey;
      await ipc.createSession(
        name,
        cli,
        mode,
        aliasFor(cli, get().sessionCounter),
        undefined,
        claudeId,
        account,
        containerKey,
      );
      await registry.spawnPane(name, containerKey);
      prefillPrompt(name, initialPrompt);
      registerMeta(name, cli, mode, ws.id, grp.id, containerKey, claudeId);

      set((s) => ({
        workspaces: updateWs(s.workspaces, ws.id, (w) =>
          updateGroup(w, grp.id, (g) => ({
            ...g,
            root: g.root
              ? replaceLeaf(g.root, target, (lf) => ({
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
        ),
      }));
    },

    // Close one session. tmux is killed FIRST, then the pane is detached/disposed
    // (see CLAUDE.md / TEST_SCENARIOS S3/S5/S7/S8) so no resize/write can race a
    // dying pane.
    closeSession: async (name) => {
      const meta = get().sessionMeta[name];
      await destroySessionRecord(name, meta?.containerKey);

      if (!meta) return;
      const ws = get().workspaces.find((w) => w.id === meta.workspaceId);
      const grp = ws && findGroupOf(ws, name);
      if (!ws || !grp) return;
      const nextRoot = grp.root ? removeLeaf(grp.root, name) : null;

      // Group still has panes → just drop the leaf and refocus within the group.
      if (nextRoot) {
        set((s) => ({
          workspaces: updateWs(s.workspaces, ws.id, (w) =>
            updateGroup(w, grp.id, (g) => ({
              ...g,
              root: nextRoot,
              focused: g.focused === name ? firstLeaf(nextRoot) : g.focused,
            })),
          ),
        }));
        return;
      }

      // Group is now empty. Last group in the workspace → close the tab (preserves
      // the ⌘W close-tab contract). Otherwise drop just this group and fall back to
      // a sibling if it was active.
      if (ws.groups.length <= 1) {
        const utilityShell = get().utilityShells[ws.containerKey];
        if (utilityShell && utilityShell !== name) {
          await destroySessionRecord(utilityShell, ws.containerKey);
        }
        removeWorkspace(get, set, ws.id);
        return;
      }
      // Emptied group falls to a sibling — clear focus mode / drag if it was the
      // active one so they don't carry over.
      if (ws.activeGroupId === grp.id) resetGridOverlays();
      set((s) => ({
        workspaces: updateWs(s.workspaces, ws.id, (w) => {
          const groups = w.groups.filter((g) => g.id !== grp.id);
          return {
            ...w,
            groups,
            activeGroupId: w.activeGroupId === grp.id ? groups[0].id : w.activeGroupId,
          };
        }),
      }));
    },

    closeWorkspace: async (id) => {
      const ws = get().workspaces.find((w) => w.id === id);
      if (!ws) {
        removeWorkspace(get, set, id);
        return;
      }
      const utilityShell = get().utilityShells[ws.containerKey];
      const sessions = [
        ...new Set([...workspaceLeaves(ws), ...(utilityShell ? [utilityShell] : [])]),
      ];
      for (const session of sessions) {
        await destroySessionRecord(
          session,
          get().sessionMeta[session]?.containerKey ?? ws.containerKey,
        );
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
      // If this jumps to a DIFFERENT group/workspace (e.g. the palette "go to
      // session", a sidebar session click), drop focus mode / any in-flight drag
      // so they don't bleed into the grid we land on. A same-group focus (⌘1-9,
      // a MiniPane click while maximized) must NOT exit focus mode — that would
      // break click-to-swap in the focus strip — so the reset is conditional.
      const cur = get();
      const curWs = cur.workspaces.find((w) => w.id === cur.activeWorkspaceId);
      const crossing =
        cur.activeWorkspaceId !== meta.workspaceId || curWs?.activeGroupId !== meta.groupId;
      if (crossing) resetGridOverlays();
      set((s) => ({
        activeWorkspaceId: meta.workspaceId,
        workspaces: updateWs(s.workspaces, meta.workspaceId, (w) => ({
          ...updateGroup(w, meta.groupId, (g) => ({ ...g, focused: name })),
          activeGroupId: meta.groupId,
        })),
      }));
      registry.focus(name);
      rememberLastSession(name);
    },

    switchWorkspace: (id) => {
      if (get().activeWorkspaceId === id) return;
      // Switching tabs leaves any open session-detail view (same contract as
      // setView) — otherwise the sidebar tab click is a silent no-op behind it.
      // Also drop transient pane-grid UI state (focus mode / in-flight drag) so
      // it can't bleed into the tab we're switching to — those are scoped to the
      // group you set them in, not the workspace globally.
      resetGridOverlays();
      set({ activeWorkspaceId: id, detailSession: null });
      const ws = get().workspaces.find((w) => w.id === id);
      const focused = ws && activeGroup(ws)?.focused;
      if (focused) rememberLastSession(focused);
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
      // UI rename the user just made. Target the session's per-workspace container.
      if (changed) {
        const workspace = get().sessionMeta[name]?.containerKey;
        void ipc.renameSession(name, next, workspace).catch((e) => {
          console.warn(`rename_session(${name}) failed:`, e);
        });
      }
    },

    commitRatio: (wsId, nodeId, ratio) => {
      set((s) => ({
        workspaces: updateWs(s.workspaces, wsId, (w) =>
          updateGroup(w, w.activeGroupId, (g) => ({
            ...g,
            root: g.root ? setRatio(g.root, nodeId, ratio) : g.root,
          })),
        ),
      }));
    },

    swapPanes: (wsId, a, b) => {
      if (a === b) return;
      set((s) => ({
        workspaces: updateWs(s.workspaces, wsId, (w) =>
          updateGroup(w, w.activeGroupId, (g) => ({
            ...g,
            root: g.root ? swapLeaves(g.root, a, b) : g.root,
          })),
        ),
      }));
    },

    movePane: (wsId, session, target, dir, before) => {
      if (session === target) return;
      set((s) => ({
        workspaces: updateWs(s.workspaces, wsId, (w) =>
          updateGroup(w, w.activeGroupId, (g) => ({
            ...g,
            root: g.root ? moveLeaf(g.root, session, target, dir, before) : g.root,
            // Keep the moved pane focused so the user's dragged target stays active.
            focused: session,
          })),
        ),
      }));
    },

    addGroup: (wsId) => {
      // New empty group becomes active — clear focus mode / drag so they don't
      // re-engage once a 2nd pane lands in it.
      resetGridOverlays();
      const group = makeGroup();
      set((s) => ({
        workspaces: updateWs(s.workspaces, wsId, (w) => ({
          ...w,
          groups: [...w.groups, group],
          activeGroupId: group.id,
        })),
      }));
      return group.id;
    },

    // Kill every session in the group (tmux first, then detach — matches
    // closeSession's order), drop the group, and fall back to a sibling. Closing
    // the workspace's last group closes the tab.
    closeGroup: async (wsId, groupId) => {
      const ws = get().workspaces.find((w) => w.id === wsId);
      const grp = ws?.groups.find((g) => g.id === groupId);
      if (!ws || !grp) return;
      for (const session of leavesList(grp.root)) {
        await destroySessionRecord(session, get().sessionMeta[session]?.containerKey);
      }
      if (ws.groups.length <= 1) {
        const utilityShell = get().utilityShells[ws.containerKey];
        if (utilityShell) await destroySessionRecord(utilityShell, ws.containerKey);
        removeWorkspace(get, set, wsId);
        return;
      }
      // Closing the active group falls to a sibling — clear focus mode / drag so
      // they don't carry over into it.
      if (get().workspaces.find((w) => w.id === wsId)?.activeGroupId === groupId) {
        resetGridOverlays();
      }
      set((s) => ({
        workspaces: updateWs(s.workspaces, wsId, (w) => {
          const groups = w.groups.filter((g) => g.id !== groupId);
          return {
            ...w,
            groups,
            activeGroupId: w.activeGroupId === groupId ? groups[0].id : w.activeGroupId,
          };
        }),
      }));
    },

    renameGroup: (wsId, groupId, name) => {
      const next = name.trim();
      if (!next) return;
      set((s) => ({
        workspaces: updateWs(s.workspaces, wsId, (w) =>
          updateGroup(w, groupId, (g) => ({ ...g, name: next })),
        ),
      }));
    },

    setGroupColor: (wsId, groupId, color) => {
      set((s) => ({
        workspaces: updateWs(s.workspaces, wsId, (w) =>
          updateGroup(w, groupId, (g) => ({ ...g, color })),
        ),
      }));
    },

    setActiveGroup: (wsId, groupId) => {
      // Focus mode + any in-flight drag are scoped to the group they were set
      // in; clear them so switching groups doesn't carry a maximized pane (or a
      // stuck drop overlay) into the group we're switching to.
      resetGridOverlays();
      set((s) => ({
        workspaces: updateWs(s.workspaces, wsId, (w) => ({ ...w, activeGroupId: groupId })),
      }));
      // Restore terminal focus to whatever pane the group last had active. An
      // empty group has none → blur the previous group's (now off-view) pane so
      // keystrokes don't leak into a hidden terminal.
      const ws = get().workspaces.find((w) => w.id === wsId);
      const focused = ws?.groups.find((g) => g.id === groupId)?.focused;
      if (focused) registry.focus(focused);
      else (document.activeElement as HTMLElement | null)?.blur();
    },

    addPaneToGroup: async (wsId, groupId, cli, mode, initialPrompt, account) => {
      if (!isRunning()) return;
      const ws = get().workspaces.find((w) => w.id === wsId);
      const grp = ws?.groups.find((g) => g.id === groupId);
      if (!ws || !grp) return;
      if (leavesList(grp.root).length >= MAX_GROUP_PANES) return;
      const name = uniqueName(cli);
      const claudeId = claudeIdFor(cli);
      // Route to the workspace's container (owned by the workspace), not `ws.id`
      // — they diverge for a restored workspace. The new pane joins the
      // workspace's container even when this group, or the whole workspace, is
      // currently empty.
      const containerKey = ws.containerKey;
      await ipc.createSession(
        name,
        cli,
        mode,
        aliasFor(cli, get().sessionCounter),
        undefined,
        claudeId,
        account,
        containerKey,
      );
      await registry.spawnPane(name, containerKey);
      prefillPrompt(name, initialPrompt);
      registerMeta(name, cli, mode, ws.id, grp.id, containerKey, claudeId);
      set((s) => ({
        workspaces: updateWs(s.workspaces, wsId, (w) =>
          updateGroup(w, groupId, (g) => ({
            ...g,
            // Empty group (the common case — this is the empty-group CTA) → seed
            // the single first leaf, no split. The non-empty branch is a
            // defensive row-split fallback; if a directional add into a populated
            // group is ever needed, route through splitSession (carries dir).
            root: g.root
              ? replaceLeaf(g.root, firstLeaf(g.root), (lf) => ({
                  kind: "split",
                  id: nid(),
                  dir: "row",
                  ratio: 0.5,
                  a: lf,
                  b: leafNode(name),
                }))
              : leafNode(name),
            focused: name,
          })),
        ),
      }));
    },

    loadConfig: async () => {
      try {
        const config = await ipc.getConfig();
        set({ config });
        registry.setFontSize(config.terminalFontSize);
        applyDensity(config.density);
        if (config.companion) {
          const { useCompanionPrefs } = await import("./overlay");
          useCompanionPrefs.getState().hydrate(config.companion);
        }
      } catch (e) {
        console.warn("get_config failed", e);
      }
    },

    updateConfig: async (patch) => {
      const prev = get().config;
      if (!prev) return;
      const next = { ...prev, ...patch };
      set({ config: next }); // optimistic
      registry.setFontSize(next.terminalFontSize); // apply to live panes immediately
      applyDensity(next.density);
      try {
        // Backend echoes the stored object back; trust it as the source of truth.
        set({ config: await ipc.setConfig(next) });
      } catch (e) {
        console.warn("set_config failed; reverting", e);
        set({ config: prev });
        registry.setFontSize(prev.terminalFontSize);
        applyDensity(prev.density);
      }
    },

    loadWorkspaceInfo: async () => {
      try {
        const ws = get().workspaces.find((w) => w.id === get().activeWorkspaceId);
        set({ workspaceInfo: await ipc.workspaceInfo(ws?.containerKey) });
      } catch (e) {
        console.warn("workspace_info failed", e);
      }
    },

    pickWorkspaceDir: async () => {
      let path: string | null = null;
      try {
        path = await ipc.pickDirectory();
      } catch (e) {
        console.warn("pick_directory failed", e);
        return false;
      }
      if (!path) return false;
      await get().selectWorkspaceDir(path);
      return true;
    },

    selectWorkspaceDir: async (path) => {
      try {
        // Backend validates the dir + bumps the MRU; echoes the full settings.
        set({ config: await ipc.setWorkspaceDir(path) });
        await get().loadWorkspaceInfo();
      } catch (e) {
        set({ error: `set workspace dir failed: ${e}` });
      }
    },

    recreateRuntime: async () => {
      try {
        const ws = get().workspaces.find((w) => w.id === get().activeWorkspaceId);
        if (!ws?.containerKey) return;
        get().setStatus(await ipc.recreateRuntime(ws.containerKey));
        await get().loadWorkspaceInfo();
      } catch (e) {
        set({ error: `recreate runtime failed: ${e}` });
      }
    },

    // ── Saved workspaces (Welcome launcher) ─────────────────────────────────
    // All mutations route through updateConfig (optimistic + reverts on failure)
    // — a saved workspace lives in settings.json alongside the other prefs, so
    // there's no separate command to wire.
    saveWorkspace: async (name, dir) => {
      const id = `sw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const entry: SavedWorkspace = {
        id,
        name: name.trim() || "Untitled workspace",
        dir,
        pinned: false,
        lastOpened: null,
      };
      const list = get().config?.savedWorkspaces ?? [];
      await get().updateConfig({ savedWorkspaces: [...list, entry] });
      return id;
    },
    removeSavedWorkspace: async (id) => {
      const list = get().config?.savedWorkspaces ?? [];
      await get().updateConfig({ savedWorkspaces: list.filter((w) => w.id !== id) });
    },
    toggleWorkspacePin: async (id) => {
      const list = get().config?.savedWorkspaces ?? [];
      await get().updateConfig({
        savedWorkspaces: list.map((w) => (w.id === id ? { ...w, pinned: !w.pinned } : w)),
      });
    },
    // Touch lastOpened, then point the /workspace mount at this workspace's dir
    // (selectWorkspaceDir bumps recents + workspace_dir; a changed mount surfaces
    // the existing "restart runtime to apply" affordance). The caller opens the
    // spawn launcher afterwards to start the first agent.
    openSavedWorkspace: async (id) => {
      const ws = (get().config?.savedWorkspaces ?? []).find((w) => w.id === id);
      if (!ws) return;
      const list = (get().config?.savedWorkspaces ?? []).map((w) =>
        w.id === id ? { ...w, lastOpened: Date.now() } : w,
      );
      await get().updateConfig({ savedWorkspaces: list });
      await get().selectWorkspaceDir(ws.dir);
    },

    loadAccountProfiles: async () => {
      try {
        set({ accountProfiles: await ipc.listAccountProfiles() });
      } catch (e) {
        console.warn("list_account_profiles failed", e);
      }
    },

    // Add throws the backend's validation message (a string) so the dialog can
    // surface it inline; on success the returned list (with presence) replaces ours.
    addAccountProfile: async (agent, label, varName, source) => {
      const list = await ipc.addAccountProfile(agent, label, varName, source);
      set({ accountProfiles: list });
    },

    removeAccountProfile: async (id) => {
      try {
        set({ accountProfiles: await ipc.removeAccountProfile(id) });
      } catch (e) {
        set({ error: `remove account failed: ${e}` });
      }
    },

    // ── Phase-0 completion contract load actions ───────────────────────────
    // Backend is a stub until the BE track lands, so these resolve to empty/
    // null; they exist now so the parallel fleet's screens can wire them.
    loadPendingPrompts: async () => {
      try {
        set({ pendingPrompts: await ipc.pendingPrompts() });
      } catch (e) {
        console.warn("pending_prompts failed", e);
      }
    },
    loadActivityHistory: async (session) => {
      try {
        set({ activityHistory: await ipc.sessionActivityHistory(session) });
      } catch (e) {
        console.warn("session_activity_history failed", e);
      }
    },
    loadCodexUsage: async () => {
      try {
        set({ codexUsage: await ipc.codexUsage() });
      } catch (e) {
        console.warn("codex_usage failed", e);
      }
    },
    loadCodexSessions: async () => {
      try {
        set({ codexSessions: await ipc.codexSessions() });
      } catch (e) {
        console.warn("codex_sessions failed", e);
      }
    },
    loadCodexRateLimits: async () => {
      try {
        set({ codexRateLimits: await ipc.codexRateLimits() });
      } catch (e) {
        console.warn("codex_rate_limits failed", e);
      }
    },
    loadGithubStatus: async () => {
      try {
        set({ githubStatus: await ipc.githubStatus() });
      } catch (e) {
        console.warn("github_status failed", e);
      }
    },
    loadGithubRepos: async () => {
      try {
        set({ githubRepos: await ipc.githubRepos() });
      } catch (e) {
        console.warn("github_repos failed", e);
      }
    },
    loadUpdateStatus: async () => {
      try {
        set({ updateStatus: await ipc.checkUpdate() });
      } catch (e) {
        console.warn("check_update failed", e);
      }
    },
  };
});

type Get = () => CodeHubState;
type Set = (partial: Partial<CodeHubState> | ((s: CodeHubState) => Partial<CodeHubState>)) => void;

// Last-focused tmux session name, persisted to localStorage so "Reopen last
// workspace" can re-select it after the next launch's session adoption. We key
// off the session NAME (stable across restarts — it's the tmux session id) and
// not the workspace id (regenerated every launch). Best-effort; a storage
// failure (private mode, quota) must never break focusing.
const LAST_SESSION_KEY = "codehub:lastActiveSession";
function rememberLastSession(name: string) {
  try {
    localStorage.setItem(LAST_SESSION_KEY, name);
  } catch {
    // ignore — persistence is a nicety, not a requirement
  }
}
function recallLastSession(): string | null {
  try {
    return localStorage.getItem(LAST_SESSION_KEY);
  } catch {
    return null;
  }
}

// Reflect the density preference onto the document root so the structural CSS
// (panes.css `[data-density="compact"]` overrides) can tighten the chrome.
// "comfortable" clears the attribute (the default styling).
function applyDensity(density: string) {
  if (typeof document === "undefined") return;
  if (density === "compact") document.documentElement.dataset.density = "compact";
  else delete document.documentElement.dataset.density;
}

function removeWorkspace(get: Get, set: Set, id: string) {
  const list = get().workspaces;
  const idx = list.findIndex((w) => w.id === id);
  if (idx === -1) return;
  const ws = list[idx];
  const next = list.filter((w) => w.id !== id);
  const wasActive = get().activeWorkspaceId === id;
  const nextActive = wasActive
    ? (next[idx]?.id ?? next[idx - 1]?.id ?? null)
    : get().activeWorkspaceId;
  // Closing the active tab falls to a sibling — clear focus mode / drag so they
  // don't carry over into it.
  if (wasActive) resetGridOverlays();
  set((s) => {
    const utilityShells = { ...s.utilityShells };
    delete utilityShells[ws.containerKey];
    return { workspaces: next, activeWorkspaceId: nextActive, utilityShells };
  });
}

async function bootstrap(
  get: Get,
  set: Set,
  registerMeta: (
    name: string,
    cli: Cli,
    mode: Mode,
    workspaceId: string,
    groupId: string,
    containerKey: string,
    claudeId?: string,
  ) => void,
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
  // Tier-2/Tier-3: workspace mount reconciliation + account profiles (label-only,
  // with live host-env presence). Independent best-effort reads.
  void get().loadWorkspaceInfo();
  void get().loadAccountProfiles();

  // Startup behaviors are persisted prefs; the config load races the lifecycle
  // event that triggered us, so ensure it's resolved before reading the flags.
  if (!get().config) await get().loadConfig();
  const cfg = get().config;
  // "Restore sessions on launch" (default on): adopt the tmux sessions that
  // survived the last quit. When off we leave them running in the container
  // untouched (non-destructive) but start the Hub clean.
  if (cfg && !cfg.restoreSessionsOnLaunch) return;

  try {
    const sessions = await ipc.listSessions();
    // Group adopted sessions by the workspace they belong to. Every session has
    // a workspace key (from the container's `codehub.workspace` label); sessions
    // sharing a key reconstruct INTO ONE workspace tab — that re-creates the
    // workspace the container represents, and ties every pane to the right
    // container via `containerKey`.
    const byWorkspace = new Map<string, SessionInfo[]>();
    for (const s of sessions) {
      const key = s.workspace;
      const members = byWorkspace.get(key) ?? [];
      members.push(s);
      byWorkspace.set(key, members);
    }

    for (const members of byWorkspace.values()) {
      const containerKey = members[0].workspace;
      for (const s of members) await registry.spawnPane(s.name, containerKey);
      // Shell sessions restored from a workspace container map back to the
      // design's docked Shell panel. Agent sessions remain grid leaves.
      const utilityShell = members.find((s) => s.name.startsWith("shell"));
      const gridMembers = members.filter((s) => !s.name.startsWith("shell"));
      // Build a default split tree: the saved layout (ratios/dirs) isn't
      // persisted, so stack the members alternating row/col at even ratios.
      const root =
        gridMembers.length > 0
          ? gridMembers.slice(1).reduce<LayoutNode>(
              (acc, s, i) => ({
                kind: "split",
                id: nid(),
                dir: i % 2 === 0 ? "row" : "col",
                ratio: 0.5,
                a: acc,
                b: leafNode(s.name),
              }),
              leafNode(gridMembers[0].name),
            )
          : null;
      const plate = get().plateCounter + 1;
      const group = makeGroup("Group 1", root, gridMembers[0]?.name ?? null);
      const ws: Workspace = {
        id: `ws-${plate}-${Date.now().toString(36)}`,
        plate,
        groups: [group],
        activeGroupId: group.id,
        // Restored: keep the ORIGINAL container key (from the label) so splits +
        // later panes rejoin this workspace's container — surviving even after
        // every pane is closed.
        containerKey,
      };
      set((st) => ({
        plateCounter: plate,
        sessionCounter: st.sessionCounter + members.length,
        workspaces: [...st.workspaces, ws],
        activeWorkspaceId: st.activeWorkspaceId ?? ws.id,
        utilityShells: utilityShell
          ? { ...st.utilityShells, [containerKey]: utilityShell.name }
          : st.utilityShells,
      }));
      // Mode of a pre-existing tmux session is unknown; show it as Standard.
      for (const s of members) {
        const cli =
          (["claude", "codex", "antigravity", "shell"] as Cli[]).find((c) =>
            s.name.startsWith(c),
          ) ?? "claude";
        registerMeta(s.name, cli, "standard", ws.id, group.id, containerKey);
      }
    }
    // "Reopen last workspace" (default on): re-select the tab whose session was
    // focused at quit, if it's among the adopted ones. Otherwise the first
    // adopted workspace stays active (set in the loop above).
    if (!cfg || cfg.reopenLastWorkspace) {
      const last = recallLastSession();
      const wsId = last ? get().sessionMeta[last]?.workspaceId : undefined;
      if (wsId) {
        set({ activeWorkspaceId: wsId });
        registry.focus(last as string);
      }
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
  const { setStatus, setError, loadConfig } = useStore.getState();
  // UI prefs don't depend on the container, so load them eagerly at app start.
  void loadConfig();
  void onLifecycle(setStatus);
  void onLifecycleError(setError);
  // No initial containerStatus() call — there's no default container to query.
  // The backend emits a synthetic codehub://lifecycle "running" event on startup
  // when the Docker daemon is reachable, which triggers bootstrap via setStatus.
}

// Guard for close actions (⌘W, pane + sidebar close buttons). Returns true when
// it's OK to proceed: either confirmation is off, the agent is idle, or the user
// confirmed. Honors the persisted `confirmCloseRunningAgent` preference and the
// live working/idle signal. Kept as a free function (not a store action) because
// it needs the synchronous window.confirm at the call site.
export function confirmCloseRunningSession(name: string): boolean {
  const s = useStore.getState();
  const needsConfirm = s.config?.confirmCloseRunningAgent ?? true;
  const working = s.sessionActivity[name]?.state === "working";
  if (!needsConfirm || !working) return true;
  const alias = s.sessionMeta[name]?.alias ?? name;
  return window.confirm(`${alias} is still working. Close it anyway? Scrollback is kept.`);
}

// Group-close guard: a SINGLE confirmation covering every working pane in the
// group (closing a group can kill many sessions at once — prompting per-session
// would stack N dialogs). Returns true to proceed. Same preference + live
// working/idle signal as confirmCloseRunningSession.
export function confirmCloseGroup(sessions: string[], groupName: string): boolean {
  const s = useStore.getState();
  const needsConfirm = s.config?.confirmCloseRunningAgent ?? true;
  const working = sessions.filter((n) => s.sessionActivity[n]?.state === "working").length;
  if (!needsConfirm || working === 0) return true;
  const plural = working === 1 ? "agent is" : "agents are";
  return window.confirm(
    `${groupName}: ${working} ${plural} still working. Close the group? Scrollback is kept.`,
  );
}

// Convenience selectors.
export function activeWorkspace(s: CodeHubState): Workspace | undefined {
  return s.workspaces.find((w) => w.id === s.activeWorkspaceId);
}

export { leavesList, leavesOf };
export type { LayoutNode };
