import { useState } from "react";
import type { DockEdge } from "../../hooks/useResizableDock";
import { Tip } from "../primitives/Tip";

// Thin drag strip on a dock's docking edge. Invisible at rest; a 1px `--pri`
// line on hover/drag with a widened (7px) hit area + the matching resize cursor.
// Double-click resets the dock to its default size.
export function ResizeHandle({
  edge,
  onMouseDown,
  onDoubleClick,
}: {
  edge: DockEdge;
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
}) {
  const [hot, setHot] = useState(false);
  const isRow = edge === "top"; // resizes height
  const pos: React.CSSProperties =
    edge === "right"
      ? { right: -3, top: 0, bottom: 0, width: 7 }
      : edge === "left"
        ? { left: -3, top: 0, bottom: 0, width: 7 }
        : { top: -3, left: 0, right: 0, height: 7 };
  return (
    <Tip text="Drag to resize · double-click to reset">
      <div
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
        onMouseEnter={() => setHot(true)}
        onMouseLeave={() => setHot(false)}
        style={{
          position: "absolute",
          zIndex: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: isRow ? "row-resize" : "col-resize",
          ...pos,
        }}
      >
        <span
          style={{
            background: "var(--pri)",
            opacity: hot ? 0.7 : 0,
            transition: "opacity .12s",
            ...(isRow ? { height: 1, width: "100%" } : { width: 1, height: "100%" }),
          }}
        />
      </div>
    </Tip>
  );
}
