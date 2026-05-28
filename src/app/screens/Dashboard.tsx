/**
 * Dashboard — read-only overview of the workspace runtime, laid out to match
 * design/screens/dashboard.jsx exactly: a 5-metric row, a sessions table beside
 * an attention queue + runtime resource card, then an activity chart beside a
 * per-agent token-usage card.
 *
 * The design mocks a multi-container fleet with rich per-row telemetry and a
 * multi-account billing card. CodeHub's current reads expose workspace
 * containers, tmux sessions, and no billing API — so each design slot is bound
 * to the closest REAL backend read and the truly-unobtainable sub-fields are
 * dropped (never faked):
 *
 *  - Tokens·24h / Cost·24h / their deltas / the metric sparklines  → real, from
 *    claude_usage.byDay + codex_usage.byDay (per-UTC-day token + est-cost rollups).
 *  - "Context · avg"  → average live contextUsed across Claude sessions, shown as
 *    a token count. The transcript records no window maximum (ipc.ts:319), so the
 *    design's 42% gauge is impossible — the gauge is dropped, the count kept.
 *  - Sessions table: Session/Status real; Task = the session's latest activity
 *    message; Branch = the active /workspace branch (one repo, not per-row); Turns
 *    + Tokens real for Claude (transcript id), em-dash for Codex/Antigravity; the
 *    per-pane CPU column is dropped (only container-wide stats exist); $ is
 *    em-dash (no per-session model split). All/Running filter is real; "Mine" is
 *    dropped (single user).
 *  - Right card: real pending_prompts attention queue + runtime resource bar
 *    (container_stats cpu/mem) in place of the design's per-workspace fan-out.
 *  - Activity chart: turns/hour by agent from session_activity_history (Claude +
 *    Codex; Antigravity never emits hook events, so no third series).
 *  - Token usage card: per-agent real totals (Claude/Codex), the closest-real
 *    stand-in for the design's per-account billing rows.
 *
 * Honesty contract: absent data → em-dash / honest-empty, never fabricated.
 */
import { AGENT_META, AgentGlyph } from "@/app/components/primitives/AgentGlyph";
import { IconBtn } from "@/app/components/primitives/IconBtn";
import { Segmented } from "@/app/components/primitives/Segmented";
import { Spark } from "@/app/components/primitives/Spark";
import { StatusBadge } from "@/app/components/primitives/StatusBadge";
import type { StatusKey } from "@/app/components/primitives/StatusDot";
import { Tag } from "@/app/components/primitives/Tag";
import { Ico } from "@/app/components/primitives/icons";
import { MODE_BY_ID } from "@/app/lib/catalog";
import {
  type ActivityEvent,
  type ClaudeAccount,
  type ClaudeUsage,
  type CodexDayUsage,
  type CodexRateLimits,
  type CodexTokenTotals,
  type CodexUsage,
  type DayUsage,
  type PendingPrompt,
  type SessionActivity,
  type SessionUsage,
  type TokenTotals,
  ipc,
} from "@/app/lib/ipc";
import { useLauncher } from "@/app/lib/launcher";
import { useStore } from "@/app/lib/store";
import { Button } from "@/app/ui/button";
import { useEffect, useMemo, useState } from "react";

type Filter = "all" | "running";
type AgentFilter = "all" | "claude" | "codex" | "antigravity";

