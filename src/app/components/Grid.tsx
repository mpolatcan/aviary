import { useEffect, useRef, useState } from "react";
import { groupKey, splitKey, useLauncher } from "../lib/launcher";
import { useOverlay } from "../lib/overlay";
import * as registry from "../lib/panes";
import { confirmCloseRunningSession, useStore } from "../lib/store";
import type { Group, LayoutNode, SplitNode, Workspace } from "../lib/tree";
import { activeGroup, leavesList, leavesOf } from "../lib/tree";
import { PaneHead } from "./PaneHead";
import { PaneMount } from "./PaneMount";
import { PaneContextMenu, type PaneMenuItem } from "./hub/PaneContextMenu";
import { AgentGlyph } from "./primitives/AgentGlyph";
import { StatusDot } from "./primitives/StatusDot";
import { Ico } from "./primitives/icons";

// Renders the active pane group's binary split tree. Leaves carry a PaneHead +
// the reparented xterm surface (PaneMount); split nodes lay out two cells with a
// draggable divider between them. An empty group (no panes) shows the
// group-grid empty-state CTA (design GroupGrid). When focus mode is on (and the
// group has 2+ panes) the focused pane is maximized with the rest as a minimized
// side strip (design hub-states HubStateFocus).
export function Grid({ ws }: { ws: Workspace }) {
  const group = activeGroup(ws);
  const focusMode = useOverlay((s) => s.focusMode);
  if (!group?.root) return <EmptyGroup ws={ws} group={group} />;

  const leaves = leavesList(group.root);
  if (focusMode && leaves.length > 1 && group.focused && leaves.includes(group.focused)) {
    return <FocusLayout group={group} leaves={leaves} />;
  }
  return <RenderNode node={group.root} ws={ws} group={group} leaves={leaves} />;
}

