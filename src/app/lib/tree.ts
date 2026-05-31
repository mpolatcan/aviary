import type { Cli, Mode } from "./ipc";

// A workspace (tab) owns a binary split tree of sessions. Leaves are sessions;
// split nodes divide space row/col with a ratio. Ported verbatim from the
// vanilla layout model so behaviour (and TEST_SCENARIOS) stays identical.

// Cap one group at six panes (a full 3×2 grid), then steer new work into a fresh
// group so the split grid stays readable.
export const MAX_GROUP_PANES = 6;

export type SplitDir = "row" | "col";

export interface LeafNode {
  kind: "leaf";
  id: number;
  session: string;
}

export interface SplitNode {
  kind: "split";
  id: number;
  dir: SplitDir;
  ratio: number;
  a: LayoutNode;
  b: LayoutNode;
}

export type LayoutNode = LeafNode | SplitNode;

// A group is a named, colored set of panes within a workspace — it owns its own
// split tree + focus (design/screens/main-hub-a.jsx `GroupsBar` / `GroupGrid`).
// A workspace holds N groups; one is active and shown in the grid. tmux sessions
// stay flat inside that workspace's container — groups are frontend organisation.
export interface Group {
  id: string;
  name: string;
  color: string;
  root: LayoutNode | null;
  focused: string | null;
}

export interface Workspace {
  id: string;
  plate: number;
  // User-facing name for saved workspaces. Falls back to "Workspace N" for
  // ad-hoc tabs or restored containers whose saved pointer is unknown.
  title?: string;
  // Host directory mounted at /workspace when this tab was opened, when known.
  dir?: string;
  savedWorkspaceId?: string;
  groups: Group[];
  activeGroupId: string;
  // User-picked tab color (a PANE_COLORS fill), or undefined for the neutral
  // tab. Persisted by containerKey across reloads. Same mechanism as a pane's
  // color and a group's color.
  color?: string;
  // Per-workspace-container ROUTING key — the container every pane of this
  // workspace lives in (`codehub-ws-<key>`). Owned by the workspace, NOT derived
  // from `id`: a RESTORED workspace gets a fresh `id` but keeps the original
  // container key (recovered from the `codehub.workspace` label). New panes
  // (split / add-to-group) route by THIS so they join the workspace's container
  // even when it currently has no panes — deriving the key from an existing pane
  // breaks once the workspace is emptied. Always defined: every workspace has
  // its own container.
  containerKey: string;
}

export interface SessionMeta {
  cli: Cli;
  num: number;
  alias: string;
  mode: Mode;
  workspaceId: string;
  // Group within the workspace this session's pane lives in.
  groupId: string;
  // Per-workspace-container ROUTING key — the workspace key this session was
  // created/attached with, so kill/rename target the same container as attach.
  // Normally equals the workspace's containerKey; decoupling the routing key from
  // the UI workspace id is what stops restored sessions mis-routing (a restored
  // workspace gets a fresh `workspaceId` but keeps the original container key).
  // Always defined: every session lives in a per-workspace container.
  containerKey: string;
  // User-picked pane-head tint (a PANE_COLORS token). Undefined → the head uses
  // the agent accent. Frontend-only, in-memory (like Group.color); not restored.
  color?: string;
  // Claude conversation id this session was launched with (`--session-id`, or
  // the id it resumed). Lets the Hub read this session's own transcript for a
  // live token tally. Only set for Claude sessions.
  claudeId?: string;
  // Working directory the agent was launched in (a path under /workspace), so the
  // sidebar can show which repo/dir this pane targets. Undefined → the mount root
  // (/workspace); in-memory only (a restored session falls back to the ws dir).
  cwd?: string;
}

let nodeCounter = 0;
export function nid(): number {
  nodeCounter += 1;
  return nodeCounter;
}

