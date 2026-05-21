import { useState } from "react";
import { autoSplitDir } from "../hooks/useKeyboard";
import { MODE_BY_ID, SPEC_BY_CLI } from "../lib/catalog";
import type { Cli, Mode } from "../lib/ipc";
import { useLauncher } from "../lib/launcher";
import * as registry from "../lib/panes";
import { useStore } from "../lib/store";
import { leavesList } from "../lib/tree";
import { LaunchPanel } from "./LaunchPanel";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";

const KEY = "rail";

// Catalogue rail — every session across all tabs, grouped by plate. Click a row
// to focus it (switching tabs if needed); collapse to a labelled spine.
export function Rail() {
  const workspaces = useStore((s) => s.workspaces);
  const activeId = useStore((s) => s.activeWorkspaceId);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const switchWorkspace = useStore((s) => s.switchWorkspace);
  const focusSession = useStore((s) => s.focusSession);
  const closeSession = useStore((s) => s.closeSession);
  const splitSession = useStore((s) => s.splitSession);
  const newPlate = useStore((s) => s.newPlate);
  const openKey = useLauncher((s) => s.openKey);
  const ctx = useLauncher((s) => s.ctx);
  const openLaunch = useLauncher((s) => s.open);
  const closeLaunch = useLauncher((s) => s.close);
  const [collapsed, setCollapsed] = useState(false);
  const isOpen = openKey === KEY;

  const toggle = () => {
    setCollapsed((c) => !c);
    // Reflow the active tab's panes after the flex-basis transition settles.
    const active = workspaces.find((w) => w.id === activeId);
    const refit = () => {
      if (active?.root) for (const s of leavesList(active.root)) registry.fit(s);
    };
    requestAnimationFrame(refit);
    setTimeout(refit, 320);
  };

  // Rail "+" adds a session to the current tab by splitting its focused pane
  // (along its longer axis); with nothing open it falls back to a new tab. The
  // anchored popover then picks agent × mode — same UI as every other surface.
  const arm = () => {
    const focused = workspaces.find((w) => w.id === activeId)?.focused;
    openLaunch(KEY, focused ? { dir: autoSplitDir(focused), session: focused } : undefined);
  };
  const launch = (cli: Cli, mode: Mode) => {
    const target = ctx?.session;
    const dir = ctx?.dir ?? "row";
    closeLaunch();
    if (target) void splitSession(target, dir, cli, mode);
    else void newPlate(cli, mode);
  };

  return (
    <aside className={`session-rail${collapsed ? " collapsed" : ""}`}>
      <header className="rail-head">
        <span className="rail-title">Sessions</span>
        <button
          type="button"
          className="rail-toggle"
          title={collapsed ? "Expand the session list" : "Collapse the session list"}
          aria-label="toggle session list"
          onClick={toggle}
        >
          ›
        </button>
      </header>

      <div className="rail-list">
        {workspaces.map((ws) => {
          const sessions = leavesList(ws.root);
          const active = ws.id === activeId;
          return (
            <div key={ws.id}>
              <button
                type="button"
                className={`rail-group-head${active ? " active" : ""}`}
                onClick={() => switchWorkspace(ws.id)}
              >
                <span className="rg-label">Tab</span>
                <span className="rg-plate">{ws.plate}</span>
                <span className="rg-count">{sessions.length}</span>
              </button>
              {sessions.map((session) => {
                const meta = sessionMeta[session];
                const spec = meta ? SPEC_BY_CLI[meta.cli] : null;
                const badge = meta ? MODE_BY_ID[meta.mode].badge : "";
                const focused = active && ws.focused === session;
                return (
                  <div key={session} className={`rail-row${focused ? " focused" : ""}`}>
                    <button type="button" className="rr-main" onClick={() => focusSession(session)}>
                      <svg className="bird" aria-hidden="true">
                        <use href={spec?.bird ?? "#bird-owl"} />
                      </svg>
                      <span className="rr-text">
                        <span className="rr-common">{meta?.alias ?? session}</span>
                        <span className="rr-num">{spec?.label ?? ""}</span>
                      </span>
                    </button>
                    {badge && meta && (
                      <span className={`mode-badge badge-${meta.mode}`}>{badge}</span>
                    )}
                    <button
                      type="button"
                      className="rr-close"
                      aria-label="close"
                      onClick={() => void closeSession(session)}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <footer className="rail-foot">
        <Popover open={isOpen} onOpenChange={(o) => !o && closeLaunch()}>
          <PopoverAnchor asChild>
            <button
              type="button"
              className="rail-new"
              title="New session in the current tab"
              onClick={arm}
            >
              <span className="plus">＋</span>
              <span>new session</span>
            </button>
          </PopoverAnchor>
          <PopoverContent side="top" align="end" className="modal-panel popover-launch">
            {isOpen && (
              <LaunchPanel
                kicker={ctx?.session ? "Add to this tab" : "New tab"}
                onLaunch={launch}
              />
            )}
          </PopoverContent>
        </Popover>
      </footer>

      <span className="rail-spine">Sessions</span>
    </aside>
  );
}
