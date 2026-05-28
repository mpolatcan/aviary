import { motion } from "motion/react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { AgentGlyph } from "../../components/primitives/AgentGlyph";
import { IconBtn } from "../../components/primitives/IconBtn";
import { StatusBadge } from "../../components/primitives/StatusBadge";
import { StatusDot } from "../../components/primitives/StatusDot";
import { Ico } from "../../components/primitives/icons";
import { fmtTokens, useSessionUsage } from "../../hooks/useSessionUsage";
import { slideRight } from "../../hooks/useSlideIn";
import {
  type ActivityEvent,
  type Cli,
  type PendingPrompt,
  type SessionActivity,
  ipc,
} from "../../lib/ipc";
import { useOverlay } from "../../lib/overlay";
import { useStore } from "../../lib/store";
import { Input } from "../../ui/input";

// Right activity rail, aligned with design/screens/main-hub-a.jsx:
// header + live badge + awaiting-input cards + activity feed. Data remains real
// (pending_prompts, session_activity_history, session_activity) and renders
// honest-empty states until a backend source exists.
export function ActivityRail() {
  const running = useStore((s) => s.status?.state === "running");
  const setFiles = useOverlay((s) => s.setFiles);
  const [filter, setFilter] = useState("");
  const [showFilter, setShowFilter] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);

  const toggleFilter = () => {
    setShowFilter((v) => {
      if (!v) requestAnimationFrame(() => filterRef.current?.focus());
      else setFilter("");
      return !v;
    });
  };

  return (
    <motion.aside
      {...slideRight}
      className="activity-rail ch-activity-rail"
      style={{
        width: 280,
        flexShrink: 0,
        background: "var(--bg-1)",
        borderLeft: "1px solid var(--bd-soft)",
        display: "flex",
        flexDirection: "column",
        color: "var(--fg-1)",
      }}
    >
      <div
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--bd-soft)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span className="lbl">Activity</span>
        <span
          title={running ? "Live updates" : "Runtime not running"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: running ? "var(--live)" : "var(--fg-3)",
            padding: "1px 6px",
            borderRadius: 999,
            background: running
              ? "color-mix(in oklab, var(--live) 12%, transparent)"
              : "var(--bg-2)",
          }}
        >
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: running ? "var(--live)" : "var(--fg-3)",
            }}
          />
          live
        </span>
        <span style={{ flex: 1 }} />
        <IconBtn
          title="Filter activity"
          style={{ width: 22, height: 22, color: showFilter ? "var(--fg-0)" : undefined }}
          onClick={toggleFilter}
        >
          {Ico.search}
        </IconBtn>
        <IconBtn
          title="Collapse activity panel (⌘⇧A)"
          style={{ width: 22, height: 22 }}
          onClick={() => setFiles(false)}
        >
          {Ico.sidebarR}
        </IconBtn>
      </div>

      {showFilter && (
        <div style={{ padding: "6px 10px", borderBottom: "1px solid var(--bd-soft)" }}>
          <Input
            ref={filterRef}
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") toggleFilter();
            }}
            placeholder="filter sessions…"
            spellCheck={false}
            className="mono h-auto rounded-[5px] px-2 py-1 text-[11px]"
          />
        </div>
      )}

      <PromptToasts />
      <Feed filter={filter} />
      <Activity running={running} filter={filter} />
    </motion.aside>
  );
}

// Live per-session activity: every running session with a working/idle dot +
// how long it's been quiet. Clicking a row jumps to that session in the Hub.
function Activity({ running, filter }: { running: boolean; filter: string }) {
  const meta = useStore((s) => s.sessionMeta);
  const activity = useStore((s) => s.sessionActivity);
  const focusSession = useStore((s) => s.focusSession);
  const setView = useStore((s) => s.setView);
  const q = filter.trim().toLowerCase();
  const sessions = Object.entries(meta)
    .filter(([, m]) => m.cli !== "shell")
    .filter(
      ([name, m]) => !q || m.alias.toLowerCase().includes(q) || name.toLowerCase().includes(q),
    );

  if (!running) {
    return (
      <div style={{ flex: 1 }}>
        <Note>Runtime not running.</Note>
      </div>
    );
  }
  if (sessions.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          padding: 24,
          textAlign: "center",
        }}
      >
        <span style={{ opacity: 0.5 }}>{Ico.bell}</span>
        <p style={{ margin: 0, fontSize: 12, color: "var(--fg-2)", lineHeight: 1.5 }}>
          No sessions running.
        </p>
        <p style={{ margin: 0, fontSize: 11, color: "var(--fg-3)", lineHeight: 1.5 }}>
          Start one with ⌘N to see live activity.
        </p>
      </div>
    );
  }

  const open = (name: string) => {
    focusSession(name);
    setView("hub");
  };

  return (
    <div className="scroll" style={{ flex: 1, overflow: "auto", padding: "6px 8px" }}>
      {sessions.map(([name, m]) => {
        const act = activity[name];
        const claudeId = act?.claudeId ?? (m.cli === "claude" ? m.claudeId : undefined);
        return (
          <ActivityRow
            key={name}
            alias={m.alias}
            cli={m.cli}
            claudeId={claudeId ?? undefined}
            act={act}
            onOpen={() => open(name)}
          />
        );
      })}
    </div>
  );
}

