import { motion } from "motion/react";
import { useEffect, useRef } from "react";
import { slideUp } from "../../hooks/useSlideIn";
import { Ico } from "../primitives/icons";

export interface PaneMenuItem {
  icon?: React.ReactNode;
  label: string;
  kbd?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

// Right-click context menu for a pane (design main-hub-a.jsx `PaneFrame menu`).
// Positioned at the cursor; closes on click-away, Escape, scroll, or after a
// pick. Pure presentation — the caller supplies the action list.
export function PaneContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: PaneMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  // Keep the menu on-screen — clamp to the viewport (240px wide, est. row height).
  const left = Math.min(x, window.innerWidth - 232);
  const top = Math.min(y, window.innerHeight - (items.length * 30 + 16));

  return (
    <motion.div
      ref={ref}
      {...slideUp}
      style={{
        position: "fixed",
        left,
        top,
        minWidth: 216,
        zIndex: 60,
        background: "var(--bg-2)",
        border: "1px solid var(--bd)",
        borderRadius: 6,
        boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
        padding: 5,
        fontSize: "var(--fs-13)",
        color: "var(--fg-1)",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((it) =>
        it.label === "—" ? (
          <div
            key={`sep-${it.kbd ?? Math.random()}`}
            style={{ height: 1, background: "var(--bd-soft)", margin: "4px 0" }}
          />
        ) : (
          <div
            key={it.label}
            className="ctx-row"
            aria-disabled={it.disabled || undefined}
            onClick={
              it.disabled
                ? undefined
                : () => {
                    it.onClick();
                    onClose();
                  }
            }
            style={{ color: it.danger ? "var(--err)" : undefined }}
          >
            <span style={{ display: "inline-flex", color: "inherit", width: 14, opacity: 0.85 }}>
              {it.icon ?? Ico.more}
            </span>
            <span style={{ flex: 1 }}>{it.label}</span>
            {it.kbd && <span className="kbd">{it.kbd}</span>}
          </div>
        ),
      )}
    </motion.div>
  );
}
