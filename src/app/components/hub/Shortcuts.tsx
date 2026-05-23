/**
 * Keyboard shortcuts cheat sheet (⌘/). Ported from design/screens/shortcuts.jsx,
 * but trimmed to ONLY the bindings that actually work today (see
 * hooks/useKeyboard.ts + the command palette). The design's full grid lists many
 * shortcuts for features that don't exist yet (diff inspector, companion,
 * accounts, …); listing them as working would be a lie, so they're left out
 * until those features land.
 */
import { useOverlay } from "../../lib/overlay";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../ui/dialog";

type Sc = { keys: string[]; desc: string };

// Single source of truth for the working key bindings — consumed both by this
// ⌘/ dialog and the Settings → Keyboard shortcuts pane.
export const SHORTCUT_GROUPS: { title: string; items: Sc[] }[] = [
  {
    title: "Workspace",
    items: [
      { keys: ["⌘", "N"], desc: "New agent session" },
      { keys: ["⌘", "W"], desc: "Close focused session" },
      { keys: ["⌘", "\\"], desc: "Split focused pane" },
    ],
  },
  {
    title: "Navigation",
    items: [
      { keys: ["⌘", "1–9"], desc: "Jump to workspace tab" },
      { keys: ["⌘", "K"], desc: "Command palette" },
      { keys: ["⌘", "/"], desc: "This cheat sheet" },
      { keys: ["esc"], desc: "Close palette / overlay" },
    ],
  },
];

export function Shortcuts() {
  const open = useOverlay((s) => s.shortcuts);
  const setShortcuts = useOverlay((s) => s.setShortcuts);

  return (
    <Dialog open={open} onOpenChange={setShortcuts}>
      <DialogContent style={{ maxWidth: 560 }}>
        <DialogHeader>
          <DialogTitle style={{ fontSize: 16 }}>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 22, marginTop: 8 }}>
          {SHORTCUT_GROUPS.map((g) => (
            <div key={g.title}>
              <div className="lbl" style={{ marginBottom: 10, color: "var(--fg-1)", fontSize: 11 }}>
                {g.title}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {g.items.map((sc) => (
                  <div
                    key={sc.desc}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "3px 0" }}
                  >
                    <span style={{ display: "inline-flex", gap: 3 }}>
                      {sc.keys.map((k) => (
                        <span key={k} className="kbd">
                          {k}
                        </span>
                      ))}
                    </span>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 12, color: "var(--fg-1)", textAlign: "right" }}>
                      {sc.desc}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="mono" style={{ margin: "16px 0 0", fontSize: 11, color: "var(--fg-3)" }}>
          Inside a terminal pane, all other keys pass straight through to the agent / tmux. More
          shortcuts arrive as their features ship.
        </p>
      </DialogContent>
    </Dialog>
  );
}
