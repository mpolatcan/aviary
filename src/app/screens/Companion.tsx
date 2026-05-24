import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CHARACTER_EXPRESSIONS,
  CHARACTER_KINDS,
  Character,
  type CharacterKind,
} from "../components/primitives/Character";
import { CompanionAvatar, type CompanionStatus } from "../components/primitives/CompanionAvatar";
import { Ico } from "../components/primitives/icons";
import { fmtTokens, useSessionUsage } from "../hooks/useSessionUsage";
import {
  type AgentEvent,
  type PendingPrompt,
  type SessionActivity,
  ipc,
  onAgentEvent,
} from "../lib/ipc";
import { type CompanionSize, useCompanionPrefs } from "../lib/overlay";

// Content of the always-on-top companion window (P5) AND the design-system
// showcase for the companion avatar. It runs in its own webview (a separate JS
// context from the main app), so it cannot read the main store — it polls
// `session_activity` + `pending_prompts` directly and renders from those.
//
// What is REAL vs honest-empty:
//  • working / idle ............ REAL, always (← session_activity output flow)
//  • awaiting input ............ REAL when present (← pending_prompts / agent
//                                hooks); the contract stub returns empty until
//                                the BE track lands the hooks subsystem, so the
//                                "wait" state simply never appears until then —
//                                it is never faked.
//  • done / failed ............. transient, driven by live agent events
//                                (stop / stop_failure). Honest-empty until BE.
//  • turn / token counts ....... Claude-only, from the session transcript (null
//                                for non-Claude agents → omitted, never zeroed).
//
// The native window itself (frameless, always_on_top) is created by
// `open_companion` in lib.rs (or the native NSPanel island on macOS) and can
// only be exercised in a built app / `tauri dev`; in the browser dev bridge this
// route renders standalone for visual inspection with real activity data.
const ACTIVITY_POLL_MS = 1500;
const PROMPT_POLL_MS = 2000;
// How long a done/failed event lingers on the puck before it reverts to the
// live activity signal (mirrors the design's "linger ~6s" note).
const TRANSIENT_MS = 6000;

type TransientKind = "done" | "err";

export function Companion() {
  const [list, setList] = useState<SessionActivity[]>([]);
  const [prompts, setPrompts] = useState<PendingPrompt[]>([]);
  // Per-session transient overlays (done/failed) raised by live agent events.
  const [transient, setTransient] = useState<Record<string, TransientKind>>({});
  const transientTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Poll the real activity signal.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      ipc
        .sessionActivity()
        .then((a) => alive && setList(a))
        .catch(() => alive && setList([]));
    };
    tick();
    const h = setInterval(tick, ACTIVITY_POLL_MS);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, []);

  // Poll pending prompts (awaiting-input). Honest-empty until the BE hooks land.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      ipc
        .pendingPrompts()
        .then((p) => alive && setPrompts(p))
        .catch(() => alive && setPrompts([]));
    };
    tick();
    const h = setInterval(tick, PROMPT_POLL_MS);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, []);

  // Live agent events → transient done/failed pucks (cleared after a linger).
  useEffect(() => {
    const timers = transientTimers.current;
    const raise = (session: string, kind: TransientKind) => {
      setTransient((t) => ({ ...t, [session]: kind }));
      if (timers[session]) clearTimeout(timers[session]);
      timers[session] = setTimeout(() => {
        setTransient((t) => {
          const next = { ...t };
          delete next[session];
          return next;
        });
      }, TRANSIENT_MS);
    };
    const handle = (e: AgentEvent) => {
      if (e.kind === "stop") raise(e.session, "done");
      else if (e.kind === "stop_failure") raise(e.session, "err");
    };
    const un = onAgentEvent(handle);
    return () => {
      void un.then((f) => f());
      for (const id of Object.keys(timers)) clearTimeout(timers[id]);
    };
  }, []);

  const promptBySession = useMemo(() => {
    const m: Record<string, PendingPrompt> = {};
    for (const p of prompts) m[p.session] = p;
    return m;
  }, [prompts]);

  const respond = useCallback((session: string, allow: boolean) => {
    void ipc.respondPrompt(session, allow).catch(() => {});
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

      <div className="scroll" style={{ flex: 1, overflow: "auto" }}>
        {/* ── LIVE: the real always-on-top monitor ───────────────────────── */}
        <section style={{ padding: 10 }}>
          {list.length === 0 ? (
            <Empty />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {list.map((a) => (
                <LiveRow
                  key={a.session}
                  act={a}
                  prompt={promptBySession[a.session]}
                  transient={transient[a.session]}
                  onRespond={respond}
                />
              ))}
            </div>
          )}
        </section>

        {/* ── SHOWCASE: avatar states, radial menu, prefs, characters ───── */}
        <CompanionShowcase />
      </div>
    </div>
  );
}

