import { useState } from "react";
import { ColorDot } from "../components/primitives/ColorDot";
import { IconBtn } from "../components/primitives/IconBtn";
import { StatusBadge } from "../components/primitives/StatusBadge";
import { Tip } from "../components/primitives/Tip";
import { Ico } from "../components/primitives/icons";
import { deriveLiveStatus } from "../lib/activity";
import { MODE_BY_ID } from "../lib/catalog";
import { useOverlay } from "../lib/overlay";
import { confirmCloseRunningSession, useStore } from "../lib/store";
import { leavesList, paneInk } from "../lib/tree";
import { Input } from "../ui/input";

// Pane header, visually aligned with design/screens/main-hub-a.jsx: index + a
// status dot that doubles as the color picker (ColorDot) + colored pane title +
// badges, then expand/more/close. When the user picks a color the WHOLE bar takes
// that fill and every control flips to the paired contrast ink (PANE_COLORS), so
// the title and buttons stay legible in all three themes. The telemetry strip
// lives at the pane FOOTER now (PaneFoot), not here.
export function PaneHead({
  session,
  draggable,
  onDragStart,
  onDragEnd,
  onMenu,
}: {
  session: string;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  // Opens the pane context menu (split/spawn/close) at the ⋯ button. Supplied by
  // the grid leaf, which owns the menu position state.
  onMenu?: (e: React.MouseEvent) => void;
}) {
  const meta = useStore((s) => s.sessionMeta[session]);
  const activity = useStore((s) => s.sessionActivity[session]);
  const focused = useStore((s) =>
    s.workspaces.some((w) => w.groups.some((g) => g.focused === session)),
  );
  const siblings = useStore((s) => {
    for (const w of s.workspaces)
      for (const g of w.groups) {
        const ls = leavesList(g.root);
        if (ls.includes(session)) return ls.length;
      }
    return 1;
  });
  const awaiting = useStore((s) => s.pendingPrompts.some((p) => p.session === session));
  const closeSession = useStore((s) => s.closeSession);
  const renameSession = useStore((s) => s.renameSession);
  const setSessionColor = useStore((s) => s.setSessionColor);
  const focusSession = useStore((s) => s.focusSession);
  const focusMode = useOverlay((s) => s.focusMode);
  const setFocusMode = useOverlay((s) => s.setFocusMode);
  const [editing, setEditing] = useState(false);

  if (!meta) return null;

  const accent = `var(--a-${meta.cli})`;
  const badge = MODE_BY_ID[meta.mode].badge;
  // Shared, hook-truth status (thinking / running <tool> / finished / failed /
  // idle) — not the raw byte-flow signal, so a spinner redraw no longer reads as
  // "working" and a thinking agent no longer reads as "idle".
  const view = activity ? deriveLiveStatus(activity, awaiting) : null;
  const working = view?.status === "live";
  // Live state shown beside the title (omit while idle / awaiting — awaiting has
  // its own badge).
  const liveLabel = !awaiting && view && view.status !== "idle" ? view.label : null;
  const liveColor =
    view?.status === "done" ? "var(--done)" : view?.status === "err" ? "var(--err)" : "var(--live)";
  const statusText = awaiting
    ? "Awaiting input"
    : view
      ? view.label.charAt(0).toUpperCase() + view.label.slice(1)
      : "Idle";
  const canMax = siblings > 1;
  const isMax = focusMode && focused && canMax;

  // A user-picked color fills the whole bar; `ink` is its paired contrast
  // foreground (title + every control). The agent accent is the fallback and
  // drives the left identity rail when no color is picked.
  const tint = meta.color;
  const ink = paneInk(tint);
  const railColor = tint ?? accent;
  const headBg =
    tint ?? (awaiting ? `color-mix(in oklab, ${accent} 22%, var(--bg-1))` : "var(--bg-1)");
  const titleColor = ink ?? "var(--fg-0)";
  const headBorder = tint
    ? `1px solid color-mix(in oklab, ${ink} 28%, transparent)`
    : awaiting
      ? `1px solid color-mix(in oklab, ${accent} 40%, var(--bd-soft))`
      : "1px solid var(--bd-soft)";
  // Shared control recolor while tinted — recolors expand/more/close to the ink.
  const tintBtn = ink
    ? {
        idleColor: `color-mix(in oklab, ${ink} 78%, transparent)`,
        hoverColor: ink,
        hoverBg: `color-mix(in oklab, ${ink} 16%, transparent)`,
      }
    : {};

  return (
    <div
      style={{
        flex: "0 0 auto",
        background: headBg,
        borderBottom: headBorder,
        color: ink ?? "var(--fg-1)",
        // Agent-identity rail: full color when this pane is focused, dimmed
        // otherwise — a clear focused-vs-background read the lone status dot
        // can't carry. Uses the picked color when set, else the agent accent.
        borderLeft: `3px solid ${
          focused ? railColor : `color-mix(in oklab, ${railColor} 38%, transparent)`
        }`,
        userSelect: "none",
      }}
    >
      <div
        className="ch-pane-head"
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "7px 12px",
          cursor: draggable ? "grab" : undefined,
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
          {/* The status dot IS the color picker: it carries live state
              (pulse/ring) and clicking it recolors the whole pane. On a colored
              bar it shows the contrast ink (not the agent accent) so it never
              clashes with the fill; on a neutral bar it shows the agent accent.
              One dot instead of a separate swatch — same mechanism as the group
              and workspace tabs. */}
          <ColorDot
            size={12}
            display={ink ?? accent}
            selected={meta.color}
            onPick={(c) => setSessionColor(session, c)}
            pulse={working}
            ring={
              working || awaiting
                ? `color-mix(in oklab, ${ink ?? accent} 22%, transparent)`
                : undefined
            }
            border={
              ink
                ? `1px solid color-mix(in oklab, ${ink} 45%, transparent)`
                : `1px solid color-mix(in oklab, ${accent} 60%, black)`
            }
            title={`${statusText} · click to set pane color`}
          />
          {editing ? (
            <Input
              className="pane-name-input h-auto w-[12ch]"
              defaultValue={meta.alias}
              maxLength={32}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => {
                renameSession(session, e.currentTarget.value);
                setEditing(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  renameSession(session, e.currentTarget.value);
                  setEditing(false);
                } else if (e.key === "Escape") {
                  setEditing(false);
                }
              }}
            />
          ) : (
            <Tip text="Double-click to rename">
              <span
                className="mono ch-rename"
                style={{
                  fontFamily: '"JetBrainsMono Terminal", Menlo, monospace',
                  fontSize: "var(--fs-13)",
                  color: titleColor,
                  fontWeight: 600,
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setEditing(true);
                }}
              >
                {meta.alias}
              </span>
            </Tip>
          )}
        </span>

        {badge && <span className={`mode-badge badge-${meta.mode}`}>{badge}</span>}
        {awaiting && <StatusBadge status="wait">Awaiting</StatusBadge>}
        {liveLabel && (
          <span className="mono" style={{ fontSize: "var(--fs-11)", color: liveColor }}>
            {liveLabel}
          </span>
        )}

        <span style={{ flex: 1 }} />

        <IconBtn
          title={isMax ? "Restore split" : canMax ? "Maximize pane" : "Maximize — split first"}
          active={isMax}
          disabled={!canMax}
          size={22}
          {...tintBtn}
          onClick={(e) => {
            e.stopPropagation();
            if (isMax) {
              setFocusMode(false);
            } else {
              focusSession(session);
              setFocusMode(true);
            }
          }}
        >
          {isMax ? Ico.grid : Ico.expand}
        </IconBtn>
        <IconBtn
          title="Pane menu — spawn, split, close"
          size={22}
          {...tintBtn}
          onClick={(e) => {
            e.stopPropagation();
            onMenu?.(e);
          }}
        >
          {Ico.more}
        </IconBtn>
        <IconBtn
          title="Close session (⌘W)"
          danger={!ink}
          size={22}
          {...tintBtn}
          onClick={(e) => {
            e.stopPropagation();
            if (!confirmCloseRunningSession(session)) return;
            void closeSession(session);
          }}
        >
          {Ico.close}
        </IconBtn>
      </div>
    </div>
  );
}
