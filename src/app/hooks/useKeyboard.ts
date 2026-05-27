import { useEffect } from "react";
import { groupKey, splitKey, useLauncher } from "../lib/launcher";
import { useOverlay } from "../lib/overlay";
import { confirmCloseRunningSession, useStore } from "../lib/store";
import { type SplitDir, activeGroup, workspaceLeaves, workspaceTitle } from "../lib/tree";

// Split the focused pane along its longer visible axis — wider panes split into
// a row (side-by-side), taller ones into a column. Compares the leaf's dataset
// rather than building a selector: bootstrap-imported tmux names can contain
// selector-special chars and would throw querySelector.
export function autoSplitDir(session: string): SplitDir {
  const el = [...document.querySelectorAll<HTMLElement>(".pane-leaf")].find(
    (n) => n.dataset.session === session,
  );
  return el && el.clientWidth >= el.clientHeight ? "row" : "col";
}

// Global keyboard shortcuts:
//   ⌘/Ctrl N  — new tab (opens the launcher); ⌘/Ctrl T kept as an alias
//   ⌘⇧N       — new-workspace wizard (the Welcome launcher's CTA)
//   ⌘⇧T       — new workspace tab (same launcher, fresh tab target)
//   ⌘/Ctrl A  — new agent in the current workspace (same launcher, focused context)
//   ⌘/Ctrl W  — close the focused session
//   ⌘⇧W       — close the active workspace tab
//   ⌘[ / ⌘]   — previous / next workspace tab
//   ⌘/Ctrl \  — split the focused pane (longer axis); ⌘⇧\ forces a column split
//   ⌘/Ctrl E  — toggle the Files docked viewer
//   ⌘/Ctrl D  — toggle the all-changes Diff viewer
//   ⌘B        — collapse/expand the sidebar (design AppSidebar rail)
//   ⌘⇧B       — toggle the Shell docked panel
//   ⌘⇧A       — collapse/expand the Activity rail
//   ⌘G        — spawn a new agent into a fresh group (design SpawnPlacementMenu)
//   ⌘/Ctrl R  — toggle the Resume drawer (docked over the hub)
//   ⌘/Ctrl ,  — settings
//   ⌘/Ctrl K  — command palette
//   ⌘/Ctrl /  — keyboard-shortcuts cheat sheet
//   ?          — keyboard-shortcuts cheat sheet when focus is outside an editor/terminal
//   ⌘/Ctrl 1-9 — switch to tab N
//
// Attached at the capture phase so they win over xterm.js, which installs its
// own keydown handler on the pane textarea. Skipped while the inline rename
// field is focused so ⌘W there doesn't nuke the pane mid-edit.
export function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      const editable =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable ||
        target?.getAttribute("role") === "textbox";

      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey && !editable) {
        e.preventDefault();
        useOverlay.getState().toggleShortcuts();
        return;
      }

      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (target?.classList?.contains("pane-name-input")) return;

      const store = useStore.getState();
      const launcher = useLauncher.getState();
      const overlay = useOverlay.getState();
      const ws = store.workspaces.find((w) => w.id === store.activeWorkspaceId);
      // The focused session of the active group — every grid shortcut acts on it.
      const focused = ws ? (activeGroup(ws)?.focused ?? null) : null;

      // While the palette / cheat sheet is open, only the two toggles below stay
      // live (so ⌘K and ⌘/ can dismiss). Everything else — ⌘W, ⌘\, ⌘N, ⌘1-9 —
      // would act on the pane hidden behind the dialog, so swallow it. esc is
      // handled by Radix on the dialog itself.
      if (overlay.palette || overlay.shortcuts) {
        if (e.key === "k" || e.key === "/") {
          e.preventDefault();
          if (e.key === "k") overlay.togglePalette();
          else overlay.toggleShortcuts();
        }
        return;
      }

      // ⌘1-9 — jump to tab by index.
      if (/^[1-9]$/.test(e.key)) {
        const tab = store.workspaces[Number(e.key) - 1];
        if (tab) {
          e.preventDefault();
          store.switchWorkspace(tab.id);
        }
        return;
      }

      if (e.key === "[" || e.key === "]") {
        if (store.workspaces.length === 0 || !store.activeWorkspaceId) return;
        const idx = store.workspaces.findIndex((w) => w.id === store.activeWorkspaceId);
        if (idx === -1) return;
        e.preventDefault();
        const dir = e.key === "[" ? -1 : 1;
        const next =
          store.workspaces[(idx + dir + store.workspaces.length) % store.workspaces.length];
        store.switchWorkspace(next.id);
        return;
      }

      switch (e.key.toLowerCase()) {
        case "n":
          e.preventDefault();
          // ⌘⇧N opens the new-workspace wizard; plain ⌘N (and ⌘T) the spawn launcher.
          if (e.shiftKey) overlay.setNewWorkspace(true);
          else launcher.open("newtab");
          break;
        case "t":
          e.preventDefault();
          launcher.open("newtab");
          break;
        case "k":
          e.preventDefault();
          useOverlay.getState().togglePalette();
          break;
        case "/":
          e.preventDefault();
          useOverlay.getState().toggleShortcuts();
          break;
        case "w":
          e.preventDefault();
          if (e.shiftKey) {
            if (!ws) return;
            const count = workspaceLeaves(ws).length;
            const suffix =
              count > 0 ? ` This ends ${count} session${count === 1 ? "" : "s"} in the tab.` : "";
            if (window.confirm(`Close ${workspaceTitle(ws)}?${suffix}`)) {
              void store.closeWorkspace(ws.id);
            }
            return;
          }
          if (!focused) return;
          if (!confirmCloseRunningSession(focused)) return;
          void store.closeSession(focused);
          break;
        case ",":
          e.preventDefault();
          store.setView("settings");
          break;
        case "e": // toggle the Files docked viewer
          e.preventDefault();
          overlay.setFiles(!overlay.files);
          break;
        case "d": // toggle the all-changes Diff viewer
          e.preventDefault();
          overlay.setDiff(overlay.diff === null ? "" : null);
          break;
        case "r": // toggle the Resume drawer (docked over the hub)
          e.preventDefault();
          // Already on the hub with it open → close; otherwise jump to the hub
          // (the drawer only renders there) and open it.
          if (store.view === "hub" && overlay.resume) {
            overlay.setResume(false);
          } else {
            store.setView("hub");
            overlay.setResume(true);
          }
          break;
        case "b":
          e.preventDefault();
          // ⌘B collapses/expands the sidebar (design AppSidebar); ⌘⇧B toggles Shell.
          if (!e.shiftKey) {
            store.toggleSidebar();
            return;
          }
          overlay.setShell(!overlay.shell);
          break;
        case "a":
          e.preventDefault();
          // ⌘A is the in-workspace new-agent shortcut from the design handoff.
          // When there is no focused pane, fall back to the same fresh-tab path
          // as ⌘N so the command is always productive.
          if (!e.shiftKey) {
            if (focused) {
              launcher.open(splitKey(focused), { dir: "row", session: focused });
            } else {
              launcher.open("newtab");
            }
            return;
          }
          overlay.setActivityRail(!overlay.activityRail);
          break;
        case "g": {
          // ⌘G — spawn a new agent into a fresh group of the active workspace.
          if (!ws) return;
          e.preventDefault();
          const gid = store.addGroup(ws.id);
          launcher.open(groupKey(gid), { dir: "row", groupId: gid, workspaceId: ws.id });
          break;
        }
        case "|":
        case "\\": {
          if (!focused) return;
          e.preventDefault();
          // ⌘⇧\ (arrives as "|") forces a downward column split; plain ⌘\ picks
          // the longer visible axis automatically.
          const dir: SplitDir = e.shiftKey ? "col" : autoSplitDir(focused);
          launcher.open(splitKey(focused), { dir, session: focused });
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
