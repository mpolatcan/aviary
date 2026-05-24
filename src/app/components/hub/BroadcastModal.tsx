import { useCallback, useEffect, useState } from "react";
import { SPEC_BY_CLI } from "../../lib/catalog";
import { formatK } from "../../lib/format";
import type { SessionUsage } from "../../lib/ipc";
import { ipc } from "../../lib/ipc";
import { useOverlay } from "../../lib/overlay";
import { getPane } from "../../lib/panes";
import { useStore } from "../../lib/store";
import type { SessionMeta } from "../../lib/tree";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../ui/dialog";
import { AgentGlyph } from "../primitives/AgentGlyph";
import { MetricStat } from "../primitives/MetricStat";
import { StatusDot, type StatusKey } from "../primitives/StatusDot";

// Broadcast: fan one prompt out to several running agents, then compare them
// side by side. Two phases in one modal:
//
//   1. COMPOSE — pick target sessions + type the prompt. Sending writes the
//      prompt to each target's pty (bracketed-paste + CR), exactly as if you'd
//      typed it into each terminal. This path was already real; it's unchanged.
//
//   2. COMPARE — after sending, a column per target shows the agent header
//      (glyph, model, live working/idle status) and live per-agent METRICS.
//
// Honesty contract (binding): CodeHub captures no structured per-turn ANSWER
// text — the reply streams in each agent's own terminal pane, not into a buffer
// we can read. So the compare columns deliberately do NOT reproduce answer prose
// (the design mock's TermBlock content was illustrative); each column instead
// links straight to its live terminal pane ("View in pane"). Metrics are real
// only where a source exists: Claude exposes a live per-session token/turn/edit
// tally from its own transcript (claude_session_usage, keyed by the session's
// claudeId); Codex and Antigravity have no per-session id wired here yet, so
// their metrics render as em-dash rather than a fabricated number.
//
// "Pick the winner" is a local mark (your judgement of which reply you prefer);
// it has no backend effect — every target is already a real running session, so
// "promote" maps to focusing that pane in the Hub, not creating a new one.

type Phase = "compose" | "compare";

