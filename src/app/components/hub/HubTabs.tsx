import { useEffect, useRef } from "react";
import { AgentGlyph } from "../../components/primitives/AgentGlyph";
import { IconBtn } from "../../components/primitives/IconBtn";
import { StatusDot } from "../../components/primitives/StatusDot";
import { Ico } from "../../components/primitives/icons";
import type { Cli, Mode } from "../../lib/ipc";
import { useLauncher } from "../../lib/launcher";
import { useOverlay } from "../../lib/overlay";
import { useStore } from "../../lib/store";
import { leavesList } from "../../lib/tree";
import { LaunchPanel } from "../LaunchPanel";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";

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
  const newPlate = useStore((s) => s.newPlate);
  const openKey = useLauncher((s) => s.openKey);
  const openLaunch = useLauncher((s) => s.open);
  const closeLaunch = useLauncher((s) => s.close);
  const isOpen = openKey === NEW_KEY;
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

  const stripRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(workspaces.length);
  useEffect(() => {
    const strip = stripRef.current;
    if (strip && workspaces.length > prevCount.current) {
      strip.scrollTo({ left: strip.scrollWidth, behavior: "smooth" });
    }
    prevCount.current = workspaces.length;
  }, [workspaces.length]);

  const launch = (cli: Cli, mode: Mode) => {
    closeLaunch();
    void newPlate(cli, mode);
  };

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

        {/* new tab */}
        <Popover open={isOpen} onOpenChange={(o) => !o && closeLaunch()}>
          <PopoverAnchor asChild>
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
          </PopoverAnchor>
          <PopoverContent side="bottom" align="start" className="modal-panel popover-launch">
            {isOpen && <LaunchPanel kicker="New tab" onLaunch={launch} />}
          </PopoverContent>
        </Popover>
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
        <IconBtn title="Notifications (coming soon)">{Ico.bell}</IconBtn>
      </div>
    </div>
  );
}
