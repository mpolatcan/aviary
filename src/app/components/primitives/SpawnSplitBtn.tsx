import { useEffect, useRef, useState } from "react";
import { groupKey, splitKey, useLauncher } from "../../lib/launcher";
import { activeWorkspace, useStore } from "../../lib/store";
import { MAX_GROUP_PANES, type SplitDir, activeGroup, leavesList } from "../../lib/tree";
import { Ico } from "./icons";

// THE primary spawn CTA for the Hub ActionBar — one button replacing the old
// "Split right + Split down + New agent" trio (design/components.jsx
// `SpawnSplitBtn`). Left half opens the launcher at the default placement; the
// chevron half opens a placement popover for explicit targets.
//
// Default click follows the design: split right from the focused pane. When no
// pane is focused (empty workspace / no tab), it falls back to the new-tab
// launcher. The placement menu also offers "In new group" (⌘G) — creates a
// fresh pane group and lands the agent in it.
export function SpawnSplitBtn() {
  const openLaunch = useLauncher((s) => s.open);
  const addGroup = useStore((s) => s.addGroup);
  const active = useStore(activeWorkspace);
  const group = active ? activeGroup(active) : null;
  const focused = group?.focused ?? null;
  const groupFull = group ? leavesList(group.root).length >= MAX_GROUP_PANES : false;
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

  const newTab = () => {
    setOpen(false);
    openLaunch("newtab");
  };
  const split = (dir: SplitDir) => {
    if (!focused || groupFull) return;
    setOpen(false);
    openLaunch(splitKey(focused), { dir, session: focused });
  };
  const primary = () => {
    if (groupFull) newGroup();
    else if (focused) split("row");
    else newTab();
  };
  // Spawn into a fresh group: create the empty group (becomes active), then open
  // the launcher targeting it so the new agent lands as that group's first pane.
  const newGroup = () => {
    if (!active) return;
    setOpen(false);
    const gid = addGroup(active.id);
    openLaunch(groupKey(gid), { dir: "row", groupId: gid, workspaceId: active.id });
  };

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        className="spawn-half spawn-main"
        title={
          groupFull
            ? `Group full (${MAX_GROUP_PANES}/${MAX_GROUP_PANES}) — add agent in a new group (⌘G)`
            : focused
              ? "New agent — split right (⌘A)"
              : "New agent — new tab (⌘N)"
        }
        onClick={primary}
      >
        {Ico.plus}
        {groupFull ? "New group" : "New agent"}
        <span className="kbd">{groupFull ? "⌘G" : focused ? "⌘A" : "⌘N"}</span>
      </button>
      <button
        type="button"
        className={`spawn-half spawn-chev${open ? " open" : ""}`}
        title="Placement options"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {Ico.chevD}
      </button>
      {open && (
        <SpawnPlacementMenu
          focused={focused}
          groupFull={groupFull}
          hasWorkspace={!!active}
          onSplit={split}
          onNewGroup={newGroup}
          onNewTab={newTab}
        />
      )}
    </div>
  );
}

// Popover anchored to the chevron half. Split rows act on the focused pane and
// are disabled when nothing is focused (an empty workspace can't be split).
function SpawnPlacementMenu({
  focused,
  groupFull,
  hasWorkspace,
  onSplit,
  onNewGroup,
  onNewTab,
}: {
  focused: string | null;
  groupFull: boolean;
  hasWorkspace: boolean;
  onSplit: (dir: SplitDir) => void;
  onNewGroup: () => void;
  onNewTab: () => void;
}) {
  return (
    <div
      style={{
        position: "absolute",
        bottom: "calc(100% + 7px)",
        right: 0,
        minWidth: 240,
        zIndex: 30,
        background: "var(--bg-2)",
        border: "1px solid var(--bd)",
        borderRadius: 6,
        boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
        padding: 5,
        fontSize: 13,
        color: "var(--fg-1)",
      }}
    >
      <div
        style={{
          padding: "4px 8px",
          display: "flex",
          borderBottom: "1px solid var(--bd-soft)",
          marginBottom: 4,
        }}
      >
        <span className="lbl" style={{ fontSize: 10 }}>
          Placement
        </span>
      </div>
      <SpawnMenuRow
        icon={Ico.splitV}
        label="Split right"
        kbd="⌘\"
        disabled={!focused || groupFull}
        onClick={() => onSplit("row")}
      />
      <SpawnMenuRow
        icon={Ico.splitH}
        label="Split down"
        kbd="⌘⇧\"
        disabled={!focused || groupFull}
        onClick={() => onSplit("col")}
      />
      {groupFull && (
        <div className="mono" style={{ padding: "5px 8px", fontSize: 10.5, color: "var(--fg-3)" }}>
          Active group is full ({MAX_GROUP_PANES}/{MAX_GROUP_PANES}).
        </div>
      )}
      <div style={{ height: 1, background: "var(--bd-soft)", margin: "4px 0" }} />
      <SpawnMenuRow
        icon={Ico.grid}
        label="In new group"
        kbd="⌘G"
        disabled={!hasWorkspace}
        onClick={onNewGroup}
      />
      <SpawnMenuRow icon={Ico.plus} label="Open in new tab" kbd="⌘⇧T" onClick={onNewTab} />
    </div>
  );
}

function SpawnMenuRow({
  icon,
  label,
  kbd,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  kbd: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className="ctx-row"
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
    >
      <span style={{ display: "inline-flex", color: "var(--fg-2)", width: 14 }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      <span className="kbd">{kbd}</span>
    </div>
  );
}
