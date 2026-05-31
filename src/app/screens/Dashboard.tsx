/**
 * Dashboard — a viewport-filling overview of the workspace runtime.
 *
 * Layout (top→bottom, designed to fill the viewport, not sprawl):
 *  1. KPI strip — four tiles the user actually watches: Running · Cost·24h ·
 *     Context (live %) · Turns·24h. Awaiting-input is deliberately NOT here —
 *     the left sidebar already surfaces the attention queue, so the dashboard
 *     spends its width on throughput, not a queue mirror.
 *  2. Sessions — the live roster, full width (no attention sidecar). A real
 *     per-row context gauge (Claude transcript) replaces the dropped CPU/$ cols;
 *     the active container's cpu/mem rides the card header.
 *  3. Analytics — fills the lower viewport: the 24h turns/hour activity chart,
 *     then redesigned per-agent usage cards (a wide tokens/day chart + by-model
 *     proportion bars), the single home for all-time per-agent token/cost detail.
 *
 * Honesty contract: every value binds to a REAL backend read; absent data →
 * em-dash / honest-empty, never fabricated. The 24h/live KPIs and the all-time
 * Usage analytics deliberately do not restate each other.
 */
import { AGENT_META, AgentGlyph } from "@/app/components/primitives/AgentGlyph";
import { ContextGauge } from "@/app/components/primitives/ContextGauge";
import { IconBtn } from "@/app/components/primitives/IconBtn";
import { Segmented } from "@/app/components/primitives/Segmented";
import { Spark } from "@/app/components/primitives/Spark";
import { StatusBadge } from "@/app/components/primitives/StatusBadge";
import type { StatusKey } from "@/app/components/primitives/StatusDot";
import { Tip } from "@/app/components/primitives/Tip";
import { Ico } from "@/app/components/primitives/icons";
import { deriveLiveStatus } from "@/app/lib/activity";
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
import { useStore } from "@/app/lib/store";
import { Button } from "@/app/ui/button";
import { Toggle } from "@/app/ui/toggle";
import { useEffect, useMemo, useState } from "react";

type Filter = "all" | "running";
type AgentFilter = "all" | "claude" | "codex" | "antigravity";

