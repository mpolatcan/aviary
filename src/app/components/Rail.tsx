import { useState } from "react";
import { SPEC_BY_CLI } from "../lib/catalog";
import * as registry from "../lib/panes";
import { useStore } from "../lib/store";
import { leavesList } from "../lib/tree";

// Catalogue rail — every session across all tabs, grouped by plate. Click a row
// to focus it (switching tabs if needed); collapse to a labelled spine.
export function Rail({ onNewHere }: { onNewHere: () => void }) {
  const workspaces = useStore((s) => s.workspaces);
  const activeId = useStore((s) => s.activeWorkspaceId);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const switchWorkspace = useStore((s) => s.switchWorkspace);
  const focusSession = useStore((s) => s.focusSession);
  const closeSession = useStore((s) => s.closeSession);
  const [collapsed, setCollapsed] = useState(false);

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
                <span className="rg-plate">{ws.plate}</span>
                <span className="rg-label">Tab</span>
                <span className="rg-count">{sessions.length}</span>
              </button>
              {sessions.map((session) => {
                const meta = sessionMeta[session];
                const spec = meta ? SPEC_BY_CLI[meta.cli] : null;
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
        <button
          type="button"
          className="rail-new"
          title="New session in the current tab"
          onClick={onNewHere}
        >
          <span className="plus">＋</span>
          <span>new session</span>
        </button>
      </footer>

      <span className="rail-spine">Sessions</span>
    </aside>
  );
}
