/**
 * Dashboard — read-only overview of the shared runtime, laid out to match
 * design/screens/dashboard.jsx exactly: a 5-metric row, a sessions table beside
 * an attention queue + runtime resource card, then an activity chart beside a
 * per-agent token-usage card.
 *
 * The design mocks a multi-container fleet with rich per-row telemetry and a
 * multi-account billing card. CodeHub's reality is ONE shared container, N tmux
 * sessions, no billing API — so each design slot is bound to the closest REAL
 * backend read and the truly-unobtainable sub-fields are dropped (never faked):
 *
 *  - Tokens·24h / Cost·24h / their deltas / the metric sparklines  → real, from
 *    claude_usage.byDay + codex_usage.byDay (per-UTC-day token + est-cost rollups).
 *  - "Context · avg"  → average live contextUsed across Claude sessions, shown as
 *    a token count. The transcript records no window maximum (ipc.ts:319), so the
 *    design's 42% gauge is impossible — the gauge is dropped, the count kept.
 *  - Sessions table: Session/Status real; Task = the session's latest activity
 *    message; Branch = the shared /workspace branch (one repo, not per-row); Turns
 *    + Tokens real for Claude (transcript id), em-dash for Codex/Antigravity; the
 *    per-pane CPU column is dropped (only one container-wide stat exists); $ is
 *    em-dash (no per-session model split). All/Running filter is real; "Mine" is
 *    dropped (single user).
 *  - Right card: real pending_prompts attention queue + ONE runtime resource bar
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
import { Spark } from "@/app/components/primitives/Spark";
import { StatusBadge } from "@/app/components/primitives/StatusBadge";
import type { StatusKey } from "@/app/components/primitives/StatusDot";
import { Ico } from "@/app/components/primitives/icons";
import { MODE_BY_ID } from "@/app/lib/catalog";
import {
  type ActivityEvent,
  type ClaudeUsage,
  type CodexUsage,
  type PendingPrompt,
  type SessionActivity,
  type SessionUsage,
  ipc,
} from "@/app/lib/ipc";
import { useLauncher } from "@/app/lib/launcher";
import { useStore } from "@/app/lib/store";
import { Button } from "@/app/ui/button";
import { useEffect, useState } from "react";

type Filter = "all" | "running";

export function Dashboard() {
  const status = useStore((s) => s.status);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const workspaces = useStore((s) => s.workspaces);
  const focusSession = useStore((s) => s.focusSession);
  const setView = useStore((s) => s.setView);
  const openLaunch = useLauncher((s) => s.open);
  // App-wide polls (single source): runtime stats + /workspace git status.
  const stats = useStore((s) => s.containerStats);
  const git = useStore((s) => s.gitStatus);

  const state = status?.state ?? "missing";
  const running = state === "running";
  const sessions = Object.entries(sessionMeta);

  // Token analytics (~15s — files grow slowly). Counts factual; cost is the
  // backend's estimate, shown verbatim. Live signals (~4s): working/idle, the
  // awaiting-input queue, and the turn-history feed (chart + per-row Task).
  const [claude, setClaude] = useState<ClaudeUsage | null>(null);
  const [codex, setCodex] = useState<CodexUsage | null>(null);
  const [activity, setActivity] = useState<SessionActivity[]>([]);
  const [prompts, setPrompts] = useState<PendingPrompt[]>([]);
  const [history, setHistory] = useState<ActivityEvent[]>([]);
  const [claudeBySession, setClaudeBySession] = useState<Record<string, SessionUsage | null>>({});
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

  const working = activity.filter((a) => a.state === "working").length;

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

      <div className="scroll" style={{ flex: 1, overflow: "auto", padding: 24 }}>
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
          }}
        >
          {/* table */}
          <div className="ch-card" style={{ padding: 0, minWidth: 0, overflow: "hidden" }}>
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
                  padding: "28px 16px",
                  textAlign: "center",
                  fontSize: 11.5,
                  color: "var(--fg-3)",
                }}
              >
                {sessions.length === 0
                  ? "No sessions running. Press ⌘N to start one, or open an existing workspace from the sidebar."
                  : "No sessions match this filter."}
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
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
                        className="rail-file"
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

          {/* attention queue + runtime resource bar (one card, design layout) */}
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
                  padding: "18px 14px",
                  textAlign: "center",
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
                Runtime
              </div>
              {running && stats ? (
                <ResourceBar
                  name={status?.name ?? "—"}
                  cpu={Math.min(100, stats.cpuPct)}
                  mem={stats.memLimit > 0 ? (stats.memUsed / stats.memLimit) * 100 : 0}
                />
              ) : (
                <div className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>
                  {running ? "Reading stats…" : "Runtime not running."}
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
              <Button size="sm" variant="ghost" onClick={() => setView("usage")}>
                Details
              </Button>
            </div>
            <AgentUsageRows claude={claude} codex={codex} running={running} />
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

// ── runtime resource bar (one container, design ContainerBar shape) ──────────

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
      className="ch-card"
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
