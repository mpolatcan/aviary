import { useEffect, useMemo, useState } from "react";
import {
  CHARACTER_EXPRESSIONS,
  CHARACTER_KINDS,
  Character,
  type CharacterKind,
} from "../components/primitives/Character";
import { CompanionAvatar, type CompanionStatus } from "../components/primitives/CompanionAvatar";
import { IconBtn } from "../components/primitives/IconBtn";
import { Segmented } from "../components/primitives/Segmented";
import { Tip } from "../components/primitives/Tip";
import { Ico } from "../components/primitives/icons";
import { fmtTokens, useSessionUsage } from "../hooks/useSessionUsage";
import { deriveLiveStatus, fmtCounters } from "../lib/activity";
import { type PendingPrompt, type SessionActivity, ipc } from "../lib/ipc";
import { useCompanionPrefs } from "../lib/overlay";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";

// Content of the always-on-top companion window (P5) AND the design-system
// showcase for the companion avatar. It runs in its own webview (a separate JS
// context from the main app), so it cannot read the main store — it polls
// `session_activity` + `pending_prompts` directly and renders from those.
//
// What is REAL (everything — nothing fabricated):
//  • working / thinking / running-tool · idle · awaiting · finished · failed
//    all come from `session_activity`, which folds the agent hook lifecycle
//    (turns, tool calls, current tool, last-turn outcome) into one snapshot.
//    `deriveLiveStatus` collapses it to the shown status; the transient
//    finished/failed badge rides on the snapshot's `outcomeMsAgo` linger, so the
//    puck needs no client-side event/timer plumbing.
//  • token counts .............. Claude-only, from the session transcript (null
//                                for non-Claude agents → omitted, never zeroed).
//
// The native window itself (frameless, always_on_top) is created by
// `open_companion` in lib.rs (or the native NSPanel island on macOS) and can
// only be exercised in a built app / `tauri dev`; in the browser dev bridge this
// route renders standalone for visual inspection with real activity data.
const ACTIVITY_POLL_MS = 1500;
const PROMPT_POLL_MS = 2000;

function useWideCompanionPreview() {
  const [wide, setWide] = useState(() => window.innerWidth >= 900);
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return wide;
}