// Empty-group state (design GroupGrid empty branch): a dashed-plus affordance +
// a quick-spawn CTA. The CTA opens the shared launcher targeted at this group
// (groupKey ctx), so the spawn lands here rather than in a new tab.
function EmptyGroup({ ws, group }: { ws: Workspace; group: Group }) {
  const open = useLauncher((s) => s.open);
  const setFiles = useOverlay((s) => s.setFiles);
  const setShell = useOverlay((s) => s.setShell);
  const setDiff = useOverlay((s) => s.setDiff);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const spawn = (cli: "claude" | "codex" | "antigravity") => {
    setMenu(null);
    open(groupKey(group.id), {
      dir: "row",
      groupId: group.id,
      workspaceId: ws.id,
      preferredCli: cli,
    });
  };
  const openMore = () =>
    open(groupKey(group.id), { dir: "row", groupId: group.id, workspaceId: ws.id });
  const items: PaneMenuItem[] = [
    {
      icon: <AgentGlyph agent="claude" size={14} />,
      label: "New Claude",
      kbd: "⌘1",
      onClick: () => spawn("claude"),
    },
    {
      icon: <AgentGlyph agent="codex" size={14} />,
      label: "New Codex",
      kbd: "⌘2",
      onClick: () => spawn("codex"),
    },
    {
      icon: <AgentGlyph agent="antigravity" size={14} />,
      label: "New Antigravity",
      kbd: "⌘3",
      onClick: () => spawn("antigravity"),
    },
    { label: "—", onClick: () => {} },
    { icon: Ico.files, label: "Show Files", onClick: () => setFiles(true) },
    { icon: Ico.terminal, label: "Show Shell", onClick: () => setShell(true) },
    { icon: Ico.diff, label: "Show Diff", onClick: () => setDiff("") },
    { label: "—", onClick: () => {} },
    { icon: Ico.plus, label: "More agents", onClick: openMore },
  ];
  return (
    <div
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        background: "var(--bg-0)",
        minHeight: 0,
        width: "100%",
        padding: 32,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            border: "1.5px dashed var(--bd)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--fg-3)",
          }}
        >
          {Ico.plus}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: group.color }} />
          <span style={{ fontSize: 15, color: "var(--fg-0)", fontWeight: 500 }}>Empty group</span>
        </div>
        <div style={{ fontSize: 12, color: "var(--fg-2)", textAlign: "center", maxWidth: 384 }}>
          Add an agent or utility pane to {group.name}. Right-click anywhere to see all options.
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
        <button type="button" className="btn sm pri" onClick={() => spawn("claude")}>
          <span
            style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--a-claude)" }}
          />
          Claude
          <span className="kbd">⌘1</span>
        </button>
        <button type="button" className="btn sm pri" onClick={() => spawn("codex")}>
          <span
            style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--a-codex)" }}
          />
          Codex
          <span className="kbd">⌘2</span>
        </button>
        <button type="button" className="btn sm pri" onClick={() => spawn("antigravity")}>
          <span
            style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--a-antigravity)" }}
          />
          Antigravity
          <span className="kbd">⌘3</span>
        </button>
        <div className="vr" style={{ height: 24, alignSelf: "center" }} />
        <button type="button" className="btn sm" onClick={() => setFiles(true)}>
          {Ico.files}
          Files
        </button>
        <button type="button" className="btn sm" onClick={() => setShell(true)}>
          {Ico.terminal}
          Shell
        </button>
        <button type="button" className="btn sm" onClick={() => setDiff("")}>
          {Ico.diff}
          Diff
        </button>
      </div>
      <button type="button" onClick={openMore} className="btn ghost sm">
        More agents
      </button>
      {menu && (
        <PaneContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

function RenderNode({
  node,
  ws,
  group,
  leaves,
}: { node: LayoutNode; ws: Workspace; group: Group; leaves: string[] }) {
  if (node.kind === "leaf") {
    return (
      <Leaf
        session={node.session}
        group={group}
        wsId={ws.id}
        index={leaves.indexOf(node.session)}
      />
    );
  }
  return <Split node={node} ws={ws} group={group} leaves={leaves} />;
}

// Drop zones over a pane while another pane is being dragged (design hub-states
// DropQuadrants): 4 edge strips re-split this pane's slot, the center swaps. The
// active zone is computed from the cursor in onDragOver and highlighted.
type DropZone = "top" | "right" | "bottom" | "left" | "center";

function zoneFromEvent(e: React.DragEvent, el: HTMLElement): DropZone {
  const r = el.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width;
  const py = (e.clientY - r.top) / r.height;
  const EDGE = 0.18;
  if (py < EDGE) return "top";
  if (py > 1 - EDGE) return "bottom";
  if (px < EDGE) return "left";
  if (px > 1 - EDGE) return "right";
  return "center";
}

function Leaf({
  session,
  group,
  wsId,
  index,
}: { session: string; group: Group; wsId: string; index: number }) {
  const focusSession = useStore((s) => s.focusSession);
  const closeSession = useStore((s) => s.closeSession);
  const swapPanes = useStore((s) => s.swapPanes);
  const movePane = useStore((s) => s.movePane);
  const setFocusMode = useOverlay((s) => s.setFocusMode);
  const dragSession = useOverlay((s) => s.dragSession);
  const setDragSession = useOverlay((s) => s.setDragSession);
  const openLaunch = useLauncher((s) => s.open);
  const siblings = leavesList(group.root).length;
  const focused = group.focused === session;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [zone, setZone] = useState<DropZone | null>(null);

  // A drag is in flight from a DIFFERENT pane → this pane is a drop target.
  const isDropTarget = dragSession != null && dragSession !== session;

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const from = dragSession;
    setZone(null);
    setDragSession(null);
    if (!from || from === session) return;
    const z = zoneFromEvent(e, e.currentTarget as HTMLElement);
    if (z === "center") swapPanes(wsId, from, session);
    else if (z === "top") movePane(wsId, from, session, "col", true);
    else if (z === "bottom") movePane(wsId, from, session, "col", false);
    else if (z === "left") movePane(wsId, from, session, "row", true);
    else movePane(wsId, from, session, "row", false);
  };

  const items: PaneMenuItem[] = [
    {
      icon: Ico.splitV,
      label: "Split right",
      kbd: "⌘\\",
      onClick: () => openLaunch(splitKey(session), { dir: "row", session }),
    },
    {
      icon: Ico.splitH,
      label: "Split down",
      kbd: "⌘⇧\\",
      onClick: () => openLaunch(splitKey(session), { dir: "col", session }),
    },
    {
      icon: Ico.expand,
      label: "Maximize pane",
      disabled: siblings < 2,
      onClick: () => {
        focusSession(session);
        setFocusMode(true);
      },
    },
    { label: "—", onClick: () => {} },
    {
      icon: Ico.close,
      label: "Close session",
      kbd: "⌘W",
      danger: true,
      onClick: () => {
        if (!confirmCloseRunningSession(session)) return;
        void closeSession(session);
      },
    },
  ];

  return (
    <div
      className={`pane-leaf${focused ? " focused" : ""}`}
      data-session={session}
      onMouseDown={() => focusSession(session)}
      onContextMenu={(e) => {
        e.preventDefault();
        focusSession(session);
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <PaneHead
        session={session}
        index={index}
        draggable={siblings > 1}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", session);
          setDragSession(session);
        }}
        onDragEnd={() => {
          setDragSession(null);
          setZone(null);
        }}
      />
      <div className="pane-body">
        <PaneMount session={session} />
      </div>
      {/* Drop overlay — only while another pane is dragged over this one. Sits
          above the xterm surface so the terminal never sees the drag events. */}
      {isDropTarget && (
        <div
          style={{ position: "absolute", inset: 0, zIndex: 6 }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setZone(zoneFromEvent(e, e.currentTarget as HTMLElement));
          }}
          onDragLeave={(e) => {
            // Only clear when the cursor actually leaves this overlay (not on
            // entering a child), so the highlight doesn't flicker.
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setZone(null);
          }}
          onDrop={onDrop}
        >
          <DropQuadrants active={zone} />
        </div>
      )}
      {menu && (
        <PaneContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

// The 5-zone drop overlay (design hub-states DropQuadrants): 4 edge strips +
// a center swap pill. The hovered `active` zone is tinted brighter.
function DropQuadrants({ active }: { active: DropZone | null }) {
  const strip = (side: DropZone, on: boolean): React.CSSProperties => {
    const horizontal = side === "top" || side === "bottom";
    return {
      position: "absolute",
      [side]: 0,
      ...(horizontal ? { left: 0, right: 0, height: "18%" } : { top: 0, bottom: 0, width: "18%" }),
      background: `linear-gradient(to ${side}, transparent, color-mix(in oklab, var(--pri) ${on ? 42 : 18}%, transparent))`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 5,
      fontFamily: "var(--mono)",
      fontSize: 11,
      color: "var(--pri)",
      opacity: on ? 1 : 0.5,
      pointerEvents: "none",
    };
  };
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <div style={strip("top", active === "top")}>
        {Ico.splitH}
        <span>Split top</span>
      </div>
      <div style={strip("right", active === "right")}>
        {Ico.splitV}
        <span>Split right</span>
      </div>
      <div style={strip("bottom", active === "bottom")}>
        {Ico.splitH}
        <span>Split bottom</span>
      </div>
      <div style={strip("left", active === "left")}>
        {Ico.splitV}
        <span>Split left</span>
      </div>
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          background: "var(--bg-2)",
          border: "1.5px solid var(--pri)",
          borderRadius: 8,
          padding: "9px 13px",
          display: "flex",
          alignItems: "center",
          gap: 7,
          fontSize: 13,
          color: active === "center" ? "var(--fg-0)" : "var(--fg-2)",
          opacity: active === "center" ? 1 : 0.6,
          boxShadow: "0 6px 20px rgba(0,0,0,0.4)",
          pointerEvents: "none",
        }}
      >
        <span style={{ display: "inline-flex", color: "var(--pri)" }}>{Ico.expand}</span>
        Drop to swap
      </div>
    </div>
  );
}

function Split({
  node,
  ws,
  group,
  leaves,
}: { node: SplitNode; ws: Workspace; group: Group; leaves: string[] }) {
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
        <RenderNode key={node.a.id} node={node.a} ws={ws} group={group} leaves={leaves} />
      </div>
      <div className={`divider ${node.dir}`} onMouseDown={onDividerDown} />
      <div ref={bRef} className="split-cell" style={{ flex: `${1 - node.ratio} 1 0` }}>
        <RenderNode key={node.b.id} node={node.b} ws={ws} group={group} leaves={leaves} />
      </div>
    </div>
  );
}

