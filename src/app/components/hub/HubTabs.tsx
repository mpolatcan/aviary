import { useEffect, useRef, useState } from "react";
import { ColorDot } from "../../components/primitives/ColorDot";
import { IconBtn } from "../../components/primitives/IconBtn";
import { Tip } from "../../components/primitives/Tip";
import { Ico } from "../../components/primitives/icons";
import { useOverlay } from "../../lib/overlay";
import { confirmCloseWorkspace, isSpawnPlaceholder, useStore } from "../../lib/store";
import { type Workspace, workspaceLeaves, workspaceTitle } from "../../lib/tree";
import { Input } from "../../ui/input";

// Real agent sessions in a workspace — excludes configuring panes (placeholders
// with no tmux session yet) so the tab count reflects live agents.
const realSessions = (ws: Parameters<typeof workspaceLeaves>[0]) =>
  workspaceLeaves(ws).filter((s) => !isSpawnPlaceholder(s));

// Workspace tab strip, ported from design/screens/main-hub-a.jsx. Each tab is a
// live workspace. The visual anatomy mirrors the design: drag handle, workspace
// color dot, name/repo stack, one state-count chip, close button. The repo label
// is intentionally conservative because CodeHub has one mounted /workspace, not
// the design mock's multi-repo model.
function dirName(path: string | undefined): string | null {
  if (!path) return null;
  return path.split("/").filter(Boolean).pop() ?? null;
}