export function Dashboard() {
  const status = useStore((s) => s.status);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const workspaces = useStore((s) => s.workspaces);
  const focusSession = useStore((s) => s.focusSession);
  const setView = useStore((s) => s.setView);
  const newAgent = useStore((s) => s.newAgent);
  // App-wide polls (single source): active runtime stats + /workspace git status.
  const stats = useStore((s) => s.containerStats);
  const git = useStore((s) => s.gitStatus);

  const state = status?.state ?? "missing";
  const running = state === "running";
  const sessions = Object.entries(sessionMeta).filter(([, m]) => m.cli !== "shell");

  // Token analytics (~15s — files grow slowly). Counts factual; cost is the
  // backend's estimate, shown verbatim. Live signals (~4s): working/idle, the
  // awaiting-input queue (status dot only), and the turn-history feed.
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
  // Wall-clock tick (1s) so "updated Ns ago" advances between polls.
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
        (v) => {
          setRates(v);
          setUsageLoaded(true);
        },
        10000,
        () => {
          setRates(null);
          setUsageLoaded(true);
        },
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

  // session name → hook-aware live status (NOT raw byte-flow `state`) so an idle
  // agent's TUI redraws don't read as "working". Same shared derivation the hub
  // pane/sidebar use.
  const awaitingSet = new Set(prompts.map((p) => p.session));
  const liveBy = new Map(
    activity.map((a) => [a.session, deriveLiveStatus(a, awaitingSet.has(a.session)).status]),
  );
  // session name → most recent activity message (the closest-real "Task").
  const taskBy = new Map<string, string>();
  for (const e of [...history].sort((a, b) => b.at - a.at)) {
    if (e.message && !taskBy.has(e.session)) taskBy.set(e.session, e.message);
  }

  // ── byDay-derived 24h metrics (real) ────────────────────────────────────────
  const dayCost = new Map<string, number>();
  for (const d of claude?.byDay ?? []) {
    dayCost.set(d.date, (dayCost.get(d.date) ?? 0) + d.estCostUsd);
  }
  for (const d of codex?.byDay ?? []) {
    dayCost.set(d.date, (dayCost.get(d.date) ?? 0) + d.estCostUsd);
  }
  const haveUsage = claude !== null || codex !== null;
  const costToday = dayCost.get(utcDay(0)) ?? 0;
  const costSpark = lastNDays(dayCost, 8);

  // ── turns in the last 24h (prompt_submit events) + an hourly spark ──────────
  const now = Date.now();
  const DAY_MS = 24 * 3600 * 1000;
  const turnHours = new Array(24).fill(0);
  let turnsToday = 0;
  for (const e of history) {
    if (e.kind !== "prompt_submit") continue;
    const age = now - e.at;
    if (age < 0 || age > DAY_MS) continue;
    turnsToday += 1;
    const bucket = 23 - Math.floor(age / 3600000);
    if (bucket >= 0 && bucket < 24) turnHours[bucket] += 1;
  }

  // All-time avg cost/turn (no per-day turn count exists — honest all-time avg).
  const allTurns = (claude?.turns ?? 0) + (codex?.turns ?? 0);
  const allCost = (claude?.estCostUsd ?? 0) + (codex?.estCostUsd ?? 0);
  const perTurn = allTurns > 0 ? allCost / allTurns : 0;

  // Live context: average fill (used / window) across the Claude sessions we have
  // a window for. contextWindow is mapped by model family, so a real % is possible
  // now — falls back to a raw token average when no window is known.
  const ctxAll = Object.values(claudeBySession).filter(
    (u): u is SessionUsage => u !== null && u.contextUsed > 0,
  );
  const ctxWithWindow = ctxAll.filter((u) => u.contextWindow > 0);
  const ctxPct =
    ctxWithWindow.length > 0
      ? ctxWithWindow.reduce((a, u) => a + u.contextUsed / u.contextWindow, 0) /
        ctxWithWindow.length
      : null;
  const ctxUsedAvg =
    ctxAll.length > 0
      ? Math.round(ctxAll.reduce((a, u) => a + u.contextUsed, 0) / ctxAll.length)
      : null;

  // Count actively-running among CURRENT sessions (via liveBy) — not raw activity
  // rows, which can overcount past the session total ("3 of 2").
  const working = sessions.filter(([s]) => liveBy.get(s) === "live").length;
  // One status per session (declaration order) for the Running tile's pips.
  const pipStatuses: StatusKey[] = sessions.map(([s]) => liveBy.get(s) ?? "idle");

  // ── Usage analytics computed values ────────────────────────────────────────
  const claudeHas = claude !== null && claude.turns > 0;
  const codexHas = codex !== null && codex.turns > 0;
  const totalTurns = allTurns;
  const totalCost = allCost;
  const totalSessions = (claude?.sessions ?? 0) + (codex?.sessions ?? 0);
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

  // header sub: agents · workspaces (cost lives in the Cost·24h metric, not here).
  const headerSub = running
    ? `${sessions.length} agent${sessions.length === 1 ? "" : "s"} · ${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}`
    : `runtime ${state}`;

  // Apply the table filter.
  const visibleSessions = sessions.filter(([session]) => {
    if (filter === "all") return true;
    const live = liveBy.get(session);
    return live === "live" || live === "wait";
  });

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
      <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid var(--bd-soft)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <h1
            style={{
              margin: 0,
              fontSize: "var(--fs-20)",
              fontWeight: 600,
              letterSpacing: "-0.01em",
            }}
          >
            Dashboard
          </h1>
          <span className="mono" style={{ fontSize: "var(--fs-13)", color: "var(--fg-2)" }}>
            {headerSub}
          </span>
          <span style={{ flex: 1 }} />
          <Button size="sm" onClick={() => newAgent()}>
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
          gap: 16,
          minHeight: 0,
        }}
      >
        {/* KPI STRIP — four watched metrics, auto-fit so it reflows when narrow */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
            gap: 12,
          }}
        >
          <Metric
            label="Running agents"
            value={running ? String(working) : null}
            sub={
              running
                ? `of ${sessions.length} session${sessions.length === 1 ? "" : "s"}`
                : undefined
            }
            accent="live"
            pips={running ? pipStatuses : undefined}
            delay={0}
          />
          <Metric
            label="Cost · 24h"
            value={haveUsage ? fmtUsd(costToday) : null}
            sub={haveUsage ? `${fmtUsd(perTurn)} / turn · all-time avg` : undefined}
            spark={haveUsage ? costSpark : undefined}
            delay={40}
          />
          <Metric
            label="Context · avg"
            value={ctxPct !== null ? `${Math.round(ctxPct * 100)}%` : ctxAvgLabel(ctxUsedAvg)}
            sub={
              ctxPct !== null
                ? ctxUsedAvg !== null
                  ? `${fmtNum(ctxUsedAvg)} tokens · live`
                  : "live"
                : ctxUsedAvg !== null
                  ? "tokens / session · live"
                  : running
                    ? "no live tally"
                    : undefined
            }
            gauge={ctxPct}
            delay={80}
          />
          <Metric
            label="Turns · 24h"
            value={running ? String(turnsToday) : null}
            sub={running ? `${allTurns} all-time` : undefined}
            spark={running && turnsToday > 0 ? turnHours : undefined}
            sparkCalm
            delay={120}
          />
        </div>

        {/* SESSIONS — full width (no attention sidecar). Sizes to its rows.
            flexShrink:0 so the scroll column never collapses this card: overflow
            hidden gives a flex item a 0 auto-min-size, which flexbox would shrink
            to nothing once the page overflows. */}
        <div
          className="ch-card dash-rise"
          style={{
            padding: 0,
            minWidth: 0,
            overflow: "hidden",
            flexShrink: 0,
            animationDelay: "150ms",
          }}
        >
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid var(--bd-soft)",
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <span style={{ fontSize: "var(--fs-14)", fontWeight: 600, color: "var(--fg-0)" }}>
              Sessions
            </span>
            <div style={{ display: "flex", gap: 4 }}>
              <FilterBtn label="All" active={filter === "all"} onClick={() => setFilter("all")} />
              <FilterBtn
                label="Running"
                active={filter === "running"}
                onClick={() => setFilter("running")}
              />
            </div>
            <span style={{ flex: 1 }} />
            {running && stats && (
              <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-2)" }}>
                {status?.name ?? "runtime"}
                <span style={{ color: "var(--fg-3)" }}>
                  {" · "}cpu {Math.min(100, stats.cpuPct).toFixed(0)}% · mem{" "}
                  {stats.memLimit > 0 ? ((stats.memUsed / stats.memLimit) * 100).toFixed(0) : "0"}%
                </span>
              </span>
            )}
            <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
              {running ? `updated ${fmtSince(updatedAt)}` : "runtime offline"}
            </span>
          </div>

          {visibleSessions.length === 0 ? (
            <div
              className="mono"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "34px 24px",
                fontSize: "var(--fs-13)",
                lineHeight: 1.5,
                textAlign: "center",
                color: "var(--fg-3)",
              }}
            >
              {sessions.length === 0
                ? "No sessions running. Press ⌘N to start one, or open an existing workspace from the sidebar."
                : "No sessions match this filter."}
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--fs-13)" }}>
              <thead>
                <tr>
                  <Th>Session</Th>
                  <Th>Status</Th>
                  <Th>Task</Th>
                  <Th>Branch</Th>
                  <Th>Context</Th>
                  <Th align="right">Turns</Th>
                  <Th align="right">Tokens</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {visibleSessions.map(([session, meta]) => {
                  const badge = MODE_BY_ID[meta.mode].badge;
                  const awaiting = awaitingSet.has(session);
                  const st: StatusKey = liveBy.get(session) ?? "idle";
                  const su = meta.claudeId ? claudeBySession[meta.claudeId] : undefined;
                  const rowTokens = meta.cli === "claude" && su ? su.tokensIn + su.tokensOut : null;
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
                        <Tip text={task ?? ""}>
                          <span
                            style={{
                              color: task ? "var(--fg-1)" : "var(--fg-3)",
                              display: "block",
                              maxWidth: 320,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {task ?? "—"}
                          </span>
                        </Tip>
                      </Td>
                      <Td>
                        <span
                          className="mono"
                          style={{ fontSize: "var(--fs-12)", color: "var(--fg-2)" }}
                        >
                          {git?.isRepo ? (git.branch ?? "(detached)") : "—"}
                        </span>
                      </Td>
                      <Td>
                        {su && su.contextWindow > 0 ? (
                          <ContextGauge
                            used={su.contextUsed}
                            max={su.contextWindow}
                            label=""
                            width={64}
                          />
                        ) : (
                          <span
                            className="mono"
                            style={{ fontSize: "var(--fs-12)", color: "var(--fg-3)" }}
                          >
                            —
                          </span>
                        )}
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

        {/* ── ANALYTICS — fills the lower viewport ──────────────────────────── */}
        <div
          className="dash-rise"
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 14,
            marginTop: 4,
            animationDelay: "210ms",
          }}
        >
          <span style={{ fontSize: "var(--fs-16)", fontWeight: 600, color: "var(--fg-0)" }}>
            Analytics
          </span>
          <span className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--fg-2)" }}>
            {running
              ? `${totalSessions} session${totalSessions === 1 ? "" : "s"} · ${totalTurns} turn${totalTurns === 1 ? "" : "s"} · ${fmtUsd(totalCost)} est · token counts factual, cost estimated`
              : `runtime ${state}`}
          </span>
          <span style={{ flex: 1 }} />
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
          <Button
            size="sm"
            variant="ghost"
            disabled={!running || (!claudeHas && !codexHas)}
            onClick={exportCsv}
          >
            Export CSV
          </Button>
        </div>

        {/* activity chart — turns/hour over 24h */}
        <div
          className="ch-card dash-rise"
          style={{ padding: 16, minWidth: 0, animationDelay: "260ms" }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 14,
              marginBottom: 14,
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontSize: "var(--fs-14)", fontWeight: 600, color: "var(--fg-0)" }}>
              Activity · last 24h
            </span>
            <span className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--fg-2)" }}>
              turns / hour
            </span>
            <span style={{ flex: 1 }} />
            <Legend color="var(--a-claude)" label="Claude" />
            <Legend color="var(--a-codex)" label="Codex" />
          </div>
          <ActivityChart history={history} sessionMeta={sessionMeta} running={running} />
        </div>

        {/* per-agent usage cards */}
        <div
          className="dash-rise"
          style={{ display: "flex", flexDirection: "column", gap: 12, animationDelay: "300ms" }}
        >
          {!running ? (
            <UsageNote>Runtime not running — start a workspace to see usage data.</UsageNote>
          ) : !usageLoaded ? (
            <UsageNote>Reading session transcripts…</UsageNote>
          ) : claude === null && codex === null ? (
            <UsageNote>
              No session transcripts found — start an agent to begin tracking usage.
            </UsageNote>
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
                  />
                ))}

              {showAntigravity && (
                <div
                  className="ch-card"
                  style={{
                    padding: "12px 16px",
                    display: "flex",
                    alignItems: "center",
                    gap: 11,
                    opacity: 0.7,
                  }}
                >
                  <AgentGlyph agent="antigravity" size={18} color="var(--a-antigravity)" />
                  <span style={{ fontSize: "var(--fs-13)", color: "var(--fg-1)" }}>
                    {AGENT_META.antigravity.name}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
                    not installed in runtime image · no usage data
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function cellColor(v: number | null): string {
  return v !== null ? "var(--fg-1)" : "var(--fg-3)";
}

// "Context · avg" value when no context window is known (can't show a %): the raw
// token average, or em-dash when there's no live tally at all.
function ctxAvgLabel(usedAvg: number | null): string | null {
  return usedAvg !== null ? fmtNum(usedAvg) : null;
}

// ── sessions-table filter pill ──────────────────────────────────────────────

function FilterBtn({
  label,
  active,
  onClick,
}: { label: string; active: boolean; onClick: () => void }) {
  return (
    <Toggle
      size="sm"
      pressed={active}
      onPressedChange={() => onClick()}
      className="mono h-auto min-w-0 rounded-[5px] border border-transparent px-[9px] py-[3px] text-[11px] text-[var(--fg-2)] hover:bg-[var(--bg-hover)] data-[state=on]:bg-[var(--bg-3)] data-[state=on]:text-[var(--fg-0)]"
    >
      {label}
    </Toggle>
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

  const max = any ? Math.max(1, ...claude.map((c, i) => c + codex[i])) : 1;
  // Full plot when there's data to read; a compact band when empty so an idle
  // window doesn't reserve a tall blank rectangle.
  const PLOT = any ? 150 : 80;
  const GUTTER = 32;
  const rules = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div>
      <div style={{ display: "flex", gap: 8 }}>
        {/* y-axis gutter — only labels the scale when there's data to scale */}
        <div
          className="mono tnum"
          style={{
            position: "relative",
            width: GUTTER,
            height: PLOT,
            flexShrink: 0,
            fontSize: "var(--fs-11)",
            color: "var(--fg-3)",
          }}
        >
          {any && (
            <>
              <span style={{ position: "absolute", top: -4, right: 0 }}>{max}</span>
              <span style={{ position: "absolute", bottom: -4, right: 0 }}>0</span>
            </>
          )}
        </div>

        {/* plot — gridlines always render so an empty window reads as a calm
            chart with an overlaid note, not a blank rectangle */}
        <div style={{ position: "relative", flex: 1, height: PLOT, minWidth: 0 }}>
          {rules.map((f) => (
            <div
              key={f}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: `${f * 100}%`,
                height: 1,
                background: f === 0 ? "var(--bd)" : "var(--bd-soft)",
                opacity: f === 0 ? 1 : 0.7,
              }}
            />
          ))}

          {any && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "flex-end",
                gap: 3,
              }}
            >
              {claude.map((c, i) => {
                const x = codex[i];
                return (
                  <Tip
                    // biome-ignore lint/suspicious/noArrayIndexKey: 24 fixed hourly buckets, never reordered.
                    key={i}
                    text={`${hourLabel(now - (23 - i) * 3600000)} · claude ${c} · codex ${x}`}
                  >
                    <div
                      className="bar-col"
                      style={{
                        flex: 1,
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "flex-end",
                      }}
                    >
                      <div
                        style={{
                          height: `${(x / max) * 100}%`,
                          background: "var(--a-codex)",
                          minHeight: x > 0 ? 3 : 0,
                          borderRadius: "3px 3px 0 0",
                        }}
                      />
                      <div
                        style={{
                          height: `${(c / max) * 100}%`,
                          background: "var(--a-claude)",
                          minHeight: c > 0 ? 3 : 0,
                          borderRadius: x > 0 ? 0 : "3px 3px 0 0",
                        }}
                      />
                    </div>
                  </Tip>
                );
              })}
            </div>
          )}

          {!any && (
            <div
              className="mono"
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "var(--fs-12)",
                color: "var(--fg-3)",
                textAlign: "center",
              }}
            >
              {running
                ? "No turn activity in the last 24h."
                : "Runtime not running — no activity feed."}
            </div>
          )}
        </div>
      </div>

      {/* hour axis — aligned past the gutter + plot gap */}
      <div
        style={{
          display: "flex",
          gap: 3,
          marginTop: 8,
          paddingLeft: GUTTER + 8,
          fontFamily: "var(--mono)",
          fontSize: "var(--fs-11)",
          color: "var(--fg-3)",
        }}
      >
        {claude.map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 24 fixed hourly buckets, never reordered.
          <div key={i} style={{ flex: 1, textAlign: "center" }}>
            {i % 4 === 0 ? hourLabel(now - (23 - i) * 3600000) : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

function hourLabel(epochMs: number): string {
  return `${String(new Date(epochMs).getHours()).padStart(2, "0")}:00`;
}

// ── table cells / legend ────────────────────────────────────────────────────

function Th({ children, align }: { children?: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      style={{
        textAlign: align || "left",
        padding: "9px 14px",
        fontWeight: 500,
        color: "var(--fg-2)",
        fontSize: "var(--fs-11)",
        letterSpacing: "0.07em",
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
    <td style={{ padding: "11px 14px", textAlign: align || "left", verticalAlign: "middle" }}>
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
        gap: 6,
        fontSize: "var(--fs-12)",
        color: "var(--fg-1)",
      }}
    >
      <span style={{ width: 10, height: 2, background: color, borderRadius: 2 }} />
      {label}
    </span>
  );
}

// ── KPI tile ────────────────────────────────────────────────────────────────

// A dashboard metric tile. `value === null` → em-dash + a quiet placeholder (an
// empty gauge track for gauge metrics, else a hatched bar). `spark` draws a real
// sparkline beside the value; `gauge` (0..1, or null = gauge metric with no data
// yet) draws a fill bar (context); `pips` draws one status dot per session
// (running tile); `accent` tints the value. `delay` staggers the mount reveal.
function Metric({
  label,
  value,
  sub,
  spark,
  sparkCalm,
  accent,
  gauge,
  pips,
  delay = 0,
}: {
  label: string;
  value: string | null;
  sub?: string;
  spark?: number[];
  sparkCalm?: boolean;
  accent?: "live" | "wait";
  gauge?: number | null;
  pips?: StatusKey[];
  delay?: number;
}) {
  const accentColor = accent === "live" ? "var(--live)" : accent === "wait" ? "var(--wait)" : null;
  const sparkColor = accentColor ?? "var(--fg-1)";
  const isGauge = gauge !== undefined; // gauge metric (even when no data → null)
  const gaugeColor =
    gauge === null || gauge === undefined
      ? "var(--fg-1)"
      : gauge > 0.85
        ? "var(--err)"
        : gauge > 0.7
          ? "var(--wait)"
          : "var(--live)";
  const subEl = sub ? (
    <div className="mono" style={{ fontSize: "var(--fs-12)", color: accentColor ?? "var(--fg-3)" }}>
      {sub}
    </div>
  ) : null;
  return (
    <div
      className="ch-card ch-card-interactive dash-rise"
      style={{
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        animationDelay: `${delay}ms`,
      }}
    >
      <div className="lbl" style={{ fontSize: "var(--fs-11)" }}>
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span
          className="mono tnum"
          style={{
            fontSize: "var(--fs-26)",
            fontWeight: 500,
            letterSpacing: "-0.02em",
            color: value ? (accentColor ?? "var(--fg-0)") : "var(--fg-3)",
          }}
        >
          {value ?? "—"}
        </span>
        {value && spark && spark.length > 0 && (
          <span style={{ flex: 1, height: 22, minWidth: 0 }}>
            <Spark data={spark} color={sparkColor} fill calm={sparkCalm} responsive />
          </span>
        )}
      </div>
      {value && pips ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <Pips statuses={pips} />
          {subEl}
        </div>
      ) : value && isGauge ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <GaugeTrack pct={gauge} color={gaugeColor} />
          {subEl}
        </div>
      ) : value && sub ? (
        subEl
      ) : isGauge ? (
        // Gauge metric with no reading: an empty track reads "gauge, awaiting
        // data", not a broken hatch.
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <GaugeTrack pct={null} color={gaugeColor} />
          {subEl}
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

// A thin gauge bar; `pct === null` renders just the empty track.
function GaugeTrack({ pct, color }: { pct: number | null; color: string }) {
  return (
    <div style={{ height: 4, borderRadius: 999, background: "var(--bg-3)", overflow: "hidden" }}>
      {pct !== null && (
        <div style={{ width: `${Math.min(1, pct) * 100}%`, height: "100%", background: color }} />
      )}
    </div>
  );
}

// One dot per session, colored by its live status — fills the Running tile with
// a real per-session glance instead of empty space. Caps the row so a big fleet
// doesn't overflow; the count lives in the value above.
function Pips({ statuses }: { statuses: StatusKey[] }) {
  const color = (s: StatusKey) =>
    s === "live"
      ? "var(--live)"
      : s === "wait"
        ? "var(--wait)"
        : s === "done"
          ? "var(--done)"
          : s === "err"
            ? "var(--err)"
            : "var(--idle)";
  const shown = statuses.slice(0, 14);
  if (shown.length === 0) return <div style={{ height: 6 }} />;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
      {shown.map((s, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: positional session pips, no stable id needed.
          key={i}
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: color(s),
            opacity: s === "idle" ? 0.6 : 1,
            boxShadow:
              s === "live" ? "0 0 0 2px color-mix(in oklab, var(--live) 26%, transparent)" : "none",
          }}
        />
      ))}
      {statuses.length > shown.length && (
        <span className="mono" style={{ fontSize: "var(--fs-10)", color: "var(--fg-3)" }}>
          +{statuses.length - shown.length}
        </span>
      )}
    </div>
  );
}

// ── formatters ──────────────────────────────────────────────────────────────

// UTC `YYYY-MM-DD` for `offset` days from today (0 = today, -1 = yesterday).
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
}

