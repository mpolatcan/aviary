import { useEffect, useRef } from "react";
import { AgentGlyph } from "../../components/primitives/AgentGlyph";
import { IconBtn } from "../../components/primitives/IconBtn";
import { StatusDot } from "../../components/primitives/StatusDot";
import { Ico } from "../../components/primitives/icons";
import { splitKey, useLauncher } from "../../lib/launcher";
import { useOverlay } from "../../lib/overlay";
import { activeWorkspace, useStore } from "../../lib/store";
import { leavesList } from "../../lib/tree";

// Workspace tab strip, ported from design/screens/main-hub-a.jsx. Each tab is a
// live workspace; the agent glyphs reflect its panes. The trailing action group
// (files / diff / bell) lands in later phases — rendered but inert. The "+"
// opens the shared launcher to start a new tab.
const NEW_KEY = "tabbar";

export function HubTabs() {
  const workspaces = useStore((s) => s.workspaces);
  const activeId = useStore((s) => s.activeWorkspaceId);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const switchWorkspace = useStore((s) => s.switchWorkspace);
  const closeWorkspace = useStore((s) => s.closeWorkspace);
  const openLaunch = useLauncher((s) => s.open);
  // Diff button opens the combined "all changes" diff (reuses the rail's
  // DiffViewer + container_git_diff_all); Files opens the /workspace browser.
  // Both reuse the rail-mounted viewers and only matter while the runtime is up.
  const setDiff = useOverlay((s) => s.setDiff);
  const setFiles = useOverlay((s) => s.setFiles);
  const setBroadcast = useOverlay((s) => s.setBroadcast);
  const running = useStore((s) => s.status?.state === "running");
  const hasSessions = useStore((s) => s.workspaces.length > 0);
  // Hub layout toggle (tabs ↔ compare grid), persisted via the config store.
  const layout = useStore((s) => s.config?.hubLayout ?? "tabs");
  const updateConfig = useStore((s) => s.updateConfig);
  // Focused pane of the active workspace — the split buttons target it (same as
  // ⌘\ / the PaneHead split controls).
  const focused = useStore((s) => activeWorkspace(s)?.focused ?? null);
  // Awaiting-input signal for the bell dot: any session with a pending prompt
  // (← pending_prompts / live agent-event, §7). Real for Claude/Codex; empty
  // (no dot) for Antigravity and until the BE track lands.
  const pendingCount = useStore((s) => s.pendingPrompts.length);

  const armSplit = (dir: "row" | "col") => {
    if (!focused) return;
    openLaunch(splitKey(focused), { dir, session: focused });
  };

  const stripRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(workspaces.length);
  useEffect(() => {
    const strip = stripRef.current;
    if (strip && workspaces.length > prevCount.current) {
      strip.scrollTo({ left: strip.scrollWidth, behavior: "smooth" });
    }
    prevCount.current = workspaces.length;
  }, [workspaces.length]);

  return (
    <div
      style={{
        height: "var(--tabbar-h, 40px)",
        display: "flex",
        alignItems: "stretch",
        borderBottom: "1px solid var(--bd-soft)",
        background: "var(--bg-1)",
        paddingLeft: 8,
        flexShrink: 0,
      }}
    >
      <div
        ref={stripRef}
        style={{ display: "flex", minWidth: 0, overflowX: "auto", scrollbarWidth: "none" }}
      >
        {workspaces.map((ws) => {
          const sessions = leavesList(ws.root);
          const active = ws.id === activeId;
          const primary = ws.focused && sessions.includes(ws.focused) ? ws.focused : sessions[0];
          const meta = primary ? sessionMeta[primary] : undefined;
          const title = meta && sessions.length === 1 ? meta.alias : `Tab ${ws.plate}`;
          return (
            <div
              key={ws.id}
              onClick={() => switchWorkspace(ws.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "0 12px",
                height: "100%",
                borderRight: "1px solid var(--bd-soft)",
                background: active ? "var(--bg-2)" : "transparent",
                color: active ? "var(--fg-0)" : "var(--fg-1)",
                cursor: "pointer",
                position: "relative",
                whiteSpace: "nowrap",
                minWidth: 0,
              }}
            >
              {active && (
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    height: 2,
                    background: "var(--fg-0)",
                  }}
                />
              )}
              <StatusDot status={active ? "live" : "idle"} pulse={active} />
              <div
                style={{ display: "flex", flexDirection: "column", lineHeight: 1.15, minWidth: 0 }}
              >
                <span
                  className="mono"
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: active ? "var(--fg-0)" : "var(--fg-1)",
                  }}
                >
                  {title}
                </span>
                <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>
                  {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
                </span>
              </div>
              <span style={{ display: "inline-flex", gap: 3, alignItems: "center", marginLeft: 4 }}>
                {sessions.map((session) => {
                  const m = sessionMeta[session];
                  if (!m) return null;
                  return (
                    <AgentGlyph key={session} agent={m.cli} size={11} color={`var(--a-${m.cli})`} />
                  );
                })}
              </span>
              <IconBtn
                title="Close tab"
                style={{ width: 18, height: 18, marginLeft: 4 }}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeWorkspace(ws.id);
                }}
              >
                {Ico.close}
              </IconBtn>
            </div>
          );
        })}

        {/* new tab — opens the shared spawn modal */}
        <button
          type="button"
          title="New tab (⌘N)"
          onClick={() => openLaunch(NEW_KEY)}
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
      </div>

      <div style={{ flex: 1 }} />

      {/* trailing actions — Diff is live (combined /workspace diff); files +
          notifications land in later phases. */}
      <div style={{ display: "flex", alignItems: "center", gap: 2, padding: "0 8px" }}>
        {/* layout toggle: per-workspace tabs vs the compare grid (Hub B) */}
        <IconBtn
          title="Tabs layout"
          onClick={() => void updateConfig({ hubLayout: "tabs" })}
          style={
            layout === "tabs" ? { background: "var(--bg-3)", color: "var(--fg-0)" } : undefined
          }
        >
          {Ico.hub}
        </IconBtn>
        <IconBtn
          title="Compare grid layout"
          disabled={!hasSessions}
          onClick={() => void updateConfig({ hubLayout: "grid" })}
          style={
            layout === "grid" ? { background: "var(--bg-3)", color: "var(--fg-0)" } : undefined
          }
        >
          {Ico.grid}
        </IconBtn>
        <span className="vr" style={{ height: 16, margin: "0 4px" }} />
        {/* split the focused pane — column (below) / row (right), like ⌘\ */}
        <IconBtn
          title={focused ? "Split focused pane below" : "Split (no focused pane)"}
          disabled={!focused}
          onClick={() => armSplit("col")}
        >
          {Ico.splitH}
        </IconBtn>
        <IconBtn
          title={focused ? "Split focused pane right (⌘\\)" : "Split (no focused pane)"}
          disabled={!focused}
          onClick={() => armSplit("row")}
        >
          {Ico.splitV}
        </IconBtn>
        <span className="vr" style={{ height: 16, margin: "0 4px" }} />
        <IconBtn
          title={running ? "Browse /workspace files" : "Files (runtime not running)"}
          disabled={!running}
          onClick={() => setFiles(true)}
        >
          {Ico.files}
        </IconBtn>
        <IconBtn
          title={
            running && hasSessions
              ? "Broadcast a prompt to agents"
              : "Broadcast (no running sessions)"
          }
          disabled={!running || !hasSessions}
          onClick={() => setBroadcast(true)}
        >
          {Ico.arrowR}
        </IconBtn>
        <IconBtn
          title={running ? "Review all workspace changes" : "Diff (runtime not running)"}
          disabled={!running}
          onClick={() => setDiff("")}
        >
          {Ico.diff}
        </IconBtn>
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