export function Dashboard() {
  const status = useStore((s) => s.status);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const workspaces = useStore((s) => s.workspaces);
  const focusSession = useStore((s) => s.focusSession);
  const setView = useStore((s) => s.setView);
  const openLaunch = useLauncher((s) => s.open);
  // App-wide polls (single source): active runtime stats + /workspace git status.
  const stats = useStore((s) => s.containerStats);
  const git = useStore((s) => s.gitStatus);

  const state = status?.state ?? "missing";
  const running = state === "running";
  const sessions = Object.entries(sessionMeta).filter(([, m]) => m.cli !== "shell");

  // Token analytics (~15s — files grow slowly). Counts factual; cost is the
  // backend's estimate, shown verbatim. Live signals (~4s): working/idle, the
  // awaiting-input queue, and the turn-history feed (chart + per-row Task).
  const [claude, setClaude] = useState<ClaudeUsage | null>(null);
  const [codex, setCodex] = useState<CodexUsage | null>(null);
  const [activity, setActivity] = useState<SessionActivity[]>([]);
  const [prompts, setPrompts] = useState<PendingPrompt[]>([]);
  const [history, setHistory] = useState<ActivityEvent[]>([]);
  const [claudeBySession, setClaudeBySession] = useState<Record<string, SessionUsage | null>>({});
  // Usage analytics state (formerly the standalone Usage screen).
  const [rates, setRates] = useState<CodexRateLimits | null>(null);
  const [claudeAccount, setClaudeAccount] = useState<ClaudeAccount | null>(null);
  const [usageFilter, setUsageFilter] = useState<AgentFilter>("all");
  const [usageLoaded, setUsageLoaded] = useState(false);
  // Wall-clock tick (1s) so "updated Ns ago" + prompt ages advance between polls.
  const [, setTick] = useState(0);
  const [updatedAt, setUpdatedAt] = useState(() => Date.now());
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    if (!running) {
      setClaude(null);
      setCodex(null);
      setActivity([]);
      setPrompts([]);
      setHistory([]);
      setClaudeBySession({});
      setRates(null);
      setClaudeAccount(null);
      setUsageLoaded(false);
      return;
    }
    let alive = true;
    const poll = <T,>(fn: () => Promise<T>, set: (v: T) => void, ms: number, onErr: () => void) => {
      const tick = () => {
        fn()
          .then((v) => alive && set(v))
          .catch(() => alive && onErr());
      };
      tick();
      return setInterval(tick, ms);
    };
    const handles = [
      poll(
        () => ipc.claudeUsage(),
        setClaude,
        15000,
        () => setClaude(null),
      ),
      poll(
        () => ipc.codexUsage(),
        setCodex,
        15000,
        () => setCodex(null),
      ),
      poll(
        () => ipc.sessionActivity(),
        (v) => {
          setActivity(v);
          setUpdatedAt(Date.now());
        },
        4000,
        () => setActivity([]),
      ),
      poll(
        () => ipc.pendingPrompts(),
        setPrompts,
        4000,
        () => setPrompts([]),
      ),
      poll(
        () => ipc.sessionActivityHistory(),
        setHistory,
        8000,
        () => setHistory([]),
      ),
      poll(
        () => ipc.codexRateLimits(),
        (v) => { setRates(v); setUsageLoaded(true); },
        10000,
        () => { setRates(null); setUsageLoaded(true); },
      ),
      poll(
        () => ipc.claudeIntegrations().then((i) => i.account),
        setClaudeAccount,
        10000,
        () => setClaudeAccount(null),
      ),
    ];
    const ticker = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      alive = false;
      for (const h of handles) clearInterval(h);
      clearInterval(ticker);
    };
  }, [running]);

  // Stable, comma-joined Claude transcript ids in view — the per-session token
  // effect keys off this so it only re-subscribes when the set changes.
  const claudeIdKey = sessions
    .map(([, m]) => m.claudeId)
    .filter((id): id is string => Boolean(id))
    .join(",");

  useEffect(() => {
    if (!running) return;
    const claudeIds = claudeIdKey ? claudeIdKey.split(",") : [];
    if (claudeIds.length === 0) {
      setClaudeBySession({});
      return;
    }
    let alive = true;
    const tick = () => {
      for (const id of claudeIds) {
        ipc
          .claudeSessionUsage(id)
          .then((u) => alive && setClaudeBySession((prev) => ({ ...prev, [id]: u })))
          .catch(() => alive && setClaudeBySession((prev) => ({ ...prev, [id]: null })));
      }
    };
    tick();
    const h = setInterval(tick, 12000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [running, claudeIdKey]);

  // session name → live working/idle state; sessions awaiting input right now.
  const stateBy = new Map(activity.map((a) => [a.session, a.state]));
  const awaitingSet = new Set(prompts.map((p) => p.session));
  // session name → most recent activity message (the closest-real "Task"),
  // newest-wins by iterating the history sorted by `at` descending.
  const taskBy = new Map<string, string>();
  for (const e of [...history].sort((a, b) => b.at - a.at)) {
    if (e.message && !taskBy.has(e.session)) taskBy.set(e.session, e.message);
  }

  // ── byDay-derived 24h metrics (real) ────────────────────────────────────────
  const dayTok = new Map<string, number>();
  const dayCost = new Map<string, number>();
  for (const d of claude?.byDay ?? []) {
    dayTok.set(d.date, (dayTok.get(d.date) ?? 0) + d.totals.input + d.totals.output);
    dayCost.set(d.date, (dayCost.get(d.date) ?? 0) + d.estCostUsd);
  }
  for (const d of codex?.byDay ?? []) {
    dayTok.set(d.date, (dayTok.get(d.date) ?? 0) + d.totals.input + d.totals.output);
    dayCost.set(d.date, (dayCost.get(d.date) ?? 0) + d.estCostUsd);
  }
  const todayKey = utcDay(0);
  const yKey = utcDay(-1);
  const haveUsage = claude !== null || codex !== null;
  const tokToday = dayTok.get(todayKey) ?? 0;
  const tokYesterday = dayTok.get(yKey) ?? 0;
  const costToday = dayCost.get(todayKey) ?? 0;
  // Last 8 calendar days as sparklines (oldest→newest), zero-filled.
  const tokSpark = lastNDays(dayTok, 8);
  const costSpark = lastNDays(dayCost, 8);
  const tokDelta = pctDelta(tokToday, tokYesterday);

  // All-time avg cost/turn (no per-day turn count exists — honest all-time avg).
  const allTurns = (claude?.turns ?? 0) + (codex?.turns ?? 0);
  const allCost = (claude?.estCostUsd ?? 0) + (codex?.estCostUsd ?? 0);
  const perTurn = allTurns > 0 ? allCost / allTurns : 0;

  // Live context: average contextUsed across the Claude sessions we have a tally
  // for. No window max exists → a token count, never a percentage.
  const ctxVals = Object.values(claudeBySession)
    .filter((u): u is SessionUsage => u !== null && u.contextUsed > 0)
    .map((u) => u.contextUsed);
  const ctxAvg =
    ctxVals.length > 0 ? Math.round(ctxVals.reduce((a, b) => a + b, 0) / ctxVals.length) : null;

  // Count working among CURRENT sessions (via stateBy, the same per-session
  // source the table uses) — not raw activity rows, which can include stale
  // entries and overcount past the session total ("3 of 2").
  const working = sessions.filter(([s]) => stateBy.get(s) === "working").length;

  // ── Usage analytics computed values ────────────────────────────────────────
  const claudeHas = claude !== null && claude.turns > 0;
  const codexHas = codex !== null && codex.turns > 0;
  const totalTokens =
    (claude ? claude.totals.input + claude.totals.output : 0) +
    (codex ? codex.totals.input + codex.totals.output : 0);
  const totalTurns = allTurns;
  const totalCost = allCost;
  const totalSessions = (claude?.sessions ?? 0) + (codex?.sessions ?? 0);
  const avgPerTurn = totalTurns > 0 ? totalCost / totalTurns : 0;
  const claudeCount = claude?.sessions ?? 0;
  const codexCount = codex?.sessions ?? 0;
  const showClaude = usageFilter === "all" || usageFilter === "claude";
  const showCodex = usageFilter === "all" || usageFilter === "codex";
  const showAntigravity = usageFilter === "all" || usageFilter === "antigravity";
  const exportCsv = useMemo(() => makeCsvExporter(claude, codex), [claude, codex]);

  const open = (session: string) => {
    focusSession(session);
    setView("hub");
  };

  const respond = (session: string, allow: boolean) => {
    ipc
      .respondPrompt(session, allow)
      .then(() => setPrompts((prev) => prev.filter((p) => p.session !== session)))
      .catch((e) => console.warn("respond_prompt failed", e));
  };

  // header sub: agents · workspaces · today's est cost (all real).
  const headerSub = running
    ? `${sessions.length} agent${sessions.length === 1 ? "" : "s"} · ${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}${haveUsage ? ` · ${fmtUsd(costToday)} today` : ""}`
    : `runtime ${state}`;

  // Apply the table filter.
  const visibleSessions = sessions.filter(([session]) =>
    filter === "all" ? true : stateBy.get(session) === "working" || awaitingSet.has(session),
  );

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
      {/* header */}
      <div style={{ padding: "20px 28px 14px", borderBottom: "1px solid var(--bd-soft)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em" }}>
            Dashboard
          </h1>
          <span className="mono" style={{ fontSize: 12, color: "var(--fg-2)" }}>
            {headerSub}
          </span>
          <span style={{ flex: 1 }} />
          <Button size="sm" onClick={() => openLaunch("newtab")}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {Ico.plus}New agent
            </span>
          </Button>
        </div>
      </div>

      <div
        className="scroll"
        style={{
          flex: 1,
          overflow: "auto",
          padding: 24,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        {/* TOP METRICS — auto-fit so the row reflows when narrow */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 12,
            marginBottom: 22,
          }}
        >
          <Metric
            label="Running"
            value={running ? String(working) : null}
            sub={
              running
                ? `of ${sessions.length} session${sessions.length === 1 ? "" : "s"}`
                : undefined
            }
            accent="live"
          />
          <Metric
            label="Awaiting input"
            value={running ? String(prompts.length) : null}
            sub={awaitingSub(prompts, sessionMeta)}
            accent={prompts.length > 0 ? "wait" : undefined}
          />
          <Metric
            label="Tokens · 24h"
            value={haveUsage ? fmtNum(tokToday) : null}
            sub={
              haveUsage ? (tokDelta ? `${tokDelta.label} vs yesterday` : "no prior day") : undefined
            }
            delta={tokDelta?.tone}
            spark={haveUsage ? tokSpark : undefined}
          />
          <Metric
            label="Cost · 24h"
            value={haveUsage ? fmtUsd(costToday) : null}
            sub={haveUsage ? `${fmtUsd(perTurn)} / turn avg` : undefined}
            spark={haveUsage ? costSpark : undefined}
          />
          <Metric
            label="Context · avg"
            value={ctxAvg !== null ? fmtNum(ctxAvg) : null}
            sub={
              ctxAvg !== null ? "tokens / session · live" : running ? "no live tally" : undefined
            }
          />
        </div>

        {/* SESSIONS TABLE + ATTENTION/RUNTIME — right column flexes via clamp */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) clamp(280px, 22%, 360px)",
            gap: 12,
            flex: 1,
            minHeight: 200,
          }}
        >
          {/* table */}
          <div className="ch-card" style={{ padding: 0, minWidth: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <div
              style={{
                padding: "12px 16px",
                borderBottom: "1px solid var(--bd-soft)",
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-0)" }}>Sessions</span>
              <div style={{ display: "flex", gap: 4 }}>
                <FilterBtn label="All" active={filter === "all"} onClick={() => setFilter("all")} />
                <FilterBtn
                  label="Running"
                  active={filter === "running"}
                  onClick={() => setFilter("running")}
                />
              </div>
              <span style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-2)" }}>
                {running ? `updated ${fmtSince(updatedAt)}` : "runtime offline"}
              </span>
            </div>

            {visibleSessions.length === 0 ? (
              <div
                className="mono"
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "28px 16px",
                  fontSize: 11.5,
                  color: "var(--fg-3)",
                }}
              >
                {sessions.length === 0
                  ? "No sessions running. Press ⌘N to start one, or open an existing workspace from the sidebar."
                  : "No sessions match this filter."}
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, flex: 1 }}>
                <thead>
                  <tr>
                    <Th>Session</Th>
                    <Th>Status</Th>
                    <Th>Task</Th>
                    <Th>Branch</Th>
                    <Th align="right">Turns</Th>
                    <Th align="right">Tokens</Th>
                    <Th align="right">$</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {visibleSessions.map(([session, meta]) => {
                    const badge = MODE_BY_ID[meta.mode].badge;
                    const awaiting = awaitingSet.has(session);
                    const isWorking = stateBy.get(session) === "working";
                    const st: StatusKey = awaiting ? "wait" : isWorking ? "live" : "idle";
                    const su = meta.claudeId ? claudeBySession[meta.claudeId] : undefined;
                    const rowTokens =
                      meta.cli === "claude" && su ? su.tokensIn + su.tokensOut : null;
                    const rowTurns = meta.cli === "claude" && su ? su.turns : null;
                    const task = taskBy.get(session) ?? null;
                    return (
                      <tr
                        key={session}
                        className="session-row"
                        style={{ borderBottom: "1px solid var(--bd-soft)", cursor: "pointer" }}
                        onClick={() => open(session)}
                      >
                        <Td>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <AgentGlyph agent={meta.cli} size={13} color={`var(--a-${meta.cli})`} />
                            <span className="mono" style={{ color: "var(--fg-0)" }}>
                              {meta.alias}
                            </span>
                            {badge && (
                              <span className={`mode-badge badge-${meta.mode}`}>{badge}</span>
                            )}
                          </div>
                        </Td>
                        <Td>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <StatusBadge status={st} />
                            {awaiting && (
                              <span
                                style={{
                                  width: 7,
                                  height: 7,
                                  borderRadius: "50%",
                                  background: "var(--wait)",
                                  boxShadow:
                                    "0 0 0 2px color-mix(in oklab, var(--wait) 30%, transparent)",
                                }}
                              />
                            )}
                          </div>
                        </Td>
                        <Td>
                          <span
                            style={{
                              color: task ? "var(--fg-1)" : "var(--fg-3)",
                              display: "block",
                              maxWidth: 240,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={task ?? undefined}
                          >
                            {task ?? "—"}
                          </span>
                        </Td>
                        <Td>
                          <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>
                            {git?.isRepo ? (git.branch ?? "(detached)") : "—"}
                          </span>
                        </Td>
                        <Td align="right">
                          <span className="mono tnum" style={{ color: cellColor(rowTurns) }}>
                            {rowTurns !== null ? rowTurns : "—"}
                          </span>
                        </Td>
                        <Td align="right">
                          <span className="mono tnum" style={{ color: cellColor(rowTokens) }}>
                            {rowTokens !== null ? fmtNum(rowTokens) : "—"}
                          </span>
                        </Td>
                        <Td align="right">
                          {/* per-session cost has no per-model split in the live
                              tally — honest em-dash; aggregate is in Token usage. */}
                          <span className="mono tnum" style={{ color: "var(--fg-3)" }}>
                            —
                          </span>
                        </Td>
                        <Td align="right">
                          <IconBtn
                            title="Open in Hub"
                            onClick={(e) => {
                              e.stopPropagation();
                              open(session);
                            }}
                          >
                            {Ico.arrowR}
                          </IconBtn>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* attention queue + workspace resource bar (one card, design layout) */}
          <div
            className="ch-card"
            style={{ display: "flex", flexDirection: "column", minWidth: 0 }}
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
              <span
                className={prompts.length > 0 ? "dot wait" : "dot off"}
                style={{ width: 6, height: 6 }}
              />
              <span style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-0)" }}>
                Needs attention
              </span>
              <span style={{ flex: 1 }} />
              <span className="mono tnum" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                {prompts.length}
              </span>
            </div>

            {prompts.length === 0 ? (
              <div
                className="mono"
                style={{
                  flex: 1,
                  padding: "24px 14px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  color: "var(--fg-3)",
                }}
              >
                {running ? "Nothing waiting." : "Runtime not running."}
              </div>
            ) : (
              <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                {prompts.map((p) => {
                  const m = sessionMeta[p.session];
                  return (
                    <div
                      key={p.session}
                      style={{
                        padding: 10,
                        border: "1px solid color-mix(in oklab, var(--wait) 30%, var(--bd))",
                        borderRadius: 7,
                        background: "color-mix(in oklab, var(--wait) 6%, transparent)",
                      }}
                    >
                      <div
                        style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}
                      >
                        {m && <AgentGlyph agent={m.cli} size={12} color={`var(--a-${m.cli})`} />}
                        <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-0)" }}>
                          {m ? m.alias : p.session}
                        </span>
                        <span style={{ flex: 1 }} />
                        <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                          {fmtSince(p.since)}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--fg-1)",
                          marginBottom: 9,
                          lineHeight: 1.4,
                          wordBreak: "break-word",
                        }}
                      >
                        {p.message ?? "Awaiting your input"}
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <Button
                          size="sm"
                          style={{ flex: 1, justifyContent: "center" }}
                          onClick={() => respond(p.session, true)}
                        >
                          Approve
                          <span className="kbd" style={{ marginLeft: 6 }}>
                            ⏎
                          </span>
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          style={{ justifyContent: "center" }}
                          onClick={() => respond(p.session, false)}
                        >
                          Deny
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          style={{ justifyContent: "center" }}
                          onClick={() => open(p.session)}
                        >
                          Open
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div style={{ padding: 12, borderTop: "1px solid var(--bd-soft)", marginTop: "auto" }}>
              <div className="lbl" style={{ marginBottom: 8 }}>
                Workspaces
              </div>
              {running && stats ? (
                <ResourceBar
                  name={status?.name ?? "—"}
                  cpu={Math.min(100, stats.cpuPct)}
                  mem={stats.memLimit > 0 ? (stats.memUsed / stats.memLimit) * 100 : 0}
                />
              ) : (
                <div className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>
                  {running ? "Reading workspace stats…" : "Runtime not running."}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* BOTTOM: activity chart + per-agent token usage */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
          <div className="ch-card" style={{ padding: 16, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 14,
                marginBottom: 12,
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-0)" }}>
                Activity · last 24h
              </span>
              <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>
                turns / hour
              </span>
              <span style={{ flex: 1 }} />
              <Legend color="var(--a-claude)" label="Claude" />
              <Legend color="var(--a-codex)" label="Codex" />
            </div>
            <ActivityChart history={history} sessionMeta={sessionMeta} running={running} />
          </div>

          <div className="ch-card" style={{ padding: 16, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-0)" }}>
                Token usage
              </span>
              <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>
                all-time · est. cost
              </span>
              <span style={{ flex: 1 }} />
              <Button size="sm" variant="ghost" onClick={exportCsv} disabled={!running || (!claudeHas && !codexHas)}>
                Export CSV
              </Button>
            </div>
            <AgentUsageRows claude={claude} codex={codex} running={running} />
          </div>
        </div>

        {/* ── USAGE ANALYTICS (formerly the standalone Usage screen) ────────── */}
        <div style={{ marginTop: 22, borderTop: "1px solid var(--bd-soft)", paddingTop: 18 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 16 }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-0)" }}>
              Usage analytics
            </span>
            <span className="mono" style={{ fontSize: 12, color: "var(--fg-2)" }}>
              {running
                ? `${totalSessions} session${totalSessions === 1 ? "" : "s"} · ${totalTurns} turn${totalTurns === 1 ? "" : "s"} · ${fmtUsd(totalCost)} est. · token counts factual, cost estimated`
                : `runtime ${state}`}
            </span>
            <span style={{ flex: 1 }} />
            <Button
              size="sm"
              variant="ghost"
              disabled={!running || (!claudeHas && !codexHas)}
              onClick={exportCsv}
            >
              Export CSV
            </Button>
          </div>

          {/* aggregate strip */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
              marginBottom: 14,
            }}
          >
            <UsageSummaryCell
              label="tokens · all-time"
              value={running ? fmtNum(totalTokens) : "—"}
              subtle={running ? "input + output · Claude + Codex" : "runtime not running"}
            />
            <UsageSummaryCell
              label="est. cost · all-time"
              value={running ? `≈ ${fmtUsd(totalCost)}` : "—"}
              subtle="estimate — not billed"
            />
            <UsageSummaryCell
              label="turns · all-time"
              value={running ? String(totalTurns) : "—"}
              subtle={
                running && totalTurns > 0 ? `${fmtUsd(avgPerTurn)} est. avg / turn` : "no turns yet"
              }
            />
            <UsageSummaryCell
              label="sessions · all-time"
              value={running ? String(totalSessions) : "—"}
              subtle={running ? `Claude ${claudeCount} · Codex ${codexCount}` : "—"}
            />
            <UsageSummaryCell
              label="codex quota"
              value={running ? rateHeadline(rates) : "—"}
              subtle={running ? rateHeadlineSub(rates) : "runtime not running"}
              tone={rateTone(rates)}
            />
          </div>

          {/* agent filter */}
          <div
            style={{
              padding: "10px 0",
              marginBottom: 12,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <Segmented<AgentFilter>
              value={usageFilter}
              onChange={setUsageFilter}
              options={[
                { key: "all", label: `All · ${claudeCount + codexCount}` },
                { key: "claude", label: `Claude · ${claudeCount}` },
                { key: "codex", label: `Codex · ${codexCount}` },
                { key: "antigravity", label: "Antigravity · 0" },
              ]}
            />
            <span style={{ flex: 1 }} />
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>
              {running ? `updated ${fmtSince(updatedAt)}` : "runtime offline"}
            </span>
          </div>

          {/* per-agent cards */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {!running ? (
              <UsageNote>Runtime not running — start a workspace to see usage data.</UsageNote>
            ) : !usageLoaded ? (
              <UsageNote>Reading session transcripts…</UsageNote>
            ) : claude === null && codex === null ? (
              <UsageNote>No session transcripts found — start an agent to begin tracking usage.</UsageNote>
            ) : (
              <>
                {showClaude &&
                  (claudeHas ? (
                    <AgentUsageCard
                      agent="claude"
                      usage={claude as ClaudeUsage}
                      totals={claudeTotalsToCard(claude as ClaudeUsage)}
                      rateMeters={null}
                      plan={claudeAccount?.plan ?? null}
                      onNew={() => openLaunch("newtab")}
                      onExport={exportCsv}
                    />
                  ) : (
                    <EmptyAgentCard
                      agent="claude"
                      note={
                        claude === null
                          ? "Reading transcripts…"
                          : "No Claude turns recorded yet. Usage appears once an agent responds."
                      }
                      source="on-disk transcripts"
                      onNew={() => openLaunch("newtab")}
                    />
                  ))}

                {showCodex &&
                  (codexHas ? (
                    <AgentUsageCard
                      agent="codex"
                      usage={codex as CodexUsage}
                      totals={codexTotalsToTokenTotals(codex as CodexUsage)}
                      rateMeters={rates}
                      plan={rates?.planType ?? null}
                      onNew={() => openLaunch("newtab")}
                      onExport={exportCsv}
                    />
                  ) : (
                    <EmptyAgentCard
                      agent="codex"
                      note={
                        codex === null
                          ? "Reading rollout files…"
                          : "No Codex turns recorded yet. Usage appears once an agent responds."
                      }
                      source="rollout files"
                      rateNote={
                        rates === null ? "No rate-limit data on disk yet." : rateHeadlineSub(rates)
                      }
                      onNew={() => openLaunch("newtab")}
                    />
                  ))}

                {showAntigravity && (
                  <EmptyAgentCard
                    agent="antigravity"
                    note="Not installed in the runtime image — no readable usage data."
                    source="runtime image"
                    rateNote="No local Antigravity reader is available."
                    disabled
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

// Sub-line for the "Awaiting input" metric: name the single waiting session, or
// summarize, or stay quiet.
function awaitingSub(
  prompts: PendingPrompt[],
  sessionMeta: Record<string, { cli: string; alias: string }>,
): string | undefined {
  if (prompts.length === 0) return "none";
  if (prompts.length === 1) {
    const m = sessionMeta[prompts[0].session];
    return m ? `${m.cli} · ${m.alias}` : prompts[0].session;
  }
  return `${prompts.length} sessions`;
}

function cellColor(v: number | null): string {
  return v !== null ? "var(--fg-1)" : "var(--fg-3)";
}

// ── sessions-table filter pill ──────────────────────────────────────────────

function FilterBtn({
  label,
  active,
  onClick,
}: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mono"
      style={{
        fontSize: 10.5,
        padding: "2px 8px",
        borderRadius: 5,
        border: "1px solid transparent",
        background: active ? "var(--bg-3)" : "transparent",
        color: active ? "var(--fg-0)" : "var(--fg-2)",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

// ── runtime resource bar (design ContainerBar shape) ─────────────────────────

function ResourceBar({ name, cpu, mem }: { name: string; cpu: number; mem: number }) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10.5,
          fontFamily: "var(--mono)",
          color: "var(--fg-1)",
          marginBottom: 4,
        }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: "60%",
          }}
        >
          {name}
        </span>
        <span style={{ color: "var(--fg-2)" }}>
          cpu {cpu.toFixed(0)}% · mem {mem.toFixed(0)}%
        </span>
      </div>
      <div style={{ display: "flex", gap: 3, height: 4 }}>
        <div style={{ flex: 1, background: "var(--bg-3)", borderRadius: 999, overflow: "hidden" }}>
          <div
            style={{
              width: `${cpu}%`,
              height: "100%",
              background: cpu > 60 ? "var(--wait)" : "var(--live)",
            }}
          />
        </div>
        <div style={{ flex: 1, background: "var(--bg-3)", borderRadius: 999, overflow: "hidden" }}>
          <div style={{ width: `${mem}%`, height: "100%", background: "var(--idle)" }} />
        </div>
      </div>
    </div>
  );
}

// ── activity chart ──────────────────────────────────────────────────────────

function ActivityChart({
  history,
  sessionMeta,
  running,
}: {
  history: ActivityEvent[];
  sessionMeta: Record<string, { cli: string }>;
  running: boolean;
}) {
  const now = Date.now();
  const windowMs = 24 * 3600 * 1000;
  const claude = new Array(24).fill(0);
  const codex = new Array(24).fill(0);
  let any = false;
  for (const e of history) {
    if (e.kind !== "prompt_submit") continue;
    const ageMs = now - e.at;
    if (ageMs < 0 || ageMs > windowMs) continue;
    const bucket = 23 - Math.floor(ageMs / 3600000);
    if (bucket < 0 || bucket > 23) continue;
    const cli = sessionMeta[e.session]?.cli;
    if (cli === "claude") {
      claude[bucket] += 1;
      any = true;
    } else if (cli === "codex") {
      codex[bucket] += 1;
      any = true;
    }
  }

  if (!any) {
    return (
      <div
        className="mono"
        style={{
          height: 146,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
          color: "var(--fg-3)",
          textAlign: "center",
          lineHeight: 1.5,
        }}
      >
        {running ? "No turn activity in the last 24h." : "Runtime not running — no activity feed."}
      </div>
    );
  }

  const max = Math.max(1, ...claude.map((c, i) => c + codex[i]));
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 120 }}>
        {claude.map((c, i) => {
          const x = codex[i];
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: 24 fixed hourly buckets, never reordered.
              key={i}
              title={`${hourLabel(now - (23 - i) * 3600000)} · claude ${c} · codex ${x}`}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                justifyContent: "flex-end",
                gap: 1,
              }}
            >
              <div
                style={{
                  height: `${(x / max) * 100}%`,
                  background: "var(--a-codex)",
                  minHeight: x > 0 ? 2 : 0,
                  borderRadius: "2px 2px 0 0",
                }}
              />
              <div
                style={{
                  height: `${(c / max) * 100}%`,
                  background: "var(--a-claude)",
                  minHeight: c > 0 ? 2 : 0,
                }}
              />
            </div>
          );
        })}
      </div>
      <div
        style={{
          display: "flex",
          gap: 4,
          marginTop: 6,
          fontFamily: "var(--mono)",
          fontSize: 10,
          color: "var(--fg-3)",
        }}
      >
        {claude.map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 24 fixed hourly buckets, never reordered.
          <div key={i} style={{ flex: 1, textAlign: "center" }}>
            {i % 4 === 0 ? hourLabel(now - (23 - i) * 3600000) : "·"}
          </div>
        ))}
      </div>
    </div>
  );
}

function hourLabel(epochMs: number): string {
  return `${String(new Date(epochMs).getHours()).padStart(2, "0")}:00`;
}

// ── per-agent token usage ───────────────────────────────────────────────────

function AgentUsageRows({
  claude,
  codex,
  running,
}: {
  claude: ClaudeUsage | null;
  codex: CodexUsage | null;
  running: boolean;
}) {
  if (!running) {
    return (
      <div className="mono" style={{ fontSize: 11, color: "var(--fg-3)", padding: "8px 0" }}>
        Runtime not running — no usage to read.
      </div>
    );
  }
  const claudeTok = claude ? claude.totals.input + claude.totals.output : 0;
  const codexTok = codex ? codex.totals.input + codex.totals.output : 0;
  const maxTok = Math.max(1, claudeTok, codexTok);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
      <UsageRow
        agent="claude"
        ready={claude !== null}
        tokens={claudeTok}
        turns={claude?.turns ?? 0}
        cost={claude?.estCostUsd ?? 0}
        pct={claudeTok / maxTok}
      />
      <UsageRow
        agent="codex"
        ready={codex !== null}
        tokens={codexTok}
        turns={codex?.turns ?? 0}
        cost={codex?.estCostUsd ?? 0}
        pct={codexTok / maxTok}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 12, opacity: 0.6 }}>
        <AgentGlyph agent="antigravity" size={16} color="var(--a-antigravity)" />
        <span style={{ flex: 1, fontSize: 12.5, color: "var(--fg-2)" }}>
          {AGENT_META.antigravity.name}
        </span>
        <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
          not installed — no usage data
        </span>
      </div>
    </div>
  );
}

function UsageRow({
  agent,
  ready,
  tokens,
  turns,
  cost,
  pct,
}: {
  agent: "claude" | "codex";
  ready: boolean;
  tokens: number;
  turns: number;
  cost: number;
  pct: number;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <AgentGlyph agent={agent} size={16} color={`var(--a-${agent})`} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 12.5, color: "var(--fg-0)" }}>{AGENT_META[agent].name}</span>
          <span style={{ flex: 1 }} />
          {ready ? (
            <span
              className="mono tnum"
              style={{ fontSize: 10.5, color: "var(--fg-2)", whiteSpace: "nowrap" }}
            >
              {turns} turns
            </span>
          ) : (
            <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
              reading…
            </span>
          )}
        </div>
        <div
          style={{ height: 4, background: "var(--bg-3)", borderRadius: 999, overflow: "hidden" }}
        >
          <div
            style={{
              width: `${ready ? Math.max(2, pct * 100) : 0}%`,
              height: "100%",
              background: `var(--a-${agent})`,
            }}
          />
        </div>
      </div>
      <div
        style={{
          display: "flex",
          gap: 12,
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--fg-1)",
          whiteSpace: "nowrap",
        }}
      >
        <span className="tnum">
          <span style={{ color: "var(--fg-3)" }}>tok </span>
          {ready ? fmtNum(tokens) : "—"}
        </span>
        <span className="tnum" style={{ color: ready ? "var(--fg-1)" : "var(--fg-3)" }}>
          {ready ? `≈ ${fmtUsd(cost)}` : "—"}
        </span>
      </div>
    </div>
  );
}

