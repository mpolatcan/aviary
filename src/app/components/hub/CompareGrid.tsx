import { type CSSProperties, useState } from "react";
import { IconBtn } from "../../components/primitives/IconBtn";
import { Ico } from "../../components/primitives/icons";
import { useLauncher } from "../../lib/launcher";
import { useOverlay } from "../../lib/overlay";
import { activeWorkspace, useStore } from "../../lib/store";
import { leavesList } from "../../lib/tree";
import { PaneHead } from "../PaneHead";
import { PaneMount } from "../PaneMount";

// Hub B — the compare grid (design/screens/main-hub-b.jsx). Instead of the
// per-workspace split tree, every live session across every workspace is tiled
// as its own pane so agents can be watched side-by-side. Each tile reuses the
// same PaneHead + reparented xterm surface (PaneMount) as the split grid; only
// the layout differs, so panes/buffers survive a tabs↔grid toggle untouched.
//
// The topbar ("Comparing N sessions", layout selector, search, new-agent, bell)
// is ported from the design. The bell dot is REAL — fed by pending_prompts (←
// agent-native hooks, §7); empty until the BE track lands. The layout selector
// (2×2 / 1×4 / 3+1) only changes the CSS grid template — buffers are untouched.
type LayoutMode = "grid" | "row" | "spotlight";

// The CSS for each layout, given the tile count.
function gridStyle(mode: LayoutMode, n: number): CSSProperties {
  if (mode === "row") {
    // 1×N strip — one row, every tile side-by-side.
    return { gridTemplateColumns: `repeat(${Math.max(1, n)}, 1fr)`, gridTemplateRows: "1fr" };
  }
  if (mode === "spotlight" && n >= 2) {
    // 3+1: a large primary spanning the left, the rest stacked on the right.
    return {
      gridTemplateColumns: "2fr 1fr",
      gridTemplateRows: `repeat(${n - 1}, 1fr)`,
    };
  }
  // 2×2 (default): square-ish — ceil(sqrt(n)) columns.
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  return { gridTemplateColumns: `repeat(${cols}, 1fr)` };
}

// In spotlight mode the first tile spans the full column of rows on the left.
function tileStyle(mode: LayoutMode, index: number, n: number): CSSProperties | undefined {
  if (mode === "spotlight" && n >= 2 && index === 0) {
    return { gridColumn: "1", gridRow: `1 / span ${n - 1}` };
  }
  if (mode === "spotlight" && n >= 2) {
    return { gridColumn: "2" };
  }
  return undefined;
}

export function CompareGrid() {
  const workspaces = useStore((s) => s.workspaces);
  const focused = useStore((s) => activeWorkspace(s)?.focused);
  const focusSession = useStore((s) => s.focusSession);
  const openLaunch = useLauncher((s) => s.open);
  const togglePalette = useOverlay((s) => s.togglePalette);
  const pendingCount = useStore((s) => s.pendingPrompts.length);
  const [mode, setMode] = useState<LayoutMode>("grid");

  // Flatten every workspace's leaves into one ordered list of sessions.
  const sessions = workspaces.flatMap((ws) => leavesList(ws.root));
  const n = sessions.length;

  return (
    <>
      {/* topbar */}
      <div
        style={{
          height: 48,
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "0 16px",
          borderBottom: "1px solid var(--bd-soft)",
          background: "var(--bg-1)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11.5, color: "var(--fg-1)", letterSpacing: "0.04em" }}>
            Comparing
          </span>
          <span className="mono tnum" style={{ fontSize: 13, color: "var(--fg-0)" }}>
            {n} session{n === 1 ? "" : "s"}
          </span>
        </div>
        <span className="vr" style={{ height: 16 }} />
        <div style={{ display: "flex", gap: 4 }}>
          <LayoutBtn label="2×2" active={mode === "grid"} onClick={() => setMode("grid")} />
          <LayoutBtn label="1×N" active={mode === "row"} onClick={() => setMode("row")} />
          <LayoutBtn
            label="3 + 1"
            active={mode === "spotlight"}
            onClick={() => setMode("spotlight")}
          />
        </div>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => togglePalette()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 9px",
            borderRadius: 6,
            border: "1px solid var(--bd-soft)",
            background: "transparent",
            color: "var(--fg-2)",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          {Ico.search}
          <span>Search</span>
          <span className="kbd">⌘K</span>
        </button>
        <button
          type="button"
          onClick={() => openLaunch("newtab")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 9px",
            borderRadius: 6,
            border: "1px solid var(--bd)",
            background: "var(--bg-3)",
            color: "var(--fg-0)",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          {Ico.plus}
          <span>New agent</span>
        </button>
        <IconBtn
          title={
            pendingCount > 0
              ? `${pendingCount} session${pendingCount === 1 ? "" : "s"} awaiting input`
              : "No sessions awaiting input"
          }
          active={pendingCount > 0}
        >
          <span style={{ position: "relative", display: "inline-flex" }}>
            {Ico.bell}
            {pendingCount > 0 && (
              <span
                style={{
                  position: "absolute",
                  top: -1,
                  right: -1,
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--wait)",
                }}
              />
            )}
          </span>
        </IconBtn>
      </div>

      {/* tile grid */}
      <div className="compare-grid" style={gridStyle(mode, n)}>
        {sessions.map((session, i) => (
          <div
            key={session}
            className={`pane-leaf${focused === session ? " focused" : ""}`}
            data-session={session}
            onMouseDown={() => focusSession(session)}
            style={tileStyle(mode, i, n)}
          >
            <PaneHead session={session} />
            <div className="pane-body">
              <PaneMount session={session} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function LayoutBtn({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontFamily: "var(--mono)",
        fontSize: 11,
        padding: "4px 8px",
        borderRadius: 5,
        border: "1px solid var(--bd-soft)",
        background: active ? "var(--bg-3)" : "transparent",
        color: active ? "var(--fg-0)" : "var(--fg-2)",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}
