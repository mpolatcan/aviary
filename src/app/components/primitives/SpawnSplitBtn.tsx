import { useEffect, useRef, useState } from "react";
import { activeWorkspace, useStore } from "../../lib/store";
import { MAX_GROUP_PANES, type SplitDir, activeGroup, leavesList } from "../../lib/tree";
import { Tip } from "./Tip";
import { Ico } from "./icons";

// THE primary spawn CTA for the Hub ActionBar — one button replacing the old
// "Split right + Split down + New agent" trio (design/components.jsx
// `SpawnSplitBtn`). Left half drops a configuring pane at the default placement;
// the chevron half opens a placement popover for explicit targets.
//
// Default click follows the design: split right from the focused pane → a
// configuring pane there. No focused pane (empty workspace) → a new workspace
// with a configuring first pane. The placement menu also offers "In new group"
// (⌘⇧N). Configuration happens IN the pane (no modal).
export function SpawnSplitBtn() {
  const beginSplitSpawn = useStore((s) => s.beginSplitSpawn);
  const beginGroupSpawn = useStore((s) => s.beginGroupSpawn);
  const beginNewWorkspaceSpawn = useStore((s) => s.beginNewWorkspaceSpawn);
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
    beginNewWorkspaceSpawn();
  };
  const split = (dir: SplitDir) => {
    if (!focused || groupFull) return;
    setOpen(false);
    beginSplitSpawn(focused, dir);
  };
  // Primary "New agent" auto-places into the active group's even grid; a manual
  // split (the placement menu) is the freeform escape hatch.
  const primary = () => {
    if (groupFull) newGroup();
    else if (active && group) {
      setOpen(false);
      beginGroupSpawn(active.id, group.id);
    } else newTab();
  };
  // Spawn into a fresh group: create the empty group (becomes active), then drop
  // a configuring pane as that group's first pane.
  const newGroup = () => {
    if (!active) return;
    setOpen(false);
    const gid = addGroup(active.id);
    beginGroupSpawn(active.id, gid);
  };

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <Tip
        text={
          groupFull
            ? `Group full (${MAX_GROUP_PANES}/${MAX_GROUP_PANES}) — add agent in a new group (⌘⇧N)`
            : "New agent — fills the next grid cell (⌘N)"
        }
      >
        <button type="button" className="spawn-half spawn-main" onClick={primary}>
          {Ico.plus}
          {groupFull ? "New group" : "New agent"}
          <span className="kbd">{groupFull ? "⌘⇧N" : "⌘N"}</span>
        </button>
      </Tip>
      <Tip text="Placement options">
        <button
          type="button"
          className={`spawn-half spawn-chev${open ? " open" : ""}`}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {Ico.chevD}
        </button>
      </Tip>
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
        fontSize: "var(--fs-13)",
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
        <span className="lbl" style={{ fontSize: "var(--fs-10)" }}>
          Placement
        </span>
      </div>
      <SpawnMenuRow
        icon={Ico.splitV}
        label="Split vertically"
        kbd="⌘\"
        disabled={!focused || groupFull}
        onClick={() => onSplit("row")}
      />
      <SpawnMenuRow
        icon={Ico.splitH}
        label="Split horizontally"
        kbd="⌘⇧\"
        disabled={!focused || groupFull}
        onClick={() => onSplit("col")}
      />
      {groupFull && (
        <div
          className="mono"
          style={{ padding: "5px 8px", fontSize: "var(--fs-11)", color: "var(--fg-3)" }}
        >
          Active group is full ({MAX_GROUP_PANES}/{MAX_GROUP_PANES}).
        </div>
      )}
      <div style={{ height: 1, background: "var(--bd-soft)", margin: "4px 0" }} />
      <SpawnMenuRow
        icon={Ico.grid}
        label="In new group"
        kbd="⌘⇧N"
        disabled={!hasWorkspace}
        onClick={onNewGroup}
      />
      <SpawnMenuRow icon={Ico.plus} label="New workspace" kbd="⌘T" onClick={onNewTab} />
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
