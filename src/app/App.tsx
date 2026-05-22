import { useEffect } from "react";
import { Grid } from "./components/Grid";
import { ActivityRail } from "./components/hub/ActivityRail";
import { BroadcastModal } from "./components/hub/BroadcastModal";
import { CommandPalette } from "./components/hub/CommandPalette";
import { HubSidebar } from "./components/hub/HubSidebar";
import { HubStatusBar } from "./components/hub/HubStatusBar";
import { HubTabs } from "./components/hub/HubTabs";
import { PlannedScreen } from "./components/hub/PlannedScreen";
import { Shortcuts } from "./components/hub/Shortcuts";
import { WorkspaceBar } from "./components/hub/WorkspaceBar";
import { useKeyboard } from "./hooks/useKeyboard";
import { useLauncher } from "./lib/launcher";
import { activeWorkspace, initLifecycle, useStore } from "./lib/store";
import { ContainerInspector } from "./screens/ContainerInspector";
import { Dashboard } from "./screens/Dashboard";
import { EmptyHero } from "./screens/EmptyState";
import { Settings } from "./screens/Settings";

// Designed screens whose real data needs backend CodeHub doesn't capture yet
// (per-turn token/cost capture, persistent session history, integration
// connectors). Rendered as honest, navigable PlannedScreen stubs that name
// what's missing — never fabricated numbers. See BACKEND_PLAN.md.
const PLANNED = {
  usage: {
    title: "Usage",
    blurb:
      "A per-agent breakdown of tokens, cost and turns across your sessions — so you can see where spend goes and compare models.",
    needs:
      "Needs per-turn capture: CodeHub does not yet record token/cost/turn metrics from the agent CLIs (the numbers live only inside each CLI's own session).",
  },
  resume: {
    title: "Resume",
    blurb:
      "Reopen a past session — its transcript, working tree and the agent it ran — and pick up where you left off.",
    needs:
      "Needs persistent session history: tmux sessions are ephemeral and are discarded when closed, so there is nothing to resume from yet.",
  },
  integrations: {
    title: "Integrations",
    blurb:
      "Connect CodeHub to GitHub, issue trackers and chat so sessions can open PRs, pull tickets and post updates.",
    needs:
      "Needs integration connectors + credential storage: none of these third-party connections are implemented yet.",
  },
} as const;

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
      ) : view === "dashboard" ? (
        <Dashboard />
      ) : (
        <PlannedScreen {...PLANNED[view]} />
      )}

      {/* Floating overlays, above every view (⌘K / ⌘/). Portalled, so placement
          here is incidental. */}
      <CommandPalette />
      <Shortcuts />
      <BroadcastModal />
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