export function HubTabs() {
  const workspaces = useStore((s) => s.workspaces);
  const activeId = useStore((s) => s.activeWorkspaceId);
  const git = useStore((s) => s.gitStatus);
  const switchWorkspace = useStore((s) => s.switchWorkspace);
  const setPalette = useOverlay((s) => s.setPalette);
  const launcher = useOverlay((s) => s.launcher);
  const setLauncher = useOverlay((s) => s.setLauncher);
  // Awaiting-input signal for the bell dot: any session with a pending prompt
  // (← pending_prompts / live agent-event, §7). Real for Claude/Codex; empty
  // (no dot) for Antigravity and until the BE track lands.
  const pendingPrompts = useStore((s) => s.pendingPrompts);
  const pendingCount = pendingPrompts.length;
  const pendingSessions = pendingPrompts.map((p) => p.session);

  const stripRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(workspaces.length);
  const [overflowOpen, setOverflowOpen] = useState(false);
  // True when the tab strip is scrolled past its viewport (more tabs than fit).
  // Drives the trailing "⌄" overflow affordance (design HubStateTabOverflow).
  const [overflowing, setOverflowing] = useState(false);
  // Scroll-extent flags: hide the ‹ arrow at the far left, the › at the far
  // right, so a dead-end arrow never shows.
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  useEffect(() => {
    const strip = stripRef.current;
    if (strip && workspaces.length > prevCount.current) {
      strip.scrollTo({ left: strip.scrollWidth, behavior: "smooth" });
    }
    prevCount.current = workspaces.length;
  }, [workspaces.length]);

  // Measure overflow + scroll extents whenever tabs change, the strip scrolls,
  // or the window resizes.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const measure = () => {
      setOverflowing(strip.scrollWidth > strip.clientWidth + 4);
      setAtStart(strip.scrollLeft <= 0);
      setAtEnd(strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    strip.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      strip.removeEventListener("scroll", measure);
    };
  }, []);

  // Page the tab strip by ~one tab-width-and-a-half so the back/forward arrows
  // move a predictable chunk (tabs are fixed-width + flexShrink:0, so the strip
  // overflows and scrolls instead of squeezing each tab).
  const scrollTabs = (dir: -1 | 1) => {
    stripRef.current?.scrollBy({ left: dir * 264, behavior: "smooth" });
  };

  return (
    <div
      style={{
        height: "var(--tabbar-h, 40px)",
        display: "flex",
        alignItems: "stretch",
        borderBottom: "1px solid var(--bd-soft)",
        background: "var(--bg-1)",
        flexShrink: 0,
      }}
    >
      {overflowing && !atStart && (
        <IconBtn
          title="Scroll tabs left"
          onClick={() => scrollTabs(-1)}
          style={{ alignSelf: "center", flexShrink: 0 }}
        >
          {Ico.chevL}
        </IconBtn>
      )}
      <div
        ref={stripRef}
        style={{ display: "flex", minWidth: 0, overflowX: "auto", scrollbarWidth: "none" }}
      >
        {workspaces.map((ws) => (
          <WorkspaceTab
            key={ws.id}
            ws={ws}
            // While the launcher tab is showing, NO workspace tab is the active
            // one (the launcher is) — so none render the active fill.
            active={!launcher && ws.id === activeId}
            git={git?.isRepo ?? false}
            pendingSessions={pendingSessions}
            onSelect={() => {
              setLauncher(false);
              switchWorkspace(ws.id);
            }}
          />
        ))}

        {/* Browser-style "new workspace" tab: a chip while the launcher is open,
            the "+" affordance while it's closed. The launcher fills the content
            area below (HubView), so other tabs + the sidebar stay visible. */}
        {launcher ? (
          <Tip text="New workspace — recent, resume, or create">
            <div
              className="ch-tab active"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 8px 0 11px",
                height: "100%",
                borderRight: "1px solid var(--bd-soft)",
                background: "var(--bg-2)",
                color: "var(--fg-0)",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              <span style={{ color: "var(--pri)", display: "inline-flex" }}>{Ico.plus}</span>
              <span style={{ fontSize: "var(--fs-12)", fontWeight: 500 }}>New workspace</span>
              <Tip text="Close (esc)">
                <button
                  type="button"
                  className="tab-close"
                  style={{ marginLeft: 2 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setLauncher(false);
                  }}
                >
                  {Ico.close}
                </button>
              </Tip>
            </div>
          </Tip>
        ) : (
          <Tip text="Open workspace — recent, resume, or new (⌘T)">
            <button
              type="button"
              onClick={() => setLauncher(true)}
              style={{
                alignSelf: "center",
                marginLeft: 6,
                padding: "4px 6px",
                background: "transparent",
                border: "none",
                color: "var(--fg-2)",
                cursor: "pointer",
                display: "inline-flex",
              }}
            >
              {Ico.plus}
            </button>
          </Tip>
        )}
      </div>

      {overflowing && !atEnd && (
        <IconBtn
          title="Scroll tabs right"
          onClick={() => scrollTabs(1)}
          style={{ alignSelf: "center", flexShrink: 0 }}
        >
          {Ico.chevR}
        </IconBtn>
      )}

      <div style={{ flex: 1 }} />

      {/* trailing actions — persistent ⌘K search (design: main-hub-a tab bar)
          + overflow menu (when tabs exceed the strip) + the awaiting-input bell.
          Files / Diff / split / spawn live in the bottom ActionBar, not here. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: "0 8px",
          position: "relative",
        }}
      >
        <Tip text="Search workspaces (⌘K)">
          <button
            type="button"
            onClick={() => setPalette(true)}
            style={{
              alignSelf: "center",
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "4px 7px",
              background: "transparent",
              border: "none",
              color: "var(--fg-2)",
              cursor: "pointer",
              borderRadius: 6,
            }}
          >
            {Ico.search}
            <span className="kbd">⌘K</span>
          </button>
        </Tip>
        {overflowing && (
          <IconBtn
            title="All workspaces"
            active={overflowOpen}
            onClick={() => setOverflowOpen((v) => !v)}
          >
            {Ico.chevD}
          </IconBtn>
        )}
        {overflowOpen && (
          <>
            {/* click-away scrim */}
            <button
              type="button"
              aria-label="Close workspace menu"
              onClick={() => setOverflowOpen(false)}
              style={{
                position: "fixed",
                inset: 0,
                zIndex: 40,
                background: "transparent",
                border: "none",
                cursor: "default",
              }}
            />
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 4px)",
                right: 4,
                width: 280,
                zIndex: 50,
                background: "var(--bg-2)",
                border: "1px solid var(--bd)",
                borderRadius: 8,
                boxShadow: "var(--shadow-2)",
                padding: 6,
              }}
            >
              <div
                style={{
                  padding: "4px 8px",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  borderBottom: "1px solid var(--bd-soft)",
                  marginBottom: 4,
                }}
              >
                <span className="lbl" style={{ fontSize: "var(--fs-10)" }}>
                  Workspaces · {workspaces.length}
                </span>
                <span style={{ flex: 1 }} />
                <span className="mono" style={{ fontSize: "var(--fs-10)", color: "var(--fg-3)" }}>
                  ⌘P
                </span>
              </div>
              {workspaces.map((ws) => {
                const sessions = realSessions(ws);
                const waits = sessions.filter((s) => pendingSessions.includes(s)).length;
                const color = ws.color ?? ws.groups[0]?.color ?? "var(--pri)";
                return (
                  <div
                    key={ws.id}
                    className="ctx-row"
                    onClick={() => {
                      switchWorkspace(ws.id);
                      setOverflowOpen(false);
                    }}
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        background: color,
                        border: `1px solid color-mix(in oklab, ${color} 60%, black)`,
                        flexShrink: 0,
                      }}
                    />
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        lineHeight: 1.15,
                        flex: 1,
                        minWidth: 0,
                      }}
                    >
                      <span
                        className="mono"
                        style={{
                          fontSize: "var(--fs-13)",
                          color: "var(--fg-0)",
                          fontWeight: 500,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {workspaceTitle(ws)}
                      </span>
                      <span
                        className="mono"
                        style={{ fontSize: "var(--fs-10)", color: "var(--fg-3)" }}
                      >
                        {ws.id === activeId && git?.isRepo
                          ? "1 repo"
                          : (dirName(ws.dir) ?? "workspace")}
                      </span>
                    </div>
                    {waits > 0 && (
                      <span
                        className="mono"
                        style={{ fontSize: "var(--fs-10)", color: "var(--wait)" }}
                      >
                        {waits} wait
                      </span>
                    )}
                  </div>
                );
              })}
              <div style={{ borderTop: "1px solid var(--bd-soft)", marginTop: 4, paddingTop: 4 }}>
                <div
                  className="ctx-row"
                  onClick={() => {
                    setOverflowOpen(false);
                    setPalette(true);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    fontSize: "var(--fs-13)",
                  }}
                >
                  {Ico.search}
                  Search workspaces…
                  <span className="kbd" style={{ marginLeft: "auto" }}>
                    ⌘P
                  </span>
                </div>
              </div>
            </div>
          </>
        )}
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
    </div>
  );
}