// Focus mode (design hub-states HubStateFocus): the focused pane fills the area;
// every sibling collapses to a card in the "Minimized · N" strip. Clicking a card
// swaps focus to it; Esc or "Show all panes" exits focus mode.
function FocusLayout({ group, leaves }: { group: Group; leaves: string[] }) {
  const focusSession = useStore((s) => s.focusSession);
  const setFocusMode = useOverlay((s) => s.setFocusMode);
  const focused = group.focused as string;
  const others = leaves.filter((s) => s !== focused);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setFocusMode(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [setFocusMode]);

  // Re-fit the (now larger) focused xterm after layout settles.
  useEffect(() => {
    registry.fit(focused);
  }, [focused]);

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0, gap: 1, background: "var(--bd-soft)" }}>
      <div className="pane-leaf focused" data-session={focused} style={{ flex: 1, minWidth: 0 }}>
        <PaneHead session={focused} index={leaves.indexOf(focused)} />
        <div className="pane-body">
          <PaneMount session={focused} />
        </div>
      </div>
      <div
        style={{
          width: 208,
          flexShrink: 0,
          background: "var(--bg-1)",
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--bd-soft)",
        }}
      >
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--bd-soft)" }}>
          <span className="lbl">Minimized · {others.length}</span>
        </div>
        {others.map((s) => (
          <MiniPane key={s} session={s} index={leaves.indexOf(s)} onClick={() => focusSession(s)} />
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ padding: "8px 12px", borderTop: "1px solid var(--bd-soft)" }}>
          <button
            type="button"
            onClick={() => setFocusMode(false)}
            style={{
              width: "100%",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--bd-soft)",
              background: "var(--bg-2)",
              color: "var(--fg-1)",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {Ico.grid}
            Show all panes
            <span className="kbd">Esc</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function MiniPane({
  session,
  index,
  onClick,
}: { session: string; index: number; onClick: () => void }) {
  const meta = useStore((s) => s.sessionMeta[session]);
  const activity = useStore((s) => s.sessionActivity[session]);
  const awaiting = useStore((s) => s.pendingPrompts.some((p) => p.session === session));
  if (!meta) return null;
  const working = activity?.state === "working";
  const status = awaiting ? "wait" : working ? "live" : "idle";
  const accent = `var(--a-${meta.cli})`;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: "left",
        padding: "8px 12px",
        borderBottom: "1px solid var(--bd-soft)",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        cursor: "pointer",
        background: "transparent",
        border: "none",
        borderBottomWidth: 1,
        borderBottomStyle: "solid",
        borderBottomColor: "var(--bd-soft)",
        width: "100%",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--fg-3)",
            background: "var(--bg-3)",
            padding: "0 4px",
            borderRadius: 3,
            minWidth: 14,
            textAlign: "center",
          }}
        >
          {index + 1}
        </span>
        <AgentGlyph agent={meta.cli} size={11} color={accent} />
        <span
          className="mono"
          style={{
            fontSize: 12,
            color: "var(--fg-1)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
            flex: 1,
          }}
        >
          {meta.alias}
        </span>
        <StatusDot status={status} pulse={working} />
      </div>
    </button>
  );
}
