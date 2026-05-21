import { useEffect } from "react";
import { useLauncher } from "../lib/launcher";
import { useStore } from "../lib/store";
import type { SplitDir } from "../lib/tree";

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
//   ⌘/Ctrl T  — new tab (opens the launcher)
//   ⌘/Ctrl W  — close the focused session
//   ⌘/Ctrl \  — split the focused pane
//   ⌘/Ctrl 1-9 — switch to tab N
//
// Attached at the capture phase so they win over xterm.js, which installs its
// own keydown handler on the pane textarea. Skipped while the inline rename
// field is focused so ⌘W there doesn't nuke the pane mid-edit.
export function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.classList?.contains("pane-name-input")) return;

      const store = useStore.getState();
      const launcher = useLauncher.getState();
      const ws = store.workspaces.find((w) => w.id === store.activeWorkspaceId);

      // ⌘1-9 — jump to tab by index.
      if (/^[1-9]$/.test(e.key)) {
        const tab = store.workspaces[Number(e.key) - 1];
        if (tab) {
          e.preventDefault();
          store.switchWorkspace(tab.id);
        }
        return;
      }

      switch (e.key.toLowerCase()) {
        case "t":
          e.preventDefault();
          void launcher.openLauncher("New tab").then((c) => {
            if (c) void store.newPlate(c.cli, c.mode);
          });
          break;
        case "w":
          if (!ws?.focused) return;
          e.preventDefault();
          void store.closeSession(ws.focused);
          break;
        case "\\": {
          if (!ws?.focused) return;
          e.preventDefault();
          const focused = ws.focused;
          void launcher.openLauncher("Split").then((c) => {
            if (c) void store.splitSession(focused, autoSplitDir(focused), c.cli, c.mode);
          });
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