// Pane-head color (SessionMeta.color). Each fills the WHOLE pane header, so it
// ships with a paired `ink` (foreground) chosen for contrast against that exact
// fill. DELIBERATELY theme-independent oklch literals (not --tokens): a user-
// picked pane color must read identically in dark/gray/light, and its legibility
// must be deterministic — token accents shift lightness per theme and would flip
// a once-legible bar to unreadable. `ink` is a near-black for high-luminance
// hues (green/amber/teal/coral/slate) and a near-white for the deep ones.
export interface PaneColor {
  bg: string;
  ink: string;
}
export const PANE_COLORS: PaneColor[] = [
  { bg: "oklch(0.74 0.14 35)", ink: "oklch(0.2 0.03 35)" }, // coral
  { bg: "oklch(0.62 0.13 265)", ink: "oklch(0.97 0.02 265)" }, // blue
  { bg: "oklch(0.6 0.19 295)", ink: "oklch(0.97 0.02 295)" }, // violet
  { bg: "oklch(0.8 0.17 145)", ink: "oklch(0.24 0.05 145)" }, // green
  { bg: "oklch(0.84 0.14 85)", ink: "oklch(0.26 0.05 85)" }, // amber
  { bg: "oklch(0.68 0.07 240)", ink: "oklch(0.18 0.02 240)" }, // slate
  { bg: "oklch(0.6 0.2 25)", ink: "oklch(0.97 0.02 25)" }, // red
  { bg: "oklch(0.76 0.09 200)", ink: "oklch(0.22 0.03 200)" }, // teal
];

// The contrast ink paired with a pane-head fill (undefined when not a known
// PANE_COLORS fill, e.g. an unset pane → fall back to the default fg tokens).
export function paneInk(bg?: string): string | undefined {
  return bg ? PANE_COLORS.find((c) => c.bg === bg)?.ink : undefined;
}

let groupCounter = 0;
export function makeGroup(
  name?: string,
  root: LayoutNode | null = null,
  focused: string | null = null,
  color?: string,
): Group {
  groupCounter += 1;
  const n = groupCounter;
  return {
    id: `grp-${n}-${Date.now().toString(36)}`,
    name: name || `Group ${n}`,
    // Auto-assign from the shared palette so a group tab fills with a real color
    // (and gets a paired ink) out of the box; the ColorDot recolors it.
    color: color ?? PANE_COLORS[(n - 1) % PANE_COLORS.length].bg,
    root,
    focused,
  };
}

// The group currently shown in the grid. Falls back to the first group so
// callers never have to null-check a malformed workspace.
export function activeGroup(ws: Workspace): Group {
  return ws.groups.find((g) => g.id === ws.activeGroupId) ?? ws.groups[0];
}

export function workspaceTitle(ws: Pick<Workspace, "plate" | "title">): string {
  const title = ws.title?.trim();
  return title || `Workspace ${ws.plate}`;
}

// Find which group within a workspace owns a given session (by leaf membership).
export function findGroupOf(ws: Workspace, session: string): Group | undefined {
  return ws.groups.find((g) => g.root != null && leavesList(g.root).includes(session));
}

// All session names across every group of a workspace.
export function workspaceLeaves(ws: Workspace): string[] {
  return ws.groups.flatMap((g) => leavesList(g.root));
}

// Immutably replace one group in a workspace's group list.
export function updateGroup(ws: Workspace, groupId: string, fn: (g: Group) => Group): Workspace {
  return { ...ws, groups: ws.groups.map((g) => (g.id === groupId ? fn(g) : g)) };
}

export function leafNode(session: string): LeafNode {
  return { kind: "leaf", id: nid(), session };
}

// Default columns for the auto-balanced grid (design "3 columns × N rows").
export const GRID_COLS = 3;