// The last `n` calendar days of a per-day map, oldest→newest, zero-filled.
function lastNDays(map: Map<string, number>, n: number): number[] {
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(map.get(utcDay(-i)) ?? 0);
  return out;
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
// The single home for all-time per-agent token/cost detail (the KPI strip stays
// 24h/live, never restated here). Each card is full-width: a wide tokens/day
// chart, a stat row, and by-model proportion bars.

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
}: {
  agent: "claude" | "codex";
  usage: ClaudeUsage | CodexUsage;
  totals: CardTokenTotals;
  rateMeters: CodexRateLimits | null;
  plan: string | null;
}) {
  const accent = `var(--a-${agent})`;
  const tokens = totals.input + totals.output;
  const days = (usage.byDay as Array<DayUsage | CodexDayUsage>).slice(-14).map((d) => ({
    date: d.date,
    tokens: d.totals.input + d.totals.output + cacheTokens(d.totals),
  }));
  const hasRate = rateMeters !== null && hasAnyRate(rateMeters);
  const tone = rateTone(rateMeters);
  const accentBd =
    tone === "warn"
      ? "color-mix(in oklab, var(--wait) 35%, var(--bd))"
      : tone === "over"
        ? "color-mix(in oklab, var(--err) 35%, var(--bd))"
        : "var(--bd)";

  const maxModelTok = Math.max(1, ...usage.byModel.map((m) => modelTokens(m)));

  return (
    <div
      className="ch-card"
      style={{
        padding: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        borderColor: accentBd,
      }}
    >
      {/* header */}
      <div
        style={{
          padding: "13px 16px",
          borderBottom: "1px solid var(--bd-soft)",
          display: "flex",
          alignItems: "center",
          gap: 11,
          flexWrap: "wrap",
        }}
      >
        <AgentGlyph agent={agent} size={24} color={accent} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: "var(--fs-14)", fontWeight: 600, color: "var(--fg-0)" }}>
            {AGENT_META[agent].name}
          </div>
          <div className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-2)" }}>
            {plan ? plan : agent === "claude" ? "subscription / API" : "—"}
          </div>
        </div>
        <StatusBadge status="live">Active</StatusBadge>
        <span style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <HeadStat label="tokens" value={fmtNum(tokens)} />
          <span style={{ width: 1, height: 22, background: "var(--bd-soft)" }} />
          <HeadStat label="turns" value={String(usage.turns)} />
          <span style={{ width: 1, height: 22, background: "var(--bd-soft)" }} />
          <HeadStat label="est cost" value={fmtUsd(usage.estCostUsd)} accent />
        </div>
      </div>

      {/* body: wide tokens/day chart + stats + by-model bars */}
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
        {agent === "codex" && hasRate && rateMeters && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
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
          </div>
        )}

        {days.length >= 1 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div
              className="lbl-soft"
              style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--fs-11)" }}
            >
              <span>tokens / day</span>
              <span style={{ color: "var(--fg-2)" }}>
                last {days.length} day{days.length === 1 ? "" : "s"}
              </span>
            </div>
            <DayChart days={days} color={accent} />
          </div>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
            gap: 14,
          }}
        >
          <UsageStat label="Input" value={fmtNum(totals.input)} />
          <UsageStat label="Output" value={fmtNum(totals.output)} />
          <UsageStat label="Cache" value={fmtNum(totals.cache)} />
          {totals.reasoning !== null ? (
            <UsageStat label="Reasoning" value={fmtNum(totals.reasoning)} />
          ) : (
            <UsageStat label="Tokens" value={fmtNum(tokens)} />
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <div className="lbl">By model</div>
          <ModelBarHead />
          {usage.byModel.map((m) => (
            <ModelBar
              key={m.model}
              model={m.model}
              turns={m.turns}
              tokens={modelTokens(m)}
              priced={m.priced}
              cost={m.estCostUsd}
              max={maxModelTok}
              color={accent}
            />
          ))}
        </div>

        <div
          style={{
            paddingTop: 10,
            borderTop: "1px dashed var(--bd-soft)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            fontSize: "var(--fs-12)",
            color: tone === "over" ? "var(--err)" : tone === "warn" ? "var(--wait)" : "var(--fg-2)",
          }}
        >
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: "var(--fs-11)",
              color: "var(--fg-3)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            forecast
          </span>
          <span>{forecastText(agent, rateMeters)}</span>
          <span style={{ flex: 1 }} />
          <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
            ≈ {fmtUsd(usage.estCostUsd)} est · rates {usage.ratesAsOf}
          </span>
          {usage.unpricedTokens > 0 && (
            <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--wait)" }}>
              · {fmtNum(usage.unpricedTokens)} unpriced excluded
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// A compact label+value pair for the usage-card header (tokens · turns · cost).
function HeadStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }}>
      <span
        className="mono"
        style={{
          fontSize: "var(--fs-11)",
          color: "var(--fg-3)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        {label}
      </span>
      <span
        className="mono tnum"
        style={{
          fontSize: "var(--fs-14)",
          fontWeight: 500,
          color: accent ? "var(--fg-0)" : "var(--fg-1)",
        }}
      >
        {value}
      </span>
    </span>
  );
}

// Wide per-day token bar chart. Columns flex to fill the width (no trailing void
// on sparse data), but each bar is width-capped + centered in its column so two
// days don't become two giant blocks. Height ∝ tokens, opacity ramped so busier
// days read louder; a baseline + max y-label give it scale; labels sit per-column
// so they always align under their bar.
function DayChart({ days, color }: { days: { date: string; tokens: number }[]; color: string }) {
  const max = Math.max(...days.map((d) => d.tokens), 1);
  const PLOT = 104;
  const labelAt = new Set([0, Math.floor((days.length - 1) / 2), days.length - 1]);
  return (
    <div style={{ display: "flex", gap: 8 }}>
      {/* y-axis gutter */}
      <div
        className="mono tnum"
        style={{
          position: "relative",
          width: 34,
          height: PLOT,
          flexShrink: 0,
          fontSize: "var(--fs-10)",
          color: "var(--fg-3)",
        }}
      >
        <span style={{ position: "absolute", top: -3, right: 0 }}>{fmtNum(max)}</span>
        <span style={{ position: "absolute", bottom: -3, right: 0 }}>0</span>
      </div>
      {/* plot + per-column labels */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ position: "relative", height: PLOT }}>
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: 1,
              background: "var(--bd)",
            }}
          />
          <div style={{ position: "absolute", inset: 0, display: "flex", gap: 4 }}>
            {days.map((d) => {
              const r = d.tokens / max;
              return (
                <Tip key={d.date} text={`${d.date} · ${fmtNum(d.tokens)} tokens`}>
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "flex-end",
                      alignItems: "center",
                    }}
                  >
                    <div
                      className="bar-col"
                      style={{
                        width: "100%",
                        maxWidth: 56,
                        height: `${Math.max(2, r * 100)}%`,
                        minHeight: d.tokens > 0 ? 3 : 2,
                        // Lit top → grounded base: a vertical gradient reads more
                        // refined than a flat bar; opacity still ramps with volume.
                        background: `linear-gradient(to top, color-mix(in oklab, ${color} 55%, transparent), ${color})`,
                        opacity: 0.4 + 0.6 * r,
                        borderRadius: "3px 3px 0 0",
                      }}
                    />
                  </div>
                </Tip>
              );
            })}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            gap: 4,
            marginTop: 6,
            fontFamily: "var(--mono)",
            fontSize: "var(--fs-10)",
            color: "var(--fg-3)",
          }}
        >
          {days.map((d, i) => (
            <div key={d.date} style={{ flex: 1, textAlign: "center", minWidth: 0 }}>
              {labelAt.has(i) ? d.date.slice(5) : ""}
            </div>
          ))}
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
        <span className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--fg-1)" }}>
          {label}
          {windowMinutes !== null && (
            <span style={{ color: "var(--fg-3)" }}> · {fmtWindow(windowMinutes)}</span>
          )}
        </span>
        <span style={{ flex: 1 }} />
        <span
          className="mono tnum"
          style={{ fontSize: "var(--fs-13)", color: "var(--fg-0)", fontWeight: 500 }}
        >
          {usedPct.toFixed(usedPct < 10 ? 1 : 0)}%
        </span>
      </div>
      <div style={{ height: 5, background: "var(--bg-3)", borderRadius: 999, overflow: "hidden" }}>
        <div style={{ width: `${pct * 100}%`, height: "100%", background: color }} />
      </div>
      <div className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
        {resetsAt ? `resets ${fmtResets(resetsAt)}` : "no reset time on disk"}
      </div>
    </div>
  );
}

