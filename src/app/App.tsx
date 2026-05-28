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
import { PromptToasts } from "./components/hub/PromptToasts";
import { RuntimeBanner } from "./components/hub/RuntimeBanner";
import { ShellPanel } from "./components/hub/ShellPanel";
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
  const openLaunch = useLauncher((s) => s.open);
  const hasSaved = useStore(
    (s) => (s.config?.savedWorkspaces?.length ?? 0) > 0 || (s.workspaceContainers?.length ?? 0) > 0,
  );
  const initialLoadDone = useStore(
    (s) => s.workspaceContainers !== null && s.dockerInfo !== null,
  );
  const files = useOverlay((s) => s.files);
  const setFiles = useOverlay((s) => s.setFiles);
  const diff = useOverlay((s) => s.diff);
  const setDiff = useOverlay((s) => s.setDiff);
  const filePreview = useOverlay((s) => s.filePreview);
  const setFilePreview = useOverlay((s) => s.setFilePreview);
  const shell = useOverlay((s) => s.shell);
  const resume = useOverlay((s) => s.resume);
  const resumeSide = useOverlay((s) => s.resumeSide);
  useActivityPoll();
  useAgentEvents();

  return (
    <>
      {resume && resumeSide === "left" && <ResumeDrawer />}
      <AnimatePresence>
        {files && <FilesBrowser key="files" onClose={() => setFiles(false)} />}
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
        <HubTabs />
        {active ? (
          <>
            <GroupsBar ws={active} />
            <div className="hub-grid" style={{ position: "relative" }}>
              <Grid ws={active} />
              <PromptToasts />
            </div>
            {shell && <ShellPanel />}
            <WorkspaceBar />
            <ActionBar />
          </>
        ) : !initialLoadDone ? (
          <div style={{ flex: 1 }} />
        ) : hasSaved ? (
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <Welcome />
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <EmptyHero
              onNew={(cli) =>
                openLaunch("newtab", cli ? { dir: "row", preferredCli: cli } : undefined)
              }
            />
          </div>
        )}
        {active && <HubStatusBar />}
      </main>

      {active && (
        <>
          <AnimatePresence>
            {diff !== null && <DiffViewer key="diff" path={diff} onClose={() => setDiff(null)} />}
          </AnimatePresence>
          <AnimatePresence>
            {filePreview !== null && (
              <FilePreview key="filepreview" path={filePreview} onClose={() => setFilePreview(null)} />
            )}
          </AnimatePresence>
          {resume && resumeSide === "right" && <ResumeDrawer />}
        </>
      )}
    </>
  );
}