// Build an EVEN grid tree from an ordered leaf list: chunk into rows of ≤maxCols,
// each row a horizontal arrangement at equal widths, rows stacked at equal
// heights. Right-leaning binary splits with `ratio = 1/(remaining)` make every
// cell the same size. Used by auto-placement ("New agent") so panes form a
// uniform grid instead of lopsided nested halves; manual split/resize still
// produce freeform trees. Returns null for an empty list.
export function buildGridTree(leaves: string[], maxCols = GRID_COLS): LayoutNode | null {
  if (leaves.length === 0) return null;
  if (leaves.length === 1) return leafNode(leaves[0]);
  // Even right-leaning split of N nodes along one axis.
  const evenAxis = (items: LayoutNode[], dir: SplitDir): LayoutNode =>
    items.reduceRight<LayoutNode | null>((acc, item, i) => {
      if (acc === null) return item;
      return { kind: "split", id: nid(), dir, ratio: 1 / (items.length - i), a: item, b: acc };
    }, null) as LayoutNode;
  const rows: LayoutNode[] = [];
  for (let i = 0; i < leaves.length; i += maxCols) {
    rows.push(evenAxis(leaves.slice(i, i + maxCols).map(leafNode), "row"));
  }
  return rows.length === 1 ? rows[0] : evenAxis(rows, "col");
}

export function* leavesOf(node: LayoutNode): Generator<string> {
  if (node.kind === "leaf") {
    yield node.session;
  } else {
    yield* leavesOf(node.a);
    yield* leavesOf(node.b);
  }
}

export function leavesList(node: LayoutNode | null): string[] {
  return node ? [...leavesOf(node)] : [];
}

export function firstLeaf(node: LayoutNode): string {
  return leavesOf(node).next().value as string;
}

export function replaceLeaf(
  node: LayoutNode,
  session: string,
  make: (leaf: LeafNode) => LayoutNode,
): LayoutNode {
  if (node.kind === "leaf") {
    return node.session === session ? make(node) : node;
  }
  return {
    ...node,
    a: replaceLeaf(node.a, session, make),
    b: replaceLeaf(node.b, session, make),
  };
}

export function removeLeaf(node: LayoutNode, session: string): LayoutNode | null {
  if (node.kind === "leaf") {
    return node.session === session ? null : node;
  }
  const a = removeLeaf(node.a, session);
  const b = removeLeaf(node.b, session);
  if (a === null) return b;
  if (b === null) return a;
  return { ...node, a, b };
}

// Swap two sessions' positions in the tree by exchanging the `session` field on
// their leaves. No node is added or removed and no tmux session dies — the two
// panes just trade slots, so their xterm surfaces survive (PaneMount reparents
// by session on the next render). Used by drag-to-center "swap" (hub-states
// HubStateDragging). Returns the node unchanged if either session is absent.
export function swapLeaves(node: LayoutNode, a: string, b: string): LayoutNode {
  if (a === b) return node;
  if (node.kind === "leaf") {
    if (node.session === a) return { ...node, session: b };
    if (node.session === b) return { ...node, session: a };
    return node;
  }
  return { ...node, a: swapLeaves(node.a, a, b), b: swapLeaves(node.b, a, b) };
}

// Move a session next to a target, splitting the target's slot in `dir`. The
// dragged leaf is removed from its current position (collapsing its old split,
// like a close) and re-inserted beside `target`; `before=true` places the moved
// pane on the leading side (top/left), else trailing (bottom/right). No tmux
// session dies — both panes survive the reshape (drag-to-edge split, hub-states
// HubStateDragging). No-op when moving onto itself.
export function moveLeaf(
  node: LayoutNode,
  session: string,
  target: string,
  dir: SplitDir,
  before: boolean,
): LayoutNode {
  if (session === target) return node;
  const without = removeLeaf(node, session);
  if (without === null) return node; // dragged leaf was the whole tree — nothing to do
  const moved = leafNode(session);
  return replaceLeaf(without, target, (leaf) => ({
    kind: "split",
    id: nid(),
    dir,
    ratio: 0.5,
    a: before ? moved : leaf,
    b: before ? leaf : moved,
  }));
}

// Immutably set a split node's ratio by node id (used by divider drag commit).
export function setRatio(node: LayoutNode, id: number, ratio: number): LayoutNode {
  if (node.kind === "leaf") return node;
  if (node.id === id) return { ...node, ratio };
  return { ...node, a: setRatio(node.a, id, ratio), b: setRatio(node.b, id, ratio) };
}
