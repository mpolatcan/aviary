import { useMemo, useState } from "react";
import { useOverlay } from "../../lib/overlay";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";

type Sc = { keys: string[]; desc: string };

export const SHORTCUT_GROUPS: { title: string; items: Sc[] }[] = [
  {
    title: "Workspace",
    items: [
      { keys: ["⌘", "N"], desc: "New agent session" },
      { keys: ["⌘", "T"], desc: "New workspace tab" },
      { keys: ["⌘", "W"], desc: "Close current pane" },
      { keys: ["⌘", "⇧", "W"], desc: "Close workspace tab" },
      { keys: ["⌘", "\\"], desc: "Split pane vertically" },
      { keys: ["⌘", "⇧", "\\"], desc: "Split pane horizontally" },
      { keys: ["⌘", "E"], desc: "Toggle files pane" },
      { keys: ["⌘", "⇧", "B"], desc: "Toggle shell pane" },
      { keys: ["⌘", "D"], desc: "Toggle diff inspector" },
    ],
  },
  {
    title: "Navigation",
    items: [
      { keys: ["⌘", "1–9"], desc: "Jump to workspace tab" },
      { keys: ["⌘", "["], desc: "Previous tab" },
      { keys: ["⌘", "]"], desc: "Next tab" },
      { keys: ["⌘", "K"], desc: "Command palette" },
      { keys: ["⌘", "⇧", "F"], desc: "Search across sessions" },
      { keys: ["⌘", "⇧", "J"], desc: "Expand dynamic island" },
      { keys: ["⌥", "tab"], desc: "Cycle agent panes" },
      { keys: ["⌘", "⇧", "P"], desc: "Pin / docks sidebar" },
      { keys: ["⌘", "↑"], desc: "Top of scrollback" },
    ],
  },
  {
    title: "Agent · Turn",
    items: [
      { keys: ["↵"], desc: "Send / approve" },
      { keys: ["⇧", "↵"], desc: "New line in prompt" },
      { keys: ["⌘", "↵"], desc: "Send to all visible agents" },
      { keys: ["esc"], desc: "Cancel turn" },
      { keys: ["⌘", "."], desc: "Stop agent" },
      { keys: ["⌘", "R"], desc: "Restart turn from last prompt" },
      { keys: ["⌘", "⇧", "R"], desc: "Restart with same context" },
      { keys: ["⌘", "Z"], desc: "Undo last agent edit" },
      { keys: ["tab"], desc: "Cycle auto-mode" },
    ],
  },
  {
    title: "System",
    items: [
      { keys: ["⌘", ","], desc: "Open settings" },
      { keys: ["?"], desc: "This help" },
      { keys: ["⌘", "⇧", "L"], desc: "Cycle theme (dark / gray / light)" },
      { keys: ["⌘", "⇧", "C"], desc: "Toggle companion" },
      { keys: ["⌘", "⇧", "N"], desc: "New workspace" },
      { keys: ["⌘", "⌥", "I"], desc: "Open dev tools" },
      { keys: ["⌘", "Q"], desc: "Quit CodeHub" },
    ],
  },
  {
    title: "Diff Inspector",
    items: [
      { keys: ["j", "k"], desc: "Next / previous hunk" },
      { keys: ["s"], desc: "Stage hunk" },
      { keys: ["u"], desc: "Unstage hunk" },
      { keys: ["⌘", "P"], desc: "Open PR…" },
      { keys: ["c"], desc: "Commit staged" },
    ],
  },
  {
    title: "Container",
    items: [
      { keys: ["⌘", "⇧", "X"], desc: "Exec shell in container" },
      { keys: ["⌘", "⌥", "R"], desc: "Restart container" },
      { keys: ["⌘", "⌥", "."], desc: "Stop container" },
      { keys: ["⌘", "⌥", "L"], desc: "Tail container logs" },
    ],
  },
  {
    title: "Selection / Scroll",
    items: [
      { keys: ["⌘", "F"], desc: "Find in pane" },
      { keys: ["⌘", "A"], desc: "New agent (split)" },
      { keys: ["⌘", "C"], desc: "Copy" },
      { keys: ["⌘", "⇧", "V"], desc: "Paste as plain" },
      { keys: ["/"], desc: "Search scrollback" },
    ],
  },
  {
    title: "Accounts",
    items: [
      { keys: ["⌘", "⇧", "A"], desc: "Switch account on active pane" },
      { keys: ["⌘", "⌥", "B"], desc: "Open billing" },
    ],
  },
];

export function Shortcuts() {
  const open = useOverlay((s) => s.shortcuts);
  const setShortcuts = useOverlay((s) => s.setShortcuts);
  const [filter, setFilter] = useState("");

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
      <DialogContent
        className="w-[min(70rem,calc(100vw-32px))] max-w-[calc(100vw-32px)] gap-0 overflow-hidden rounded-[14px] border-[var(--bd-strong)] bg-[var(--bg-2)] p-0 shadow-[0_30px_80px_rgba(0,0,0,.6)] sm:max-w-none"
        showCloseButton={false}
        style={{ maxHeight: "min(47.5rem, calc(100vh - 48px))" }}
      >
        <DialogHeader className="gap-0">
          <div
            style={{
              padding: "14px 22px",
              borderBottom: "1px solid var(--bd-soft)",
              display: "flex",
              alignItems: "center",
              gap: 14,
            }}
          >
            <DialogTitle style={{ fontSize: 16 }}>Keyboard shortcuts</DialogTitle>
            <DialogDescription className="sr-only">
              Search and review the keyboard shortcuts available in CodeHub.
            </DialogDescription>
            <span className="mono" style={{ fontSize: 12, color: "var(--fg-2)" }}>
              press <span className="kbd">?</span> anywhere to open ·{" "}
              <span className="kbd">esc</span> to close
            </span>
            <span style={{ flex: 1 }} />
            <Input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter shortcuts…"
              spellCheck={false}
              className="mono h-auto w-[220px] rounded-md px-2.5 py-1 text-xs"
            />
          </div>
        </DialogHeader>

        <div
          className="scroll"
          style={{
            overflow: "auto",
            padding: 22,
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: "28px 22px",
            minHeight: 80,
          }}
        >
          {groups.length === 0 ? (
            <p
              className="mono"
              style={{
                margin: 0,
                fontSize: 12,
                color: "var(--fg-3)",
                gridColumn: "1 / -1",
              }}
            >
              No shortcuts match "{filter}".
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
                      key={`${sc.keys.join("+")} ${sc.desc}`}
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
                      <span
                        style={{
                          fontSize: 12,
                          color: "var(--fg-1)",
                          textAlign: "right",
                        }}
                      >
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
            padding: "10px 22px",
            borderTop: "1px solid var(--bd-soft)",
            background: "var(--bg-1)",
          }}
        >
          <p
            className="mono"
            style={{ margin: 0, fontSize: 11, color: "var(--fg-3)", flex: 1 }}
          >
            vim-style keys also work inside terminal panes (handled by tmux)
          </p>
          <Button variant="outline" size="sm" onClick={() => {}}>
            Customize…
          </Button>
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            Print
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
