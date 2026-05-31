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
  DockerRuntimeDetection,
  GitStatus,
  GithubRepo,
  GithubStatus,
  KeyStatus,
  Mode,
  ModelProvider,
  PendingPrompt,
  RuntimeHealth,
  SavedWorkspace,
  SessionActivity,
  SessionInfo,
  UpdateStatus,
  WorkspaceContainer,
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
  buildGridTree,
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
  workspaceTitle,
} from "./tree";

// One background GitHub clone job (New Workspace wizard → post-create clone).
export interface RepoCloneJob {
  repo: string; // nameWithOwner, e.g. "owner/repo"
  status: "cloning" | "done" | "error";
  error?: string;
}

// Top-level view, switched from the sidebar nav. "hub" is the terminal grid;
// the rest are full-pane screens. Resume is no longer a view — it's a docked
// drawer over the hub (useOverlay.resume). Integrations is no longer a view
// either — it's a Settings pane (settingsSection === "integrations"), reached by
// deep-linking into Settings.
export type HubView = "hub" | "dashboard" | "settings";

// A pane being CONFIGURED inline (design "New agent · configuring"): a grid leaf
// that holds a draft config but no tmux session yet. It occupies a real slot in
// the split tree (leaf `session` = a `__spawn-N` placeholder id); the Grid renders
// the config form for it instead of an xterm. `commitSpawn` creates the session
// and swaps the placeholder leaf for the live one; `cancelSpawn` removes it.
export interface SpawnDraft {
  id: string;
  workspaceId: string;
  groupId: string;
  cli: Cli;
  mode: Mode;
  account?: string;
  // Working directory (a path under /workspace) the agent starts in.
  cwd?: string;
  // First-create mount dir, only when this draft is the first pane of a NEW
  // workspace (its container doesn't exist until commit).
  workspaceDir?: string;
  // Resume target (a prior agent session id). Set when this pane was opened from
  // the Resume drawer: Claude resumes its transcript via `--resume`, other CLIs
  // honestly start fresh (no backend resume path). Commit threads it to the
  // backend and pins the Claude id so the Hub reads the resumed transcript.
  resume?: string;
}

let spawnCounter = 0;
const nextSpawnId = (): string => {
  spawnCounter += 1;
  return `__spawn-${spawnCounter.toString(36)}`;
};

// A grid leaf whose `session` is a configuring-pane placeholder (no tmux session
// behind it yet). Used to keep placeholders out of agent-session counts.
export function isSpawnPlaceholder(session: string): boolean {
  return session.startsWith("__spawn-");
}

