/**
 * DevPreview — dev-only harness for previewing ported screens in isolation.
 * Gated behind import.meta.env.DEV + the #/__screens hash in main.tsx. NOT in
 * production builds. Provides a screen switcher + dark/light theme toggle so the
 * design-backed screens can be reviewed without hunting through the live app.
 */
import { AboutDialog } from "@/app/components/AboutDialog";
import { Grid } from "@/app/components/Grid";
import { AppShell } from "@/app/components/chrome/AppShell";
import { ActionBar } from "@/app/components/hub/ActionBar";
import { CommandPalette } from "@/app/components/hub/CommandPalette";
import { GroupsBar } from "@/app/components/hub/GroupsBar";
import { HubSidebar } from "@/app/components/hub/HubSidebar";
import { HubStatusBar } from "@/app/components/hub/HubStatusBar";
import { HubTabs } from "@/app/components/hub/HubTabs";
import { RuntimeBanner } from "@/app/components/hub/RuntimeBanner";
import { Shortcuts } from "@/app/components/hub/Shortcuts";
import { WorkspaceBar } from "@/app/components/hub/WorkspaceBar";
import { ipc } from "@/app/lib/ipc";
import { useOverlay } from "@/app/lib/overlay";
import { type HubView, activeWorkspace, initLifecycle, useStore } from "@/app/lib/store";
import { useTheme } from "@/app/lib/theme";
import { MAX_GROUP_PANES, leavesList, workspaceTitle } from "@/app/lib/tree";
import { Companion } from "@/app/screens/Companion";
import { Dashboard } from "@/app/screens/Dashboard";
import { EmptyHero, EmptyState } from "@/app/screens/EmptyState";
import { LiveActivities } from "@/app/screens/LiveActivities";
import { NewWorkspace } from "@/app/screens/NewWorkspace";
import { ResumeDrawer } from "@/app/screens/Resume";
import { SessionDetail } from "@/app/screens/SessionDetail";
import { Settings } from "@/app/screens/Settings";
import { SpawnDialog } from "@/app/screens/SpawnDialog";
import StatesGallery from "@/app/screens/States";

import { Welcome } from "@/app/screens/Welcome";
import { useEffect, useState } from "react";

type ScreenKey =
  | "empty"
  | "main-hub-a"
  | "hub-states"
  | "welcome"
  | "spawn"
  | "new-workspace"
  | "palette"
  | "shortcuts"
  | "about"
  | "dashboard"
  | "workspaces"
  | "settings"
  | "settings-agents"
  | "settings-integrations"
  | "settings-platform"
  | "settings-notifications"
  | "live-activities"
  | "companion"
  | "agent-settings"
  | "resume"
  | "session-detail"
  | "states";

const SCREENS: { key: ScreenKey; label: string; title: string }[] = [
  { key: "empty", label: "Empty state", title: "codehub · welcome" },
  { key: "main-hub-a", label: "Main hub", title: "codehub · hub" },
  { key: "hub-states", label: "Hub states", title: "codehub · hub states" },
  { key: "welcome", label: "Welcome", title: "codehub · workspace launcher" },
  { key: "spawn", label: "Spawn dialog", title: "codehub · new agent" },
  { key: "new-workspace", label: "New workspace", title: "codehub · new workspace" },
  { key: "palette", label: "Command palette", title: "codehub · ⌘K" },
  { key: "shortcuts", label: "Shortcuts", title: "codehub · shortcuts" },
  { key: "about", label: "About", title: "codehub · about" },
  { key: "dashboard", label: "Dashboard", title: "codehub · dashboard" },
  { key: "workspaces", label: "Workspaces", title: "codehub · workspaces · runtime" },
  { key: "settings", label: "Settings", title: "codehub · settings" },
  { key: "settings-agents", label: "Agents", title: "codehub · settings · agents" },
  { key: "settings-integrations", label: "Source control", title: "codehub · source control" },
  { key: "settings-platform", label: "Platform", title: "codehub · platform" },
  { key: "settings-notifications", label: "Notifications", title: "codehub · notifications" },
  { key: "live-activities", label: "Live activities", title: "codehub · live activities" },
  { key: "companion", label: "Companion", title: "codehub · companion" },
  { key: "agent-settings", label: "Agent settings", title: "codehub · agent settings" },
  { key: "resume", label: "Resume", title: "codehub · resume" },
  { key: "session-detail", label: "Session detail", title: "codehub · session detail" },
  { key: "states", label: "States", title: "codehub · states" },
];

