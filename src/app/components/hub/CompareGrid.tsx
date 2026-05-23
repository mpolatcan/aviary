import { activeWorkspace, useStore } from "../../lib/store";
import { leavesList } from "../../lib/tree";
import { PaneHead } from "../PaneHead";
import { PaneMount } from "../PaneMount";

// Hub B — the compare grid (design/screens/main-hub-b.jsx). Instead of the
// per-workspace split tree, every live session across every workspace is tiled
// as its own pane so agents can be watched side-by-side. Each tile reuses the
// same PaneHead + reparented xterm surface (PaneMount) as the split grid; only
// the layout differs, so panes/buffers survive a tabs↔grid toggle untouched.
//
// Column count = ceil(sqrt(n)) → 1 tile = 1×1, 2 = 2×1, 3-4 = 2×2, 5-9 = 3×3.
export function CompareGrid() {
  const workspaces = useStore((s) => s.workspaces);
  const focused = useStore((s) => activeWorkspace(s)?.focused);
  const focusSession = useStore((s) => s.focusSession);

  // Flatten every workspace's leaves into one ordered list of sessions.
  const sessions = workspaces.flatMap((ws) => leavesList(ws.root));
  const cols = Math.max(1, Math.ceil(Math.sqrt(sessions.length)));

  return (
    <div className="compare-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {sessions.map((session) => (
        <div
          key={session}
          className={`pane-leaf${focused === session ? " focused" : ""}`}
          data-session={session}
          onMouseDown={() => focusSession(session)}
        >
          <PaneHead session={session} />
          <div className="pane-body">
            <PaneMount session={session} />
          </div>
        </div>
      ))}
    </div>
  );
}