// One live agent row: a {@link CompanionAvatar} puck driven by the real status,
// the agent identity, honest working / idle-duration, and (Claude only) a live
// token/turn tally. Clicking jumps to the session in the main window.
function LiveRow({
  act,
  prompt,
  transient,
  onRespond,
}: {
  act: SessionActivity;
  prompt: PendingPrompt | undefined;
  transient: TransientKind | undefined;
  onRespond: (session: string, allow: boolean) => void;
}) {
  const working = act.state === "working";
  const cli = act.cli ?? "unknown";
  const name = act.alias ?? act.session;
  // Live token tally from this Claude session's transcript (null for non-Claude
  // agents and before the first response) — real numbers only, never faked.
  const usage = useSessionUsage(act.claudeId);

  // Status precedence: a pending prompt (awaiting) beats a transient done/err,
  // which beats the working/idle activity signal.
  const status: CompanionStatus = prompt
    ? "wait"
    : transient === "err"
      ? "err"
      : transient === "done"
        ? "done"
        : working
          ? "live"
          : "idle";

  const sub = prompt
    ? (prompt.message ?? "needs your approval")
    : transient === "done"
      ? "finished"
      : transient === "err"
        ? "failed"
        : working
          ? "working"
          : `idle ${fmtIdle(act.idleMs)}`;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: "8px 10px",
        borderRadius: 10,
        border: "1px solid var(--bd-soft)",
        background: "var(--bg-2)",
      }}
    >
      <button
        type="button"
        onClick={() => void ipc.focusSessionFromCompanion(act.session)}
        title={`${name} — jump to session`}
        aria-label={`${name} — jump to session`}
        style={{
          border: "none",
          background: "transparent",
          cursor: "pointer",
          padding: 0,
          display: "flex",
          flexShrink: 0,
        }}
      >
        <CompanionAvatar
          agent={cli}
          status={status}
          thinking={working && !prompt && !transient}
          size={44}
          style={{ pointerEvents: "none" }}
        />
      </button>
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
            color:
              status === "wait"
                ? "var(--wait)"
                : status === "err"
                  ? "var(--err)"
                  : working
                    ? "var(--live)"
                    : "var(--fg-3)",
          }}
        >
          {sub}
          {usage && (
            <span style={{ color: "var(--fg-3)" }}>
              {" · "}
              {usage.turns} turn{usage.turns === 1 ? "" : "s"} ·{" "}
              {fmtTokens(usage.tokensIn + usage.tokensOut)} tok
            </span>
          )}
        </span>
      </span>
      {prompt ? (
        <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => onRespond(act.session, false)}
            style={pillBtn("ghost")}
          >
            Deny
          </button>
          <button type="button" onClick={() => onRespond(act.session, true)} style={pillBtn("ok")}>
            Approve
          </button>
        </span>
      ) : (
        <span className={`dot ${working ? "live pulse" : "idle"}`} style={{ flexShrink: 0 }} />
      )}
    </div>
  );
}

function Empty() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: "28px 20px",
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