function ModelBarHead() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 0 4px",
        borderBottom: "1px solid var(--bd-soft)",
      }}
    >
      <span className="lbl" style={{ flex: 1 }}>
        model
      </span>
      <span className="lbl" style={{ width: "32%", flexShrink: 0 }}>
        share
      </span>
      <NumCell head>turns</NumCell>
      <NumCell head>tokens</NumCell>
      <NumCell head wide>
        est. cost
      </NumCell>
    </div>
  );
}

// One model's usage as a horizontal proportion bar (share of the agent's biggest
// model), so the by-model breakdown reads as a chart, not a cramped number table.
function ModelBar({
  model,
  turns,
  tokens,
  priced,
  cost,
  max,
  color,
}: {
  model: string;
  turns: number;
  tokens: number;
  priced: boolean;
  cost: number;
  max: number;
  color: string;
}) {
  const r = Math.min(1, tokens / max);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0" }}>
      <Tip text={model}>
        <span
          className="mono"
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--fg-0)",
            fontSize: "var(--fs-12)",
          }}
        >
          {model}
          {!priced && (
            <span style={{ marginLeft: 6, fontSize: "var(--fs-10)", color: "var(--fg-3)" }}>
              unpriced
            </span>
          )}
        </span>
      </Tip>
      <span
        style={{
          width: "32%",
          flexShrink: 0,
          height: 6,
          background: "var(--bg-3)",
          borderRadius: 999,
          overflow: "hidden",
        }}
      >
        <span
          style={{
            display: "block",
            width: `${r * 100}%`,
            height: "100%",
            background: color,
            opacity: 0.42 + 0.58 * r,
            borderRadius: "inherit",
          }}
        />
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
        fontSize: head ? undefined : "var(--fs-12)",
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
      <span className="lbl-soft" style={{ fontSize: "var(--fs-11)" }}>
        {label}
      </span>
      <span
        className="mono tnum"
        style={{ fontSize: "var(--fs-16)", color: "var(--fg-0)", fontWeight: 500 }}
      >
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
}: {
  agent: "claude" | "codex";
  note: string;
  source: string;
  rateNote?: string;
}) {
  const accent = `var(--a-${agent})`;
  return (
    <div className="ch-card" style={{ padding: 0, display: "flex", flexDirection: "column" }}>
      <div
        style={{
          padding: "13px 16px",
          borderBottom: "1px solid var(--bd-soft)",
          display: "flex",
          alignItems: "center",
          gap: 11,
        }}
      >
        <AgentGlyph agent={agent} size={24} color={accent} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: "var(--fs-14)", fontWeight: 600, color: "var(--fg-0)" }}>
            {AGENT_META[agent].name}
          </div>
          <div className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-2)" }}>
            waiting for recorded usage · {source}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <StatusBadge status="idle">Ready</StatusBadge>
      </div>

      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
            gap: 14,
          }}
        >
          <UsageStat label="Input" value="—" />
          <UsageStat label="Output" value="—" />
          <UsageStat label="Cache" value="—" />
          <UsageStat label={agent === "codex" ? "Reasoning" : "Tokens"} value="—" />
        </div>
        <div
          className="mono"
          style={{ fontSize: "var(--fs-12)", color: "var(--fg-2)", lineHeight: 1.5 }}
        >
          {note}
          {rateNote ? ` · ${rateNote}` : ""}
        </div>
      </div>
    </div>
  );
}

function UsageNote({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mono ch-card"
      style={{
        padding: "40px 16px",
        textAlign: "center",
        fontSize: "var(--fs-12)",
        color: "var(--fg-3)",
      }}
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
    return "No on-disk quota windows — token usage is unmetered.";
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
