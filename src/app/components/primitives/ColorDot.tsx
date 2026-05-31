import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PANE_COLORS } from "../../lib/tree";
import { Tip } from "./Tip";

// Shared color-picker dot — ONE mechanism for pane heads, group tabs, and
// workspace tabs. A small round swatch that opens the PANE_COLORS palette; the
// element it lives on takes the picked color as a full fill (the caller does
// that). `display` is what the dot shows (the contrast ink on a color-filled
// surface, so it never clashes with the fill); `selected` is the currently-
// picked color used to ring the active swatch. `pulse`/`ring` carry live state
// on the pane head.
//
// The palette is PORTALED to <body> with fixed positioning so it floats above
// the terminal grid — a same-stacking-context absolute popover was painting
// BEHIND the pane below the group/workspace tab strips.
export function ColorDot({
  selected,
  display,
  onPick,
  title = "Color",
  size = 10,
  pulse = false,
  ring,
  border,
  align = "left",
  allowDefault = true,
}: {
  selected?: string;
  display?: string;
  onPick: (color?: string) => void;
  title?: string;
  size?: number;
  pulse?: boolean;
  ring?: string;
  border?: string;
  align?: "left" | "right";
  allowDefault?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    // A scroll or resize would detach the fixed popover from its anchor — just
    // close it rather than chase the moving target.
    const onMove = () => setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  const dotBg = display ?? selected ?? "var(--bg-3)";

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!open && anchorRef.current) setRect(anchorRef.current.getBoundingClientRect());
    setOpen((v) => !v);
  };

  return (
    <>
      <Tip text={title}>
        <button
          ref={anchorRef}
          type="button"
          onClick={toggle}
          style={{
            width: size,
            height: size,
            borderRadius: "50%",
            padding: 0,
            flexShrink: 0,
            cursor: "pointer",
            background: dotBg,
            border: border ?? `1px solid color-mix(in oklab, ${dotBg} 62%, black)`,
            boxShadow: ring ? `0 0 0 3px ${ring}` : "none",
            animation: pulse ? "ch-pulse 2s ease-in-out infinite" : "none",
          }}
        />
      </Tip>
      {open &&
        rect &&
        createPortal(
          <div
            ref={popRef}
            style={{
              position: "fixed",
              top: rect.bottom + 6,
              ...(align === "right"
                ? { right: Math.max(8, window.innerWidth - rect.right) }
                : { left: Math.max(8, rect.left) }),
              zIndex: 1000,
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 6,
              padding: 8,
              background: "var(--bg-2)",
              border: "1px solid var(--bd)",
              borderRadius: 8,
              boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
            }}
          >
            {PANE_COLORS.map((c) => (
              <Tip key={c.bg} text={c.bg}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPick(c.bg);
                    setOpen(false);
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = "scale(1.18)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = "scale(1)";
                  }}
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    border: c.bg === selected ? "2px solid var(--fg-0)" : "1px solid var(--bd)",
                    padding: 0,
                    background: c.bg,
                    cursor: "pointer",
                    transition: "transform .1s ease",
                  }}
                />
              </Tip>
            ))}
            {allowDefault && (
              <Tip text="Default — clear the custom color">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPick(undefined);
                    setOpen(false);
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-3)";
                    e.currentTarget.style.color = "var(--fg-0)";
                    e.currentTarget.style.borderColor = "var(--bd-strong)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "var(--bg-1)";
                    e.currentTarget.style.color = "var(--fg-1)";
                    e.currentTarget.style.borderColor = selected ? "var(--bd)" : "var(--fg-2)";
                  }}
                  style={{
                    gridColumn: "1 / -1",
                    marginTop: 2,
                    padding: "4px 6px",
                    fontSize: "var(--fs-11)",
                    borderRadius: 5,
                    border: !selected ? "1px solid var(--fg-2)" : "1px solid var(--bd)",
                    background: "var(--bg-1)",
                    color: "var(--fg-1)",
                    cursor: "pointer",
                    transition: "background .12s ease, color .12s ease, border-color .12s ease",
                  }}
                >
                  Default
                </button>
              </Tip>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