// ── SHOWCASE ────────────────────────────────────────────────────────────────
// The design-system gallery (states · radial menu · preferences · characters).
// Faithful port of design/project/screens/companion.jsx, wired to the real
// companion-prefs store. Honest sample bubbles are clearly captioned as such.
function CompanionShowcase() {
  return (
    <div style={{ borderTop: "1px solid var(--bd-soft)", padding: "16px 14px 20px" }}>
      <ShowcaseHeading title="States" note="size 56px · pulses with state · right-click for menu" />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
          gap: 12,
          marginBottom: 20,
        }}
      >
        <CompCard caption="Idle" desc="Gentle float. Status ring at rest.">
          <CompanionAvatar agent="claude" status="idle" />
        </CompCard>
        <CompCard caption="Thinking" desc="Orbiting dots around the rim." tone="live">
          <CompanionAvatar agent="claude" status="live" thinking />
        </CompCard>
        <CompCard caption="Awaiting input" desc="Amber glow + tap-target ring." tone="wait">
          <CompanionAvatar agent="codex" status="wait" />
        </CompCard>
        <CompCard caption="Done" desc="Green check pop." tone="done">
          <CompanionAvatar agent="claude" status="done" />
        </CompCard>
        <CompCard caption="Failed" desc="Red badge, lingers." tone="err">
          <CompanionAvatar agent="claude" status="err" />
        </CompCard>
        <CompCard caption="Bubble" desc="Hover or click to show context." tone="live">
          <CompanionAvatar
            agent="claude"
            status="live"
            bubble="refactoring auth"
            bubbleMeta="sample"
            expanded
          />
        </CompCard>
        <CompCard caption="Dragging" desc="Scales up. Casts ghost trail." tone="live">
          <CompanionAvatar agent="codex" status="live" dragging />
        </CompCard>
        <CompCard caption="Docked" desc="Half-hidden against an edge.">
          <CompanionAvatar agent="antigravity" status="idle" docked />
        </CompCard>
      </div>

      <ShowcaseHeading
        title="Right-click menu"
        note="radial actions — keeps the screen unblocked"
      />
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}>
        <CompanionRadial />
      </div>

      <CompanionPrefsPanel />

      <ShowcaseHeading title="Characters" note="6 built-in styles · per-agent override" />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: 12,
        }}
      >
        {CHARACTER_KINDS.map((c) => (
          <CharacterCard key={c.kind} kind={c.kind} name={c.name} desc={c.desc} />
        ))}
      </div>
    </div>
  );
}

function ShowcaseHeading({ title, note }: { title: string; note: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 12,
        marginBottom: 12,
        flexWrap: "wrap",
      }}
    >
      <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--fg-0)" }}>{title}</h2>
      <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-2)" }}>
        {note}
      </span>
    </div>
  );
}

function CompCard({
  caption,
  desc,
  tone,
  children,
}: {
  caption: string;
  desc: string;
  tone?: "live" | "wait" | "done" | "err";
  children: React.ReactNode;
}) {
  const toneColor =
    tone === "wait"
      ? "var(--wait)"
      : tone === "done"
        ? "var(--done)"
        : tone === "err"
          ? "var(--err)"
          : "var(--live)";
  return (
    <div
      style={{
        background: "var(--bg-2)",
        border: "1px solid var(--bd)",
        borderRadius: 10,
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div
        style={{
          background: "linear-gradient(180deg, var(--bg-3), var(--bg-0))",
          borderRadius: 7,
          padding: 16,
          minHeight: 96,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          border: "1px solid var(--bd-soft)",
        }}
      >
        {children}
      </div>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 2 }}>
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: toneColor }} />
          <span style={{ fontSize: 12, color: "var(--fg-0)", fontWeight: 500 }}>{caption}</span>
        </div>
        <div style={{ fontSize: 10.5, color: "var(--fg-2)" }}>{desc}</div>
      </div>
    </div>
  );
}

// Radial action menu around the avatar — the six companion actions.
const RADIAL_ACTIONS: { label: string; icon: string; angle: number; primary?: boolean }[] = [
  { label: "Jump", icon: "↗", angle: -90, primary: true },
  { label: "Approve", icon: "✓", angle: -30 },
  { label: "Mute", icon: "◖", angle: 30 },
  { label: "Dock", icon: "⇤", angle: 90 },
  { label: "Settings", icon: "⚙", angle: 150 },
  { label: "Hide", icon: "×", angle: 210 },
];