const SCREEN_ALIASES: Partial<Record<string, ScreenKey>> = {
  "empty-state": "empty",
  "spawn-dialog": "spawn",
  "command-palette": "palette",
  "container-inspector": "workspaces",
  integrations: "settings-integrations",
  platform: "settings-platform",
};

function currentScreen(): ScreenKey {
  const m = window.location.hash.match(/#\/__screens\/([^/?#]+)/);
  const raw = m?.[1];
  const k = raw ? (SCREEN_ALIASES[raw] ?? (raw as ScreenKey)) : undefined;
  return k && SCREENS.some((s) => s.key === k) ? k : "empty";
}

function previewNav(screen: ScreenKey): { view: HubView; settingsSection?: string } {
  if (screen === "dashboard") return { view: "dashboard" };
  if (screen === "agent-settings") return { view: "settings", settingsSection: "agents" };
  if (screen.startsWith("settings-")) {
    return { view: "settings", settingsSection: screen.replace("settings-", "") };
  }
  if (screen === "settings") return { view: "settings", settingsSection: "agents" };
  return { view: "hub" };
}

function usesAppSidebar(screen: ScreenKey): boolean {
  return [
    "main-hub-a",
    "hub-states",
    "welcome",
    "spawn",
    "dashboard",
    "workspaces",
    "settings",
    "settings-agents",
    "settings-integrations",
    "settings-platform",
    "settings-notifications",
    "agent-settings",
    "new-workspace",
    "palette",
    "shortcuts",
    "about",
    "resume",
    "session-detail",
  ].includes(screen);
}

export default function DevPreview() {
  const { theme, toggle } = useTheme();
  const [screen, setScreen] = useState<ScreenKey>(currentScreen);

  useEffect(() => {
    void initLifecycle();
    // The real app receives a synthetic lifecycle event during startup. When a
    // dev browser reloads straight into #/__screens, that event can already be
    // gone, so seed the store from the workspace-container fleet.
    ipc
      .listWorkspaceContainers()
      .then((fleet) => {
        const current = fleet.find((c) => c.status.state === "running") ?? fleet[0];
        if (current) useStore.getState().setStatus(current.status);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onHash = () => setScreen(currentScreen());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const nav = previewNav(screen);
    const store = useStore.getState();
    if (store.sidebarCollapsed) store.toggleSidebar();
    if (nav.settingsSection) store.setSettingsSection(nav.settingsSection);
    if (store.view !== nav.view) store.setView(nav.view);
  }, [screen]);

  const select = (k: ScreenKey) => {
    window.location.hash = `#/__screens/${k}`;
    setScreen(k);
  };

  const meta = SCREENS.find((s) => s.key === screen) ?? SCREENS[0];
  const hasAppRail = usesAppSidebar(screen);

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-0)",
      }}
    >
      {/* dev toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 14px",
          borderBottom: "1px solid var(--bd-soft)",
          background: "var(--bg-1)",
          flexShrink: 0,
          fontFamily: "var(--sans)",
          flexWrap: "wrap",
        }}
      >
        <span className="lbl" style={{ color: "var(--fg-2)" }}>
          Screens
        </span>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", minWidth: 0 }}>
          {SCREENS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => select(s.key)}
              style={{
                padding: "4px 10px",
                borderRadius: "var(--r-2)",
                border: "1px solid var(--bd)",
                background: screen === s.key ? "var(--bg-3)" : "transparent",
                color: screen === s.key ? "var(--fg-0)" : "var(--fg-2)",
                fontSize: "var(--fs-12)",
                cursor: "pointer",
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={toggle}
          style={{
            padding: "4px 12px",
            borderRadius: "var(--r-2)",
            border: "1px solid var(--bd)",
            background: "var(--bg-3)",
            color: "var(--fg-0)",
            fontSize: "var(--fs-12)",
            cursor: "pointer",
          }}
        >
          Theme: {theme}
        </button>
      </div>

      {/* framed screen */}
      <div style={{ flex: 1, overflow: "hidden", padding: 16 }}>
        <div
          style={{
            width: "100%",
            height: "100%",
            border: "1px solid var(--bd)",
            borderRadius: "var(--r-4)",
            overflow: "hidden",
            boxShadow: "var(--shadow-2)",
          }}
        >
          <AppShell
            title={meta.title}
            rail={hasAppRail ? <HubSidebar /> : undefined}
            railFramed={false}
          >
            <PreviewBody screen={screen} />
          </AppShell>
        </div>
      </div>
    </div>
  );
}

