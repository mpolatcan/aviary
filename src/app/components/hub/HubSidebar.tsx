import { motion } from "motion/react";
import type { ReactNode } from "react";
import { AgentGlyph } from "../../components/primitives/AgentGlyph";
import { IconBtn } from "../../components/primitives/IconBtn";
import { Logo } from "../../components/primitives/Logo";
import { StatusDot } from "../../components/primitives/StatusDot";
import { Tip } from "../../components/primitives/Tip";
import { Ico } from "../../components/primitives/icons";
import { fmtTokens, useSessionUsage } from "../../hooks/useSessionUsage";
import { MODE_BY_ID, SPEC_BY_CLI } from "../../lib/catalog";
import { useOverlay } from "../../lib/overlay";
import { confirmCloseRunningSession, useStore } from "../../lib/store";
import { type Group, leavesList, workspaceLeaves, workspaceTitle } from "../../lib/tree";

function dirName(path: string | undefined): string | null {
  if (!path) return null;
  return path.split("/").filter(Boolean).pop() ?? null;
}

// Left sidebar — ported 1:1 from design/components.jsx `AppSidebar`. Two forms:
// an expanded 264px panel and a collapsed 52px icon rail (⌘B / header chevron
// toggles `sidebarCollapsed`). Structure matches the design exactly:
//   header (logo + collapse) · Views nav · Workspaces list · account footer.
// Data is real: views are the live HubViews, the Workspaces section lists the
// open workspaces and their tmux sessions, the footer shows runtime identity
// (CodeHub has no per-user account system — the design's "m.kim · Free 12%"
// has no source, so we bind the same slot to the real runtime instead).

// design NAV_ITEMS — top-level views. `view` is the live HubView each maps to;
// `badge` resolves to a real count (sessions) or undefined.
type NavId = "hub" | "dashboard" | "workspaces" | "settings";