function CompanionRadial() {
  const r = 70;
  return (
    <div style={{ position: "relative", width: 220, height: 220 }}>
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
        }}
      >
        <CompanionAvatar agent="claude" status="live" />
      </div>
      {RADIAL_ACTIONS.map((a) => {
        const x = Math.cos((a.angle * Math.PI) / 180) * r;
        const y = Math.sin((a.angle * Math.PI) / 180) * r;
        return (
          <div
            key={a.label}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 3,
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: "50%",
                background: a.primary ? "var(--fg-0)" : "var(--bg-3)",
                color: a.primary ? "var(--bg-0)" : "var(--fg-0)",
                border: "1px solid var(--bd)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 14,
                boxShadow: "0 6px 16px rgba(0,0,0,0.4)",
              }}
            >
              {a.icon}
            </div>
            <span
              style={{
                fontSize: 9.5,
                color: "var(--fg-2)",
                fontFamily: "var(--mono)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                whiteSpace: "nowrap",
              }}
            >
              {a.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// Preferences panel — wired to the real companion-prefs store. The character
// picker + size are honoured by the live pucks above (the showcase cards keep
// their own fixed styles so the gallery still demos every style).
function CompanionPrefsPanel() {
  const p = useCompanionPrefs();
  return (
    <div
      style={{
        background: "var(--bg-2)",
        border: "1px solid var(--bd)",
        borderRadius: 10,
        padding: 16,
        marginBottom: 20,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span className="lbl">Companion preferences</span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "1px 6px",
            borderRadius: 4,
            fontFamily: "var(--mono)",
            fontSize: 9.5,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            fontWeight: 500,
            background: "color-mix(in oklab, var(--idle) 12%, transparent)",
            border: "1px solid color-mix(in oklab, var(--idle) 30%, transparent)",
            color: "var(--idle)",
          }}
        >
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--idle)" }} />
          desktop only
        </span>
      </div>
      <PrefRow label="Show companion" control={<Toggle on={p.show} onChange={p.setShow} />} />
      <PrefRow
        label="Hide while CodeHub window is focused"
        control={<Toggle on={p.hideWhenFocused} onChange={p.setHideWhenFocused} />}
      />
      <PrefRow
        label="Click-through when no events"
        sub="Mouse passes to apps underneath"
        control={<Toggle on={p.clickThrough} onChange={p.setClickThrough} />}
      />
      <PrefRow
        label="Snap to screen edges"
        control={<Toggle on={p.snapToEdges} onChange={p.setSnapToEdges} />}
      />
      <PrefRow
        label="Show bubble on hover"
        control={<Toggle on={p.bubbleOnHover} onChange={p.setBubbleOnHover} />}
      />
      <PrefRow
        label="Character"
        sub="Each agent can use a different style"
        control={<CharacterSelect value={p.character} onChange={p.setCharacter} />}
      />
      <PrefRow
        label="Size"
        last
        control={
          <div style={{ display: "flex", gap: 4 }}>
            {(["S", "M", "L"] as CompanionSize[]).map((s) => (
              <button
                type="button"
                key={s}
                onClick={() => p.setSize(s)}
                style={{
                  width: 24,
                  height: 22,
                  borderRadius: 4,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  background: s === p.size ? "var(--bg-3)" : "transparent",
                  color: s === p.size ? "var(--fg-0)" : "var(--fg-2)",
                  border: "1px solid var(--bd)",
                  cursor: "pointer",
                }}
              >
                {s}
              </button>
            ))}
          </div>
        }
      />
    </div>
  );
}

function CharacterSelect({
  value,
  onChange,
}: {
  value: CharacterKind;
  onChange: (k: CharacterKind) => void;
}) {
  const current = CHARACTER_KINDS.find((c) => c.kind === value);
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 9px",
        background: "var(--bg-3)",
        borderRadius: 6,
        border: "1px solid var(--bd)",
        cursor: "pointer",
      }}
    >
      <Character kind={value} expression="idle" size={18} />
      <span style={{ fontSize: 12, color: "var(--fg-0)" }}>{current?.name ?? value}</span>
      <span style={{ color: "var(--fg-2)", fontSize: 10 }}>▾</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as CharacterKind)}
        aria-label="Companion character style"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: "auto",
        }}
      >
        {CHARACTER_KINDS.map((c) => (
          <option key={c.kind} value={c.kind}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function PrefRow({
  label,
  sub,
  control,
  last,
}: {
  label: string;
  sub?: string;
  control: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "10px 0",
        borderBottom: last ? "none" : "1px solid var(--bd-soft)",
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12.5, color: "var(--fg-0)" }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: "var(--fg-2)" }}>{sub}</div>}
      </div>
      {control}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      style={{
        width: 34,
        height: 20,
        borderRadius: 999,
        border: "1px solid var(--bd)",
        background: on ? "var(--live)" : "var(--bg-3)",
        position: "relative",
        cursor: "pointer",
        flexShrink: 0,
        transition: "background 0.15s",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 1,
          left: on ? 15 : 1,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: on ? "#0a0a0a" : "var(--fg-2)",
          transition: "left 0.15s",
        }}
      />
    </button>
  );
}

