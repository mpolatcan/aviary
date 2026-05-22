import { AgentGlyph } from "../../components/primitives/AgentGlyph";
import { IconBtn } from "../../components/primitives/IconBtn";
import { Logo } from "../../components/primitives/Logo";
import { StatusDot } from "../../components/primitives/StatusDot";
import { Ico } from "../../components/primitives/icons";
import { MODE_BY_ID, SPEC_BY_CLI } from "../../lib/catalog";
import type { Cli, Mode } from "../../lib/ipc";
import { useLauncher } from "../../lib/launcher";
import { useStore } from "../../lib/store";
import { leavesList } from "../../lib/tree";
import { Button } from "../../ui/button";
import { LaunchPanel } from "../LaunchPanel";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";

// Left sidebar, ported from design/screens/main-hub-a.jsx. Logo, New-agent
// launcher, view nav, and the live session list grouped by tab (one shared
// runtime container today, so groups are tabs). View items beyond Hub are
// stubbed (their screens land in P4) — shown but inert.
const NEW_KEY = "newtab";

export function HubSidebar() {
  const workspaces = useStore((s) => s.workspaces);
  const activeId = useStore((s) => s.activeWorkspaceId);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const status = useStore((s) => s.status);
  const switchWorkspace = useStore((s) => s.switchWorkspace);
  const focusSession = useStore((s) => s.focusSession);
  const closeSession = useStore((s) => s.closeSession);
  const newPlate = useStore((s) => s.newPlate);
  const openKey = useLauncher((s) => s.openKey);
  const openLaunch = useLauncher((s) => s.open);
  const closeLaunch = useLauncher((s) => s.close);
  const isOpen = openKey === NEW_KEY;

  const launch = (cli: Cli, mode: Mode) => {
    closeLaunch();
    void newPlate(cli, mode);
  };

  const sessionCount = Object.keys(sessionMeta).length;
  const runtimeLive = status?.state === "running";

  return (
    <aside
      style={{
        width: 264,
        flexShrink: 0,
        background: "var(--bg-1)",
        borderRight: "1px solid var(--bd-soft)",
        display: "flex",
        flexDirection: "column",
        color: "var(--fg-1)",
      }}
    >
      <div style={{ padding: "12px 14px 10px", borderBottom: "1px solid var(--bd-soft)" }}>
        <Logo />
      </div>

      {/* quick actions */}
      <div style={{ padding: "10px 10px 6px", display: "flex", flexDirection: "column", gap: 4 }}>
        <Popover open={isOpen} onOpenChange={(o) => !o && closeLaunch()}>
          <PopoverAnchor asChild>
            <Button
              onClick={() => openLaunch(NEW_KEY)}
              style={{ justifyContent: "space-between", width: "100%" }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {Ico.plus}New agent
              </span>
              <span style={{ display: "flex", gap: 2, opacity: 0.7 }}>
                <span className="kbd">⌘</span>
                <span className="kbd">N</span>
              </span>
            </Button>
          </PopoverAnchor>
          <PopoverContent side="bottom" align="start" className="modal-panel popover-launch">
            {isOpen && <LaunchPanel kicker="New tab" onLaunch={launch} />}
          </PopoverContent>
        </Popover>
      </div>

      {/* views */}
      <div style={{ padding: "10px 10px 4px" }}>
        <div className="lbl" style={{ padding: "0 4px 6px" }}>
          Views
        </div>
        <div className="side-item active">
          {Ico.hub}
          <span style={{ flex: 1 }}>Hub</span>
        </div>
        <div className="side-item" style={{ opacity: 0.4 }} title="Coming soon">
          {Ico.grid}
          <span style={{ flex: 1 }}>Dashboard</span>
        </div>
        <div className="side-item" style={{ opacity: 0.4 }} title="Coming soon">
          {Ico.container}
          <span style={{ flex: 1 }}>Containers</span>
        </div>
        <div className="side-item" style={{ opacity: 0.4 }} title="Coming soon">
          {Ico.settings}
          <span style={{ flex: 1 }}>Settings</span>
        </div>
      </div>

      {/* sessions grouped by tab */}
      <div
        style={{
          flex: 1,
          padding: "12px 10px 4px",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 4px 8px",
          }}
        >
          <span className="lbl">Sessions · {sessionCount}</span>
        </div>

        {workspaces.length === 0 ? (
          <div
            style={{
              padding: "20px 12px",
              textAlign: "center",
              border: "1px dashed var(--bd)",
              borderRadius: 8,
              fontSize: 11.5,
              color: "var(--fg-2)",
              lineHeight: 1.55,
            }}
          >
            No sessions yet.
            <br />
            <span className="mono" style={{ color: "var(--fg-3)" }}>
              ⌘N
            </span>{" "}
            to start one.
          </div>
        ) : (
          <div
            className="scroll"
            style={{
              flex: 1,
              overflow: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {workspaces.map((ws) => {
              const sessions = leavesList(ws.root);
              const active = ws.id === activeId;
              return (
                <div
                  key={ws.id}
                  style={{
                    borderRadius: 7,
                    padding: 4,
                    background: "color-mix(in oklab, var(--bg-2) 60%, transparent)",
                    border: "1px solid var(--bd-soft)",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => switchWorkspace(ws.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 6px 6px",
                      width: "100%",
                      background: "transparent",
                      border: "none",
                      borderBottom: "1px solid var(--bd-soft)",
                      marginBottom: 4,
                      cursor: "pointer",
                      color: "inherit",
                    }}
                  >
                    <span style={{ display: "inline-flex", color: "var(--fg-2)" }}>
                      {Ico.container}
                    </span>
                    <span
                      className="mono"
                      style={{
                        fontSize: 11,
                        color: active ? "var(--fg-0)" : "var(--fg-1)",
                        fontWeight: 500,
                        flex: 1,
                        textAlign: "left",
                      }}
                    >
                      Tab {ws.plate}
                    </span>
                    <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>
                      {sessions.length}
                    </span>
                  </button>

                  <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                    {sessions.map((session) => {
                      const meta = sessionMeta[session];
                      if (!meta) return null;
                      const spec = SPEC_BY_CLI[meta.cli];
                      const badge = MODE_BY_ID[meta.mode].badge;
                      const focused = active && ws.focused === session;
                      return (
                        <div
                          key={session}
                          className={`side-item${focused ? " active" : ""}`}
                          style={{ alignItems: "flex-start", padding: "8px 10px" }}
                          onClick={() => focusSession(session)}
                        >
                          <div style={{ display: "flex", alignItems: "center", paddingTop: 1 }}>
                            <StatusDot status={focused ? "live" : "idle"} pulse={focused} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 5,
                                marginBottom: 2,
                              }}
                            >
                              <AgentGlyph
                                agent={meta.cli}
                                size={11}
                                color={`var(--a-${meta.cli})`}
                              />
                              <span
                                className="mono"
                                style={{
                                  fontSize: 11.5,
                                  fontWeight: 500,
                                  color: "var(--fg-0)",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {meta.alias}
                              </span>
                              {badge && (
                                <span className={`mode-badge badge-${meta.mode}`}>{badge}</span>
                              )}
                              <span style={{ flex: 1 }} />
                              <button
                                type="button"
                                aria-label="close"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void closeSession(session);
                                }}
                                style={{
                                  background: "transparent",
                                  border: "none",
                                  color: "var(--fg-3)",
                                  cursor: "pointer",
                                  fontSize: 13,
                                  lineHeight: 1,
                                  padding: 0,
                                }}
                              >
                                ×
                              </button>
                            </div>
                            <div
                              style={{
                                fontSize: 11,
                                color: "var(--fg-2)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {spec.label}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* footer — real runtime identity, no fabricated account */}
      <div
        style={{
          padding: "10px 12px",
          borderTop: "1px solid var(--bd-soft)",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <StatusDot status={runtimeLive ? "live" : "idle"} pulse={runtimeLive} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mono" style={{ fontSize: 11.5, color: "var(--fg-1)" }}>
            {status?.name ?? "codehub-runtime"}
          </div>
          <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-2)" }}>
            {status?.state ?? "—"}
          </div>
        </div>
        <IconBtn title="Settings (coming soon)">{Ico.settings}</IconBtn>
      </div>
    </aside>
  );
}
