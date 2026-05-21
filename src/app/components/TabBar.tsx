import { SPEC_BY_CLI } from "../lib/catalog";
import { useStore } from "../lib/store";
import { leavesList } from "../lib/tree";
import { NewTabPopover } from "./NewTabPopover";

export function TabBar() {
  const workspaces = useStore((s) => s.workspaces);
  const activeId = useStore((s) => s.activeWorkspaceId);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const switchWorkspace = useStore((s) => s.switchWorkspace);
  const closeWorkspace = useStore((s) => s.closeWorkspace);

  return (
    <nav
      className="relative flex items-stretch bg-bg border-b-2 border-rule"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <NewTabPopover />

      <div
        className="flex flex-1 overflow-x-auto [scrollbar-width:none]"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {workspaces.map((ws) => {
          const sessions = leavesList(ws.root);
          const primary = ws.focused && sessions.includes(ws.focused) ? ws.focused : sessions[0];
          const spec = primary ? SPEC_BY_CLI[sessionMeta[primary]?.cli ?? "claude"] : null;
          const count = sessions.length;
          const active = ws.id === activeId;
          return (
            <div
              key={ws.id}
              className={`tab${active ? " active" : ""}`}
              onClick={() => switchWorkspace(ws.id)}
            >
              <span className="plate-num">{ws.plate}</span>
              <svg className="bird" aria-hidden="true">
                <use href={spec?.bird ?? "#bird-owl"} />
              </svg>
              <span className="tab-text">
                <span className="latin">Tab {ws.plate}</span>
                <span className="common">{count === 1 ? "1 session" : `${count} sessions`}</span>
              </span>
              <button
                type="button"
                className="close"
                aria-label="close"
                onClick={(e) => {
                  e.stopPropagation();
                  void closeWorkspace(ws.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
