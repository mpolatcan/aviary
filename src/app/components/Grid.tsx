import { useEffect, useRef } from "react";
import * as registry from "../lib/panes";
import { useStore } from "../lib/store";
import type { LayoutNode, SplitNode, Workspace } from "../lib/tree";
import { leavesOf } from "../lib/tree";
import { PaneHead } from "./PaneHead";
import { PaneMount } from "./PaneMount";

// Renders a workspace's binary split tree. Leaves carry a PaneHead + the
// reparented xterm surface (PaneMount); split nodes lay out two cells with a
// draggable divider between them.
export function Grid({ ws }: { ws: Workspace }) {
  return <RenderNode node={ws.root as LayoutNode} ws={ws} />;
}

function RenderNode({ node, ws }: { node: LayoutNode; ws: Workspace }) {
  if (node.kind === "leaf") {
    return <Leaf session={node.session} ws={ws} />;
  }
  return <Split node={node} ws={ws} />;
}

function Leaf({ session, ws }: { session: string; ws: Workspace }) {
  const focusSession = useStore((s) => s.focusSession);
  const focused = ws.focused === session;
  return (
    <div
      className={`pane-leaf${focused ? " focused" : ""}`}
      data-session={session}
      onMouseDown={() => focusSession(session)}
    >
      <PaneHead session={session} focused={focused} />
      <div className="pane-body">
        <PaneMount session={session} />
      </div>
    </div>
  );
}

function Split({ node, ws }: { node: SplitNode; ws: Workspace }) {
  const aRef = useRef<HTMLDivElement>(null);
  const bRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const commitRatio = useStore((s) => s.commitRatio);
  // Aborts an in-flight drag's document listeners if this Split unmounts (e.g. a
  // sibling close collapses the split, or the tab switches) before mouseup.
  const dragAbort = useRef<AbortController | null>(null);

  useEffect(() => () => dragAbort.current?.abort(), []);

  const onDividerDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const container = wrapRef.current;
    if (!container) return;
    const horizontal = node.dir === "row";
    let latest = node.ratio;

    const ac = new AbortController();
    dragAbort.current = ac;
    const { signal } = ac;

    const onMove = (ev: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const total = horizontal ? rect.width : rect.height;
      if (total <= 0) return;
      const pos = horizontal ? ev.clientX - rect.left : ev.clientY - rect.top;
      latest = Math.min(0.85, Math.max(0.15, pos / total));
      if (aRef.current) aRef.current.style.flex = `${latest} 1 0`;
      if (bRef.current) bRef.current.style.flex = `${1 - latest} 1 0`;
    };
    const onUp = () => {
      ac.abort();
      dragAbort.current = null;
      document.body.classList.remove("dragging");
      commitRatio(ws.id, node.id, latest);
      for (const s of leavesOf(node)) registry.fit(s);
    };
    document.addEventListener("mousemove", onMove, { signal });
    document.addEventListener("mouseup", onUp, { signal });
    document.body.classList.add("dragging");
  };

  return (
    <div ref={wrapRef} className={`split ${node.dir}`}>
      <div ref={aRef} className="split-cell" style={{ flex: `${node.ratio} 1 0` }}>
        <RenderNode key={node.a.id} node={node.a} ws={ws} />
      </div>
      <div className={`divider ${node.dir}`} onMouseDown={onDividerDown} />
      <div ref={bRef} className="split-cell" style={{ flex: `${1 - node.ratio} 1 0` }}>
        <RenderNode key={node.b.id} node={node.b} ws={ws} />
      </div>
    </div>
  );
}