interface CodeHubState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  sessionMeta: Record<string, SessionMeta>;
  // Configuring panes (design "New agent · configuring"), keyed by placeholder
  // leaf id. Each is an in-grid spawn form awaiting "Spawn agent".
  spawnDrafts: Record<string, SpawnDraft>;
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
  // Live liveness of the active workspace's container (container_health): uptime
  // start, restart count, OOM flag. Polled alongside containerStats (same hook,
  // same active container) so the bottom-bar runtime dot + the Details panel read
  // one shared snapshot. Null while down / before first read.
  containerHealth: RuntimeHealth | null;
  // Rolling window of the most recent container_stats samples (newest last) for
  // the active container, maintained by setContainerStats. Shared so the bottom
  // status bar's inline sparklines and the Details dock's gauges draw the same
  // real series instead of each keeping its own ring. Cleared on container switch
  // (clearStatsHistory) and whenever the runtime goes down (setContainerStats(null)).
  statsHistory: ContainerStats[];
  // Live /workspace git status (branch + ahead/behind + uncommitted count),
  // polled app-wide while the runtime is up (useGitStatusPoll). Shared by the
  // activity rail's Changes list and the Hub meta strip so they don't each poll
  // container_git_status independently. Null while down / before first read.
  gitStatus: GitStatus | null;

  // Tier-1 reads, fetched once the runtime is reachable.
  // Presence/version metadata only — never secret values.
  dockerInfo: DockerInfo | null;
  dockerRuntime: DockerRuntimeDetection | null;
  keyStatus: Record<AgentCli, KeyStatus> | null;
  agentVersions: Record<AgentCli, AgentVersion> | null;
  workspaceContainers: WorkspaceContainer[] | null;

  // Persisted UI preferences (settings.json). Null until the first load resolves;
  // the Settings screen reads + writes it through updateConfig.
  config: AppSettings | null;

  // Tier-2 workspace picker: configured-vs-mounted /workspace + needs-recreate.
  // Null until first load. Tier-3 account profiles (label-only, with live
  // presence), loaded for the Settings + spawn dialog account picker.
  workspaceInfo: WorkspaceInfo | null;
  accountProfiles: AccountProfileStatus[];
  // Configured model providers with live token presence (Settings → Coding
  // Agents + spawn dialog). Loaded via `loadProviders`; mutation actions return
  // the fresh list. Separate from `config.providers` (which carries no presence).
  providers: ModelProvider[];

  // ── Phase-0 completion contract ──────────────────────
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
  // Background GitHub repo clones started by the New Workspace wizard (the clone
  // runs after the workspace opens). Drives the clone progress banner.
  repoClones: RepoCloneJob[];
  // App update check (Settings → About).
  updateStatus: UpdateStatus | null;

  // Global loading overlay message. null = idle, string = busy with that label.
  busyMessage: string | null;

  // imperative bookkeeping (non-reactive counters)
  plateCounter: number;
  sessionCounter: number;
  bootstrapped: boolean;
  // True once the first restore attempt has SETTLED (succeeded, errored, was
  // skipped, or the daemon is known unreachable). Gates the empty-state: until
  // it flips we show a blank pane to avoid flashing the launcher mid-restore;
  // after it flips, "no active workspace" always resolves to Welcome/EmptyHero —
  // never a permanent blank. Decoupled from `workspaceContainers`/`dockerInfo`
  // being non-null because either can stay null forever if its IPC throws,
  // which previously trapped the Hub blank after closing the last tab.
  bootSettled: boolean;

  setBusy: (msg: string | null) => void;
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
  setContainerHealth: (h: RuntimeHealth | null) => void;
  // Drop the rolling stats window — called by the poll on container switch so two
  // containers' series never splice together.
  clearStatsHistory: () => void;
  // Re-read the per-workspace container fleet into `workspaceContainers`. Used by
  // the launcher after a lifecycle action (stop-idle / prune-stopped / card
  // remove) so the cards + counts reflect the change without a full reboot.
  refreshWorkspaceContainers: () => Promise<void>;
  // Per-container lifecycle op in flight, keyed by containerKey → the verb. Set
  // by start/stop/restartContainer while the docker call runs; the Welcome cards
  // and sidebar rows read it to show an inline spinner + disable their controls.
  // Cleared (and the fleet refreshed) when the op settles.
  containerBusy: Record<string, "starting" | "stopping" | "restarting">;
  // Container lifecycle, shared by the Welcome launcher card + the sidebar
  // workspace row so both show the same in-flight state. Each manages
  // `containerBusy` and refreshes the fleet after; callers confirm destructive
  // ops (stop/restart kill the container's sessions) BEFORE calling.
  startContainer: (key: string) => Promise<void>;
  stopContainer: (key: string) => Promise<void>;
  restartContainer: (key: string) => Promise<void>;
  setGitStatus: (g: GitStatus | null) => void;
  ensureDockedShell: () => Promise<string | null>;
  createExtraShell: () => Promise<string | null>;
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
    cwd?: string,
  ) => Promise<void>;
  closeSession: (name: string) => Promise<void>;
  closeWorkspace: (id: string) => Promise<void>;
  closeAllSessions: () => Promise<void>;
  // ── Inline configuring-pane spawn (design "New agent · configuring") ────────
  // Each begin* drops a placeholder leaf + draft into the grid (no session yet);
  // the Grid renders a config form for it. updateSpawnDraft edits the draft;
  // commitSpawn creates the session and swaps the placeholder leaf for the live
  // pane; cancelSpawn removes it (collapsing the split / closing an empty
  // group/workspace, like closeSession).
  beginSplitSpawn: (target: string, dir: SplitDir, cli?: Cli) => void;
  beginGroupSpawn: (wsId: string, groupId: string, cli?: Cli, resume?: string) => void;
  beginNewWorkspaceSpawn: (
    cli?: Cli,
    workspaceMeta?: { title?: string; dir?: string; savedWorkspaceId?: string },
    resume?: string,
  ) => void;
  // "New agent" from anywhere (command palette, Dashboard, empty-state hero,
  // Resume drawer): switch to the Hub and drop an inline configuring pane — into
  // the active group (rebalanced grid), a fresh group if it's full, or a new
  // workspace when none is open. `resume` pre-loads a prior session to continue.
  // The single front door so every "new agent" CTA opens the pane, never the
  // legacy modal.
  newAgent: (cli?: Cli, resume?: string) => void;
  updateSpawnDraft: (id: string, patch: Partial<SpawnDraft>) => void;
  commitSpawn: (id: string, initialPrompt?: string) => Promise<void>;
  cancelSpawn: (id: string) => void;
  // Resume a running per-workspace container into the Hub as a tab: adopt its
  // live tmux sessions (or open an empty tab bound to it when its agents have
  // exited). Focuses an already-open workspace instead of duplicating. Backs the
  // Workspaces inspector's "Open in Hub" — without it a running container that
  // launch-time restore didn't adopt (or whose tab was closed) is unreachable.
  openContainerWorkspace: (containerKey: string) => Promise<void>;
  focusSession: (name: string) => void;
  switchWorkspace: (id: string) => void;
  renameSession: (name: string, alias: string) => void;
  // Recolor a pane's header tint (a PANE_COLORS fill), or undefined to reset to
  // the agent accent. Persisted by session name across reloads.
  setSessionColor: (name: string, color?: string) => void;
  // Recolor a workspace tab (a PANE_COLORS fill), or undefined for the neutral
  // tab. Persisted by containerKey across reloads.
  setWorkspaceColor: (wsId: string, color?: string) => void;
  // Rename a workspace tab; also updates the saved-workspace entry when this tab
  // is a saved workspace, so the name persists.
  renameWorkspace: (wsId: string, title: string) => void;
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
    cwd?: string,
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
  saveWorkspace: (name: string, dir: string, additionalDirs?: string[]) => Promise<string>;
  removeSavedWorkspace: (id: string) => Promise<void>;
  toggleWorkspacePin: (id: string) => Promise<void>;
  openSavedWorkspace: (id: string) => Promise<void>;

  // Model providers (Settings → Coding Agents). `setProviders` replaces the
  // slice from a mutation's returned list.
  loadProviders: () => Promise<void>;
  setProviders: (list: ModelProvider[]) => void;

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
  renameAccountProfile: (id: string, label: string) => Promise<void>;
  setAccountProfileEnabled: (id: string, enabled: boolean) => Promise<void>;

  // Phase-0 completion contract load actions (best-effort, mirror the existing
  // load* pattern). Each catches its own failure so it can't block callers.
  loadPendingPrompts: () => Promise<void>;
  loadActivityHistory: (session?: string) => Promise<void>;
  loadCodexUsage: () => Promise<void>;
  loadCodexSessions: () => Promise<void>;
  loadCodexRateLimits: () => Promise<void>;
  loadGithubStatus: () => Promise<void>;
  loadGithubRepos: () => Promise<void>;
  // Clone a GitHub repo into an open workspace container, tracking progress in
  // `repoClones` (background; the wizard calls this after the workspace opens).
  cloneRepoIntoWorkspace: (
    workspace: string,
    nameWithOwner: string,
    target: string,
  ) => Promise<void>;
  dismissRepoClone: (repo: string) => void;
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
  // Opening / switching to a workspace leaves the launcher tab (it's shown in
  // the hub content slot, so a stale `launcher` would keep covering the grid).
  if (o.launcher) o.setLauncher(false);
}

// Display alias for a session, e.g. "honey-badger · Claude 1". The workspace
// label prefixes the per-workspace, per-CLI sequence number so a terminal reads
// which workspace it belongs to — in the UI pane head AND the tmux `#W` status
// bar (the alias is passed as the tmux window name at create time, so both read
// identically).
// Session label / pane title: just the agent + its per-workspace sequence
// ("Claude 1"). The workspace is already shown by the tab + sidebar header and the
// working dir by the pane footer / sidebar dir line, so it is NOT repeated here.
// `_workspace` stays on the signature for call-site compatibility (every spawn
// path passes the workspace title); the label simply omits it.
function aliasFor(_workspace: string, cli: Cli, num: number): string {
  return `${SPEC_BY_CLI[cli].alias} ${num}`;
}

// Next per-(workspace, cli) sequence number: existing sessions of that CLI in
// the workspace, +1. Numbering restarts per workspace instead of running global,
// and shells count separately from agents. Called before the new session's meta
// is added, so it excludes the one being created.
function nextSeq(meta: Record<string, SessionMeta>, workspaceId: string, cli: Cli): number {
  return (
    Object.values(meta).filter((m) => m.workspaceId === workspaceId && m.cli === cli).length + 1
  );
}

