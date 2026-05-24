/**
 * Keyboard shortcuts cheat sheet (⌘/). Ported from design/screens/shortcuts.jsx.
 *
 * Honesty rule (binding): this lists ONLY bindings that actually fire today —
 * the global handlers in hooks/useKeyboard.ts plus the unconditional pass-through
 * to the terminal. The design mock's full grid included shortcuts for features
 * that don't exist yet (diff inspector, companion toggle, account switch, theme
 * toggle, stop-agent, …); listing those as working would be a lie, so they're
 * omitted until those features ship. Keeping this in sync with useKeyboard.ts is
 * the maintenance contract — a binding appears here only when it's wired there.
 *
 * Adds a filter input (live substring match over key + description) and a print
 * button (window.print) over the design.
 */
import { useMemo, useState } from "react";
import { useOverlay } from "../../lib/overlay";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../ui/dialog";

type Sc = { keys: string[]; desc: string };

// Single source of truth for the working key bindings — consumed both by this
// ⌘/ dialog and the Settings → Keyboard shortcuts pane. Every entry maps to a
// real case in useKeyboard.ts (or the always-on terminal pass-through).
export const SHORTCUT_GROUPS: { title: string; items: Sc[] }[] = [
  {
    title: "Workspace",
    items: [
      { keys: ["⌘", "N"], desc: "New agent session" },
      { keys: ["⌘", "T"], desc: "New workspace tab" },
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
      { keys: ["esc"], desc: "Close palette / cheat sheet" },
    ],
  },
];

export function Shortcuts() {
  const open = useOverlay((s) => s.shortcuts);
  const setShortcuts = useOverlay((s) => s.setShortcuts);
  const [filter, setFilter] = useState("");

  // Live substring filter over key glyphs + description (case-insensitive).
  // Groups with no surviving items drop out entirely.
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return SHORTCUT_GROUPS;
    return SHORTCUT_GROUPS.map((g) => ({
      title: g.title,
      items: g.items.filter(
        (sc) =>
          sc.desc.toLowerCase().includes(q) ||
          sc.keys.join(" ").toLowerCase().includes(q) ||
          g.title.toLowerCase().includes(q),
      ),
    })).filter((g) => g.items.length > 0);
  }, [filter]);

  return (
    <Dialog open={open} onOpenChange={setShortcuts}>
      <DialogContent style={{ maxWidth: 620 }}>
        <DialogHeader>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <DialogTitle style={{ fontSize: 16 }}>Keyboard shortcuts</DialogTitle>
            <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>
              press <span className="kbd">⌘</span>
              <span className="kbd" style={{ marginLeft: 2 }}>
                /
              </span>{" "}
              to toggle
            </span>
            <span style={{ flex: 1 }} />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter…"
              spellCheck={false}
              style={{
                background: "var(--bg-1)",
                border: "1px solid var(--bd)",
                borderRadius: 6,
                padding: "5px 10px",
                fontSize: 12,
                color: "var(--fg-1)",
                fontFamily: "var(--mono)",
                width: 160,
                outline: "none",
              }}
            />
          </div>
        </DialogHeader>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 22,
            marginTop: 8,
            minHeight: 80,
          }}
        >
          {groups.length === 0 ? (
            <p className="mono" style={{ margin: 0, fontSize: 12, color: "var(--fg-3)" }}>
              No shortcuts match “{filter}”.
            </p>
          ) : (
            groups.map((g) => (
              <div key={g.title}>
                <div
                  className="lbl"
                  style={{ marginBottom: 10, color: "var(--fg-1)", fontSize: 11 }}
                >
                  {g.title}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {g.items.map((sc) => (
                    <div
                      key={sc.desc}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "3px 0",
                      }}
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
            ))
          )}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 16,
            paddingTop: 12,
            borderTop: "1px solid var(--bd-soft)",
          }}
        >
          <p className="mono" style={{ margin: 0, fontSize: 11, color: "var(--fg-3)", flex: 1 }}>
            Inside a terminal pane, every other key passes straight through to the agent / tmux.
            More shortcuts arrive as their features ship.
          </p>
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            Print
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
