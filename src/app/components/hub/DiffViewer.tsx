import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { IconBtn } from "../../components/primitives/IconBtn";
import { Tip } from "../../components/primitives/Tip";
import { Ico } from "../../components/primitives/icons";
import { useResizableDock } from "../../hooks/useResizableDock";
import { EASE } from "../../hooks/useSlideIn";
import { ipc } from "../../lib/ipc";
import { activeWorkspace, useStore } from "../../lib/store";
import { DiffBody, diffCounts, parseDiff } from "./DiffBody";
import { ResizeHandle } from "./ResizeHandle";

// A unified diff docked on the right (design/screens/hub-states.jsx DiffPanel),
// toggled from the hub ActionBar (⌘D) or opened on a specific file from the
// activity rail's Changes list. With a path it's one /workspace file
// (container_git_diff); with the empty-string sentinel it's the combined diff of
// every tracked change (container_git_diff_all). Parsing + row rendering live in
// DiffBody, shared with the session-detail inspector.
//
// Read-only: the design's "Stage all / Commit" footer is dropped — CodeHub has
// no staging/commit IPC, so showing those controls would fabricate an action
// that doesn't exist. The agents drive git from inside their panes.

// 22rem — matches the design's DiffPanel width.
const WIDTH = 352;

export function DiffViewer({ path, onClose }: { path: string; onClose: () => void }) {
  const [diff, setDiff] = useState<string | null>(null);
  // The diff is for the active workspace's container.
  const containerKey = useStore((s) => activeWorkspace(s)?.containerKey);
  const { size, dragging, ref, beginResize, reset } = useResizableDock("ch.diff.w", WIDTH, {
    min: 300,
    max: 700,
    edge: "left",
  });

  useEffect(() => {
    let alive = true;
    setDiff(null);
    // Empty-string sentinel → combined diff of every change; a path → that file.
    const load =
      path === ""
        ? ipc.containerGitDiffAll(containerKey)
        : ipc.containerGitDiff(path, containerKey);
    load.then((d) => alive && setDiff(d)).catch(() => alive && setDiff(""));
    return () => {
      alive = false;
    };
  }, [path, containerKey]);

  const counts = diff ? diffCounts(parseDiff(diff)) : null;

  return (
    <motion.aside
      ref={ref}
      initial={{ width: 0 }}
      animate={{ width: size }}
      exit={{ width: 0 }}
      transition={{ duration: dragging ? 0 : 0.28, ease: EASE }}
      style={{ flexShrink: 0, overflow: "hidden", position: "relative" }}
    >
      {/* fixed-width inner so content doesn't reflow while the outer width animates */}
      <div
        style={{
          width: size,
          height: "100%",
          background: "var(--bg-1)",
          borderLeft: "1px solid var(--bd-soft)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          color: "var(--fg-1)",
        }}
      >
        <div
          style={{
            padding: "8px 10px",
            borderBottom: "1px solid var(--bd-soft)",
            display: "flex",
            alignItems: "center",
            gap: 7,
          }}
        >
          <span style={{ color: "var(--wait)", display: "inline-flex" }}>{Ico.diff}</span>
          <Tip text={path === "" ? "All tracked changes" : path}>
            <span
              className="mono"
              style={{
                fontSize: "var(--fs-12)",
                fontWeight: 500,
                color: "var(--fg-0)",
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                direction: path === "" ? "ltr" : "rtl",
                textAlign: "left",
              }}
            >
              {path === "" ? "All changes" : path}
            </span>
          </Tip>
          {counts && (counts.added > 0 || counts.removed > 0) && (
            <span className="mono tnum" style={{ fontSize: "var(--fs-11)", flexShrink: 0 }}>
              <span style={{ color: "var(--live)" }}>+{counts.added}</span>{" "}
              <span style={{ color: "var(--err)" }}>−{counts.removed}</span>
            </span>
          )}
          <IconBtn title="Hide diff panel (⌘D)" onClick={onClose}>
            {Ico.close}
          </IconBtn>
        </div>
        <DiffBody
          diff={diff}
          emptyLabel={
            path === ""
              ? "No tracked changes — the working tree is clean."
              : "No diff to show — the file may be unchanged or binary."
          }
          style={{ flex: 1, minHeight: 0, overflow: "auto" }}
        />
      </div>
      <ResizeHandle edge="left" onMouseDown={beginResize} onDoubleClick={reset} />
    </motion.aside>
  );
}