// ── table cells / legend ────────────────────────────────────────────────────

function Th({ children, align }: { children?: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      style={{
        textAlign: align || "left",
        padding: "8px 14px",
        fontWeight: 500,
        color: "var(--fg-2)",
        fontSize: 10.5,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        borderBottom: "1px solid var(--bd-soft)",
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, align }: { children?: React.ReactNode; align?: "left" | "right" }) {
  return (
    <td style={{ padding: "9px 14px", textAlign: align || "left", verticalAlign: "middle" }}>
      {children}
    </td>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11,
        color: "var(--fg-1)",
      }}
    >
      <span style={{ width: 9, height: 2, background: color, borderRadius: 2 }} />
      {label}
    </span>
  );
}

// ── metric card ─────────────────────────────────────────────────────────────

// A dashboard metric card (design Metric). `value === null` → em-dash + hatched
// bar (no reading yet / runtime down). `spark` draws a real sparkline beside the
// value; `accent` tints the value + sub; `delta` colors the sub up/down.
function Metric({
  label,
  value,
  sub,
  spark,
  accent,
  delta,
}: {
  label: string;
  value: string | null;
  sub?: string;
  spark?: number[];
  accent?: "live" | "wait";
  delta?: "up" | "down";
}) {
  const accentColor = accent === "live" ? "var(--live)" : accent === "wait" ? "var(--wait)" : null;
  const deltaColor = delta === "up" ? "var(--live)" : delta === "down" ? "var(--err)" : null;
  const subColor = accentColor ?? deltaColor ?? "var(--fg-3)";
  const sparkColor = accentColor ?? "var(--fg-1)";
  return (
    <div
      className="ch-card ch-card-interactive"
      style={{ padding: 14, display: "flex", flexDirection: "column", gap: 6 }}
    >
      <div className="lbl">{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span
          className="mono tnum"
          style={{
            fontSize: 28,
            fontWeight: 500,
            letterSpacing: "-0.02em",
            color: value ? (accentColor ?? "var(--fg-0)") : "var(--fg-3)",
          }}
        >
          {value ?? "—"}
        </span>
        {value && spark && spark.length > 0 && (
          <Spark data={spark} w={70} h={20} color={sparkColor} fill />
        )}
      </div>
      {value && sub ? (
        <div className="mono" style={{ fontSize: 10.5, color: subColor }}>
          {sub}
        </div>
      ) : (
        <div
          style={{
            height: 4,
            borderRadius: 999,
            marginTop: 2,
            background: "repeating-linear-gradient(45deg, var(--bg-3) 0 6px, transparent 6px 12px)",
            opacity: 0.5,
          }}
        />
      )}
    </div>
  );
}

// ── formatters ──────────────────────────────────────────────────────────────

// UTC `YYYY-MM-DD` for `offset` days from today (0 = today, -1 = yesterday).
// byDay dates are UTC, so the comparison stays consistent across timezones.
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
}