export function BroadcastModal() {
  const open = useOverlay((s) => s.broadcast);
  const setOpen = useOverlay((s) => s.setBroadcast);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const running = useStore((s) => s.status?.state === "running");
  const focusSession = useStore((s) => s.focusSession);
  const setView = useStore((s) => s.setView);

  const sessions = Object.entries(sessionMeta);
  const [phase, setPhase] = useState<Phase>("compose");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState("");
  // The prompt actually sent (snapshot at send time), shown in the compare head.
  const [sentPrompt, setSentPrompt] = useState("");
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [winner, setWinner] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // Seed selection from a snapshot taken at open time (getState, not the
    // reactive value) so re-renders mid-compose don't re-seed.
    setSelected(new Set(Object.keys(useStore.getState().sessionMeta)));
    setPrompt("");
    setSentPrompt("");
    setSentAt(null);
    setWinner(null);
    setPhase("compose");
  }, [open]);

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const targets = sessions.filter(([name]) => selected.has(name));
  const canSend = running && prompt.trim().length > 0 && targets.length > 0;

  const send = () => {
    if (!canSend) return;
    // Bracketed-paste (DECSET 2004) wraps a multi-line prompt as one paste so
    // interior newlines stay literal; the trailing CR submits it once. This is
    // exactly what a terminal sends on paste; agent TUIs enable bracketed paste.
    const payload = `\x1b[200~${prompt}\x1b[201~\r`;
    for (const [name] of targets) {
      const pane = getPane(name);
      if (!pane) continue;
      ipc.ptyWrite(pane.paneId, payload).catch(console.warn);
    }
    setSentPrompt(prompt);
    setSentAt(Date.now());
    setPhase("compare");
  };

  const jumpTo = (name: string) => {
    focusSession(name);
    setView("hub");
    setOpen(false);
  };

  const wide = phase === "compare";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
      <DialogContent style={{ maxWidth: wide ? 920 : 560, width: "calc(100vw - 48px)" }}>
        <DialogHeader>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <DialogTitle style={{ fontSize: 14, fontWeight: 600 }}>
              {phase === "compose" ? "Broadcast a prompt" : "Compare agents"}
            </DialogTitle>
            <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>
              {phase === "compose"
                ? "one prompt → many agents"
                : `${targets.length} ${targets.length === 1 ? "agent" : "agents"} · replies stream in their terminals`}
            </span>
          </div>
        </DialogHeader>

        {sessions.length === 0 ? (
          <Note>No running sessions to broadcast to.</Note>
        ) : phase === "compose" ? (
          <ComposePhase
            prompt={prompt}
            setPrompt={setPrompt}
            sessions={sessions}
            selected={selected}
            toggle={toggle}
            targets={targets}
            canSend={canSend}
            onSend={send}
          />
        ) : (
          <ComparePhase
            sentPrompt={sentPrompt}
            sentAt={sentAt}
            targets={targets}
            winner={winner}
            setWinner={setWinner}
            onJump={jumpTo}
            onBack={() => setPhase("compose")}
            onResend={send}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ComposePhase({
  prompt,
  setPrompt,
  sessions,
  selected,
  toggle,
  targets,
  canSend,
  onSend,
}: {
  prompt: string;
  setPrompt: (v: string) => void;
  sessions: [string, SessionMeta][];
  selected: Set<string>;
  toggle: (name: string) => void;
  targets: unknown[];
  canSend: boolean;
  onSend: () => void;
}) {
  return (
    <>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
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

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
        <span style={{ flex: 1 }} />
        <Button variant="success" size="sm" disabled={!canSend} onClick={onSend}>
          Broadcast to {targets.length} {targets.length === 1 ? "agent" : "agents"}
          <span className="kbd" style={{ marginLeft: 6 }}>
            ⌘⏎
          </span>
        </Button>
      </div>
    </>
  );
}

function ComparePhase({
  sentPrompt,
  sentAt,
  targets,
  winner,
  setWinner,
  onJump,
  onBack,
  onResend,
}: {
  sentPrompt: string;
  sentAt: number | null;
  targets: [string, SessionMeta][];
  winner: string | null;
  setWinner: (n: string | null) => void;
  onJump: (name: string) => void;
  onBack: () => void;
  onResend: () => void;
}) {
  // Re-derive elapsed every second for the header timer.
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = sentAt ? Math.max(0, Math.round((Date.now() - sentAt) / 1000)) : 0;

  const cols = Math.min(3, Math.max(1, targets.length));

  return (
    <>
      {/* the shared prompt that was sent */}
      <div
        style={{
          background: "var(--bg-0)",
          border: "1px solid var(--bd)",
          borderRadius: 10,
          padding: "10px 14px",
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
        }}
      >
        <span className="mono" style={{ color: "var(--live)", fontSize: 13, paddingTop: 1 }}>
          ▸
        </span>
        <div
          className="mono"
          style={{
            flex: 1,
            fontSize: 12.5,
            color: "var(--fg-0)",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 80,
            overflow: "auto",
          }}
        >
          {sentPrompt}
        </div>
        <span className="mono tnum" style={{ fontSize: 10.5, color: "var(--fg-2)", flexShrink: 0 }}>
          {elapsed}s ago
        </span>
      </div>

      {/* one column per target */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gap: 10,
          marginTop: 4,
        }}
      >
        {targets.map(([name, meta]) => (
          <CompareColumn
            key={name}
            name={name}
            meta={meta}
            isWinner={winner === name}
            onPick={() => setWinner(winner === name ? null : name)}
            onJump={() => onJump(name)}
          />
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
        <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
          Replies stream in each agent's terminal — open a pane to read it.
        </span>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" onClick={onBack}>
          Edit prompt
        </Button>
        <Button variant="outline" size="sm" onClick={onResend}>
          Re-broadcast
        </Button>
      </div>
    </>
  );
}

function CompareColumn({
  name,
  meta,
  isWinner,
  onPick,
  onJump,
}: {
  name: string;
  meta: SessionMeta;
  isWinner: boolean;
  onPick: () => void;
  onJump: () => void;
}) {
  const dash = "—";
  const activity = useStore((s) => s.sessionActivity[name]);
  const [usage, setUsage] = useState<SessionUsage | null>(null);

  // Live per-session metrics — Claude only (its transcript is readable by the
  // claudeId it launched with). Polled while the column is mounted; null when
  // there's no usable data yet, rendered as em-dash. Codex/Antigravity expose no
  // per-session id here, so they stay em-dash (honest, not faked).
  const claudeId = meta.cli === "claude" ? meta.claudeId : undefined;
  const poll = useCallback(() => {
    if (!claudeId) return;
    ipc
      .claudeSessionUsage(claudeId)
      .then(setUsage)
      .catch(() => {});
  }, [claudeId]);
  useEffect(() => {
    if (!claudeId) return;
    poll();
    const t = setInterval(poll, 4000);
    return () => clearInterval(t);
  }, [claudeId, poll]);

  // Status from the output-flow activity signal: working = streaming now, idle =
  // quiet. This is real (output flow), not a claimed turn-completion.
  const status: StatusKey = activity?.state === "working" ? "live" : "idle";
  const statusLabel = activity?.state === "working" ? "streaming" : "idle";

  const tokens = usage ? formatK(usage.tokensIn + usage.tokensOut) : dash;
  const turns = usage ? String(usage.turns) : dash;
  const edits = usage ? String(usage.edits) : dash;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-0)",
        border: "1px solid var(--bd)",
        borderRadius: 10,
        overflow: "hidden",
        outline: isWinner
          ? "1.5px solid color-mix(in oklab, var(--live) 70%, transparent)"
          : "none",
        outlineOffset: -1.5,
        minWidth: 0,
      }}
    >
      {/* head */}
      <div style={{ background: "var(--bg-1)", borderBottom: "1px solid var(--bd-soft)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px 4px" }}>
          <StatusDot status={status} pulse />
          <AgentGlyph agent={meta.cli} size={13} color={`var(--a-${meta.cli})`} />
          <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--fg-0)", minWidth: 0 }}>
            {meta.alias}
          </span>
          {isWinner && (
            <span
              className="mono"
              style={{
                fontSize: 9.5,
                padding: "1px 5px",
                borderRadius: 4,
                background: "color-mix(in oklab, var(--live) 22%, transparent)",
                color: "var(--live)",
                border: "1px solid color-mix(in oklab, var(--live) 35%, transparent)",
                fontWeight: 600,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
              }}
            >
              pick
            </span>
          )}
          <span style={{ flex: 1 }} />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 12px 8px",
            flexWrap: "wrap",
          }}
        >
          <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-2)" }}>
            {SPEC_BY_CLI[meta.cli].label} · {statusLabel}
          </span>
        </div>
      </div>

      {/* metrics — real for Claude, em-dash otherwise */}
      <div
        style={{
          padding: "10px 12px",
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          flex: 1,
          alignContent: "flex-start",
        }}
      >
        <MetricStat label="turns" value={turns} />
        <MetricStat label="tok" value={tokens} />
        <MetricStat label="edits" value={edits} />
      </div>

      {/* actions */}
      <div
        style={{
          padding: "10px 12px",
          borderTop: "1px solid var(--bd-soft)",
          background: "var(--bg-1)",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <Button
          variant={isWinner ? "success" : "outline"}
          size="sm"
          style={{ flex: 1, justifyContent: "center" }}
          onClick={onPick}
        >
          {isWinner ? "Picked" : "Mark as pick"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onJump}>
          View in pane
        </Button>
      </div>
    </div>
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
