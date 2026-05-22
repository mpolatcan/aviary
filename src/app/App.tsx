import { useEffect } from "react";
import { Grid } from "./components/Grid";
import { ActivityRail } from "./components/hub/ActivityRail";
import { CommandPalette } from "./components/hub/CommandPalette";
import { HubSidebar } from "./components/hub/HubSidebar";
import { HubStatusBar } from "./components/hub/HubStatusBar";
import { HubTabs } from "./components/hub/HubTabs";
import { Shortcuts } from "./components/hub/Shortcuts";
import { WorkspaceBar } from "./components/hub/WorkspaceBar";
import { useKeyboard } from "./hooks/useKeyboard";
import { useLauncher } from "./lib/launcher";
import { activeWorkspace, initLifecycle, useStore } from "./lib/store";
import { ContainerInspector } from "./screens/ContainerInspector";
import { Dashboard } from "./screens/Dashboard";
import { EmptyHero } from "./screens/EmptyState";
import { Settings } from "./screens/Settings";

// App shell. The left sidebar is always present; the main region swaps on the
// sidebar's view nav (P4). "hub" is the live terminal grid + activity rail; the
// other views are full-pane screens.
export function App() {
  const view = useStore((s) => s.view);

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
      {view === "hub" ? (
        <HubView />
      ) : view === "containers" ? (
        <ContainerInspector />
      ) : view === "settings" ? (
        <Settings />
      ) : (
        <Dashboard />
      )}

      {/* Floating overlays, above every view (⌘K / ⌘/). Portalled, so placement
          here is incidental. */}
      <CommandPalette />
      <Shortcuts />
    </div>
  );
}

// The Hub view: workspace tabs + per-pane terminal grid + activity rail. Splits,
// rename, keyboard shortcuts and lifecycle wiring are preserved from the vanilla
// shell — only the chrome is reskinned.
function HubView() {
  const active = useStore(activeWorkspace);
  const openLaunch = useLauncher((s) => s.open);

  return (
    <>
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
    </>
  );
}