// The last `n` calendar days of a per-day map, oldest→newest, zero-filled.
function lastNDays(map: Map<string, number>, n: number): number[] {
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(map.get(utcDay(-i)) ?? 0);
  return out;
}

// Percent delta of `cur` vs `prev`, or null when there's no prior baseline.
function pctDelta(cur: number, prev: number): { label: string; tone: "up" | "down" } | null {
  if (prev <= 0) return null;
  const p = Math.round(((cur - prev) / prev) * 100);
  return { label: `${p >= 0 ? "+" : ""}${p}%`, tone: p >= 0 ? "up" : "down" };
}

// Compact "time since" from an epoch-ms instant.
function fmtSince(epochMs: number): string {
  const s = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Compact token count: 1_234_567 → "1.2M", 12_300 → "12.3K", 540 → "540".
function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) {
    const decimals = n >= 10_000 ? 0 : 1;
    if (Number((n / 1_000).toFixed(decimals)) >= 1_000) {
      return `${(n / 1_000_000).toFixed(1)}M`;
    }
    return `${(n / 1_000).toFixed(decimals)}K`;
  }
  return String(n);
}

// USD with cents; sub-cent amounts get more precision so they don't read $0.00.
function fmtUsd(n: number): string {
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

// Window length: minutes → "3h" / "5h" / "45m" / "7d".
function fmtWindow(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes >= 60) return `${(minutes / 60).toFixed(1)}h`;
  return `${minutes}m`;
}

