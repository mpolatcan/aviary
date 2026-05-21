import type { Cli, Mode } from "./ipc";

// A workspace (tab) owns a binary split tree of sessions. Leaves are sessions;
// split nodes divide space row/col with a ratio. Ported verbatim from the
// vanilla layout model so behaviour (and TEST_SCENARIOS) stays identical.

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

export interface Workspace {
  id: string;
  plate: number;
  root: LayoutNode | null;
  focused: string | null;
}

export interface SessionMeta {
  cli: Cli;
  num: number;
  alias: string;
  mode: Mode;
  workspaceId: string;
}

let nodeCounter = 0;
export function nid(): number {
  nodeCounter += 1;
  return nodeCounter;
}

export function leafNode(session: string): LeafNode {
  return { kind: "leaf", id: nid(), session };
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

// Immutably set a split node's ratio by node id (used by divider drag commit).
export function setRatio(node: LayoutNode, id: number, ratio: number): LayoutNode {
  if (node.kind === "leaf") return node;
  if (node.id === id) return { ...node, ratio };
  return { ...node, a: setRatio(node.a, id, ratio), b: setRatio(node.b, id, ratio) };
}
