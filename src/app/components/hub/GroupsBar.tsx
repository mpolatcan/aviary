import { useEffect, useRef, useState } from "react";
import { confirmCloseGroup, useStore } from "../../lib/store";
import {
  GROUP_COLORS,
  type Group,
  MAX_GROUP_PANES,
  type Workspace,
  leavesList,
} from "../../lib/tree";
import { IconBtn } from "../primitives/IconBtn";
import { Ico } from "../primitives/icons";

// Pane-group tab strip for the active workspace (design/screens/main-hub-a.jsx
// `GroupsBar`). Sits between the workspace tab bar and the grid. Each group owns
// its own split tree + focus; selecting a group swaps the grid. The "+" adds an
// empty group (its grid shows the empty-state CTA). Carved tab styling + the
// per-group color accent mirror the design.
export function GroupsBar({ ws }: { ws: Workspace }) {
  const addGroup = useStore((s) => s.addGroup);
  const setActiveGroup = useStore((s) => s.setActiveGroup);
  const groups = ws.groups;

  return (
    <div
      style={{
        height: 32,
        flexShrink: 0,
        display: "flex",
        alignItems: "stretch",
        borderBottom: "1px solid var(--bd-soft)",
        background: "var(--bg-1)",
        paddingLeft: 8,
      }}
    >
      {groups.map((g) => (
        <GroupTab
          key={g.id}
          ws={ws}
          group={g}
          active={g.id === ws.activeGroupId}
          onSelect={() => setActiveGroup(ws.id, g.id)}
        />
      ))}
      <IconBtn
        title="Add group"
        onClick={() => addGroup(ws.id)}
        style={{ alignSelf: "center", marginLeft: 6, width: 22, height: 22 }}
      >
        {Ico.plus}
      </IconBtn>
      <div style={{ flex: 1 }} />
      <span
        className="mono"
        style={{ alignSelf: "center", fontSize: 10, color: "var(--fg-3)", padding: "0 10px" }}
      >
        {groups.length} group{groups.length === 1 ? "" : "s"}
      </span>
    </div>
  );
}

function GroupTab({
  ws,
  group,
  active,
  onSelect,
}: {
  ws: Workspace;
  group: Group;
  active: boolean;
  onSelect: () => void;
}) {
  const renameGroup = useStore((s) => s.renameGroup);
  const closeGroup = useStore((s) => s.closeGroup);
  const count = leavesList(group.root).length;
  const full = count >= MAX_GROUP_PANES;
  const [editing, setEditing] = useState(false);

  const close = (e: React.MouseEvent) => {
    e.stopPropagation();
    // One confirmation covering every working pane in the group (not one per).
    if (!confirmCloseGroup(leavesList(group.root), group.name)) return;
    void closeGroup(ws.id, group.id);
  };

  return (
    <div
      onClick={onSelect}
      onDoubleClick={() => setEditing(true)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "0 10px 0 6px",
        height: "100%",
        borderRight: "1px solid var(--bd-soft)",
        background: active ? "var(--bg-2)" : "transparent",
        color: active ? "var(--fg-0)" : "var(--fg-2)",
        cursor: "pointer",
        position: "relative",
        fontSize: 12,
        boxShadow: active
          ? "inset 0 1px 3px rgba(0,0,0,0.35), inset 0 0 0 1px var(--bd-soft)"
          : "none",
      }}
    >
      {active && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            background: group.color,
          }}
        />
      )}
      <ColorDot ws={ws} group={group} />
      {editing ? (
        <input
          className="pane-name-input"
          defaultValue={group.name}
          // biome-ignore lint/a11y/noAutofocus: rename input is opened by an explicit user action
          autoFocus
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            renameGroup(ws.id, group.id, e.currentTarget.value);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              renameGroup(ws.id, group.id, e.currentTarget.value);
              setEditing(false);
            } else if (e.key === "Escape") {
              setEditing(false);
            }
          }}
          style={{
            width: 90,
            background: "var(--bg-0)",
            border: "1px solid var(--bd)",
            borderRadius: 4,
            color: "var(--fg-0)",
            font: "inherit",
            padding: "1px 4px",
          }}
        />
      ) : (
        <span style={{ fontWeight: active ? 500 : 400 }}>{group.name}</span>
      )}
      <span
        className="mono"
        title={full ? "Group at pane capacity" : `${count} pane${count === 1 ? "" : "s"}`}
        style={{
          fontSize: 10,
          color: full ? "var(--wait)" : "var(--fg-3)",
          background: full ? "color-mix(in oklab, var(--wait) 14%, transparent)" : "transparent",
          border: full ? "1px solid color-mix(in oklab, var(--wait) 30%, transparent)" : "none",
          borderRadius: 999,
          padding: full ? "1px 5px" : 0,
          lineHeight: 1,
        }}
      >
        {full ? `${count}/${MAX_GROUP_PANES}` : count}
      </span>
      <IconBtn title="Close group" onClick={close} style={{ width: 18, height: 18, marginLeft: 4 }}>
        {Ico.close}
      </IconBtn>
    </div>
  );
}

// Small clickable color swatch → a palette popover (design ColorDot). Recolors
// the group's accent line.
function ColorDot({ ws, group }: { ws: Workspace; group: Group }) {
  const setGroupColor = useStore((s) => s.setGroupColor);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        title="Group color"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          border: "none",
          padding: 0,
          background: group.color,
          cursor: "pointer",
        }}
      />
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 30,
            display: "flex",
            gap: 6,
            padding: 7,
            background: "var(--bg-2)",
            border: "1px solid var(--bd)",
            borderRadius: 6,
            boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
          }}
        >
          {GROUP_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setGroupColor(ws.id, group.id, c);
                setOpen(false);
              }}
              style={{
                width: 16,
                height: 16,
                borderRadius: "50%",
                border: c === group.color ? "2px solid var(--fg-0)" : "1px solid var(--bd)",
                padding: 0,
                background: c,
                cursor: "pointer",
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
