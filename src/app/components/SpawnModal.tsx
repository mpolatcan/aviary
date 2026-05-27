import { useEffect } from "react";
import type { Cli, Mode } from "../lib/ipc";
import { useLauncher } from "../lib/launcher";
import { activeWorkspace, useStore } from "../lib/store";
import { MAX_GROUP_PANES, leavesList, workspaceTitle } from "../lib/tree";
import { type GroupChoice, NEW_GROUP, SpawnDialog } from "../screens/SpawnDialog";

// The single agent-creation modal, shared by every launch surface (sidebar
// "New agent", tab "+", pane split control, ⌘N / ⌘T). Driven entirely by the
// useLauncher store: any surface calls `open(key, ctx)`, and this host renders
// the full SpawnDialog over the whole window. The launch context decides the
// action — a split context (`ctx.session`) splits that pane; otherwise a fresh
// workspace tab is opened. Replaces the per-surface anchored popovers so the
// rich dialog (agent · mode · account · repo · container · prompt) is the one
// agent-creation UX everywhere.
export function SpawnModal() {
  const openKey = useLauncher((s) => s.openKey);
  const ctx = useLauncher((s) => s.ctx);
  const close = useLauncher((s) => s.close);
  const newPlate = useStore((s) => s.newPlate);
  const splitSession = useStore((s) => s.splitSession);
  const addPaneToGroup = useStore((s) => s.addPaneToGroup);
  const addGroup = useStore((s) => s.addGroup);
  const defaultCli = useStore((s) => s.config?.defaultAgent ?? "claude");
  const active = useStore(activeWorkspace);
  const runtimeLive = useStore((s) => s.status?.state === "running");

  useEffect(() => {
    if (openKey === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openKey, close]);

  if (openKey === null) return null;
  const splitting = Boolean(ctx?.session);

  // The active workspace's groups, offered as spawn targets in the dialog. Only
  // for the plain new-tab launch — a split (ctx.session) or empty-group CTA
  // (ctx.groupId) already fixes where the pane lands, so no picker is shown.
  const groups: GroupChoice[] | undefined =
    !splitting && !ctx?.groupId && active
      ? active.groups.map((g) => {
          const count = leavesList(g.root).length;
          return {
            id: g.id,
            name: g.name,
            color: g.color,
            count,
            full: count >= MAX_GROUP_PANES,
          };
        })
      : undefined;
  const workspaceName = active ? workspaceTitle(active) : ctx?.workspaceTitle;

  const launch = (
    cli: Cli,
    mode: Mode,
    prompt: string,
    account?: string,
    targetGroupId?: string,
  ) => {
    close();
    if (ctx?.session) {
      void splitSession(ctx.session, ctx.dir, cli, mode, prompt, account);
    } else if (ctx?.groupId && ctx.workspaceId) {
      void addPaneToGroup(ctx.workspaceId, ctx.groupId, cli, mode, prompt, account);
    } else if (targetGroupId && active) {
      // Spawn into the active workspace: an existing group, or a fresh one.
      // addPaneToGroup no-ops when the runtime is down; only create a NEW group
      // once we know the spawn can land, so a stopped container can't orphan an
      // empty, now-active group.
      if (targetGroupId === NEW_GROUP && !runtimeLive) return;
      if (targetGroupId !== NEW_GROUP) {
        const targetGroup = active.groups.find((g) => g.id === targetGroupId);
        if (leavesList(targetGroup?.root ?? null).length >= MAX_GROUP_PANES) return;
      }
      const groupId = targetGroupId === NEW_GROUP ? addGroup(active.id) : targetGroupId;
      void addPaneToGroup(active.id, groupId, cli, mode, prompt, account);
    } else {
      // Default (and historic) behaviour: a brand-new workspace tab.
      const resume = cli === "claude" ? ctx?.resume : undefined;
      void newPlate(cli, mode, resume, prompt, account, {
        title: ctx?.workspaceTitle,
        dir: ctx?.workspaceDir,
        savedWorkspaceId: ctx?.savedWorkspaceId,
      });
    }
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 50 }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          close();
        }
      }}
    >
      <SpawnDialog
        defaultCli={ctx?.preferredCli ?? defaultCli}
        splitting={splitting}
        groups={groups}
        workspaceName={workspaceName}
        onLaunch={launch}
        onCancel={close}
      />
    </div>
  );
}