export function HubSidebar() {
  const collapsed = useStore((s) => s.sidebarCollapsed);
  return (
    <motion.div
      animate={{ width: collapsed ? 52 : 264 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      style={{
        flexShrink: 0,
        overflow: "hidden",
        display: "flex",
      }}
    >
      {collapsed ? <SidebarRail /> : <SidebarExpanded />}
    </motion.div>
  );
}

// ── shared selectors + nav model ────────────────────────────────────────────
function useNav() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const setSettingsSection = useStore((s) => s.setSettingsSection);
  // Count agents (non-shell), matching the Dashboard header's "N agents" and the
  // running-card "of N sessions" — shell panels aren't agents.
  const sessionCount = useStore(
    (s) => Object.values(s.sessionMeta).filter((m) => m.cli !== "shell").length,
  );

  const activeId: NavId | null =
    view === "hub"
      ? "hub"
      : view === "dashboard"
        ? "dashboard"
        : view === "containers"
          ? "workspaces"
          : view === "settings"
            ? "settings"
            : null;

  const items: Array<{
    id: NavId;
    label: string;
    icon: ReactNode;
    badge?: string;
    go: () => void;
  }> = [
    { id: "hub", label: "Hub", icon: Ico.hub, go: () => setView("hub") },
    {
      id: "dashboard",
      label: "Dashboard",
      icon: Ico.grid,
      badge: sessionCount > 0 ? String(sessionCount) : undefined,
      go: () => setView("dashboard"),
    },
    { id: "workspaces", label: "Workspaces", icon: Ico.container, go: () => setView("containers") },
    {
      id: "settings",
      label: "Settings",
      icon: Ico.settings,
      go: () => {
        setSettingsSection("general");
        setView("settings");
      },
    },
  ];
  return { activeId, items };
}

// ── EXPANDED (264px) ─────────────────────────────────────────────────────────
function SidebarExpanded() {
  const { activeId, items } = useNav();
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const openAbout = useOverlay((s) => s.setAbout);

  return (
    <aside
      style={{
        width: 264,
        flexShrink: 0,
        background: "var(--bg-1)",
        borderRight: "1px solid var(--bd-soft)",
        display: "flex",
        flexDirection: "column",
        color: "var(--fg-1)",
      }}
    >
      {/* header — logo + collapse */}
      <div
        style={{
          padding: "12px 14px 10px",
          borderBottom: "1px solid var(--bd-soft)",
          display: "flex",
          alignItems: "center",
        }}
      >
        <button
          type="button"
          title="About CodeHub"
          onClick={() => openAbout(true)}
          style={{
            display: "flex",
            alignItems: "center",
            background: "transparent",
            border: "none",
            padding: 0,
            margin: 0,
            cursor: "pointer",
            color: "inherit",
          }}
        >
          <Logo />
        </button>
        <span style={{ flex: 1 }} />
        <IconBtn title="Collapse sidebar (⌘B)" onClick={toggleSidebar}>
          {Ico.sidebarL}
        </IconBtn>
      </div>

      {/* Views */}
      <div style={{ padding: "10px 10px 4px" }}>
        <div style={{ padding: "0 4px 6px" }}>
          <span className="lbl">Views</span>
        </div>
        {items.map((n) => (
          <button
            type="button"
            key={n.id}
            className={`side-item${activeId === n.id ? " active" : ""}`}
            onClick={n.go}
          >
            {n.icon}
            <span style={{ flex: 1 }}>{n.label}</span>
            {n.badge && (
              <span className="mono" style={{ color: "var(--fg-2)", fontSize: 11 }}>
                {n.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Workspaces */}
      <WorkspacesSection />

      {/* footer — runtime identity (closest real source for the account slot) */}
      <SidebarFooter />
    </aside>
  );
}

// ── Workspaces list (design `WorkspaceSideRow`) ──────────────────────────────
function WorkspacesSection() {
  const workspaces = useStore((s) => s.workspaces);
  const openWizard = useOverlay((s) => s.setNewWorkspace);

  return (
    <div
      style={{
        flex: 1,
        padding: "12px 10px 4px",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 4px 8px",
        }}
      >
        <span className="lbl">Workspaces · {workspaces.length}</span>
        <IconBtn title="New workspace (⌘⇧N)" onClick={() => openWizard(true)}>
          {Ico.plus}
        </IconBtn>
      </div>

      {workspaces.length === 0 ? (
        <div
          style={{
            padding: "20px 12px",
            textAlign: "center",
            border: "1px dashed var(--bd)",
            borderRadius: 8,
            fontSize: 12,
            color: "var(--fg-2)",
            lineHeight: 1.55,
          }}
        >
          No workspaces yet.
          <br />
          <span className="mono" style={{ color: "var(--fg-3)" }}>
            ⌘⇧N
          </span>{" "}
          to create one.
        </div>
      ) : (
        <div
          className="scroll"
          style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 6 }}
        >
          {workspaces.map((ws) => (
            <WorkspaceSideRow key={ws.id} workspaceId={ws.id} />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkspaceSideRow({ workspaceId }: { workspaceId: string }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const activeId = useStore((s) => s.activeWorkspaceId);
  const switchWorkspace = useStore((s) => s.switchWorkspace);
  const git = useStore((s) => s.gitStatus);
  if (!ws) return null;
  const open = ws.id === activeId;
  const sessions = workspaceLeaves(ws);
  const title = workspaceTitle(ws);
  const repoLabel =
    open && git?.isRepo ? (git.branch ?? "detached") : (dirName(ws.dir) ?? "workspace");
  // Show a group sublabel only when the workspace has more than one group
  // (a single default group is just noise).
  const showGroupLabels = ws.groups.length > 1;

  return (
    <div
      className="ws-side-row"
      style={{
        borderRadius: 7,
        padding: 4,
        background: open ? "color-mix(in oklab, var(--bg-2) 60%, transparent)" : "transparent",
        border: `1px solid ${open ? "var(--bd-soft)" : "transparent"}`,
      }}
    >
      <button
        type="button"
        onClick={() => switchWorkspace(ws.id)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 6px 6px",
          width: "100%",
          background: "transparent",
          border: "none",
          borderBottom: open ? "1px solid var(--bd-soft)" : "none",
          marginBottom: open ? 4 : 0,
          cursor: "pointer",
          color: "inherit",
        }}
      >
        <span style={{ display: "inline-flex", color: open ? "var(--pri)" : "var(--fg-2)" }}>
          {open ? Ico.hub : Ico.container}
        </span>
        <span
          className="mono"
          style={{
            fontSize: 11,
            color: "var(--fg-1)",
            fontWeight: 500,
            flex: 1,
            textAlign: "left",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </span>
        <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>
          {sessions.length}
        </span>
      </button>

      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10,
          color: "var(--fg-3)",
          padding: "0 6px 4px",
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        {Ico.branch}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {repoLabel}
        </span>
      </div>

      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {ws.groups.map((g) => (
            <GroupSessions key={g.id} group={g} showLabel={showGroupLabels} />
          ))}
        </div>
      )}
    </div>
  );
}

// A group's session rows, optionally prefixed by a small colored group label
// (design AppSidebar groups its agent rows by group name).
function GroupSessions({ group, showLabel }: { group: Group; showLabel: boolean }) {
  const sessions = leavesList(group.root);
  if (sessions.length === 0) return null;
  return (
    <>
      {showLabel && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 6px 2px",
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: group.color }} />
          <span className="lbl" style={{ fontSize: 9 }}>
            {group.name}
          </span>
        </div>
      )}
      {sessions.map((session) => (
        <SessionRow key={session} session={session} workspaceFocused={group.focused} />
      ))}
    </>
  );
}

function SessionRow({
  session,
  workspaceFocused,
}: {
  session: string;
  workspaceFocused: string | null;
}) {
  const meta = useStore((s) => s.sessionMeta[session]);
  const activity = useStore((s) => s.sessionActivity[session]);
  const awaiting = useStore((s) => s.pendingPrompts.some((p) => p.session === session));
  const focusSession = useStore((s) => s.focusSession);
  const closeSession = useStore((s) => s.closeSession);
  if (!meta) return null;
  const spec = SPEC_BY_CLI[meta.cli];
  const badge = MODE_BY_ID[meta.mode].badge;
  const focused = workspaceFocused === session;
  const working = activity?.state === "working";
  const status = awaiting ? "wait" : working ? "live" : focused ? "live" : "idle";
  const claudeId = activity?.claudeId ?? (meta.cli === "claude" ? meta.claudeId : undefined);
  const usage = useSessionUsage(claudeId ?? null);
  const isAgent = meta.cli !== "shell";

  return (
    <div
      className={`side-item${focused ? " active" : ""}${working ? " session-working" : ""}`}
      style={{
        alignItems: "flex-start",
        padding: "8px 10px",
        position: "relative",
        overflow: "hidden",
        ...(working
          ? {
              background: "color-mix(in oklab, var(--live) 6%, transparent)",
              borderLeft: "2px solid var(--live)",
              paddingLeft: 8,
            }
          : awaiting
            ? {
                background: "color-mix(in oklab, var(--wait) 8%, transparent)",
                borderLeft: "2px solid var(--wait)",
                paddingLeft: 8,
              }
            : {}),
      }}
      onClick={() => focusSession(session)}
    >
      <div style={{ display: "flex", alignItems: "center", paddingTop: 1 }}>
        <StatusDot status={status} pulse={working || awaiting || focused} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 2 }}>
          <AgentGlyph agent={meta.cli} size={11} color={`var(--a-${meta.cli})`} />
          <span
            className="mono"
            style={{
              fontSize: 11.5,
              fontWeight: 500,
              color: "var(--fg-0)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {meta.alias}
          </span>
          {badge && <span className={`mode-badge badge-${meta.mode}`}>{badge}</span>}
          {awaiting && (
            <span
              className="mono"
              style={{
                fontSize: 9,
                fontWeight: 600,
                color: "var(--wait)",
                background: "color-mix(in oklab, var(--wait) 15%, transparent)",
                padding: "1px 5px",
                borderRadius: 3,
                flexShrink: 0,
                letterSpacing: "0.03em",
              }}
            >
              INPUT
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="session-close"
            aria-label="close"
            onClick={(e) => {
              e.stopPropagation();
              if (!confirmCloseRunningSession(session)) return;
              void closeSession(session);
            }}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--fg-3)",
              cursor: "pointer",
              fontSize: 13,
              lineHeight: 1,
              padding: 0,
              opacity: 0,
              transition: "opacity .15s",
            }}
          >
            ×
          </button>
        </div>
        <div
          className="mono tnum"
          style={{
            fontSize: 10.5,
            color: working ? "var(--live)" : awaiting ? "var(--wait)" : "var(--fg-3)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={working ? { fontWeight: 500 } : undefined}>
            {awaiting
              ? "needs input"
              : working
                ? "working"
                : activity
                  ? `idle ${fmtIdle(activity.idleMs)}`
                  : spec.label}
          </span>
          {isAgent && usage && (
            <>
              <span style={{ color: "var(--fg-3)" }}>·</span>
              <span style={{ color: "var(--fg-3)" }}>
                {usage.turns}t · {fmtTokens(usage.tokensIn + usage.tokensOut)} tok
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function fmtIdle(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

// ── footer — design's account row, fed by real runtime identity ──────────────
function SidebarFooter() {
  const status = useStore((s) => s.status);
  const dockerInfo = useStore((s) => s.dockerInfo);
  const runtimeLive = status?.state === "running";

  return (
    <div
      style={{
        padding: "10px 12px",
        borderTop: "1px solid var(--bd-soft)",
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: 5,
          background: "linear-gradient(135deg, oklch(0.7 0.13 30), oklch(0.6 0.13 280))",
          flexShrink: 0,
          position: "relative",
        }}
      >
        <span
          style={{
            position: "absolute",
            right: -2,
            bottom: -2,
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: runtimeLive ? "var(--live)" : "var(--idle)",
            border: "1.5px solid var(--bg-1)",
          }}
        />
      </div>
      <div style={{ flex: 1, minWidth: 0 }} title={status?.name ?? undefined}>
        <div
          className="mono"
          style={{
            fontSize: 12,
            color: "var(--fg-0)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {status?.state ?? "—"}
        </div>
        <div className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>
          {dockerInfo?.version ? `docker ${dockerInfo.version}` : "docker daemon"}
        </div>
      </div>
    </div>
  );
}

// ── COLLAPSED RAIL (52px) ─────────────────────────────────────────────────────
function SidebarRail() {
  const { activeId, items } = useNav();
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const runtimeState = useStore((s) => s.status?.state);

  return (
    <aside
      style={{
        width: 52,
        flexShrink: 0,
        background: "var(--bg-0)",
        borderRight: "1px solid var(--bd-soft)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "12px 0 10px",
      }}
    >
      <div
        style={{
          paddingBottom: 10,
          marginBottom: 8,
          width: "100%",
          display: "flex",
          justifyContent: "center",
        }}
      >
        <Logo size={20} withText={false} />
      </div>
      <RailIcon title="Expand sidebar (⌘B)" onClick={toggleSidebar}>
        {Ico.sidebarR}
      </RailIcon>
      <div style={{ height: 8 }} />
      {items.map((n) => (
        <RailIcon
          key={n.id}
          title={n.label}
          active={activeId === n.id}
          badge={n.badge}
          onClick={n.go}
        >
          {n.icon}
        </RailIcon>
      ))}
      <div style={{ flex: 1 }} />
      <div
        title={runtimeState ?? "unknown"}
        style={{
          display: "flex",
          justifyContent: "center",
          padding: "6px 0",
        }}
      >
        <StatusDot
          status={
            runtimeState === "running" ? "live" : runtimeState === "starting" ? "wait" : "off"
          }
          pulse={runtimeState === "running"}
        />
      </div>
    </aside>
  );
}

function RailIcon({
  children,
  active,
  badge,
  title,
  onClick,
}: {
  children: ReactNode;
  active?: boolean;
  badge?: string;
  title: string;
  onClick?: () => void;
}) {
  return (
    <Tip text={title} side="right">
      <button
        type="button"
        onClick={onClick}
        style={{
          width: 32,
          height: 32,
          borderRadius: 7,
          marginBottom: 4,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: active ? "var(--bg-3)" : "transparent",
          color: active ? "var(--fg-0)" : "var(--fg-2)",
          cursor: "pointer",
          position: "relative",
          border: "none",
          padding: 0,
          transition: "background .12s, color .12s",
        }}
        onMouseEnter={(e) => {
          if (!active) {
            e.currentTarget.style.background = "var(--bg-3)";
            e.currentTarget.style.color = "var(--fg-0)";
          }
        }}
        onMouseLeave={(e) => {
          if (!active) {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--fg-2)";
          }
        }}
      >
        {children}
        {badge && (
          <span
            className="mono"
            style={{
              position: "absolute",
              top: -2,
              right: -2,
              fontSize: 10,
              fontWeight: 600,
              background: "var(--fg-0)",
              color: "var(--bg-0)",
              borderRadius: 7,
              padding: "1px 4px",
              minWidth: 14,
              textAlign: "center",
              border: "1.5px solid var(--bg-0)",
            }}
          >
            {badge}
          </span>
        )}
      </button>
    </Tip>
  );
}
