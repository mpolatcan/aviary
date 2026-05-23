/**
 * Resume — past Claude Code conversations, read from their on-disk session
 * transcripts (the same source as Usage; see claude_sessions). Each row is a
 * REAL transcript: its title is the conversation's own ai-title (or first user
 * prompt), its branch/turn-count/timestamps are recorded facts, never guessed.
 *
 * Clicking Resume reopens that exact conversation in a new Hub tab via
 * `claude --resume <id>`, so the agent picks up with its full history.
 *
 * Only Claude Code persists resumable transcripts today; Codex/Antigravity have
 * no comparable on-disk history, so this view is Claude-only (stated in the UI).
 */
import { AgentGlyph } from "@/app/components/primitives/AgentGlyph";
import { Ico } from "@/app/components/primitives/icons";
import { type ClaudeSession, ipc } from "@/app/lib/ipc";
import { useStore } from "@/app/lib/store";
import { Button } from "@/app/ui/button";
import { useEffect, useState } from "react";

export function Resume() {
  const status = useStore((s) => s.status);
  const newPlate = useStore((s) => s.newPlate);
  const setView = useStore((s) => s.setView);
  const state = status?.state ?? "missing";
  const running = state === "running";

  // One-shot poll (~10s): transcripts appear/grow as agents work. Alive-guarded;
  // a failed read clears to null (honest note), same contract as Usage.
  const [sessions, setSessions] = useState<ClaudeSession[] | null>(null);
  const [resuming, setResuming] = useState<string | null>(null);
  useEffect(() => {
    if (!running) {
      setSessions(null);
      return;
    }
    let alive = true;
    const tick = () => {
      ipc
        .claudeSessions()
        .then((s) => alive && setSessions(s))
        .catch(() => alive && setSessions(null));
    };
    tick();
    const h = setInterval(tick, 10000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [running]);

  // Relaunch the conversation in a fresh Hub tab, then jump to it.
  const resume = (id: string) => {
    setResuming(id);
    newPlate("claude", "standard", id)
      .then(() => setView("hub"))
      .catch(console.warn)
      .finally(() => setResuming(null));
  };

  const empty = sessions !== null && sessions.length === 0;

  return (
    <main
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-1)",
        minWidth: 0,
        color: "var(--fg-1)",
      }}
    >
      <div style={{ padding: "20px 28px 14px", borderBottom: "1px solid var(--bd-soft)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em" }}>
            Resume
          </h1>
          <span className="mono" style={{ fontSize: 12, color: "var(--fg-2)" }}>
            {sessions ? `${sessions.length} past sessions` : `runtime ${state}`}
          </span>
        </div>
        <p className="mono" style={{ margin: "8px 0 0", fontSize: 11, color: "var(--fg-3)" }}>
          Past Claude Code conversations from on-disk transcripts. Resume reopens one with its full
          history.
        </p>
      </div>

      <div className="scroll" style={{ flex: 1, overflow: "auto", padding: 24 }}>
        {!running ? (
          <Note>Runtime not running — no transcripts to read.</Note>
        ) : sessions === null ? (
          <Note>Reading session transcripts…</Note>
        ) : empty ? (
          <Note>No past Claude conversations yet. Sessions appear here once an agent has run.</Note>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {sessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                busy={resuming === s.id}
                disabled={resuming !== null}
                onResume={() => resume(s.id)}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function SessionRow({
  session,
  busy,
  disabled,
  onResume,
}: {
  session: ClaudeSession;
  busy: boolean;
  disabled: boolean;
  onResume: () => void;
}) {
  const age = fmtAge(session.lastActive);
  return (
    <div
      className="ch-card"
      style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 14 }}
    >
      <AgentGlyph agent="claude" size={16} color="var(--a-claude)" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: "var(--fg-0)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={session.title}
        >
          {session.title}
        </div>
        <div
          className="mono"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 3,
            fontSize: 10.5,
            color: "var(--fg-3)",
            overflow: "hidden",
          }}
        >
          {session.branch && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
              {Ico.diff}
              {session.branch}
            </span>
          )}
          <span>
            {session.turns} {session.turns === 1 ? "turn" : "turns"}
          </span>
          {age && <span>· {age}</span>}
          {session.model && (
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: "var(--fg-2)",
              }}
            >
              · {session.model}
            </span>
          )}
        </div>
      </div>
      <span
        className="mono"
        style={{ fontSize: 9.5, color: "var(--fg-3)", flexShrink: 0 }}
        title={session.id}
      >
        {session.id.slice(0, 8)}
      </span>
      <Button size="sm" variant="outline" onClick={onResume} disabled={disabled}>
        {busy ? "Resuming…" : "Resume"}
      </Button>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mono"
      style={{ padding: "40px 16px", textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}
    >
      {children}
    </div>
  );
}

// Compact relative age from an RFC3339 timestamp: "just now" / "12m" / "3h" /
// "2d". Returns null when the timestamp is missing or unparseable, so the row
// simply omits the age rather than showing a bogus one.
function fmtAge(iso: string): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const secs = Math.floor((Date.now() - t) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}
