import { useState } from "react";
import { confirmCloseGroup, useStore } from "../../lib/store";
import { type Group, MAX_GROUP_PANES, type Workspace, leavesList } from "../../lib/tree";
import { Input } from "../../ui/input";
import { ColorDot } from "../primitives/ColorDot";
import { IconBtn } from "../primitives/IconBtn";
import { Tip } from "../primitives/Tip";
import { Ico } from "../primitives/icons";

// Pane-group tab strip for the active workspace (design/screens/main-hub-a.jsx
// `GroupsBar`). Sits between the workspace tab bar and the grid, flush-left and
// aligned with it. A subtle inset top shadow makes it read as RECESSED into the
// workspace bar above (carved-in) — no window-spanning colored frames. Group
// tabs match the workspace tabs: active = square raised surface + a thin top
// accent line in its color + a ColorDot for identity.
export function GroupsBar({ ws }: { ws: Workspace }) {
  const addGroup = useStore((s) => s.addGroup);
  const setActiveGroup = useStore((s) => s.setActiveGroup);
  const groups = ws.groups;

  return (
    <div
      style={{
        height: 30,
        flexShrink: 0,
        display: "flex",
        alignItems: "stretch",
        borderBottom: "1px solid var(--bd-soft)",
        background: "var(--bg-1)",
        // Recessed into the workspace bar above — a subtle "carved in" cue
        // (no window-spanning colored frame).
        boxShadow: "inset 0 4px 6px -4px rgba(0,0,0,0.55)",
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
        size={22}
        style={{ alignSelf: "center", marginLeft: 6 }}
      >
        {Ico.plus}
      </IconBtn>
      <div style={{ flex: 1 }} />
      {groups.length > 1 && (
        <span
          className="mono"
          style={{
            alignSelf: "center",
            fontSize: "var(--fs-10)",
            color: "var(--fg-3)",
            padding: "0 10px",
          }}
        >
          {groups.length} groups
        </span>
      )}
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
  const setGroupColor = useStore((s) => s.setGroupColor);
  const count = leavesList(group.root).length;
  const full = count >= MAX_GROUP_PANES;
  const [editing, setEditing] = useState(false);

  // Active = raised neutral surface (no tint) with a square top accent line in
  // the group color; identity lives on the ColorDot. Square, flush.
  const accent = group.color;
  const fg = active ? "var(--fg-0)" : "var(--fg-2)";

  const close = (e: React.MouseEvent) => {
    e.stopPropagation();
    // One confirmation covering every working pane in the group (not one per).
    if (!confirmCloseGroup(leavesList(group.root), group.name)) return;
    void closeGroup(ws.id, group.id);
  };

  return (
    <div
      className={`group-tab${active ? " active" : ""}`}
      onClick={onSelect}
      onDoubleClick={() => setEditing(true)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "0 8px",
        height: "100%",
        borderRight: "1px solid var(--bd-soft)",
        ...(active ? { background: "var(--bg-2)", boxShadow: `inset 0 3px 0 ${accent}` } : {}),
        color: fg,
        cursor: "pointer",
        position: "relative",
        fontSize: "var(--fs-12)",
      }}
    >
      <ColorDot
        size={10}
        display={group.color}
        selected={group.color}
        onPick={(c) => c && setGroupColor(ws.id, group.id, c)}
        allowDefault={false}
        title="Group color"
      />
      {editing ? (
        <Input
          className="pane-name-input h-auto"
          defaultValue={group.name}
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
        <Tip text="Double-click to rename">
          <span className="ch-rename" style={{ fontWeight: active ? 500 : 400, color: fg }}>
            {group.name}
          </span>
        </Tip>
      )}
      <Tip text={full ? "Group at pane capacity" : `${count} pane${count === 1 ? "" : "s"}`}>
        <span
          className="mono"
          style={{
            fontSize: "var(--fs-10)",
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
      </Tip>
      <Tip text="Close group">
        <button type="button" className="tab-close" onClick={close}>
          {Ico.close}
        </button>
      </Tip>
    </div>
  );
}