// Lossy, Docker-name-safe slug of a workspace label, mirroring the backend
// `sanitize_key` slug rules (lowercase, non-alphanumerics → single dash,
// trimmed, capped). Only the READABLE lead of the container key — uniqueness
// comes from the suffix `containerKeyFor` appends.
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

function dirBasename(dir?: string): string {
  return dir?.split("/").filter(Boolean).pop() ?? "";
}

// Per-workspace container ROUTING key. A SAVED workspace keys off its stable
// `savedWorkspaceId` so reopening lands in the SAME container instead of
// spawning a fresh one each time (and leaking the old one); the title slug is
// the readable lead, so the container reads as `codehub-ws-<name>-…`. An ad-hoc
// tab has no stable identity, so it gets a readable slug + a per-open random
// suffix. The backend `sanitize_key` appends a hash of the FULL key, so distinct
// keys never collide onto one container.
export function containerKeyFor(meta?: {
  title?: string;
  dir?: string;
  savedWorkspaceId?: string;
}): string {
  const lead = slugify(meta?.title ?? "") || slugify(dirBasename(meta?.dir));
  if (meta?.savedWorkspaceId) {
    return lead ? `${lead}-${meta.savedWorkspaceId}` : meta.savedWorkspaceId;
  }
  return `${lead || "workspace"}-${Date.now().toString(36)}`;
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
    alias: string,
    claudeId?: string,
    cwd?: string,
  ) => {
    const meta: SessionMeta = {
      cli,
      num: nextSeq(get().sessionMeta, workspaceId, cli),
      alias,
      mode,
      workspaceId,
      groupId,
      claudeId,
      containerKey,
      cwd,
      // Restore a persisted pane color (survives reload / session adoption).
      color: recallPaneColor(name),
    };
    set((s) => ({ sessionMeta: { ...s.sessionMeta, [name]: meta } }));
    // Pin the transcript id to the session name so a restart can recover it.
    if (claudeId) persistClaudeId(name, claudeId);
  };

  const destroySessionRecord = async (name: string, containerKey?: string) => {
    const meta = get().sessionMeta[name];
    try {
      await ipc.killSession(name, containerKey ?? meta?.containerKey);
    } catch (e) {
      console.warn(`kill_session(${name}) failed:`, e);
    }
    await registry.destroyPane(name);
    forgetClaudeId(name);
    forgetPaneColor(name);
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
    spawnDrafts: {},
    status: null,
    error: null,
    view: "hub",
    settingsSection: "general",
    sidebarCollapsed: false,
    detailSession: null,
    utilityShells: {},
    sessionActivity: {},
    containerStats: null,
    containerHealth: null,
    statsHistory: [],
    gitStatus: null,
    dockerInfo: null,
    dockerRuntime: null,
    keyStatus: null,
    workspaceContainers: null,
    containerBusy: {},
    agentVersions: null,
    config: null,
    workspaceInfo: null,
    accountProfiles: [],
    providers: [],
    // Phase-0 completion contract slices (empty/null until the fleet loads them).
    pendingPrompts: [],
    activityHistory: [],
    codexUsage: null,
    codexSessions: [],
    codexRateLimits: null,
    githubStatus: null,
    githubRepos: [],
    repoClones: [],
    updateStatus: null,
    busyMessage: null,
    plateCounter: 0,
    sessionCounter: 0,
    bootstrapped: false,
    bootSettled: false,

    setBusy: (msg) => set({ busyMessage: msg }),

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
      set({ busyMessage: "Starting runtime…" });
      try {
        get().setStatus(await ipc.containerStart(workspace));
      } catch (e) {
        set({ error: `start runtime failed: ${e}` });
      } finally {
        set({ busyMessage: null });
      }
    },
    stopRuntime: async () => {
      const ws = get().workspaces.find((w) => w.id === get().activeWorkspaceId);
      const workspace = ws?.containerKey;
      set({ busyMessage: "Stopping runtime…" });
      try {
        get().setStatus(await ipc.containerStop(workspace));
      } catch (e) {
        set({ error: `stop runtime failed: ${e}` });
      } finally {
        set({ busyMessage: null });
      }
    },
    restartRuntime: async () => {
      const ws = get().workspaces.find((w) => w.id === get().activeWorkspaceId);
      const workspace = ws?.containerKey;
      set({ busyMessage: "Restarting runtime…" });
      try {
        get().setStatus(await ipc.containerRestart(workspace));
      } catch (e) {
        set({ error: `restart runtime failed: ${e}` });
      } finally {
        set({ busyMessage: null });
      }
    },

    // Switching to a top-level view leaves any open session-detail view + the
    // launcher tab (a sidebar-nav switch is a deliberate context change).
    setView: (view) => {
      if (useOverlay.getState().launcher) useOverlay.getState().setLauncher(false);
      set({ view, detailSession: null });
    },

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

    setContainerStats: (containerStats) =>
      set((s) => ({
        containerStats,
        // Append to the rolling window (newest last, ~1 min at the 2s poll); a
        // null snapshot (runtime down) clears it so a restart starts fresh.
        statsHistory: containerStats ? [...s.statsHistory, containerStats].slice(-30) : [],
      })),

    setContainerHealth: (containerHealth) => set({ containerHealth }),

    clearStatsHistory: () => set({ statsHistory: [] }),

    refreshWorkspaceContainers: async () => {
      try {
        const workspaceContainers = await ipc.listWorkspaceContainers();
        set({ workspaceContainers });
      } catch {
        // best-effort — keep the last snapshot rather than blanking the launcher
      }
    },

    startContainer: async (key) => runContainerOp(get, set, key, "starting", ipc.containerStart),
    stopContainer: async (key) => runContainerOp(get, set, key, "stopping", ipc.containerStop),
    restartContainer: async (key) =>
      runContainerOp(get, set, key, "restarting", ipc.containerRestart),

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
        const alias = aliasFor(
          workspaceTitle(ws),
          "shell",
          nextSeq(get().sessionMeta, ws.id, "shell"),
        );
        await ipc.createSession(
          name,
          "shell",
          "standard",
          alias,
          undefined,
          undefined,
          undefined,
          ws.containerKey,
        );
        await registry.spawnPane(name, ws.containerKey);
        registerMeta(name, "shell", "standard", ws.id, ws.activeGroupId, ws.containerKey, alias);
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

    createExtraShell: async () => {
      if (!isRunning()) return null;
      const ws = get().workspaces.find((w) => w.id === get().activeWorkspaceId);
      if (!ws) return null;
      const name = uniqueName("shell");
      const alias = aliasFor(
        workspaceTitle(ws),
        "shell",
        nextSeq(get().sessionMeta, ws.id, "shell"),
      );
      await ipc.createSession(
        name,
        "shell",
        "standard",
        alias,
        undefined,
        undefined,
        undefined,
        ws.containerKey,
      );
      await registry.spawnPane(name, ws.containerKey);
      registerMeta(name, "shell", "standard", ws.id, ws.activeGroupId, ws.containerKey, alias);
      return name;
    },

    newPlate: async (cli, mode, resume, initialPrompt, account, workspaceMeta) => {
      // Reopening a saved workspace that is already open must not spawn a second
      // tab onto the same (now-stable) container — focus the existing tab instead.
      if (workspaceMeta?.savedWorkspaceId) {
        const open = get().workspaces.find(
          (w) => w.savedWorkspaceId === workspaceMeta.savedWorkspaceId,
        );
        if (open) {
          get().switchWorkspace(open.id);
          return;
        }
      }
      set({ busyMessage: "Starting session…" });
      try {
        const name = uniqueName(cli);
        const claudeId = claudeIdFor(cli, resume);
        // A resume carries its id via --resume; a fresh Claude session pins a new
        // one via --session-id (same value, so we can read its transcript back).
        const sessionId = resume ? undefined : claudeId;
        const plate = get().plateCounter + 1;
        // The UI tab id is unique per tab; the CONTAINER key is a stable, readable
        // identity (the saved-workspace id when present) so reopening reuses the
        // same container and the name reads as `codehub-ws-<workspace-name>-…`
        // instead of an opaque random id. Splits + later panes route by it.
        const wsId = `ws-${plate}-${Date.now().toString(36)}`;
        const containerKey = containerKeyFor(workspaceMeta);
        const label = workspaceMeta?.title?.trim() || `Workspace ${plate}`;
        const alias = aliasFor(label, cli, 1);
        await ipc.createSession(
          name,
          cli,
          mode,
          alias,
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
          title: recallWsTitle(containerKey) ?? workspaceMeta?.title,
          dir: workspaceMeta?.dir,
          savedWorkspaceId: workspaceMeta?.savedWorkspaceId,
          groups: [group],
          activeGroupId: group.id,
          color: recallWsColor(containerKey),
          containerKey,
        };
        registerMeta(name, cli, mode, ws.id, group.id, containerKey, alias, claudeId);
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
      } finally {
        set({ busyMessage: null });
      }
    },

    splitSession: async (target, dir, cli, mode, initialPrompt, account, cwd) => {
      if (!isRunning()) return;
      const ws = get().workspaces.find((w) => w.id === get().sessionMeta[target]?.workspaceId);
      const grp = ws && findGroupOf(ws, target);
      if (!ws || !grp || !grp.root) return;
      if (leavesList(grp.root).length >= MAX_GROUP_PANES) return;
      set({ busyMessage: "Starting session…" });
      try {
        const name = uniqueName(cli);
        const claudeId = claudeIdFor(cli);
        // Route to the workspace's container, not `ws.id` — they differ for a
        // restored workspace (fresh `ws.id`, original key kept on the workspace).
        // Splitting must land the new pane in the same container as its siblings.
        const containerKey = ws.containerKey;
        const alias = aliasFor(workspaceTitle(ws), cli, nextSeq(get().sessionMeta, ws.id, cli));
        await ipc.createSession(
          name,
          cli,
          mode,
          alias,
          undefined,
          claudeId,
          account,
          containerKey,
          undefined,
          cwd,
        );
        await registry.spawnPane(name, containerKey);
        prefillPrompt(name, initialPrompt);
        registerMeta(name, cli, mode, ws.id, grp.id, containerKey, alias, claudeId, cwd);

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
      } finally {
        set({ busyMessage: null });
      }
    },

    // Close one session. tmux is killed FIRST, then the pane is detached/disposed
    // (see CLAUDE.md / TEST_SCENARIOS S3/S5/S7/S8) so no resize/write can race a
    // dying pane.
    closeSession: async (name) => {
      set({ busyMessage: "Closing session…" });
      try {
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
      } finally {
        set({ busyMessage: null });
      }
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
        // Configuring panes have no tmux session to kill — removeWorkspace drops
        // their drafts.
      ].filter((s) => !isSpawnPlaceholder(s));
      for (const session of sessions) {
        await destroySessionRecord(
          session,
          get().sessionMeta[session]?.containerKey ?? ws.containerKey,
        );
      }
      removeWorkspace(get, set, id);
    },

    openContainerWorkspace: async (containerKey) => {
      // Already a Hub tab → just focus it (don't duplicate onto one container).
      const existing = get().workspaces.find((w) => w.containerKey === containerKey);
      if (existing) {
        get().switchWorkspace(existing.id);
        get().setView("hub");
        return;
      }
      set({ busyMessage: "Opening workspace…" });
      try {
        const members = (await ipc.listSessions().catch(() => [])).filter(
          (s) => s.workspace === containerKey,
        );
        resetGridOverlays();
        await adoptWorkspace(get, set, registerMeta, members, containerKey, true);
        get().setView("hub");
        const focused = members.find((s) => !s.name.startsWith("shell"))?.name;
        if (focused) registry.focus(focused);
      } finally {
        set({ busyMessage: null });
      }
    },

    // Stop-all (Settings danger zone). Kills every session in every workspace;
    // closeWorkspace already SIGTERMs each session and persists tmux scrollback.
    // Snapshot the ids first — closeWorkspace mutates the workspace list.
    closeAllSessions: async () => {
      for (const id of get().workspaces.map((w) => w.id)) {
        await get().closeWorkspace(id);
      }
    },

    // ── Inline configuring-pane spawn ──────────────────────────────────────
    beginSplitSpawn: (target, dir, cli) => {
      if (!isRunning()) return;
      // Resolve the workspace by LEAF membership, not sessionMeta: the focused
      // pane may itself be a configuring placeholder (`__spawn-N`) with no meta,
      // so a meta lookup would fail and splitting again would no-op.
      const ws = get().workspaces.find((w) =>
        w.groups.some((g) => leavesList(g.root).includes(target)),
      );
      const grp = ws && findGroupOf(ws, target);
      if (!ws || !grp || !grp.root) return;
      if (leavesList(grp.root).length >= MAX_GROUP_PANES) return;
      const id = nextSpawnId();
      const draft: SpawnDraft = {
        id,
        workspaceId: ws.id,
        groupId: grp.id,
        cli: cli ?? ((get().config?.defaultAgent ?? "claude") as Cli),
        mode: "standard",
        cwd: "/workspace",
      };
      set((s) => ({
        spawnDrafts: { ...s.spawnDrafts, [id]: draft },
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
                  b: leafNode(id),
                }))
              : leafNode(id),
            focused: id,
          })),
        ),
      }));
    },

    beginGroupSpawn: (wsId, groupId, cli, resume) => {
      if (!isRunning()) return;
      const ws = get().workspaces.find((w) => w.id === wsId);
      const grp = ws?.groups.find((g) => g.id === groupId);
      if (!ws || !grp) return;
      if (leavesList(grp.root).length >= MAX_GROUP_PANES) return;
      const id = nextSpawnId();
      const draft: SpawnDraft = {
        id,
        workspaceId: ws.id,
        groupId,
        cli: cli ?? ((get().config?.defaultAgent ?? "claude") as Cli),
        mode: "standard",
        cwd: "/workspace",
        resume,
      };
      set((s) => ({
        spawnDrafts: { ...s.spawnDrafts, [id]: draft },
        workspaces: updateWs(s.workspaces, wsId, (w) =>
          updateGroup(w, groupId, (g) => ({
            ...g,
            // Auto-placement rebalances the whole group into an EVEN ≤3-col grid
            // (append the new pane, rebuild) — no lopsided nested halves. Manual
            // splits (beginSplitSpawn) stay freeform.
            root: buildGridTree([...leavesList(g.root), id]),
            focused: id,
          })),
        ),
      }));
    },

    beginNewWorkspaceSpawn: (cli, workspaceMeta, resume) => {
      // Already-open saved workspace → focus it (same guard as newPlate).
      if (workspaceMeta?.savedWorkspaceId) {
        const open = get().workspaces.find(
          (w) => w.savedWorkspaceId === workspaceMeta.savedWorkspaceId,
        );
        if (open) {
          get().switchWorkspace(open.id);
          return;
        }
      }
      const plate = get().plateCounter + 1;
      const wsId = `ws-${plate}-${Date.now().toString(36)}`;
      const containerKey = containerKeyFor(workspaceMeta);
      const id = nextSpawnId();
      const group = makeGroup("Group 1", leafNode(id), id);
      const ws: Workspace = {
        id: wsId,
        plate,
        title: recallWsTitle(containerKey) ?? workspaceMeta?.title,
        dir: workspaceMeta?.dir,
        savedWorkspaceId: workspaceMeta?.savedWorkspaceId,
        groups: [group],
        activeGroupId: group.id,
        color: recallWsColor(containerKey),
        containerKey,
      };
      const draft: SpawnDraft = {
        id,
        workspaceId: wsId,
        groupId: group.id,
        cli: cli ?? ((get().config?.defaultAgent ?? "claude") as Cli),
        mode: "standard",
        cwd: "/workspace",
        workspaceDir: workspaceMeta?.dir,
        resume,
      };
      resetGridOverlays();
      set((s) => ({
        plateCounter: plate,
        workspaces: [...s.workspaces, ws],
        activeWorkspaceId: wsId,
        spawnDrafts: { ...s.spawnDrafts, [id]: draft },
      }));
    },

    newAgent: (cli, resume) => {
      // setView("hub") also clears the launcher overlay so the configuring pane
      // is actually visible (the launcher tab renders over the grid).
      get().setView("hub");
      const s = get();
      const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
      if (!ws) {
        s.beginNewWorkspaceSpawn(cli, undefined, resume);
        return;
      }
      const grp = activeGroup(ws);
      if (leavesList(grp.root).length >= MAX_GROUP_PANES) {
        const gid = s.addGroup(ws.id);
        s.beginGroupSpawn(ws.id, gid, cli, resume);
      } else {
        s.beginGroupSpawn(ws.id, ws.activeGroupId, cli, resume);
      }
    },

    updateSpawnDraft: (id, patch) => {
      set((s) => {
        const d = s.spawnDrafts[id];
        if (!d) return {};
        return { spawnDrafts: { ...s.spawnDrafts, [id]: { ...d, ...patch } } };
      });
    },

    commitSpawn: async (id, initialPrompt) => {
      const draft = get().spawnDrafts[id];
      if (!draft) return;
      const ws = get().workspaces.find((w) => w.id === draft.workspaceId);
      if (!ws) {
        get().cancelSpawn(id);
        return;
      }
      set({ busyMessage: "Starting session…" });
      try {
        const name = uniqueName(draft.cli);
        const claudeId = claudeIdFor(draft.cli, draft.resume);
        // A resume carries its id via --resume; a fresh Claude session pins a new
        // one via --session-id (same value, so we can read its transcript back).
        const sessionId = draft.resume ? undefined : claudeId;
        const alias = aliasFor(
          workspaceTitle(ws),
          draft.cli,
          nextSeq(get().sessionMeta, ws.id, draft.cli),
        );
        await ipc.createSession(
          name,
          draft.cli,
          draft.mode,
          alias,
          draft.resume,
          sessionId,
          draft.account,
          ws.containerKey,
          draft.workspaceDir,
          draft.cwd,
        );
        await registry.spawnPane(name, ws.containerKey);
        prefillPrompt(name, initialPrompt);
        registerMeta(
          name,
          draft.cli,
          draft.mode,
          ws.id,
          draft.groupId,
          ws.containerKey,
          alias,
          claudeId,
          draft.cwd,
        );
        // A NEW-workspace draft created the container just now → refresh status.
        const status = draft.workspaceDir
          ? await ipc.containerStatus(ws.containerKey).catch(() => null)
          : null;
        set((s) => {
          const spawnDrafts = { ...s.spawnDrafts };
          delete spawnDrafts[id];
          return {
            spawnDrafts,
            status: status ?? s.status,
            bootstrapped: status?.state === "running" ? true : s.bootstrapped,
            workspaces: updateWs(s.workspaces, ws.id, (w) =>
              updateGroup(w, draft.groupId, (g) => ({
                ...g,
                // Swap the placeholder leaf for the live session leaf in place.
                root: g.root ? replaceLeaf(g.root, id, () => leafNode(name)) : leafNode(name),
                focused: name,
              })),
            ),
          };
        });
        registry.focus(name);
      } finally {
        set({ busyMessage: null });
      }
    },

    cancelSpawn: (id) => {
      const draft = get().spawnDrafts[id];
      if (!draft) return;
      const ws = get().workspaces.find((w) => w.id === draft.workspaceId);
      set((s) => {
        const spawnDrafts = { ...s.spawnDrafts };
        delete spawnDrafts[id];
        return { spawnDrafts };
      });
      if (!ws) return;
      const grp = ws.groups.find((g) => g.id === draft.groupId);
      if (!grp) return;
      const nextRoot = grp.root ? removeLeaf(grp.root, id) : null;
      if (nextRoot) {
        set((s) => ({
          workspaces: updateWs(s.workspaces, ws.id, (w) =>
            updateGroup(w, grp.id, (g) => ({
              ...g,
              root: nextRoot,
              focused: g.focused === id ? firstLeaf(nextRoot) : g.focused,
            })),
          ),
        }));
        return;
      }
      // Group emptied → last group closes the tab; otherwise drop just the group.
      if (ws.groups.length <= 1) {
        removeWorkspace(get, set, ws.id);
        return;
      }
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

    setSessionColor: (name, color) => {
      set((s) => {
        const meta = s.sessionMeta[name];
        if (!meta) return {};
        return { sessionMeta: { ...s.sessionMeta, [name]: { ...meta, color } } };
      });
      persistPaneColor(name, color);
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

    setWorkspaceColor: (wsId, color) => {
      const ws = get().workspaces.find((w) => w.id === wsId);
      set((s) => ({
        workspaces: updateWs(s.workspaces, wsId, (w) => ({ ...w, color })),
      }));
      if (ws) persistWsColor(ws.containerKey, color);
    },

    renameWorkspace: (wsId, title) => {
      const next = title.trim();
      if (!next) return;
      const ws = get().workspaces.find((w) => w.id === wsId);
      set((s) => ({
        workspaces: updateWs(s.workspaces, wsId, (w) => ({ ...w, title: next })),
      }));
      // Persist by containerKey (NOT the saved-workspace name — that would shift
      // the derived container key). Survives reload via recallWsTitle.
      if (ws) persistWsTitle(ws.containerKey, next);
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

    addPaneToGroup: async (wsId, groupId, cli, mode, initialPrompt, account, cwd) => {
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
      const alias = aliasFor(workspaceTitle(ws), cli, nextSeq(get().sessionMeta, ws.id, cli));
      await ipc.createSession(
        name,
        cli,
        mode,
        alias,
        undefined,
        claudeId,
        account,
        containerKey,
        undefined,
        cwd,
      );
      await registry.spawnPane(name, containerKey);
      prefillPrompt(name, initialPrompt);
      registerMeta(name, cli, mode, ws.id, grp.id, containerKey, alias, claudeId, cwd);
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
    saveWorkspace: async (name, dir, additionalDirs) => {
      const id = `sw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const entry: SavedWorkspace = {
        id,
        name: name.trim() || "Untitled workspace",
        dir,
        pinned: false,
        lastOpened: null,
        createdAt: Date.now(),
        // Extra repos this workspace mounts beside `dir` (each at
        // /workspace/<basename>); omit the key entirely when there are none.
        ...(additionalDirs?.length ? { additionalDirs } : {}),
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

    loadProviders: async () => {
      try {
        set({ providers: await ipc.listProviders() });
      } catch (e) {
        console.warn("list_providers failed", e);
      }
    },

    setProviders: (list) => set({ providers: list }),

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

    renameAccountProfile: async (id, label) => {
      try {
        set({ accountProfiles: await ipc.renameAccountProfile(id, label) });
      } catch (e) {
        set({ error: `rename account failed: ${e}` });
      }
    },

    setAccountProfileEnabled: async (id, enabled) => {
      try {
        set({ accountProfiles: await ipc.setAccountProfileEnabled(id, enabled) });
      } catch (e) {
        set({ error: `toggle account failed: ${e}` });
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
    cloneRepoIntoWorkspace: async (workspace, nameWithOwner, target) => {
      // (Re)start a job entry for this repo as "cloning".
      set((s) => ({
        repoClones: [
          ...s.repoClones.filter((j) => j.repo !== nameWithOwner),
          { repo: nameWithOwner, status: "cloning" as const },
        ],
      }));
      try {
        await ipc.githubCloneInto(workspace, nameWithOwner, target);
        set((s) => ({
          repoClones: s.repoClones.map((j) =>
            j.repo === nameWithOwner ? { ...j, status: "done" as const } : j,
          ),
        }));
      } catch (e) {
        set((s) => ({
          repoClones: s.repoClones.map((j) =>
            j.repo === nameWithOwner
              ? { ...j, status: "error" as const, error: String(e).replace(/^Error:\s*/, "") }
              : j,
          ),
        }));
      }
    },
    dismissRepoClone: (repo) =>
      set((s) => ({ repoClones: s.repoClones.filter((j) => j.repo !== repo) })),
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

// Run a container lifecycle op (start/stop/restart) with shared in-flight state:
// flag `containerBusy[key]` for the duration so every surface (Welcome card,
// sidebar row) shows a spinner + disables its controls, then refresh the fleet
// and clear the flag. Swallows errors (logs them) so a failed op still settles
// the busy flag rather than wedging the spinner forever.
async function runContainerOp(
  get: Get,
  set: Set,
  key: string,
  verb: "starting" | "stopping" | "restarting",
  op: (workspace: string) => Promise<unknown>,
) {
  set((s) => ({ containerBusy: { ...s.containerBusy, [key]: verb } }));
  try {
    await op(key);
  } catch (e) {
    console.warn(`container ${verb} (${key}) failed:`, e);
  } finally {
    await get().refreshWorkspaceContainers();
    set((s) => {
      const containerBusy = { ...s.containerBusy };
      delete containerBusy[key];
      return { containerBusy };
    });
  }
}

function removeWorkspace(get: Get, set: Set, id: string) {
  const list = get().workspaces;
  const idx = list.findIndex((w) => w.id === id);
  if (idx === -1) return;
  const ws = list[idx];
  const next = list.filter((w) => w.id !== id);
  // Closing the tab frees its container's CPU/mem instead of leaving it running
  // idle. Stop (not remove) so a reopen restarts it fast and keeps its state;
  // the Workspaces view prunes it for good. Only when no remaining tab still
  // routes to that container. Fire-and-forget — a stop failure (already gone,
  // daemon down) must never block the UI close.
  if (!next.some((w) => w.containerKey === ws.containerKey)) {
    void ipc.containerStop(ws.containerKey).catch((e) => {
      console.warn(`container_stop(${ws.containerKey}) on close failed:`, e);
    });
  }
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
    // Drop any configuring-pane drafts that belonged to this workspace.
    const spawnDrafts = Object.fromEntries(
      Object.entries(s.spawnDrafts).filter(([, d]) => d.workspaceId !== id),
    );
    return { workspaces: next, activeWorkspaceId: nextActive, utilityShells, spawnDrafts };
  });
}

// Claude's transcript id is pinned via `--session-id` on create, but a restart
// adopts the still-running tmux session without knowing that id (it was minted
// in the prior process). Persist {sessionName: claudeId} so a restore can
// recover it and read live usage — otherwise restored Claude panes show "—".
const CLAUDE_ID_KEY = "codehub.claudeIds";

function readClaudeIds(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(CLAUDE_ID_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function persistClaudeId(name: string, claudeId: string): void {
  try {
    const m = readClaudeIds();
    m[name] = claudeId;
    localStorage.setItem(CLAUDE_ID_KEY, JSON.stringify(m));
  } catch {
    // localStorage unavailable — usage just won't survive a restart this session.
  }
}

function forgetClaudeId(name: string): void {
  try {
    const m = readClaudeIds();
    if (name in m) {
      delete m[name];
      localStorage.setItem(CLAUDE_ID_KEY, JSON.stringify(m));
    }
  } catch {
    // ignore
  }
}

function recallClaudeId(name: string): string | undefined {
  return readClaudeIds()[name];
}

// User-picked pane-head color, persisted by session NAME (stable across restarts
// — it's the tmux session id) so a restored pane keeps its color. Mirrors the
// claudeId persistence. A small JSON map in localStorage; best-effort.
function readStrMap(key: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}");
  } catch {
    return {};
  }
}
function writeStrEntry(key: string, id: string, value?: string): void {
  try {
    const m = readStrMap(key);
    if (value) m[id] = value;
    else delete m[id];
    localStorage.setItem(key, JSON.stringify(m));
  } catch {
    // localStorage unavailable — value just won't survive a reload this session.
  }
}

const PANE_COLOR_KEY = "codehub.paneColors";
const recallPaneColor = (name: string): string | undefined => readStrMap(PANE_COLOR_KEY)[name];
const persistPaneColor = (name: string, color?: string): void =>
  writeStrEntry(PANE_COLOR_KEY, name, color);
const forgetPaneColor = (name: string): void => writeStrEntry(PANE_COLOR_KEY, name, undefined);

// Workspace tab color + name override, persisted by the stable containerKey (the
// UI workspace id regenerates every launch) so a reopened workspace keeps both.
// The title is persisted HERE rather than on the saved-workspace entry on
// purpose: the container key is derived from the saved NAME, so editing that name
// would shift the key and orphan the running container — keying the override by
// containerKey sidesteps that.
const WS_COLOR_KEY = "codehub.wsColors";
const recallWsColor = (containerKey: string): string | undefined =>
  readStrMap(WS_COLOR_KEY)[containerKey];
const persistWsColor = (containerKey: string, color?: string): void =>
  writeStrEntry(WS_COLOR_KEY, containerKey, color);

const WS_TITLE_KEY = "codehub.wsTitles";
const recallWsTitle = (containerKey: string): string | undefined =>
  readStrMap(WS_TITLE_KEY)[containerKey];
const persistWsTitle = (containerKey: string, title?: string): void =>
  writeStrEntry(WS_TITLE_KEY, containerKey, title);

type RegisterMeta = (
  name: string,
  cli: Cli,
  mode: Mode,
  workspaceId: string,
  groupId: string,
  containerKey: string,
  alias: string,
  claudeId?: string,
  cwd?: string,
) => void;

// Adopt one container's surviving tmux sessions into a workspace tab — the unit
// shared by launch-time restore (bootstrap) and on-demand "Open in Hub"
// (openContainerWorkspace). Recovers the saved name/dir by matching the container
// key, lays the grid out alternating row/col, and routes the docked shell to
// utilityShells. `members` may be empty (a running container whose agents exited)
// → an empty tab bound to the container so the user can launch into it. Returns
// the new workspace id. `activate` makes it the active tab (resume); restore
// passes false so only the FIRST adopted workspace becomes active.
async function adoptWorkspace(
  get: Get,
  set: Set,
  registerMeta: RegisterMeta,
  members: SessionInfo[],
  containerKey: string,
  activate: boolean,
): Promise<string> {
  // Recover the saved identity (name / dir) by matching the container key — the
  // key is derived from the saved id, so a restored/resumed tab shows its REAL
  // name and is recognized as that saved workspace. No match → generic fallback.
  const saved = (get().config?.savedWorkspaces ?? []).find(
    (sw) => containerKeyFor({ title: sw.name, savedWorkspaceId: sw.id }) === containerKey,
  );
  for (const s of members) await registry.spawnPane(s.name, containerKey);
  // Shell sessions map back to the docked Shell panel; agent sessions are grid leaves.
  const utilityShell = members.find((s) => s.name.startsWith("shell"));
  const gridMembers = members.filter((s) => !s.name.startsWith("shell"));
  // Saved layout (ratios/dirs) isn't persisted; stack members alternating row/col.
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
  const label = saved?.name?.trim() || `Workspace ${plate}`;
  const group = makeGroup("Group 1", root, gridMembers[0]?.name ?? null);
  const ws: Workspace = {
    id: `ws-${plate}-${Date.now().toString(36)}`,
    plate,
    title: recallWsTitle(containerKey) ?? saved?.name,
    dir: saved?.dir,
    savedWorkspaceId: saved?.id,
    groups: [group],
    activeGroupId: group.id,
    color: recallWsColor(containerKey),
    // Keep the ORIGINAL container key so splits + later panes rejoin this
    // workspace's container — surviving even after every pane is closed.
    containerKey,
  };
  set((st) => ({
    plateCounter: plate,
    sessionCounter: st.sessionCounter + members.length,
    workspaces: [...st.workspaces, ws],
    activeWorkspaceId: activate ? ws.id : (st.activeWorkspaceId ?? ws.id),
    utilityShells: utilityShell
      ? { ...st.utilityShells, [containerKey]: utilityShell.name }
      : st.utilityShells,
  }));
  // Mode of a pre-existing tmux session is unknown; show it as Standard. The
  // original alias lived only in the tmux window name (not returned by
  // list_sessions), so reconstruct a workspace-prefixed one.
  for (const s of members) {
    const cli =
      (["claude", "codex", "antigravity", "shell"] as Cli[]).find((c) => s.name.startsWith(c)) ??
      "claude";
    // Recover the persisted transcript id so restored Claude panes show live usage.
    const claudeId = cli === "claude" ? recallClaudeId(s.name) : undefined;
    const alias = aliasFor(label, cli, nextSeq(get().sessionMeta, ws.id, cli));
    registerMeta(s.name, cli, "standard", ws.id, group.id, containerKey, alias, claudeId);
  }
  return ws.id;
}

async function bootstrap(get: Get, set: Set, registerMeta: RegisterMeta) {
  // Tier-1 reads: daemon info, per-CLI version + key presence.
  // dockerInfo, dockerRuntime, workspaceContainers are loaded eagerly in
  // initLifecycle (they don't need a running container). Refresh them here too
  // so bootstrap picks up any state that changed between app-load and the
  // lifecycle event arriving.
  void ipc
    .dockerInfo()
    .then((dockerInfo) => set({ dockerInfo }))
    .catch(() => {});
  void ipc
    .detectDockerRuntime()
    .then((dockerRuntime) => set({ dockerRuntime }))
    .catch(() => {});
  void ipc
    .listWorkspaceContainers()
    .then((wc) => set({ workspaceContainers: wc }))
    .catch(() => {});
  void ipc
    .agentKeyStatus()
    .then((keyStatus) => set({ keyStatus }))
    .catch((e) => console.warn("agent_key_status failed", e));
  void ipc
    .agentVersions()
    .then((agentVersions) => set({ agentVersions }))
    .catch((e) => console.warn("agent_versions failed", e));
  // Tier-2/Tier-3: workspace mount reconciliation + account profiles (label-only,
  // with live presence). Independent best-effort reads.
  void get().loadWorkspaceInfo();
  void get().loadAccountProfiles();
  // Source control: load GitHub connection status at boot (was Settings-visit-
  // only — the card read "not connected" until you opened Settings), then prefetch
  // the repo list when connected so the New Workspace picker is populated + cached
  // up front. Both best-effort.
  void get()
    .loadGithubStatus()
    .then(() => {
      if (get().githubStatus?.connected) return get().loadGithubRepos();
    })
    .catch(() => {});

  // Startup behaviors are persisted prefs; the config load races the lifecycle
  // event that triggered us, so ensure it's resolved before reading the flags.
  if (!get().config) await get().loadConfig();
  const cfg = get().config;
  // "Restore sessions on launch" (default on): adopt the tmux sessions that
  // survived the last quit. When off we leave them running in the container
  // untouched (non-destructive) but start the Hub clean.
  if (cfg && !cfg.restoreSessionsOnLaunch) {
    set({ bootSettled: true });
    return;
  }

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
      // Adopt each container's surviving sessions into a tab. `activate: false`
      // — only the FIRST adopted workspace becomes active (reopenLastWorkspace
      // below may re-point it).
      await adoptWorkspace(get, set, registerMeta, members, members[0].workspace, false);
    }

    // Auto-stop pure orphans: managed containers that are RUNNING but have no
    // live sessions AND no saved-workspace entry — cruft from past runs that
    // can't be reopened as a named workspace and would otherwise leak CPU/mem
    // forever. Saved workspaces are EXEMPT (the user may resume them — Q: "leave
    // as-is"); a container that has sessions was just adopted above. Best-effort.
    void (async () => {
      try {
        const fleet = await ipc.listWorkspaceContainers();
        const withSessions = new Set(sessions.map((s) => s.workspace));
        const savedKeys = new Set(
          (get().config?.savedWorkspaces ?? []).map((sw) =>
            containerKeyFor({ title: sw.name, savedWorkspaceId: sw.id }),
          ),
        );
        for (const c of fleet) {
          if (c.status.state === "running" && !withSessions.has(c.key) && !savedKeys.has(c.key)) {
            void ipc.containerStop(c.key).catch(() => {});
          }
        }
      } catch {
        // best-effort cleanup — never block restore
      }
    })();

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
  } finally {
    set({ bootSettled: true });
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
  const set = useStore.setState;
  // UI prefs don't depend on the container, so load them eagerly at app start.
  void loadConfig();
  // Docker status + runtime detection + workspace containers are independent of
  // the lifecycle event — load eagerly so the empty-state hero renders correctly
  // on first paint (not after the lifecycle event arrives).
  //
  // Trigger restore from daemon reachability, NOT only the backend's one-time
  // synthetic lifecycle push: the Tauri backend emits that event once in its
  // `setup` hook (process startup). A webview reload (⌘R) re-runs THIS but not
  // `setup`, so the reloaded frontend would never receive the event and never
  // bootstrap — the Hub would come up empty until a full app restart. (The dev
  // bridge re-emits on every WS connect, which is why `make dev-web` reloads
  // worked and masked this.) Synthesizing a "running" status here makes every
  // (re)load self-sufficient; it's idempotent with the real event via the
  // `bootstrapped` guard in setStatus.
  void ipc
    .dockerInfo()
    .then((dockerInfo) => {
      set({ dockerInfo });
      if (dockerInfo.reachable) {
        setStatus({ state: "running", id: null, image: "", name: "daemon" });
      } else {
        // No reachable daemon → bootstrap (which sets bootSettled) never runs.
        // Settle here so the empty-state hero renders instead of a blank pane.
        set({ bootSettled: true });
      }
    })
    .catch((e) => {
      console.warn("docker_info failed", e);
      set({ bootSettled: true });
    });
  void ipc
    .detectDockerRuntime()
    .then((dockerRuntime) => set({ dockerRuntime }))
    .catch((e) => console.warn("detect_docker_runtime failed", e));
  void ipc
    .listWorkspaceContainers()
    .then((workspaceContainers) => set({ workspaceContainers }))
    .catch((e) => console.warn("list_workspace_containers failed", e));
  // Still subscribe to the live lifecycle event — it carries real start/stop
  // transitions after launch (and is the redundant first-launch trigger).
  void onLifecycle(setStatus);
  void onLifecycleError(setError);
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

// Workspace-close guard: a single confirmation covering every working agent in
// the workspace. Returns "close" to proceed, or null to abort. The
// `confirmCloseRunningAgent` pref is specifically about RUNNING agents, so an
// idle workspace closes silently rather than nagging. Closing always stops the
// container (see removeWorkspace) — reopen restarts it.
export function confirmCloseWorkspace(wsId: string): "close" | null {
  const s = useStore.getState();
  const ws = s.workspaces.find((w) => w.id === wsId);
  if (!ws) return "close";
  const sessions = workspaceLeaves(ws);
  const needsConfirm = s.config?.confirmCloseRunningAgent ?? true;
  const working = sessions.filter((n) => s.sessionActivity[n]?.state === "working").length;
  if (!needsConfirm || working === 0) return "close";
  const title = workspaceTitle(ws);
  const plural = working === 1 ? "agent is" : "agents are";
  const msg = `Close ${title}?\n\n${working} ${plural} still working. Sessions will be killed and the workspace container will stop (reopen to resume).`;
  return window.confirm(msg) ? "close" : null;
}

// Convenience selectors.
export function activeWorkspace(s: CodeHubState): Workspace | undefined {
  return s.workspaces.find((w) => w.id === s.activeWorkspaceId);
}

export { leavesList, leavesOf };
export type { LayoutNode };
