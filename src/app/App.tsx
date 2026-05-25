import { useEffect } from "react";
import { AboutDialog } from "./components/AboutDialog";
import { Grid } from "./components/Grid";
import { SpawnModal } from "./components/SpawnModal";
import { ActionBar } from "./components/hub/ActionBar";
import { ActivityRail } from "./components/hub/ActivityRail";
import { CommandPalette } from "./components/hub/CommandPalette";
import { DiffViewer } from "./components/hub/DiffViewer";
import { FilesBrowser } from "./components/hub/FilesBrowser";
import { GroupsBar } from "./components/hub/GroupsBar";
import { HubSidebar } from "./components/hub/HubSidebar";
import { HubStatusBar } from "./components/hub/HubStatusBar";
import { HubTabs } from "./components/hub/HubTabs";
import { RuntimeBanner } from "./components/hub/RuntimeBanner";
import { Shortcuts } from "./components/hub/Shortcuts";
import { WorkspaceBar } from "./components/hub/WorkspaceBar";
import { useActivityPoll } from "./hooks/useActivityPoll";
import { useAgentEvents } from "./hooks/useAgentEvents";
import { useContainerStatsPoll } from "./hooks/useContainerStatsPoll";
import { useGitStatusPoll } from "./hooks/useGitStatusPoll";
import { useKeyboard } from "./hooks/useKeyboard";
import { listen } from "./lib/bridge";
import { ipc } from "./lib/ipc";
import { useLauncher } from "./lib/launcher";
import { useOverlay } from "./lib/overlay";
import { activeWorkspace, initLifecycle, useStore } from "./lib/store";
import { ContainerInspector } from "./screens/ContainerInspector";
import { Dashboard } from "./screens/Dashboard";
import { EmptyHero } from "./screens/EmptyState";
import { NewWorkspace } from "./screens/NewWorkspace";
import { ResumeDrawer } from "./screens/Resume";
import { SessionDetail } from "./screens/SessionDetail";
import { Settings } from "./screens/Settings";
import { Usage } from "./screens/Usage";
import { Welcome } from "./screens/Welcome";

// App shell. The left sidebar is always present; the main region swaps on the
// sidebar's view nav (P4). "hub" is the live terminal grid + activity rail; the
// other views are full-pane screens.
export function App() {
  const view = useStore((s) => s.view);
  const detailSession = useStore((s) => s.detailSession);
  const newWorkspace = useOverlay((s) => s.newWorkspace);

  useKeyboard();
  // One app-wide runtime-stats poll, shared by every resource gauge (see hook).
  useContainerStatsPoll();
  // One app-wide /workspace git poll, shared by the activity rail + Hub meta strip.
  useGitStatusPoll();
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
      ) : view === "containers" ? (
        <ContainerInspector />
      ) : view === "settings" ? (
        <Settings />
      ) : view === "dashboard" ? (
        <Dashboard />
      ) : view === "usage" ? (
        <Usage />
      ) : (
        <HubView />
      )}

      {/* Floating overlays, above every view (⌘K / ⌘/). Portalled, so placement
          here is incidental. */}
      <CommandPalette />
      <Shortcuts />
      <SpawnModal />
      <AboutDialog />
      {newWorkspace && <NewWorkspace />}
    </div>
  );
}

// The Hub view: workspace tabs + per-pane terminal grid + activity rail. Splits,
// rename, keyboard shortcuts and lifecycle wiring are preserved from the vanilla
// shell — only the chrome is reskinned.
function HubView() {
  const active = useStore(activeWorkspace);
  const openLaunch = useLauncher((s) => s.open);
  // No tab open → the launcher. With saved workspaces, show the Welcome picker;
  // on a cold first run with none, the original setup hero.
  const hasSaved = useStore((s) => (s.config?.savedWorkspaces?.length ?? 0) > 0);
  // Docked utility panels (design hub-states FilesPanel / DiffPanel), toggled
  // from the ActionBar (⌘E / ⌘D) or the activity rail's Changes list. They dock
  // as flex siblings of <main> — Files on the left, Diff on the right just
  // inside the activity rail — so the tab bar + status bar stay main-width.
  const files = useOverlay((s) => s.files);
  const setFiles = useOverlay((s) => s.setFiles);
  const diff = useOverlay((s) => s.diff);
  const setDiff = useOverlay((s) => s.setDiff);
  // Resume drawer docks at the right, replacing the activity-rail slot (design
  // resume.jsx). The drawer self-gates on the same flag, so it's null when closed.
  const resume = useOverlay((s) => s.resume);
  // The drawer can dock left (before the hub) or right (replacing the rail).
  const resumeSide = useOverlay((s) => s.resumeSide);
  // Real working/idle signal for PaneHead + the rail's Activity section.
  useActivityPoll();
  // Live awaiting-input + turn-history stream (← agent-native hooks, §7): keeps
  // pending_prompts (bell dot / toast) + session_activity_history (feed) fresh.
  // Honest-empty until the BE track lands.
  useAgentEvents();

  return (
    <>
      {resume && resumeSide === "left" && <ResumeDrawer />}
      {files && <FilesBrowser onClose={() => setFiles(false)} />}
      <main
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          background: "var(--bg-1)",
        }}
      >
        <RuntimeBanner />
        <HubTabs />
        {active ? (
          <>
            <GroupsBar ws={active} />
            <div className="hub-grid">
              <Grid ws={active} />
            </div>
            {/* Design order below the grid: meta strip → pane actions → status. */}
            <WorkspaceBar />
            {/* Bottom chrome: Files / Shell / Diff + Resume + the spawn CTA. Only
                with a live pane grid — the empty hero owns the space otherwise. */}
            <ActionBar />
          </>
        ) : hasSaved ? (
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <Welcome />
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            {/* New-agent flow opens the shared launcher anchored in the sidebar. */}
            <EmptyHero onNew={() => openLaunch("newtab")} />
          </div>
        )}
        <HubStatusBar />
      </main>

      {diff !== null && <DiffViewer path={diff} onClose={() => setDiff(null)} />}
      {resume && resumeSide === "right" ? <ResumeDrawer /> : <ActivityRail />}
    </>
  );
}
