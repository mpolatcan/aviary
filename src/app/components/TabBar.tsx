import { useEffect, useRef } from "react";
import { MODE_BY_ID, SPEC_BY_CLI } from "../lib/catalog";
import { useStore } from "../lib/store";
import { leavesList } from "../lib/tree";
import { NewTabPopover } from "./NewTabPopover";

export function TabBar() {
  const workspaces = useStore((s) => s.workspaces);
  const activeId = useStore((s) => s.activeWorkspaceId);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const switchWorkspace = useStore((s) => s.switchWorkspace);
  const closeWorkspace = useStore((s) => s.closeWorkspace);

  // Keep the newest tab in view. Tabs append to the right (store.newPlate), so a
  // freshly opened tab can land past the overflow edge — scroll the strip to its
  // end whenever the tab count grows.
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
    <nav
      className="relative flex items-stretch bg-bg border-b-2 border-rule"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <div
        ref={stripRef}
        className="flex min-w-0 shrink overflow-x-auto [scrollbar-width:none]"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {workspaces.map((ws) => {
          const sessions = leavesList(ws.root);
          const primary = ws.focused && sessions.includes(ws.focused) ? ws.focused : sessions[0];
          const meta = primary ? sessionMeta[primary] : undefined;
          const spec = SPEC_BY_CLI[meta?.cli ?? "claude"];
          const count = sessions.length;
          const active = ws.id === activeId;
          // Single-session tab carries that session's identity (alias + CLI);
          // multi-session collapses to a count. Mode badge surfaces AUTO/YOLO at
          // the tab so a risky pane is visible without opening it.
          const title = count === 1 && meta ? meta.alias : `Tab ${ws.plate}`;
          const subtitle = count === 1 ? spec.label : `${count} sessions`;
          const badge = count === 1 && meta ? MODE_BY_ID[meta.mode].badge : "";
          return (
            <div
              key={ws.id}
              className={`tab tab-enter${active ? " active" : ""}`}
              onClick={() => switchWorkspace(ws.id)}
            >
              <span className="plate-num">{ws.plate}</span>
              <svg className="bird" aria-hidden="true">
                <use href={spec.bird} />
              </svg>
              <span className="tab-text">
                <span className="latin">{title}</span>
                <span className="common">{subtitle}</span>
              </span>
              <span className="tab-end">
                {badge && <span className={`mode-badge badge-${meta?.mode}`}>{badge}</span>}
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
              </span>
            </div>
          );
        })}

        {/* Sits immediately right of the last tab (inside the scroll strip), so a
            new tab always appears just before it. The empty bar area to the right
            of the strip stays a window-drag region. */}
        <NewTabPopover />
      </div>
    </nav>
  );
}