// One workspace tab. A carved browser tab: the ACTIVE tab is pressed-in (inset
// shadow) over a subtle tint of its color, with a thin top accent bar; inactive
// tabs are flat with the color shown only by the leading ColorDot. Double-click
// the name to rename.
function WorkspaceTab({
  ws,
  active,
  git,
  pendingSessions,
  onSelect,
}: {
  ws: Workspace;
  active: boolean;
  git: boolean;
  pendingSessions: string[];
  onSelect: () => void;
}) {
  const closeWorkspace = useStore((s) => s.closeWorkspace);
  const renameWorkspace = useStore((s) => s.renameWorkspace);
  const setWorkspaceColor = useStore((s) => s.setWorkspaceColor);
  const [editing, setEditing] = useState(false);

  const sessions = realSessions(ws);
  const waits = sessions.filter((session) => pendingSessions.includes(session)).length;
  const state = waits > 0 ? "wait" : sessions.length > 0 ? "live" : "idle";
  const chipLabel =
    waits > 0 ? `${waits} wait` : sessions.length > 0 ? String(sessions.length) : "—";
  const title = workspaceTitle(ws);
  const repoLabel = active && git ? "1 repo" : (dirName(ws.dir) ?? "workspace");

  // Active tab = raised neutral surface (no tint) with a square top accent line
  // in its color; the color identity lives on the ColorDot. Square, flush — no
  // rounded floating-chip look. Inactive sets no inline background so the CSS
  // owns its hover.
  const wsColor = ws.color;
  const accent = wsColor ?? "var(--pri)";
  const tabFg = active ? "var(--fg-0)" : "var(--fg-1)";
  const subFg = "var(--fg-3)";

  const chipBg =
    state === "wait"
      ? "var(--wait)"
      : state === "live"
        ? "color-mix(in oklab, var(--live) 18%, transparent)"
        : "transparent";
  const chipFg = state === "wait" ? "var(--bg-0)" : state === "live" ? "var(--live)" : subFg;

  return (
    <Tip
      text={`${title} · ${sessions.length} session${sessions.length === 1 ? "" : "s"}${waits > 0 ? ` · ${waits} awaiting input` : ""}`}
    >
      <div
        className={`ch-tab${active ? " active" : ""}`}
        onClick={onSelect}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "0 10px 0 8px",
          height: "100%",
          borderRight: "1px solid var(--bd-soft)",
          ...(active ? { background: "var(--bg-2)", boxShadow: `inset 0 3px 0 ${accent}` } : {}),
          color: tabFg,
          cursor: "pointer",
          position: "relative",
          whiteSpace: "nowrap",
          width: 212,
          flexShrink: 0,
        }}
      >
        <ColorDot
          size={10}
          display={accent}
          selected={wsColor}
          onPick={(c) => setWorkspaceColor(ws.id, c)}
          title="Workspace color"
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            lineHeight: 1.15,
            flex: 1,
            minWidth: 0,
          }}
        >
          {editing ? (
            <Input
              className="pane-name-input h-auto"
              defaultValue={title}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => {
                renameWorkspace(ws.id, e.currentTarget.value);
                setEditing(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  renameWorkspace(ws.id, e.currentTarget.value);
                  setEditing(false);
                } else if (e.key === "Escape") {
                  setEditing(false);
                }
              }}
              style={{
                width: "100%",
                background: "var(--bg-0)",
                border: "1px solid var(--bd)",
                borderRadius: 4,
                color: "var(--fg-0)",
                font: "inherit",
                fontSize: "var(--fs-12)",
                padding: "1px 4px",
              }}
            />
          ) : (
            <Tip text="Double-click to rename">
              <span
                className="ch-rename"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setEditing(true);
                }}
                style={{
                  fontSize: "var(--fs-12)",
                  fontWeight: 500,
                  color: tabFg,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {title}
              </span>
            </Tip>
          )}
          <span className="mono" style={{ fontSize: "var(--fs-10)", color: subFg }}>
            {repoLabel}
          </span>
        </div>
        <span
          className="mono"
          style={{
            fontSize: "var(--fs-10)",
            fontWeight: state === "wait" ? 600 : 500,
            color: chipFg,
            background: chipBg,
            padding: "1px 5px",
            borderRadius: 999,
            lineHeight: 1,
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            flexShrink: 0,
          }}
        >
          {state === "live" && (
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--live)" }} />
          )}
          {chipLabel}
        </span>
        <Tip text="Close workspace">
          <button
            type="button"
            className="tab-close"
            style={{ marginLeft: 2 }}
            onClick={(e) => {
              e.stopPropagation();
              const result = confirmCloseWorkspace(ws.id);
              if (result) void closeWorkspace(ws.id);
            }}
          >
            {Ico.close}
          </button>
        </Tip>
      </div>
    </Tip>
  );
}
