import { useEffect } from "react";
import { AgentGlyph } from "../../components/primitives/AgentGlyph";
import { StatusBadge } from "../../components/primitives/StatusBadge";
import type { Cli, PendingPrompt } from "../../lib/ipc";
import { ipc } from "../../lib/ipc";
import { useStore } from "../../lib/store";

export function PromptToasts() {
  const prompts = useStore((s) => s.pendingPrompts);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const focusSession = useStore((s) => s.focusSession);
  const agentPrompts = prompts.filter((p) => sessionMeta[p.session]?.cli !== "shell");

  const respond = (session: string, allow: boolean) => {
    void ipc.respondPrompt(session, allow).catch((e) => {
      console.warn(`respond_prompt(${session}, ${allow}) failed:`, e);
    });
  };

  const firstSession = agentPrompts[0]?.session;
  useEffect(() => {
    if (!firstSession) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
      const k = e.key.toLowerCase();
      if (k === "a" || k === "d") {
        e.preventDefault();
        void ipc.respondPrompt(firstSession, k === "a").catch((err) => {
          console.warn(`respond_prompt(${firstSession}) failed:`, err);
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [firstSession]);

  if (agentPrompts.length === 0) return null;

  const respondAll = (allow: boolean) => {
    for (const p of agentPrompts) respond(p.session, allow);
  };

  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        maxWidth: 320,
        pointerEvents: "auto",
      }}
    >
      {agentPrompts.length > 1 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            background: "var(--bg-2)",
            border: "1px solid var(--bd-soft)",
            borderRadius: 8,
          }}
        >
          <span className="lbl" style={{ fontSize: 10 }}>
            {agentPrompts.length} awaiting
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn ok sm" onClick={() => respondAll(true)}>
            Approve all
          </button>
          <button type="button" className="btn sm" onClick={() => respondAll(false)}>
            Deny all
          </button>
        </div>
      )}
      {agentPrompts.map((p, i) => (
        <PromptToast
          key={p.session}
          prompt={p}
          alias={sessionMeta[p.session]?.alias ?? p.session}
          cli={sessionMeta[p.session]?.cli}
          hotkeys={i === 0}
          onJump={() => focusSession(p.session)}
          onRespond={(allow) => respond(p.session, allow)}
        />
      ))}
    </div>
  );
}

function PromptToast({
  prompt,
  alias,
  cli,
  hotkeys,
  onJump,
  onRespond,
}: {
  prompt: PendingPrompt;
  alias: string;
  cli: Cli | undefined;
  hotkeys: boolean;
  onJump: () => void;
  onRespond: (allow: boolean) => void;
}) {
  return (
    <div
      style={{
        border: "1px solid color-mix(in oklab, var(--wait) 35%, transparent)",
        background: "color-mix(in oklab, var(--wait) 10%, var(--bg-2))",
        borderRadius: 8,
        padding: 12,
        boxShadow: "0 8px 24px rgba(0,0,0,.35)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <StatusBadge status="wait">Needs input</StatusBadge>
        <span
          className="mono"
          style={{ fontSize: 10.5, color: "var(--fg-2)", marginLeft: "auto" }}
        >
          {fmtAgo(prompt.since)}
        </span>
      </div>
      <button
        type="button"
        onClick={onJump}
        title="Jump to this session"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 4,
          border: "none",
          background: "transparent",
          padding: 0,
          cursor: "pointer",
        }}
      >
        {cli && <AgentGlyph agent={cli} size={12} color={`var(--a-${cli})`} />}
        <span style={{ fontSize: 12, fontWeight: 500, color: "var(--fg-0)" }}>{alias}</span>
      </button>
      <p style={{ fontSize: 11.5, color: "var(--fg-1)", margin: "4px 0 12px", lineHeight: 1.5 }}>
        {prompt.message ?? "This agent is waiting for your approval."}
      </p>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          className="btn ok solid sm"
          style={{ flex: 1 }}
          onClick={() => onRespond(true)}
        >
          Approve
          {hotkeys && <span className="kbd">A</span>}
        </button>
        <button type="button" className="btn sm" onClick={() => onRespond(false)}>
          Deny
          {hotkeys && <span className="kbd">D</span>}
        </button>
      </div>
    </div>
  );
}

function fmtAgo(atMs: number): string {
  const s = Math.max(0, Math.floor((Date.now() - atMs) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