function ActivityRow({
  alias,
  cli,
  claudeId,
  act,
  onOpen,
}: {
  alias: string;
  cli: Cli;
  claudeId: string | undefined;
  act: SessionActivity | undefined;
  onOpen: () => void;
}) {
  const working = act?.state === "working";
  const usage = useSessionUsage(claudeId);
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${alias} — jump to session`}
      className="rail-file"
      style={{
        display: "flex",
        gap: 8,
        width: "100%",
        padding: "7px 6px",
        borderRadius: 6,
        border: "none",
        background: "transparent",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span style={{ paddingTop: 3 }}>
        <AgentGlyph agent={cli} size={11} color={`var(--a-${cli})`} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 1 }}>
          <span
            className="mono"
            style={{
              fontSize: 11,
              color: "var(--fg-1)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {alias}
          </span>
          <StatusDot status={working ? "live" : "idle"} pulse={working} />
          <span style={{ flex: 1 }} />
          <span
            className="mono"
            style={{ fontSize: 10.5, color: working ? "var(--live)" : "var(--fg-3)" }}
          >
            {working ? "working" : act ? `idle ${fmtIdle(act.idleMs)}` : "idle"}
          </span>
        </span>
        {usage && (
          <span
            className="mono tnum"
            style={{ display: "block", fontSize: 10, color: "var(--fg-3)" }}
          >
            {usage.turns} turn{usage.turns === 1 ? "" : "s"} ·{" "}
            {fmtTokens(usage.tokensIn + usage.tokensOut)} tok
          </span>
        )}
      </span>
    </button>
  );
}

function fmtIdle(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

// Awaiting-input toasts — one card per pending prompt. Approve/Deny write the
// accept/deny keystroke to that pane via respond_prompt. A/D answer the first
// pending prompt when no text input has focus.
function PromptToasts() {
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
      style={{ borderBottom: "1px solid var(--bd-soft)", display: "flex", flexDirection: "column" }}
    >
      {agentPrompts.length > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px 0" }}>
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
    <div style={{ padding: 12 }}>
      <div
        style={{
          border: "1px solid color-mix(in oklab, var(--wait) 35%, transparent)",
          background: "color-mix(in oklab, var(--wait) 10%, var(--bg-2))",
          borderRadius: 8,
          padding: 12,
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
    </div>
  );
}

// Turn-by-turn history feed. Honest-empty until session_activity_history returns
// events; the live per-session Activity list below still fills the rail.
function Feed({ filter }: { filter: string }) {
  const history = useStore((s) => s.activityHistory);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const focusSession = useStore((s) => s.focusSession);
  if (history.length === 0) return null;

  const q = filter.trim().toLowerCase();
  const rows = history
    .filter((ev) => sessionMeta[ev.session]?.cli !== "shell")
    .filter((ev) => !q || (sessionMeta[ev.session]?.alias ?? ev.session).toLowerCase().includes(q))
    .sort((a, b) => b.at - a.at)
    .slice(0, 40);
  if (rows.length === 0) return null;

  return (
    <div
      className="scroll"
      style={{
        maxHeight: 260,
        overflow: "auto",
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 1,
        borderBottom: "1px solid var(--bd-soft)",
      }}
    >
      {rows.map((ev) => (
        <FeedRow
          key={`${ev.session}-${ev.at}-${ev.kind}`}
          ev={ev}
          alias={sessionMeta[ev.session]?.alias ?? ev.session}
          cli={sessionMeta[ev.session]?.cli}
          onJump={() => focusSession(ev.session)}
        />
      ))}
    </div>
  );
}

function FeedRow({
  ev,
  alias,
  cli,
  onJump,
}: {
  ev: ActivityEvent;
  alias: string;
  cli: Cli | undefined;
  onJump: () => void;
}) {
  const { text, dot } = describe(ev);
  return (
    <button
      type="button"
      onClick={onJump}
      className="rail-file"
      title={`${alias} — jump to session`}
      style={{
        display: "flex",
        gap: 8,
        padding: "7px 6px",
        borderRadius: 6,
        border: "none",
        background: "transparent",
        cursor: "pointer",
        textAlign: "left",
        width: "100%",
      }}
    >
      <span style={{ paddingTop: 3 }}>
        {cli ? <AgentGlyph agent={cli} size={11} color={`var(--a-${cli})`} /> : null}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 1 }}>
          <span className="mono" style={{ fontSize: 11, color: "var(--fg-1)" }}>
            {alias}
          </span>
          {dot && <StatusDot status={dot} />}
          <span style={{ flex: 1 }} />
          <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
            {fmtAgo(ev.at)}
          </span>
        </span>
        <span style={{ display: "block", fontSize: 11.5, color: "var(--fg-1)", lineHeight: 1.4 }}>
          {ev.message ?? text}
        </span>
      </span>
    </button>
  );
}

function describe(ev: ActivityEvent): { text: string; dot?: "done" | "err" } {
  switch (ev.kind) {
    case "session_start":
      return { text: "Session started" };
    case "prompt_submit":
      return { text: "Started a turn" };
    case "pre_tool":
      return { text: "Running a tool" };
    case "post_tool":
      return { text: "Tool finished" };
    case "notification":
      return { text: "Notification" };
    case "stop":
      return { text: "Turn finished", dot: "done" };
    case "stop_failure":
      return { text: "Turn failed", dot: "err" };
    case "session_end":
      return { text: "Session ended" };
    default:
      return { text: ev.kind };
  }
}

function fmtAgo(atMs: number): string {
  const s = Math.max(0, Math.floor((Date.now() - atMs) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div
      className="mono"
      style={{ padding: 14, fontSize: 11, color: "var(--fg-3)", lineHeight: 1.5 }}
    >
      {children}
    </div>
  );
}
