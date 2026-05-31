import { motion } from "motion/react";
import type { ReactNode } from "react";
import { AgentGlyph } from "../../components/primitives/AgentGlyph";
import { IconBtn } from "../../components/primitives/IconBtn";
import { Logo } from "../../components/primitives/Logo";
import { StatusDot } from "../../components/primitives/StatusDot";
import { Tip } from "../../components/primitives/Tip";
import { Ico } from "../../components/primitives/icons";
import { fmtTokens, useCodexUsage, useSessionUsage } from "../../hooks/useSessionUsage";
import { deriveLiveStatus } from "../../lib/activity";
import { MODE_BY_ID, SPEC_BY_CLI } from "../../lib/catalog";
import { useOverlay } from "../../lib/overlay";
import { confirmCloseRunningSession, useStore } from "../../lib/store";
import { type Group, leavesList, workspaceLeaves, workspaceTitle } from "../../lib/tree";

// Compact a host mount path to its last two segments ("…/Desktop/my-projects") so
// the workspace card shows the real mount WITH parent context — not just the
// basename, which usually already names the workspace.
function mountPath(path: string | undefined): string {
  if (!path) return "workspace";
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return `/${parts.join("/")}`;
  return `…/${parts.slice(-2).join("/")}`;
}

// Compact size for the workspace row's lifecycle IconBtns (restart/stop/start) —
// smaller than the default 26 so two fit the dense 264px sidebar row.
const LIFE_BTN = { width: 22, height: 22 } as const;

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
type NavId = "hub" | "dashboard" | "settings";

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
  const setView = useStore((s) => s.setView);
  const openLauncher = useOverlay((s) => s.setLauncher);

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
        <IconBtn
          title="Open workspace — recent, resume, or new (⌘T)"
          onClick={() => {
            setView("hub");
            openLauncher(true);
          }}
        >
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
            ⌘T
          </span>{" "}
          to open one.
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
  const containers = useStore((s) => s.workspaceContainers);
  // Shared container lifecycle actions + in-flight flag (also used by the Welcome
  // card), so the row shows a spinner + disables its controls while an op runs.
  const lcStart = useStore((s) => s.startContainer);
  const lcStop = useStore((s) => s.stopContainer);
  const lcRestart = useStore((s) => s.restartContainer);
  const busy = useStore((s) => (ws ? s.containerBusy[ws.containerKey] : undefined));
  if (!ws) return null;
  const open = ws.id === activeId;
  const sessions = workspaceLeaves(ws);
  const title = workspaceTitle(ws);
  // Container lifecycle, mirrored from the Welcome card. Restart/stop kill every
  // attached tmux session (the bollard execs die with the container), so both
  // confirm + name how many go. Hover-revealed (like the session close button).
  const state = containers?.find((c) => c.key === ws.containerKey)?.status.state;
  const killClause =
    sessions.length > 0
      ? ` This kills ${sessions.length} attached session${sessions.length === 1 ? "" : "s"}.`
      : "";
  const restartContainer = async () => {
    if (busy) return;
    if (!window.confirm(`Restart the "${title}" workspace container?${killClause}`)) return;
    await lcRestart(ws.containerKey);
  };
  const stopContainer = async () => {
    if (busy) return;
    if (!window.confirm(`Stop the "${title}" workspace container?${killClause}`)) return;
    await lcStop(ws.containerKey);
  };
  const startContainer = async () => {
    if (busy) return;
    await lcStart(ws.containerKey);
  };
  // The mounted directory, shown right under the name with parent context
  // ("…/Desktop/my-projects") so it reads as a real path, not the redundant
  // basename. A repo mount (live git, open workspace) also gets a branch chip;
  // a plain-directory mount never fakes one.
  const isRepo = open && !!git?.isRepo;
  const path = mountPath(ws.dir);
  const branch = isRepo ? (git?.branch ?? "detached") : null;
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "4px 6px 1px",
        }}
      >
        <button
          type="button"
          onClick={() => switchWorkspace(ws.id)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flex: 1,
            minWidth: 0,
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            color: "inherit",
          }}
        >
          <span
            style={{
              display: "inline-flex",
              color: open ? "var(--pri)" : "var(--fg-2)",
              flexShrink: 0,
            }}
          >
            {open ? Ico.hub : Ico.container}
          </span>
          <span
            className="mono"
            style={{
              fontSize: 12.5,
              color: open ? "var(--fg-0)" : "var(--fg-1)",
              fontWeight: 600,
              flex: 1,
              textAlign: "left",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title}
          </span>
        </button>
        {busy ? (
          <span
            title={`${busy}…`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              color: "var(--wait)",
              flexShrink: 0,
            }}
          >
            {Ico.spinner}
          </span>
        ) : (
          <>
            {state === "running" && (
              <span style={{ display: "inline-flex", gap: 1 }}>
                <IconBtn
                  title="Restart container"
                  style={LIFE_BTN}
                  onClick={(e) => {
                    e.stopPropagation();
                    void restartContainer();
                  }}
                >
                  {Ico.restart}
                </IconBtn>
                <IconBtn
                  title="Stop container"
                  style={LIFE_BTN}
                  hoverColor="var(--err)"
                  hoverBg="color-mix(in oklab, var(--err) 16%, transparent)"
                  onClick={(e) => {
                    e.stopPropagation();
                    void stopContainer();
                  }}
                >
                  {Ico.stop}
                </IconBtn>
              </span>
            )}
            {state === "stopped" && (
              <IconBtn
                title="Start container"
                style={LIFE_BTN}
                onClick={(e) => {
                  e.stopPropagation();
                  void startContainer();
                }}
              >
                {Ico.play}
              </IconBtn>
            )}
          </>
        )}
        {sessions.length > 0 && (
          <span
            className="mono tnum"
            title={`${sessions.length} pane${sessions.length === 1 ? "" : "s"}`}
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: open ? "var(--fg-1)" : "var(--fg-2)",
              background: "var(--bg-3)",
              borderRadius: 5,
              padding: "1px 6px",
              flexShrink: 0,
            }}
          >
            {sessions.length}
          </span>
        )}
      </div>

      {/* mounted directory — proper path, right under the name; a repo also gets a
          branch chip. Divider + spacing live here so name+path read as one block. */}
      <div
        title={branch ? `${ws.dir ?? path} · ${branch}` : (ws.dir ?? path)}
        style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--fg-2)",
          padding: "0 6px 6px",
          borderBottom: open ? "1px solid var(--bd-soft)" : "none",
          marginBottom: open ? 5 : 0,
          display: "flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        <span style={{ display: "inline-flex", flexShrink: 0, color: "var(--fg-3)" }}>
          {Ico.files}
        </span>
        <span
          style={{
            flex: branch ? "0 1 auto" : 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {path}
        </span>
        {branch && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              flexShrink: 0,
              maxWidth: "45%",
              padding: "0 5px",
              borderRadius: 4,
              background: "var(--bg-3)",
              color: "var(--fg-1)",
            }}
          >
            <span style={{ display: "inline-flex", flexShrink: 0, color: "var(--fg-3)" }}>
              {Ico.branch}
            </span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {branch}
            </span>
          </span>
        )}
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
  // Hooks must run unconditionally. Compute claudeId + usage BEFORE the `meta`
  // guard: when a session closes, its sessionMeta is deleted and this row
  // re-renders once with meta undefined — an early return above useSessionUsage
  // would render fewer hooks, throwing "Rendered fewer hooks than expected" and
  // (with no error boundary) blanking the whole app.
  const claudeId = activity?.claudeId ?? (meta?.cli === "claude" ? meta.claudeId : undefined);
  const codexId = meta?.cli === "codex" ? (activity?.codexId ?? undefined) : undefined;
  // Both hooks run unconditionally (above the meta guard AND not `??`-gated) —
  // Claude reads its transcript, Codex its rollout; the unused one returns null.
  const claudeUsage = useSessionUsage(claudeId ?? null);
  const codexUsage = useCodexUsage(codexId ?? null);
  const usage = claudeUsage ?? codexUsage;
  // The workspace's mount dir — fallback label when the pane runs at the mount
  // root (or for a restored session whose cwd wasn't kept). Selected unconditionally
  // (above the meta guard) so the hook count never changes when a row closes.
  const wsDir = useStore((s) => {
    const m = s.sessionMeta[session];
    return m ? s.workspaces.find((w) => w.id === m.workspaceId)?.dir : undefined;
  });
  if (!meta) return null;
  const spec = SPEC_BY_CLI[meta.cli];
  const badge = MODE_BY_ID[meta.mode].badge;
  const focused = workspaceFocused === session;
  // Drive the whole row from the shared derived status so it agrees with the
  // pane head + island (deriveLiveStatus folds in sessionStatus==="awaiting", so
  // we don't lag the pane on the slower pendingPrompts poll). Focus is shown by
  // the row highlight, NOT a fake "live" dot — live/working means a real turn is
  // in flight (tool use / thinking), never just "this pane is selected".
  const view = activity ? deriveLiveStatus(activity, awaiting) : null;
  const status = view?.status ?? "idle";
  const working = status === "live";
  const isWait = status === "wait";
  const label = view?.label ?? spec.label;
  const statusColor = isWait
    ? "var(--wait)"
    : status === "err"
      ? "var(--err)"
      : status === "done"
        ? "var(--done)"
        : working
          ? "var(--live)"
          : "var(--fg-2)";
  const isAgent = meta.cli !== "shell";
  // Working dir this pane targets: the cwd basename when pinned to a sub-dir,
  // else the workspace mount's own folder name (the "mount root").
  const dirBase = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
  const workingDir =
    meta.cwd && meta.cwd !== "/workspace"
      ? dirBase(meta.cwd)
      : wsDir
        ? dirBase(wsDir)
        : "workspace";
  // Full host path of the working dir, for the truncation tooltip: the mount path
  // plus whatever sub-path the agent was pinned to under /workspace.
  const fullDir =
    meta.cwd?.startsWith("/workspace") && wsDir
      ? `${wsDir}${meta.cwd.slice("/workspace".length)}`
      : (wsDir ?? meta.cwd ?? workingDir);

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
          : isWait
            ? {
                background: "color-mix(in oklab, var(--wait) 8%, transparent)",
                borderLeft: "2px solid var(--wait)",
                paddingLeft: 8,
              }
            : {}),
      }}
      onClick={() => focusSession(session)}
    >
      <div style={{ display: "flex", alignItems: "center", alignSelf: "center" }}>
        <StatusDot status={status} pulse={working} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* line 1: agent identity + live status (right) */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
          <AgentGlyph agent={meta.cli} size={12} color={`var(--a-${meta.cli})`} />
          <span
            className="mono"
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--fg-0)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {meta.alias}
          </span>
          {badge && <span className={`mode-badge badge-${meta.mode}`}>{badge}</span>}
          <span style={{ flex: 1 }} />
          {isWait ? (
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
          ) : (
            <span
              className="mono"
              style={{
                fontSize: 10,
                color: statusColor,
                fontWeight: working ? 600 : 400,
                flexShrink: 0,
                whiteSpace: "nowrap",
              }}
            >
              {label}
            </span>
          )}
        </div>
        {/* line 2: working dir + token meter, one muted meta line */}
        {isAgent && (
          <div
            className="mono"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: 10.5,
              color: "var(--fg-2)",
            }}
          >
            <span
              style={{
                display: "inline-flex",
                flexShrink: 0,
                transform: "scale(0.82)",
                color: "var(--fg-3)",
              }}
            >
              {Ico.files}
            </span>
            <span
              title={fullDir}
              style={{
                flexShrink: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {workingDir}
            </span>
            {usage && (
              <span
                className="tnum"
                style={{ flexShrink: 0, color: "var(--fg-3)", whiteSpace: "nowrap" }}
              >
                · {usage.turns}t · {fmtTokens(usage.tokensIn + usage.tokensOut)} tok
              </span>
            )}
          </div>
        )}
      </div>
      {/* close — absolutely centered on the card's right edge (see .session-close);
          revealed on row hover, red on its own hover. */}
      <button
        type="button"
        className="session-close"
        aria-label="close"
        onClick={(e) => {
          e.stopPropagation();
          if (!confirmCloseRunningSession(session)) return;
          void closeSession(session);
        }}
      >
        ×
      </button>
    </div>
  );
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