function fmtResets(resetsAt: string): string {
  let ms: number;
  const asNum = Number(resetsAt);
  if (Number.isFinite(asNum) && resetsAt.trim() !== "") {
    ms = asNum > 1e12 ? asNum : asNum * 1000;
  } else {
    ms = Date.parse(resetsAt);
  }
  if (!Number.isFinite(ms)) return resetsAt;
  const diff = ms - Date.now();
  if (diff <= 0) return "now";
  const totalMin = Math.floor(diff / 60000);
  if (totalMin >= 1440) return `in ${Math.floor(totalMin / 1440)}d`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `in ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ── Usage analytics components ─────────────────────────────────────────────
// Migrated from the standalone Usage screen into Dashboard as a scrollable
// extension below the Activity + Token usage row.

interface CardTokenTotals {
  input: number;
  output: number;
  cache: number;
  reasoning: number | null;
}

function AgentUsageCard({
  agent,
  usage,
  totals,
  rateMeters,
  plan,
  onNew,
  onExport,
}: {
  agent: "claude" | "codex";
  usage: ClaudeUsage | CodexUsage;
  totals: CardTokenTotals;
  rateMeters: CodexRateLimits | null;
  plan: string | null;
  onNew: () => void;
  onExport: () => void;
}) {
  const tokens = totals.input + totals.output;
  const spark = (usage.byDay as Array<DayUsage | CodexDayUsage>)
    .slice(-13)
    .map((d) => d.totals.input + d.totals.output + cacheTokens(d.totals));

  const hasRate = rateMeters !== null && hasAnyRate(rateMeters);
  const tone = rateTone(rateMeters);
  const accentBd =
    tone === "warn"
      ? "color-mix(in oklab, var(--wait) 35%, var(--bd))"
      : tone === "over"
        ? "color-mix(in oklab, var(--err) 35%, var(--bd))"
        : "var(--bd)";

  return (
    <div
      className="ch-card ch-card-interactive"
      style={{ padding: 0, display: "flex", overflow: "hidden", borderColor: accentBd }}
    >
      <div
        style={{
          flex: "0 0 260px",
          padding: "16px 18px",
          borderRight: "1px solid var(--bd-soft)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <AgentGlyph agent={agent} size={28} color={`var(--a-${agent})`} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--fg-0)" }}>
              {AGENT_META[agent].name}
            </div>
            <div className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>
              {plan ? plan : agent === "claude" ? "subscription / API" : "—"}
            </div>
          </div>
          <StatusBadge status="live">Active</StatusBadge>
        </div>

        {spark.length > 1 && (
          <div style={{ marginTop: 4 }}>
            <div className="lbl-soft" style={{ marginBottom: 4 }}>
              last {spark.length} days · tokens
            </div>
            <Spark data={spark} w={224} h={28} color={`var(--a-${agent})`} fill />
          </div>
        )}

        <div
          style={{
            marginTop: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontSize: 11,
            color: "var(--fg-2)",
            fontFamily: "var(--mono)",
          }}
        >
          <div>
            <span style={{ color: "var(--fg-3)" }}>source</span>{" "}
            <span style={{ color: "var(--fg-1)" }}>
              {agent === "claude" ? "on-disk transcripts" : "rollout files"}
            </span>
          </div>
          <div>
            <span style={{ color: "var(--fg-3)" }}>cost</span>{" "}
            <span style={{ color: "var(--fg-1)" }}>estimate · not billed</span>
          </div>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          padding: "16px 22px",
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        {agent === "codex" && hasRate && rateMeters && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="lbl">Rate windows · on-disk quota</div>
            <RateMeter
              label="primary window"
              usedPct={rateMeters.primaryUsedPct}
              windowMinutes={rateMeters.primaryWindowMinutes}
              resetsAt={rateMeters.primaryResetsAt}
            />
            <RateMeter
              label="secondary window"
              usedPct={rateMeters.secondaryUsedPct}
              windowMinutes={rateMeters.secondaryWindowMinutes}
              resetsAt={rateMeters.secondaryResetsAt}
            />
            <div style={{ height: 1, background: "var(--bd-soft)" }} />
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
          <UsageStat label="Input" value={fmtNum(totals.input)} />
          <UsageStat label="Output" value={fmtNum(totals.output)} />
          <UsageStat label="Cache" value={fmtNum(totals.cache)} />
          {totals.reasoning !== null ? (
            <UsageStat label="Reasoning" value={fmtNum(totals.reasoning)} />
          ) : (
            <UsageStat label="Tokens" value={fmtNum(tokens)} />
          )}
        </div>

        <div>
          <div className="lbl" style={{ marginBottom: 8 }}>
            By model
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <ModelRowHead />
            {usage.byModel.map((m) => (
              <ModelRow
                key={m.model}
                model={m.model}
                turns={m.turns}
                tokens={modelTokens(m)}
                priced={m.priced}
                cost={m.estCostUsd}
              />
            ))}
          </div>
        </div>

        <div
          style={{
            marginTop: "auto",
            padding: "10px 0 0",
            borderTop: "1px dashed var(--bd-soft)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            fontSize: 12,
            color: tone === "over" ? "var(--err)" : tone === "warn" ? "var(--wait)" : "var(--fg-2)",
          }}
        >
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              color: "var(--fg-3)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            forecast
          </span>
          <span>{forecastText(agent, rateMeters)}</span>
          <span style={{ flex: 1 }} />
          <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
            ≈ {fmtUsd(usage.estCostUsd)} est · rates {usage.ratesAsOf}
          </span>
          {usage.unpricedTokens > 0 && (
            <span className="mono" style={{ fontSize: 10.5, color: "var(--wait)" }}>
              · {fmtNum(usage.unpricedTokens)} unpriced excluded
            </span>
          )}
        </div>
      </div>

      <div
        style={{
          flex: "0 0 160px",
          padding: "16px 18px",
          borderLeft: "1px solid var(--bd-soft)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <Button size="sm" style={{ width: "100%", justifyContent: "center" }} onClick={onNew}>
          New {AGENT_META[agent].name}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          style={{ width: "100%", justifyContent: "center" }}
          onClick={onExport}
        >
          Export CSV
        </Button>
        <span style={{ flex: 1 }} />
        <div
          className="mono"
          style={{ fontSize: 10, color: "var(--fg-3)", lineHeight: 1.5, textAlign: "center" }}
        >
          plan &amp; billing managed by the provider
        </div>
      </div>
    </div>
  );
}

function RateMeter({
  label,
  usedPct,
  windowMinutes,
  resetsAt,
}: {
  label: string;
  usedPct: number | null;
  windowMinutes: number | null;
  resetsAt: string | null;
}) {
  if (usedPct === null) return null;
  const pct = Math.min(1, Math.max(0, usedPct / 100));
  const color = pct > 0.85 ? "var(--err)" : pct > 0.7 ? "var(--wait)" : "var(--live)";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-1)" }}>
          {label}
          {windowMinutes !== null && (
            <span style={{ color: "var(--fg-3)" }}> · {fmtWindow(windowMinutes)}</span>
          )}
        </span>
        <span style={{ flex: 1 }} />
        <span
          className="mono tnum"
          style={{ fontSize: 12.5, color: "var(--fg-0)", fontWeight: 500 }}
        >
          {usedPct.toFixed(usedPct < 10 ? 1 : 0)}%
        </span>
      </div>
      <div style={{ height: 5, background: "var(--bg-3)", borderRadius: 999, overflow: "hidden" }}>
        <div style={{ width: `${pct * 100}%`, height: "100%", background: color }} />
      </div>
      <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
        {resetsAt ? `resets ${fmtResets(resetsAt)}` : "no reset time on disk"}
      </div>
    </div>
  );
}

function ModelRowHead() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 8px 4px",
        borderBottom: "1px solid var(--bd-soft)",
      }}
    >
      <span className="lbl" style={{ flex: 1 }}>model</span>
      <NumCell head>turns</NumCell>
      <NumCell head>tokens</NumCell>
      <NumCell head wide>est. cost</NumCell>
    </div>
  );
}

function ModelRow({
  model,
  turns,
  tokens,
  priced,
  cost,
}: {
  model: string;
  turns: number;
  tokens: number;
  priced: boolean;
  cost: number;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px" }}>
      <span
        className="mono"
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "var(--fg-0)",
          fontSize: 12,
        }}
        title={model}
      >
        {model}
        {!priced && (
          <span style={{ marginLeft: 6, fontSize: 9.5, color: "var(--fg-3)" }}>unpriced</span>
        )}
      </span>
      <NumCell>{String(turns)}</NumCell>
      <NumCell>{fmtNum(tokens)}</NumCell>
      <NumCell wide>{priced ? fmtUsd(cost) : "—"}</NumCell>
    </div>
  );
}

function NumCell({
  children,
  head,
  wide,
}: {
  children: React.ReactNode;
  head?: boolean;
  wide?: boolean;
}) {
  return (
    <span
      className={head ? "lbl tnum" : "mono tnum"}
      style={{
        width: wide ? 80 : 56,
        textAlign: "right",
        flexShrink: 0,
        fontSize: head ? undefined : 12,
        color: head ? undefined : "var(--fg-1)",
      }}
    >
      {children}
    </span>
  );
}

function UsageStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="lbl-soft">{label}</span>
      <span className="mono tnum" style={{ fontSize: 16, color: "var(--fg-0)", fontWeight: 500 }}>
        {value}
      </span>
    </div>
  );
}

function EmptyAgentCard({
  agent,
  note,
  source,
  rateNote,
  onNew,
  disabled,
}: {
  agent: "claude" | "codex" | "antigravity";
  note: string;
  source: string;
  rateNote?: string;
  onNew?: () => void;
  disabled?: boolean;
}) {
  const accent = `var(--a-${agent})`;
  return (
    <div
      className="ch-card ch-card-interactive"
      style={{
        padding: 0,
        display: "flex",
        overflow: "hidden",
        opacity: disabled ? 0.74 : 1,
      }}
    >
      <div
        style={{
          flex: "0 0 260px",
          padding: "16px 18px",
          borderRight: "1px solid var(--bd-soft)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <AgentGlyph agent={agent} size={28} color={accent} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--fg-0)" }}>
              {AGENT_META[agent].name}
            </div>
            <div className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>
              waiting for recorded usage
            </div>
          </div>
          {disabled ? <Tag>not installed</Tag> : <StatusBadge status="idle">Ready</StatusBadge>}
        </div>

        <div
          style={{
            marginTop: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontSize: 11,
            color: "var(--fg-2)",
            fontFamily: "var(--mono)",
          }}
        >
          <div>
            <span style={{ color: "var(--fg-3)" }}>source</span>{" "}
            <span style={{ color: "var(--fg-1)" }}>{source}</span>
          </div>
          <div>
            <span style={{ color: "var(--fg-3)" }}>cost</span>{" "}
            <span style={{ color: "var(--fg-1)" }}>not estimated yet</span>
          </div>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          padding: "16px 22px",
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
          <UsageStat label="Input" value="—" />
          <UsageStat label="Output" value="—" />
          <UsageStat label="Cache" value="—" />
          <UsageStat label={agent === "codex" ? "Reasoning" : "Tokens"} value="—" />
        </div>

        <div
          className="mono"
          style={{
            padding: "12px 0",
            borderTop: "1px solid var(--bd-soft)",
            borderBottom: "1px solid var(--bd-soft)",
            color: "var(--fg-2)",
            fontSize: 12,
          }}
        >
          {note}
        </div>

        <div
          style={{
            marginTop: "auto",
            padding: "10px 0 0",
            borderTop: "1px dashed var(--bd-soft)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 12,
            color: "var(--fg-2)",
          }}
        >
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              color: "var(--fg-3)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            forecast
          </span>
          <span>{rateNote ?? "No quota window is available from local data."}</span>
        </div>
      </div>

      <div
        style={{
          flex: "0 0 160px",
          padding: "16px 18px",
          borderLeft: "1px solid var(--bd-soft)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <Button
          size="sm"
          style={{ width: "100%", justifyContent: "center" }}
          onClick={onNew}
          disabled={disabled || !onNew}
        >
          New {AGENT_META[agent].name}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          style={{ width: "100%", justifyContent: "center" }}
          disabled
        >
          Export CSV
        </Button>
        <span style={{ flex: 1 }} />
        <div
          className="mono"
          style={{ fontSize: 10, color: "var(--fg-3)", lineHeight: 1.5, textAlign: "center" }}
        >
          usage appears after a recorded turn
        </div>
      </div>
    </div>
  );
}

function UsageSummaryCell({
  label,
  value,
  subtle,
  tone,
}: {
  label: string;
  value: string;
  subtle: string;
  tone?: "warn" | "over";
}) {
  const valueColor =
    tone === "warn" ? "var(--spend-warn)" : tone === "over" ? "var(--spend-over)" : "var(--fg-0)";
  const subColor = tone === "warn" ? "var(--wait)" : tone === "over" ? "var(--err)" : "var(--fg-2)";
  return (
    <div
      className="ch-card ch-card-interactive"
      style={{ padding: 14, display: "flex", flexDirection: "column", gap: 4 }}
    >
      <div className="lbl">{label}</div>
      <span
        className="mono tnum"
        style={{ fontSize: 28, color: valueColor, fontWeight: 500, letterSpacing: "-0.02em" }}
      >
        {value}
      </span>
      <div className="mono" style={{ fontSize: 10.5, color: subColor }}>
        {subtle}
      </div>
    </div>
  );
}

function UsageNote({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mono"
      style={{ padding: "40px 16px", textAlign: "center", fontSize: 12, color: "var(--fg-3)" }}
    >
      {children}
    </div>
  );
}

// ── Usage data helpers ─────────────────────────────────────────────────────

function cacheTokens(t: TokenTotals | CodexTokenTotals): number {
  return "cacheRead" in t ? t.cacheRead + t.cacheCreation : t.cachedInput;
}

function claudeTotalsToCard(u: ClaudeUsage): CardTokenTotals {
  return {
    input: u.totals.input,
    output: u.totals.output,
    cache: u.totals.cacheRead + u.totals.cacheCreation,
    reasoning: null,
  };
}

function codexTotalsToTokenTotals(u: CodexUsage): CardTokenTotals {
  return {
    input: u.totals.input,
    output: u.totals.output,
    cache: u.totals.cachedInput,
    reasoning: u.totals.reasoningOutput,
  };
}

function modelTokens(m: ClaudeUsage["byModel"][number] | CodexUsage["byModel"][number]): number {
  if ("cacheRead" in m.totals) {
    return m.totals.input + m.totals.output + m.totals.cacheRead + m.totals.cacheCreation;
  }
  return m.totals.input + m.totals.output + m.totals.cachedInput + m.totals.reasoningOutput;
}

function hasAnyRate(r: CodexRateLimits): boolean {
  return r.primaryUsedPct !== null || r.secondaryUsedPct !== null;
}

function rateHeadline(r: CodexRateLimits | null): string {
  if (!r || r.primaryUsedPct === null) return "—";
  return `${r.primaryUsedPct.toFixed(r.primaryUsedPct < 10 ? 1 : 0)}%`;
}

function rateHeadlineSub(r: CodexRateLimits | null): string {
  if (!r) return "no rollout data";
  if (r.primaryUsedPct === null) return "no quota on disk";
  const plan = r.planType ? `${r.planType} · ` : "";
  return `${plan}primary window`;
}

function rateTone(r: CodexRateLimits | null): "warn" | "over" | undefined {
  if (!r || r.primaryUsedPct === null) return undefined;
  if (r.primaryUsedPct > 85) return "over";
  if (r.primaryUsedPct > 70) return "warn";
  return undefined;
}

function forecastText(agent: "claude" | "codex", r: CodexRateLimits | null): string {
  if (agent === "claude") {
    return "No on-disk quota windows for Claude — token usage here is unmetered.";
  }
  if (!r || r.primaryUsedPct === null) {
    return "No rate-limit data on disk yet — usage appears after the next turn.";
  }
  const reset = r.primaryResetsAt ? ` · primary window ${fmtResets(r.primaryResetsAt)}` : "";
  if (r.primaryUsedPct > 85)
    return `Primary window ${r.primaryUsedPct.toFixed(0)}% used — near limit${reset}`;
  if (r.primaryUsedPct > 70) return `Primary window ${r.primaryUsedPct.toFixed(0)}% used${reset}`;
  return `Comfortable headroom · ${r.primaryUsedPct.toFixed(0)}% of primary window used${reset}`;
}

function makeCsvExporter(claude: ClaudeUsage | null, codex: CodexUsage | null): () => void {
  return () => {
    const rows: string[] = ["date,agent,input_tokens,output_tokens,cache_tokens,est_cost_usd"];
    const add = (agent: string, days: Array<DayUsage | CodexDayUsage>) => {
      for (const d of days) {
        const cache = cacheTokens(d.totals);
        rows.push(
          `${d.date},${agent},${d.totals.input},${d.totals.output},${cache},${d.estCostUsd.toFixed(4)}`,
        );
      }
    };
    if (claude) add("claude", claude.byDay);
    if (codex) add("codex", codex.byDay);
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `codehub-usage-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
}
