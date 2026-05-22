import { useEffect, useState } from "react";
import { SPEC_BY_CLI } from "../../lib/catalog";
import { ipc } from "../../lib/ipc";
import { useOverlay } from "../../lib/overlay";
import { getPane } from "../../lib/panes";
import { useStore } from "../../lib/store";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../ui/dialog";
import { AgentGlyph } from "../primitives/AgentGlyph";

// Broadcast composer: type one prompt and send it to several running agents at
// once. This is the genuinely-real core of the design's broadcast screen — the
// side-by-side answer comparison + per-agent token/cost telemetry it shows is
// fabrication-blocked (CodeHub captures no structured per-turn output or cost),
// so it's intentionally omitted. We send the prompt to each agent's input via
// the same pty_write the terminal uses; the responses stream in each agent's own
// terminal pane, exactly as if you'd typed the prompt into each by hand.

export function BroadcastModal() {
  const open = useOverlay((s) => s.broadcast);
  const setOpen = useOverlay((s) => s.setBroadcast);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const running = useStore((s) => s.status?.state === "running");

  const sessions = Object.entries(sessionMeta);
  // Selected target sessions (by name). Defaults to all whenever the modal opens.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState("");
  const [sentTo, setSentTo] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    // Seed the selection from a snapshot taken at open time (getState, not the
    // reactive value) so re-renders as sessionMeta changes mid-compose don't
    // re-seed and fight the user's selection.
    setSelected(new Set(Object.keys(useStore.getState().sessionMeta)));
    setPrompt("");
    setSentTo(null);
  }, [open]);

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
    setSentTo(null);
  };

  const targets = sessions.filter(([name]) => selected.has(name));
  const canSend = running && prompt.trim().length > 0 && targets.length > 0;

  const send = () => {
    if (!canSend) return;
    // Wrap the prompt in bracketed-paste markers (DECSET 2004) so a multi-line
    // prompt arrives as one paste — interior newlines stay literal instead of
    // each submitting a separate line — then a trailing CR submits it once.
    // This is exactly what a terminal sends when you paste into it; the agent
    // TUIs enable bracketed paste, and it degrades to a plain submit for a
    // single-line prompt. Panes without a backing pty (shouldn't happen — a
    // running session always has one) are skipped rather than throwing.
    const payload = `\x1b[200~${prompt}\x1b[201~\r`;
    let n = 0;
    for (const [name] of targets) {
      const pane = getPane(name);
      if (!pane) continue;
      ipc.ptyWrite(pane.paneId, payload).catch(console.warn);
      n++;
    }
    setSentTo(n);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
      <DialogContent style={{ maxWidth: 560 }}>
        <DialogHeader>
          <DialogTitle style={{ fontSize: 14, fontWeight: 600 }}>Broadcast a prompt</DialogTitle>
          <p style={{ margin: 0, fontSize: 12, color: "var(--fg-2)", lineHeight: 1.5 }}>
            Sends the prompt to each selected agent's input — replies stream in their own terminals.
          </p>
        </DialogHeader>

        {sessions.length === 0 ? (
          <Note>No running sessions to broadcast to.</Note>
        ) : (
          <>
            <textarea
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                setSentTo(null);
              }}
              placeholder="Type a prompt to send to the selected agents…"
              spellCheck={false}
              style={{
                width: "100%",
                minHeight: 96,
                resize: "vertical",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid var(--bd)",
                background: "var(--bg-0)",
                color: "var(--fg-0)",
                fontFamily: "var(--mono)",
                fontSize: 12.5,
                lineHeight: 1.5,
                outline: "none",
                boxSizing: "border-box",
              }}
            />

            <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 4 }}>
              <span className="lbl" style={{ marginBottom: 4 }}>
                Send to · {targets.length}/{sessions.length}
              </span>
              {sessions.map(([name, meta]) => {
                const on = selected.has(name);
                return (
                  <button
                    type="button"
                    key={name}
                    onClick={() => toggle(name)}
                    className="rail-file"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      width: "100%",
                      padding: "6px 8px",
                      borderRadius: 6,
                      border: "none",
                      background: "transparent",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: 15,
                        height: 15,
                        flexShrink: 0,
                        borderRadius: 4,
                        border: `1.5px solid ${on ? "var(--live)" : "var(--bd)"}`,
                        background: on ? "var(--live)" : "transparent",
                        color: "var(--bg-0)",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 10,
                      }}
                    >
                      {on ? "✓" : ""}
                    </span>
                    <AgentGlyph agent={meta.cli} size={13} color={`var(--a-${meta.cli})`} />
                    <span style={{ fontSize: 12.5, color: "var(--fg-0)" }}>{meta.alias}</span>
                    <span style={{ flex: 1 }} />
                    <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                      {SPEC_BY_CLI[meta.cli].label}
                    </span>
                  </button>
                );
              })}
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginTop: 6,
              }}
            >
              {sentTo !== null && (
                <span className="mono" style={{ fontSize: 11.5, color: "var(--live)" }}>
                  Sent to {sentTo} {sentTo === 1 ? "agent" : "agents"}.
                </span>
              )}
              <span style={{ flex: 1 }} />
              <button
                type="button"
                onClick={send}
                disabled={!canSend}
                style={{
                  padding: "7px 14px",
                  borderRadius: 7,
                  border: "none",
                  background: canSend ? "var(--live)" : "var(--bg-2)",
                  color: canSend ? "var(--bg-0)" : "var(--fg-3)",
                  cursor: canSend ? "pointer" : "default",
                  fontSize: 12.5,
                  fontWeight: 600,
                }}
              >
                Send to {targets.length} {targets.length === 1 ? "agent" : "agents"}
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Note({ children }: { children: string }) {
  return (
    <div
      className="mono"
      style={{ padding: "18px 4px", fontSize: 12, color: "var(--fg-3)", lineHeight: 1.5 }}
    >
      {children}
    </div>
  );
}