export function Companion() {
  const [list, setList] = useState<SessionActivity[]>([]);
  const [prompts, setPrompts] = useState<PendingPrompt[]>([]);

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

  const promptBySession = useMemo(() => {
    const m: Record<string, PendingPrompt> = {};
    for (const p of prompts) m[p.session] = p;
    return m;
  }, [prompts]);

  const widePreview = useWideCompanionPreview();

  if (widePreview) return <CompanionWideShowcase />;

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
        <IconBtn title="Close companion" onClick={() => void ipc.closeCompanion()} size={22}>
          {Ico.close}
        </IconBtn>
      </div>

      <div className="scroll" style={{ flex: 1, overflow: "auto" }}>
        {/* ── LIVE: the real always-on-top monitor ───────────────────────── */}
        <section style={{ padding: 10 }}>
          {list.length === 0 ? (
            <Empty />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {list.map((a) => (
                <LiveRow key={a.session} act={a} prompt={promptBySession[a.session]} />
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

function CompanionWideShowcase() {
  return (
    <div
      className="ch-root"
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
      <FauxCompanionDesktopHero />
      <div className="scroll" style={{ flex: 1, overflow: "auto" }}>
        <CompanionShowcase wide />
      </div>
    </div>
  );
}

function FauxCompanionDesktopHero() {
  return (
    <div style={{ position: "relative", height: 460, flexShrink: 0, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse at 70% 30%, oklch(0.32 0.06 280), oklch(0.16 0.04 230) 60%, oklch(0.10 0.03 240) 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: "radial-gradient(rgba(255,255,255,0.03) 1px, transparent 1px)",
          backgroundSize: "3px 3px",
          mixBlendMode: "overlay",
          opacity: 0.5,
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 28,
          background: "rgba(0,0,0,0.55)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          borderBottom: "1px solid rgba(255,255,255,0.05)",
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          fontSize: "var(--fs-12)",
          color: "rgba(255,255,255,0.85)",
        }}
      >
        <span style={{ fontWeight: 600, marginRight: 18 }}>Code</span>
        <span style={{ marginRight: 14 }}>File</span>
        <span style={{ marginRight: 14 }}>Edit</span>
        <span style={{ marginRight: 14 }}>View</span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ marginRight: 12, fontSize: "var(--fs-11)" }}>
          21:36
        </span>
        <span style={{ fontSize: "var(--fs-11)" }}>Wed 22 May</span>
      </div>

      <FauxEditorWindow />
      <CompanionDock />

      <div
        style={{
          position: "absolute",
          top: 90,
          right: 100,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          zIndex: 50,
        }}
      >
        <CompanionAvatar agent="codex" status="wait" bubble="needs your approval" expanded />
      </div>
      <div style={{ position: "absolute", top: 230, right: 200, zIndex: 50 }}>
        <CompanionAvatar agent="claude" status="live" />
      </div>
      <div style={{ position: "absolute", top: 320, left: 180, zIndex: 50 }}>
        <CompanionAvatar agent="antigravity" status="idle" />
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 80,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 10px",
          borderRadius: 999,
          background: "rgba(0,0,0,0.55)",
          backdropFilter: "blur(10px)",
          color: "rgba(255,255,255,0.9)",
          fontSize: "var(--fs-12)",
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#fff" }} />
        <span>3 companions floating · drag anywhere · always on top · click to jump</span>
      </div>
    </div>
  );
}

function FauxEditorWindow() {
  return (
    <div
      style={{
        position: "absolute",
        top: 50,
        left: 50,
        right: 50,
        bottom: 70,
        background: "rgba(20,22,28,0.92)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderRadius: 10,
        border: "1px solid rgba(255,255,255,0.06)",
        boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        opacity: 0.92,
      }}
    >
      <div
        style={{
          height: 28,
          background: "rgba(0,0,0,0.4)",
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          gap: 6,
          borderBottom: "1px solid rgba(255,255,255,0.04)",
        }}
      >
        <span
          style={{ width: 9, height: 9, borderRadius: "50%", background: "rgba(255,255,255,0.18)" }}
        />
        <span
          style={{ width: 9, height: 9, borderRadius: "50%", background: "rgba(255,255,255,0.18)" }}
        />
        <span
          style={{ width: 9, height: 9, borderRadius: "50%", background: "rgba(255,255,255,0.18)" }}
        />
        <span
          style={{
            flex: 1,
            textAlign: "center",
            fontSize: "var(--fs-12)",
            color: "rgba(255,255,255,0.55)",
            fontFamily: "var(--mono)",
          }}
        >
          auth.ts — aurora-api
        </span>
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          fontFamily: "var(--mono)",
          fontSize: "var(--fs-11)",
          padding: 12,
          gap: 10,
          color: "rgba(255,255,255,0.4)",
        }}
      >
        <div style={{ width: 30, textAlign: "right", lineHeight: 1.6 }}>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
        <div style={{ flex: 1, lineHeight: 1.6 }}>
          <div>
            <span style={{ color: "oklch(0.78 0.10 265)" }}>import</span>{" "}
            <span style={{ color: "rgba(255,255,255,0.7)" }}>{"{ Middleware }"}</span>{" "}
            <span style={{ color: "oklch(0.78 0.10 265)" }}>from</span>{" "}
            <span style={{ color: "oklch(0.78 0.13 35)" }}>{"'koa';"}</span>
          </div>
          <div>
            <span style={{ color: "oklch(0.78 0.10 265)" }}>import</span>{" "}
            <span style={{ color: "rgba(255,255,255,0.7)" }}>{"{ verifyToken }"}</span>{" "}
            <span style={{ color: "oklch(0.78 0.10 265)" }}>from</span>{" "}
            <span style={{ color: "oklch(0.78 0.13 35)" }}>{"'../auth/verifier';"}</span>
          </div>
          <div>&nbsp;</div>
          <div>
            <span style={{ color: "oklch(0.78 0.10 265)" }}>export const</span>{" "}
            <span style={{ color: "oklch(0.78 0.13 145)" }}>requireAuth</span>: Middleware{" "}
            <span style={{ color: "rgba(255,255,255,0.7)" }}>=</span>{" "}
            <span style={{ color: "oklch(0.78 0.10 265)" }}>async</span> (ctx, next) =&gt; {"{"}
          </div>
          <div>
            &nbsp;&nbsp;<span style={{ color: "oklch(0.78 0.10 265)" }}>const</span> token =
            ctx.headers.authorization?.replace(/^Bearer /,{" "}
            <span style={{ color: "oklch(0.78 0.13 35)" }}>''</span>);
          </div>
          <div>
            &nbsp;&nbsp;<span style={{ color: "oklch(0.78 0.10 265)" }}>const</span> r = token{" "}
            <span style={{ color: "rgba(255,255,255,0.7)" }}>&amp;&amp;</span>{" "}
            <span style={{ color: "oklch(0.78 0.10 265)" }}>await</span> verifyToken(token, SECRET);
          </div>
          <div>
            &nbsp;&nbsp;<span style={{ color: "oklch(0.78 0.10 265)" }}>if</span> (!r{" "}
            <span style={{ color: "rgba(255,255,255,0.7)" }}>||</span> !r.ok) ctx.throw(
            <span style={{ color: "oklch(0.78 0.13 145)" }}>401</span>);
          </div>
          <div>&nbsp;&nbsp;ctx.state.user = r.payload;</div>
          <div>
            &nbsp;&nbsp;<span style={{ color: "oklch(0.78 0.10 265)" }}>await</span> next();
          </div>
          <div>{"};"}</div>
        </div>
      </div>
    </div>
  );
}

function CompanionDock() {
  const apps: Array<[string | null, string]> = [
    ["#FF6B6B", "C"],
    ["#4ECDC4", "T"],
    ["#FFD93D", "B"],
    ["#A78BFA", "F"],
    [null, "CH"],
  ];
  return (
    <div
      style={{
        position: "absolute",
        bottom: 12,
        left: "50%",
        transform: "translateX(-50%)",
        background: "rgba(0,0,0,0.4)",
        backdropFilter: "blur(30px)",
        WebkitBackdropFilter: "blur(30px)",
        borderRadius: 16,
        padding: "6px 8px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        border: "1px solid rgba(255,255,255,0.06)",
        boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
      }}
    >
      {apps.map(([color, letter]) => (
        <div
          key={letter}
          style={{
            width: 42,
            height: 42,
            borderRadius: 10,
            background:
              color || "linear-gradient(135deg, oklch(0.50 0.10 230), oklch(0.30 0.08 250))",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontFamily: "var(--mono)",
            fontSize: "var(--fs-14)",
            fontWeight: 600,
            boxShadow: "0 4px 8px rgba(0,0,0,0.3)",
            position: "relative",
          }}
        >
          {letter}
          {letter === "CH" && (
            <span
              style={{
                position: "absolute",
                bottom: -8,
                left: "50%",
                transform: "translateX(-50%)",
                width: 3,
                height: 3,
                borderRadius: "50%",
                background: "#fff",
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// One live agent row: a {@link CompanionAvatar} puck driven by the shared,
// real status (deriveLiveStatus), the agent identity, the hook turn/tool
// counters, and (Claude only) a live token tally. Clicking jumps to the session.
function LiveRow({
  act,
  prompt,
}: {
  act: SessionActivity;
  prompt: PendingPrompt | undefined;
}) {
  const cli = act.cli ?? "unknown";
  const name = act.alias ?? act.session;
  const view = deriveLiveStatus(act, !!prompt);
  // Live token tally from this Claude session's transcript (null for non-Claude
  // agents and before the first response) — real numbers only, never faked.
  const usage = useSessionUsage(act.claudeId);
  const counters = fmtCounters(act);
  const tokens = usage ? usage.tokensIn + usage.tokensOut : 0;

  const status: CompanionStatus = view.status;
  const subColor =
    status === "wait"
      ? "var(--wait)"
      : status === "err"
        ? "var(--err)"
        : status === "done"
          ? "var(--done)"
          : status === "live"
            ? "var(--live)"
            : "var(--fg-3)";

  // Awaiting prefers the prompt's own message; otherwise the derived label
  // ("running Bash" / "thinking" / "finished" / "idle 3s" / …).
  const sub = prompt ? (prompt.message ?? "needs your approval") : view.label;

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
      <Tip text={`${name} — jump to session`}>
        <button
          type="button"
          onClick={() => void ipc.focusSessionFromCompanion(act.session)}
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
            thinking={view.thinking}
            size={44}
            style={{ pointerEvents: "none" }}
          />
        </button>
      </Tip>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: "var(--fs-13)",
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
          style={{ display: "block", fontSize: "var(--fs-11)", color: subColor }}
        >
          {sub}
          {counters && <span style={{ color: "var(--fg-3)" }}>{` · ${counters}`}</span>}
          {tokens > 0 && (
            <span style={{ color: "var(--fg-3)" }}>{` · ${fmtTokens(tokens)} tok`}</span>
          )}
        </span>
      </span>
      <span
        className={`dot ${status}${status === "live" ? " pulse" : ""}`}
        style={{ flexShrink: 0 }}
      />
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
      <p style={{ margin: 0, fontSize: "var(--fs-12)", color: "var(--fg-2)", lineHeight: 1.5 }}>
        No agents running.
      </p>
      <p style={{ margin: 0, fontSize: "var(--fs-11)", color: "var(--fg-3)", lineHeight: 1.5 }}>
        Start one in CodeHub to watch it here.
      </p>
    </div>
  );
}

// ── SHOWCASE ────────────────────────────────────────────────────────────────
// The design-system gallery (states · radial menu · preferences · characters).
// Faithful port of design/project/screens/companion.jsx, wired to the real
// companion-prefs store. Honest sample bubbles are clearly captioned as such.
function CompanionShowcase({ wide = false }: { wide?: boolean }) {
  return (
    <div
      style={{
        borderTop: wide ? "none" : "1px solid var(--bd-soft)",
        padding: wide ? "24px 32px" : "16px 14px 20px",
      }}
    >
      <ShowcaseHeading title="States" note="size 56px · pulses with state · right-click for menu" />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: wide
            ? "repeat(4, minmax(0, 1fr))"
            : "repeat(auto-fill, minmax(150px, 1fr))",
          gap: wide ? 14 : 12,
          marginBottom: wide ? 22 : 20,
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
      {wide ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.2fr 1fr",
            gap: 14,
            marginBottom: 22,
          }}
        >
          <CompCard
            caption="Radial · 6 actions"
            desc="Right-click or long-press. Esc closes."
            tone="live"
          >
            <CompanionRadial />
          </CompCard>
          <CompanionPrefsPanel />
        </div>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}>
            <CompanionRadial />
          </div>
          <CompanionPrefsPanel />
        </>
      )}

      <ShowcaseHeading title="Characters" note="6 built-in styles · per-agent override" />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: wide
            ? "repeat(3, minmax(0, 1fr))"
            : "repeat(auto-fill, minmax(220px, 1fr))",
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
      <h2 style={{ margin: 0, fontSize: "var(--fs-14)", fontWeight: 600, color: "var(--fg-0)" }}>
        {title}
      </h2>
      <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-2)" }}>
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
          <span style={{ fontSize: "var(--fs-12)", color: "var(--fg-0)", fontWeight: 500 }}>
            {caption}
          </span>
        </div>
        <div style={{ fontSize: "var(--fs-11)", color: "var(--fg-2)" }}>{desc}</div>
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
                fontSize: "var(--fs-14)",
                boxShadow: "0 6px 16px rgba(0,0,0,0.4)",
              }}
            >
              {a.icon}
            </div>
            <span
              style={{
                fontSize: "var(--fs-10)",
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
            fontSize: "var(--fs-10)",
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
      <PrefRow
        label="Show companion"
        control={<Switch checked={p.show} onCheckedChange={p.setShow} />}
      />
      <PrefRow
        label="Hide while CodeHub window is focused"
        control={<Switch checked={p.hideWhenFocused} onCheckedChange={p.setHideWhenFocused} />}
      />
      <PrefRow
        label="Click-through when no events"
        sub="Mouse passes to apps underneath"
        control={<Switch checked={p.clickThrough} onCheckedChange={p.setClickThrough} />}
      />
      <PrefRow
        label="Snap to screen edges"
        control={<Switch checked={p.snapToEdges} onCheckedChange={p.setSnapToEdges} />}
      />
      <PrefRow
        label="Show bubble on hover"
        control={<Switch checked={p.bubbleOnHover} onCheckedChange={p.setBubbleOnHover} />}
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
          <Segmented
            value={p.size}
            onChange={p.setSize}
            options={[
              { key: "S", label: "S" },
              { key: "M", label: "M" },
              { key: "L", label: "L" },
            ]}
          />
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
  return (
    <Select value={value} onValueChange={(v) => onChange(v as CharacterKind)}>
      <SelectTrigger size="sm" aria-label="Companion character style">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {CHARACTER_KINDS.map((c) => (
          <SelectItem key={c.kind} value={c.kind}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <Character kind={c.kind} expression="idle" size={16} />
              {c.name}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
        <div style={{ fontSize: "var(--fs-13)", color: "var(--fg-0)" }}>{label}</div>
        {sub && <div style={{ fontSize: "var(--fs-11)", color: "var(--fg-2)" }}>{sub}</div>}
      </div>
      {control}
    </div>
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
            fontSize: "var(--fs-10)",
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
      <span style={{ fontSize: "var(--fs-13)", fontWeight: 600, color: "var(--fg-0)" }}>
        {name}
      </span>
      <div
        style={{ fontSize: "var(--fs-11)", color: "var(--fg-2)", minHeight: 30, lineHeight: 1.4 }}
      >
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
                fontSize: "var(--fs-9)",
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
        <Button
          variant="ghost"
          size="xs"
          style={{ alignSelf: "flex-start" }}
          onClick={() => prefs.setCharacter(kind)}
        >
          Use {name}
        </Button>
      )}
    </div>
  );
}