function CharacterCard({
  kind,
  name,
  desc,
}: {
  kind: CharacterKind;
  name: string;
  desc: string;
}) {
  const prefs = useCompanionPrefs();
  const active = prefs.character === kind;
  return (
    <div
      style={{
        background: "var(--bg-2)",
        border: `1px solid ${active ? "var(--fg-2)" : "var(--bd)"}`,
        borderRadius: 10,
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        position: "relative",
      }}
    >
      {active && (
        <span
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            fontSize: 9.5,
            padding: "2px 6px",
            borderRadius: 4,
            background: "var(--fg-0)",
            color: "var(--bg-0)",
            fontFamily: "var(--mono)",
            fontWeight: 600,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
          }}
        >
          active
        </span>
      )}
      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-0)" }}>{name}</span>
      <div style={{ fontSize: 11, color: "var(--fg-2)", minHeight: 30, lineHeight: 1.4 }}>
        {desc}
      </div>
      <div
        style={{
          background: "linear-gradient(180deg, var(--bg-3), var(--bg-0))",
          borderRadius: 8,
          padding: "12px 8px",
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 6,
          border: "1px solid var(--bd-soft)",
        }}
      >
        {CHARACTER_EXPRESSIONS.map((exp) => (
          <div
            key={exp}
            style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}
          >
            <Character kind={kind} expression={exp} />
            <span
              style={{
                fontSize: 9,
                fontFamily: "var(--mono)",
                color: "var(--fg-3)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              {exp}
            </span>
          </div>
        ))}
      </div>
      {!active && (
        <button
          type="button"
          className="btn xs ghost"
          style={{ alignSelf: "flex-start" }}
          onClick={() => prefs.setCharacter(kind)}
        >
          Use {name}
        </button>
      )}
    </div>
  );
}

// Pill button styles for the inline approve/deny affordances (matches the
// design's pillBtn helper).
function pillBtn(kind: "ghost" | "ok"): React.CSSProperties {
  const base: React.CSSProperties = {
    border: "none",
    cursor: "pointer",
    fontFamily: "var(--sans)",
    fontSize: 11,
    fontWeight: 500,
    padding: "5px 10px",
    borderRadius: 999,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
    whiteSpace: "nowrap",
  };
  if (kind === "ok")
    return { ...base, background: "var(--live)", color: "#0a0a0a", fontWeight: 600 };
  return {
    ...base,
    background: "var(--bg-3)",
    color: "var(--fg-1)",
    border: "1px solid var(--bd)",
  };
}

// Compact quiet-duration: "3s" / "2m" / "1h".
function fmtIdle(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}
