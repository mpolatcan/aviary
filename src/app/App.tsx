import { useEffect } from "react";
import { Grid } from "./components/Grid";
import { ActivityRail } from "./components/hub/ActivityRail";
import { HubSidebar } from "./components/hub/HubSidebar";
import { HubStatusBar } from "./components/hub/HubStatusBar";
import { HubTabs } from "./components/hub/HubTabs";
import { WorkspaceBar } from "./components/hub/WorkspaceBar";
import { useKeyboard } from "./hooks/useKeyboard";
import { useLauncher } from "./lib/launcher";
import { activeWorkspace, initLifecycle, useStore } from "./lib/store";
import { EmptyHero } from "./screens/EmptyState";

// Hub A shell (design/screens/main-hub-a.jsx): sidebar · workspace tabs +
// per-pane terminal grid · activity rail. The live terminal grid, splits,
// rename, keyboard shortcuts and lifecycle wiring are preserved from the vanilla
// shell — only the chrome is reskinned.
export function App() {
  const active = useStore(activeWorkspace);
  const openLaunch = useLauncher((s) => s.open);

  useKeyboard();
  useEffect(() => {
    void initLifecycle();
  }, []);

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        width: "100%",
        overflow: "hidden",
        background: "var(--bg-1)",
      }}
    >
      <HubSidebar />

      <main
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          background: "var(--bg-1)",
        }}
      >
        <HubTabs />
        {active?.root ? (
          <>
            <WorkspaceBar />
            <div className="hub-grid">
              <Grid ws={active} />
            </div>
          </>
        ) : (
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            {/* New-agent flow opens the shared launcher anchored in the sidebar. */}
            <EmptyHero onNew={() => openLaunch("newtab")} />
          </div>
        )}
        <HubStatusBar />
      </main>

      <ActivityRail />
    </div>
  );
}
