import { useEffect, useState } from "react";
import { AGENT_META, AgentGlyph } from "../components/primitives/AgentGlyph";
import { Ico } from "../components/primitives/icons";
import { type SessionActivity, ipc } from "../lib/ipc";

// Content of the always-on-top companion window (P5). It runs in its own webview
// (a separate JS context from the main app), so it cannot read the main store —
// it polls `session_activity` directly and renders from that. Everything shown
// is the honest activity signal: each running agent's working/idle state +
// quiet-duration, derived from pane output flow. There is deliberately no
// turn timer, token count or approve/done badge — those need per-CLI capture
// the backend does not have (BACKEND_PLAN.md), and faking them is worse than
// omitting them.
//
// The native window itself (frameless, always_on_top, top-right pin, drag) is
// created by `open_companion` in lib.rs and can only be exercised in a built
// app / `tauri dev`; in the browser dev bridge this route renders standalone for
// visual inspection with real activity data.
const POLL_MS = 1500;

export function Companion() {
  const [list, setList] = useState<SessionActivity[]>([]);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      ipc
        .sessionActivity()
        .then((a) => alive && setList(a))
        .catch(() => alive && setList([]));
    };
    tick();
    const h = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, []);

  return (
    <div
      style={{
        height: "100vh",
        width: "100vw",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-1)",
        color: "var(--fg-1)",
        overflow: "hidden",
        borderRadius: 12,
        border: "1px solid var(--bd)",
      }}
    >
      {/* Title bar doubles as the window drag handle (frameless window). */}
      <div
        data-tauri-drag-region
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 12px",
          borderBottom: "1px solid var(--bd-soft)",
          flexShrink: 0,
          cursor: "default",
        }}
      >
        <span className="lbl" data-tauri-drag-region style={{ flex: 1, letterSpacing: "0.04em" }}>
          Companion
        </span>
        <button
          type="button"
          onClick={() => void ipc.closeCompanion()}
          title="Close companion"
          aria-label="Close companion"
          className="rail-file"
          style={{
            border: "none",
            background: "transparent",
            cursor: "pointer",
            color: "var(--fg-2)",
            display: "flex",
            padding: 2,
            borderRadius: 4,
          }}
        >
          {Ico.close}
        </button>
      </div>

      <div className="scroll" style={{ flex: 1, overflow: "auto", padding: 10 }}>
        {list.length === 0 ? (
          <Empty />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {list.map((a) => (
              <Row key={a.session} act={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// One agent: avatar puck (agent-colored ring, lit while working) + identity +
// honest working / idle-duration. Clicking jumps to the session in the main
// window via the backend (raises main + emits codehub://focus-session).
function Row({ act }: { act: SessionActivity }) {
  const working = act.state === "working";
  // Honest fallback: a null cli is an *unknown* agent (entry recreated by output
  // after detach dropped its label) — "unknown" matches no agent so AgentGlyph
  // renders its neutral circle, with a neutral accent, rather than coercing to a
  // real agent's identity. Same spirit as the name falling back to the raw
  // session name below.
  const cli = act.cli ?? "unknown";
  const accent = (act.cli && AGENT_META[act.cli]?.accent) || "var(--fg-1)";
  const name = act.alias ?? act.session;
  const ring = working ? "var(--live)" : "var(--bd)";

  return (
    <button
      type="button"
      onClick={() => void ipc.focusSessionFromCompanion(act.session)}
      title={`${name} — jump to session`}
      className="rail-file"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: "8px 10px",
        borderRadius: 10,
        border: "1px solid var(--bd-soft)",
        background: "var(--bg-2)",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span
        style={{
          position: "relative",
          width: 36,
          height: 36,
          borderRadius: "50%",
          background: "#0a0b0d",
          border: `2px solid ${ring}`,
          boxShadow: working ? `0 0 10px ${accent}55` : "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <span style={{ transform: "scale(1.5)", display: "flex" }}>
          <AgentGlyph agent={cli} size={12} color={accent} />
        </span>
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 12.5,
            color: "var(--fg-0)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </span>
        <span
          className="mono"
          style={{
            display: "block",
            fontSize: 10.5,
            color: working ? "var(--live)" : "var(--fg-3)",
          }}
        >
          {working ? "working" : `idle ${fmtIdle(act.idleMs)}`}
        </span>
      </span>
      <span className={`dot ${working ? "live pulse" : "idle"}`} style={{ flexShrink: 0 }} />
    </button>
  );
}

function Empty() {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: 20,
        textAlign: "center",
      }}
    >
      <span style={{ opacity: 0.5 }}>{Ico.bell}</span>
      <p style={{ margin: 0, fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.5 }}>
        No agents running.
      </p>
      <p style={{ margin: 0, fontSize: 10.5, color: "var(--fg-3)", lineHeight: 1.5 }}>
        Start one in CodeHub to watch it here.
      </p>
    </div>
  );
}

// Compact quiet-duration: "3s" / "2m" / "1h".
function fmtIdle(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}