function PreviewBody({ screen }: { screen: ScreenKey }) {
  if (screen === "empty") return <EmptyState onNew={() => {}} />;
  if (screen === "main-hub-a" || screen === "hub-states") return <PreviewHubBackdrop />;
  if (screen === "welcome") return <Welcome />;
  if (screen === "dashboard") return <Dashboard />;
  if (screen === "workspaces") return <Welcome />;

  if (screen === "states") return <StatesGallery />;
  if (screen === "live-activities") return <LiveActivities />;
  if (screen === "companion") return <Companion />;
  if (screen === "agent-settings")
    return <SettingsPreview section="agents" initialAgentDetail="claude" />;
  if (screen === "session-detail") return <SessionDetailPreview />;

  if (screen === "spawn") return <OverlayPreview kind="spawn" />;

  if (screen === "new-workspace") return <OverlayPreview kind="new-workspace" />;
  if (screen === "palette") return <OverlayPreview kind="palette" />;
  if (screen === "shortcuts") return <OverlayPreview kind="shortcuts" />;
  if (screen === "about") return <OverlayPreview kind="about" />;
  if (screen === "resume") return <OverlayPreview kind="resume" />;

  if (screen.startsWith("settings-")) {
    const section = screen.replace("settings-", "");
    return <SettingsPreview section={section} />;
  }

  return <SettingsPreview section="agents" />;
}

function SettingsPreview({
  section,
  initialAgentDetail,
}: {
  section: string;
  initialAgentDetail?: "claude" | "codex" | "antigravity";
}) {
  const setSettingsSection = useStore((s) => s.setSettingsSection);

  useEffect(() => {
    setSettingsSection(section);
  }, [section, setSettingsSection]);

  return (
    <Settings
      key={`${section}:${initialAgentDetail ?? "list"}`}
      initialAgentDetail={initialAgentDetail}
    />
  );
}

function SessionDetailPreview() {
  const session = useStore(
    (s) => Object.entries(s.sessionMeta).find(([, meta]) => meta.cli !== "shell")?.[0] ?? null,
  );

  if (!session) {
    return (
      <div style={{ height: "100%", display: "flex" }}>
        <EmptyHero onNew={() => {}} />
      </div>
    );
  }

  return <SessionDetail session={session} />;
}

function OverlayPreview({
  kind,
}: {
  kind: "new-workspace" | "spawn" | "palette" | "shortcuts" | "about" | "resume";
}) {
  const setPalette = useOverlay((s) => s.setPalette);
  const setShortcuts = useOverlay((s) => s.setShortcuts);
  const setAbout = useOverlay((s) => s.setAbout);
  const setNewWorkspace = useOverlay((s) => s.setNewWorkspace);
  const setResume = useOverlay((s) => s.setResume);
  const active = useStore(activeWorkspace);

  const groups = active?.groups.map((g) => {
    const count = leavesList(g.root).length;
    return {
      id: g.id,
      name: g.name,
      color: g.color,
      count,
      full: count >= MAX_GROUP_PANES,
    };
  });

  useEffect(() => {
    setPalette(kind === "palette");
    setShortcuts(kind === "shortcuts");
    setAbout(kind === "about");
    setNewWorkspace(kind === "new-workspace");
    setResume(kind === "resume");

    return () => {
      setPalette(false);
      setShortcuts(false);
      setAbout(false);
      setNewWorkspace(false);
      setResume(false);
    };
  }, [kind, setAbout, setNewWorkspace, setPalette, setResume, setShortcuts]);

  return (
    <div style={{ height: "100%", display: "flex", position: "relative" }}>
      <div style={{ flex: 1, minWidth: 0, display: "flex" }}>
        {kind === "new-workspace" ? <PreviewWelcomeBackdrop /> : <PreviewHubBackdrop />}
      </div>
      {kind === "resume" && <ResumeDrawer />}
      {kind === "spawn" && (
        <SpawnDialog
          workspaceName={active ? workspaceTitle(active) : undefined}
          groups={groups}
          onLaunch={() => {}}
          onCancel={() => {}}
        />
      )}
      <CommandPalette />
      <Shortcuts />
      <AboutDialog />
      {kind === "new-workspace" && <NewWorkspace />}
    </div>
  );
}

function PreviewWelcomeBackdrop() {
  return <Welcome />;
}

function PreviewHubBackdrop() {
  const active = useStore(activeWorkspace);
  const hasSaved = useStore((s) => (s.config?.savedWorkspaces?.length ?? 0) > 0);

  if (!active) {
    return hasSaved ? <Welcome /> : <EmptyHero onNew={() => {}} />;
  }

  return (
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
      <GroupsBar ws={active} />
      <div className="hub-grid">
        <Grid ws={active} />
      </div>
      <WorkspaceBar />
      <ActionBar />
      <HubStatusBar />
    </main>
  );
}
