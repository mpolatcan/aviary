import { AnimatePresence } from "motion/react";
import { useEffect } from "react";
import { AboutDialog } from "./components/AboutDialog";
import { Grid } from "./components/Grid";
import { SpawnModal } from "./components/SpawnModal";
import { ActionBar } from "./components/hub/ActionBar";
import { BusyOverlay } from "./components/hub/BusyOverlay";
import { CommandPalette } from "./components/hub/CommandPalette";
import { DiffViewer } from "./components/hub/DiffViewer";
import { FilePreview } from "./components/hub/FilePreview";
import { FilesBrowser } from "./components/hub/FilesBrowser";
import { GroupsBar } from "./components/hub/GroupsBar";
import { HubSidebar } from "./components/hub/HubSidebar";
import { HubStatusBar } from "./components/hub/HubStatusBar";
import { HubTabs } from "./components/hub/HubTabs";
import { RuntimeBanner } from "./components/hub/RuntimeBanner";
import { ShellPanel } from "./components/hub/ShellPanel";
import { Shortcuts } from "./components/hub/Shortcuts";
import { useActivityPoll } from "./hooks/useActivityPoll";
import { useAgentEvents } from "./hooks/useAgentEvents";
import { useContainerStatsPoll } from "./hooks/useContainerStatsPoll";
import { useGitStatusPoll } from "./hooks/useGitStatusPoll";
import { useKeyboard } from "./hooks/useKeyboard";
import { listen } from "./lib/bridge";
import { ipc } from "./lib/ipc";
import { useOverlay } from "./lib/overlay";
import { activeWorkspace, initLifecycle, useStore } from "./lib/store";
import { Dashboard } from "./screens/Dashboard";
import { EmptyHero } from "./screens/EmptyState";
import { NewWorkspace } from "./screens/NewWorkspace";
import { ResumeDrawer } from "./screens/Resume";
import { SessionDetail } from "./screens/SessionDetail";
import { Settings } from "./screens/Settings";

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
  //   - codehub://focus-session → raise this window + focus that session
  //   - codehub://island-approve / codehub://island-deny → the native island's
  //     inline ✓/✕ on an awaiting row relays the tmux session name here; we call
  //     respond_prompt (the island can't invoke a Tauri command from an AppKit
  //     click). The in-app toasts stay notify-only — this affordance is the
  //     island's alone. Subscribes exactly once.
  useEffect(() => {
    const uns: Array<() => void> = [];
    void listen<string>("codehub://focus-session", (e) => {
      const s = useStore.getState();
      s.focusSession(e.payload);
      s.setView("hub");
    }).then((u) => uns.push(u));
    const respondFromIsland = (allow: boolean) => (e: { payload: string }) => {
      ipc.respondPrompt(e.payload, allow).catch((err) => {
        console.warn(`island-${allow ? "approve" : "deny"}: respond_prompt failed`, err);
      });
    };
    void listen<string>("codehub://island-approve", respondFromIsland(true)).then((u) =>
      uns.push(u),
    );
    void listen<string>("codehub://island-deny", respondFromIsland(false)).then((u) => uns.push(u));
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
      ) : view === "settings" ? (
        <Settings />
      ) : view === "dashboard" ? (
        <Dashboard />
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
      <BusyOverlay />
    </div>
  );
}

// The Hub view: workspace tabs + per-pane terminal grid. Activity info is now
// shown inline in the sidebar's session rows; file preview + diff dock on the
// right as independent panels.
function HubView() {
  const active = useStore(activeWorkspace);
  const newAgent = useStore((s) => s.newAgent);
  const hasSaved = useStore(
    (s) => (s.config?.savedWorkspaces?.length ?? 0) > 0 || (s.workspaceContainers?.length ?? 0) > 0,
  );
  // Empty-state gate: blank ONLY while the first restore is still in flight.
  // Keyed off `bootSettled` (which always flips) — never off container/daemon
  // nullness, which can stick null on IPC error and trap the Hub blank.
  const bootSettled = useStore((s) => s.bootSettled);
  const files = useOverlay((s) => s.files);
  const setFiles = useOverlay((s) => s.setFiles);
  const diff = useOverlay((s) => s.diff);
  const setDiff = useOverlay((s) => s.setDiff);
  const filePreview = useOverlay((s) => s.filePreview);
  const setFilePreview = useOverlay((s) => s.setFilePreview);
  const shell = useOverlay((s) => s.shell);
  const resume = useOverlay((s) => s.resume);
  const resumeSide = useOverlay((s) => s.resumeSide);
  // The launcher is a TAB, not a modal: it fills the content area below the tab
  // bar (sidebar + tabs stay visible) so opening it feels like a browser new-tab
  // page rather than a takeover. The launcher tab chip lives in HubTabs.
  const launcher = useOverlay((s) => s.launcher);
  const setLauncher = useOverlay((s) => s.setLauncher);
  useActivityPoll();
  useAgentEvents();

  // Hub utility panels (Files / Diff / FilePreview / Resume) dock around a LIVE
  // workspace; they must never render over the Welcome empty state or the
  // launcher overlay (otherwise an open Files panel traps the user on Welcome).
  // Gate them on the same `active && !launcher` the right-dock panels already use.
  const hubPanels = !!active && !launcher;

  return (
    <>
      {resume && resumeSide === "left" && hubPanels && <ResumeDrawer />}
      <AnimatePresence>
        {files && hubPanels && <FilesBrowser key="files" onClose={() => setFiles(false)} />}
      </AnimatePresence>
      <main
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          background: "var(--bg-1)",
          position: "relative",
        }}
      >
        <RuntimeBanner />
        {/* Tab strip only when a workspace is open or the launcher tab is showing —
            on the Welcome empty state there are no tabs (and its own CTA replaces
            the "+" / bell, which belong to a live hub). */}
        {(active || launcher) && <HubTabs />}
        {launcher ? (
          // Launcher tab content: recent / resume / create, filling the area
          // below the tab bar. `onClose` returns to the active workspace.
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <Welcome onClose={() => setLauncher(false)} />
          </div>
        ) : active ? (
          <>
            <GroupsBar ws={active} />
            <div className="hub-grid" style={{ position: "relative" }}>
              <Grid ws={active} />
            </div>
            <AnimatePresence>{shell && <ShellPanel key="shell" />}</AnimatePresence>
            <ActionBar />
          </>
        ) : !bootSettled ? (
          <div style={{ flex: 1 }} />
        ) : hasSaved ? (
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <Welcome />
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <EmptyHero onNew={(cli) => newAgent(cli)} />
          </div>
        )}
        {/* Bottom region: one element that animates its height between the
            one-line status bar and the expanded graphs panel (⌘I / its chevron). */}
        {active && !launcher && <HubStatusBar />}
      </main>

      {active && !launcher && (
        <>
          <AnimatePresence>
            {diff !== null && <DiffViewer key="diff" path={diff} onClose={() => setDiff(null)} />}
          </AnimatePresence>
          <AnimatePresence>
            {filePreview !== null && (
              <FilePreview
                key="filepreview"
                path={filePreview}
                onClose={() => setFilePreview(null)}
              />
            )}
          </AnimatePresence>
          {resume && resumeSide === "right" && <ResumeDrawer />}
        </>
      )}
    </>
  );
}
