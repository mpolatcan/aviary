import { useEffect } from "react";
import { AboutDialog } from "./components/AboutDialog";
import { Grid } from "./components/Grid";
import { SpawnModal } from "./components/SpawnModal";
import { ActivityRail } from "./components/hub/ActivityRail";
import { BroadcastModal } from "./components/hub/BroadcastModal";
import { CommandPalette } from "./components/hub/CommandPalette";
import { CompareGrid } from "./components/hub/CompareGrid";
import { HubSidebar } from "./components/hub/HubSidebar";
import { HubStatusBar } from "./components/hub/HubStatusBar";
import { HubTabs } from "./components/hub/HubTabs";
import { Shortcuts } from "./components/hub/Shortcuts";
import { WorkspaceBar } from "./components/hub/WorkspaceBar";
import { useActivityPoll } from "./hooks/useActivityPoll";
import { useAgentEvents } from "./hooks/useAgentEvents";
import { useContainerStatsPoll } from "./hooks/useContainerStatsPoll";
import { useKeyboard } from "./hooks/useKeyboard";
import { listen } from "./lib/bridge";
import { ipc } from "./lib/ipc";
import { useLauncher } from "./lib/launcher";
import { activeWorkspace, initLifecycle, useStore } from "./lib/store";
import { ContainerInspector } from "./screens/ContainerInspector";
import { Dashboard } from "./screens/Dashboard";
import { EmptyHero } from "./screens/EmptyState";
import { Integrations } from "./screens/Integrations";
import { Resume } from "./screens/Resume";
import { SessionDetail } from "./screens/SessionDetail";
import { Settings } from "./screens/Settings";
import { Usage } from "./screens/Usage";
import { Workspace } from "./screens/Workspace";

// App shell. The left sidebar is always present; the main region swaps on the
// sidebar's view nav (P4). "hub" is the live terminal grid + activity rail; the
// other views are full-pane screens.
export function App() {
  const view = useStore((s) => s.view);
  const detailSession = useStore((s) => s.detailSession);

  useKeyboard();
  // One app-wide runtime-stats poll, shared by every resource gauge (see hook).
  useContainerStatsPoll();
  useEffect(() => {
    void initLifecycle();
  }, []);

  // The always-on-top companion (its own window / the macOS native island)
  // reaches the app through two backend events:
  //   - codehub://focus-session  → raise this window + focus that session
  //   - codehub://island-approve → answer an awaiting permission prompt (the
  //     native island can't call the respond_prompt command directly from an
  //     AppKit click, so it relays the tmux session name here). Payload is the
  //     session name for both. Actions/ipc are read at event time, so this
  //     subscribes exactly once.
  useEffect(() => {
    const uns: Array<() => void> = [];
    void listen<string>("codehub://focus-session", (e) => {
      const s = useStore.getState();
      s.focusSession(e.payload);
      s.setView("hub");
    }).then((u) => uns.push(u));
    void listen<string>("codehub://island-approve", (e) => {
      // Fire-and-forget: a stale/expired prompt makes this a no-op, so log
      // rather than swallow silently if the relay arrives after it resolved.
      ipc.respondPrompt(e.payload, true).catch((err) => {
        console.warn("island-approve: respond_prompt failed", err);
      });
    }).then((u) => uns.push(u));
    return () => {
      for (const un of uns) un();
    };
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
      {detailSession ? (
        <SessionDetail session={detailSession} />
      ) : view === "hub" ? (
        <HubView />
      ) : view === "workspace" ? (
        <Workspace />
      ) : view === "containers" ? (
        <ContainerInspector />
      ) : view === "settings" ? (
        <Settings />
      ) : view === "dashboard" ? (
        <Dashboard />
      ) : view === "usage" ? (
        <Usage />
      ) : view === "resume" ? (
        <Resume />
      ) : (
        <Integrations />
      )}

      {/* Floating overlays, above every view (⌘K / ⌘/). Portalled, so placement
          here is incidental. */}
      <CommandPalette />
      <Shortcuts />
      <BroadcastModal />
      <SpawnModal />
      <AboutDialog />
    </div>
  );
}

// The Hub view: workspace tabs + per-pane terminal grid + activity rail. Splits,
// rename, keyboard shortcuts and lifecycle wiring are preserved from the vanilla
// shell — only the chrome is reskinned.
function HubView() {
  const active = useStore(activeWorkspace);
  const openLaunch = useLauncher((s) => s.open);
  const grid = useStore((s) => s.config?.hubLayout === "grid");
  // Real working/idle signal for PaneHead + the rail's Activity section.
  useActivityPoll();
  // Live awaiting-input + turn-history stream (← agent-native hooks, §7): keeps
  // pending_prompts (bell dot / toast) + session_activity_history (feed) fresh.
  // Honest-empty until the BE track lands.
  useAgentEvents();

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
          grid ? (
            // Compare grid: every session tiled side-by-side; no per-workspace
            // split bar (splits are a single-workspace concept).
            <CompareGrid />
          ) : (
            <>
              <WorkspaceBar />
              <div className="hub-grid">
                <Grid ws={active} />
              </div>
            </>
          )
        ) : (
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            {/* New-agent flow opens the shared launcher anchored in the sidebar. */}
            <EmptyHero onNew={() => openLaunch("newtab")} />
          </div>
        )}
        <HubStatusBar variant={grid ? "grid" : "tabs"} />
      </main>

      <ActivityRail />
    </>
  );
}
