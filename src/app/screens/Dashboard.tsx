/**
 * Dashboard — a real, read-only overview of the shared runtime: live sessions,
 * the runtime's resource use, the /workspace git state, an attention queue of
 * sessions awaiting input, an activity chart, and per-agent token usage.
 *
 * Adapted from design/screens/dashboard.jsx, which mocks a multi-container fleet
 * with rich per-row telemetry. This wires the NOW-REAL backend reads instead:
 *
 *  - sessions, container_stats, container_git_status/log  → factual (Tier-1).
 *  - claude_usage + codex_usage (on-disk transcripts / rollout files)  → real
 *    token + turn + session counts; cost is the backend's DERIVED estimate
 *    (model × price table), displayed verbatim, never recomputed here.
 *  - pending_prompts (agent-native hooks, §7)  → the attention queue; Approve/
 *    Deny write the accept/deny keystroke via respond_prompt. Real for Claude/
 *    Codex; Antigravity never emits.
 *  - session_activity_history  → the per-hour activity chart (turns/hour by
 *    agent), bucketed from real prompt-start events.
 *  - session_activity  → the live working/idle dot per row.
 *
 * Honesty contract: absent data → em-dash / honest-empty, never fabricated.
 * Per-row token/cost is only shown for Claude (it carries a transcript id we
 * track per session); Codex/Antigravity rows show em-dash for per-row tokens —
 * their real aggregate lives in the "Token usage" card. No invented numbers.
 */
import { AGENT_META, AgentGlyph } from "@/app/components/primitives/AgentGlyph";
import { IconBtn } from "@/app/components/primitives/IconBtn";
import { StatusBadge } from "@/app/components/primitives/StatusBadge";
import type { StatusKey } from "@/app/components/primitives/StatusDot";
import { Ico } from "@/app/components/primitives/icons";
import { MODE_BY_ID, SPEC_BY_CLI } from "@/app/lib/catalog";
import {
  type ActivityEvent,
  type ClaudeUsage,
  type CodexUsage,
  type CommitInfo,
  type ContainerStats,
  type GitStatus,
  type PendingPrompt,
  type SessionActivity,
  type SessionInfo,
  type SessionUsage,
  ipc,
} from "@/app/lib/ipc";
import { useLauncher } from "@/app/lib/launcher";
import { useStore } from "@/app/lib/store";
import { Button } from "@/app/ui/button";
import { useEffect, useState } from "react";

export function Dashboard() {
  const status = useStore((s) => s.status);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const workspaces = useStore((s) => s.workspaces);
  const focusSession = useStore((s) => s.focusSession);
  const setView = useStore((s) => s.setView);
  const openLaunch = useLauncher((s) => s.open);

  const state = status?.state ?? "missing";
  const running = state === "running";
  const sessions = Object.entries(sessionMeta);

  // Live runtime stats (~2s), workspace git (~5s), recent commits (~10s), tmux
  // sessions (~5s) — the Tier-1 reads. Each is a one-shot poll with an alive
  // guard; a failed read clears to null → honest note.
  const [stats, setStats] = useState<ContainerStats | null>(null);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  const [tmux, setTmux] = useState<SessionInfo[] | null>(null);
  // Real token analytics (~15s — files grow slowly). Both factual; cost is the
  // backend's estimate, shown verbatim. Null while down / pre-read.
  const [claude, setClaude] = useState<ClaudeUsage | null>(null);
  const [codex, setCodex] = useState<CodexUsage | null>(null);
  // Live signals (~4s): working/idle per session + the awaiting-input queue +
  // the turn-history feed (for the chart). All real for Claude/Codex.
  const [activity, setActivity] = useState<SessionActivity[]>([]);
  const [prompts, setPrompts] = useState<PendingPrompt[]>([]);
  const [history, setHistory] = useState<ActivityEvent[]>([]);
  // Per-Claude-session live token tally (keyed by the transcript id we track at
  // create time). Codex/Antigravity have no such per-tmux id → omitted.
  const [claudeBySession, setClaudeBySession] = useState<Record<string, SessionUsage | null>>({});

  useEffect(() => {
    if (!running) {
      setStats(null);
      setGit(null);
      setCommits(null);
      setTmux(null);
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
        () => ipc.containerStats(),
        setStats,
        2000,
        () => setStats(null),
      ),
      poll(
        () => ipc.containerGitStatus(),
        setGit,
        5000,
        () => setGit(null),
      ),
      poll(
        () => ipc.containerGitLog(12),
        setCommits,
        10000,
        () => setCommits(null),
      ),
      poll(
        () => ipc.listSessions(),
        setTmux,
        5000,
        () => setTmux(null),
      ),
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
        setActivity,
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
    return () => {
      alive = false;
      for (const h of handles) clearInterval(h);
    };
  }, [running]);

  // Stable, comma-joined list of Claude transcript ids currently in view — the
  // effect below keys off this string so it only re-subscribes when the set of
  // Claude sessions actually changes (not on every render).
  const claudeIdKey = sessions
    .map(([, m]) => m.claudeId)
    .filter((id): id is string => Boolean(id))
    .join(",");

  // Per-Claude-session token tally, polled lazily for the sessions in view. We
  // read each Claude session's transcript (`claudeId`) on the same slow cadence.
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

  // session name → created epoch (seconds), for per-session uptime.
  const createdBy = new Map((tmux ?? []).map((s) => [s.name, s.created]));
  // session name → live working/idle state.
  const stateBy = new Map(activity.map((a) => [a.session, a.state]));
  // sessions awaiting input right now (keyed by tmux name, mirrors PaneHead).
  const awaitingSet = new Set(prompts.map((p) => p.session));

  // Aggregate token/cost across both real agents (factual counts + the backend's
  // estimated cost). Antigravity contributes nothing — no readable data.
  const claudeTokens = claude ? claude.totals.input + claude.totals.output : 0;
  const codexTokens = codex ? codex.totals.input + codex.totals.output : 0;
  const totalTokens = claudeTokens + codexTokens;
  const haveUsage = claude !== null || codex !== null;
  const totalCost = (claude?.estCostUsd ?? 0) + (codex?.estCostUsd ?? 0);

  const open = (session: string) => {
    focusSession(session);
    setView("hub");
  };

  // Resolve a pending prompt by writing the accept/deny keystroke to its pane.
  // On success, optimistically drop it from the local queue (the next poll
  // reconciles either way); on failure, leave it so the next poll re-shows it.
  const respond = (session: string, allow: boolean) => {
    ipc
      .respondPrompt(session, allow)
      .then(() => setPrompts((prev) => prev.filter((p) => p.session !== session)))
      .catch((e) => console.warn("respond_prompt failed", e));
  };

  const sessionLabel = `${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`;
  const costLabel = haveUsage ? ` · ${fmtUsd(totalCost)} est. today` : "";
  const headerSub = running ? `${sessionLabel}${costLabel}` : `runtime ${state}`;

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
        {/* metric row — all real (sessions + live container_stats + git +
            awaiting-input count + combined Claude/Codex token total). */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(5, 1fr)",
            gap: 12,
            marginBottom: 18,
          }}
        >
          <Metric label="Sessions" value={String(sessions.length)} sub={runSub(sessions.length)} />
          <Metric
            label="Awaiting input"
            value={running ? String(prompts.length) : null}
            sub={awaitingSub(prompts, sessionMeta)}
            accent={prompts.length > 0 ? "wait" : undefined}
          />
          <Metric
            label="Runtime CPU"
            value={stats ? `${stats.cpuPct.toFixed(1)}%` : null}
            fill={stats ? Math.min(100, stats.cpuPct) : null}
          />
          <Metric
            label="Runtime memory"
            value={stats ? fmtBytes(stats.memUsed) : null}
            sub={stats && stats.memLimit > 0 ? `/ ${fmtBytes(stats.memLimit)}` : undefined}
            fill={stats && stats.memLimit > 0 ? (stats.memUsed / stats.memLimit) * 100 : null}
          />
          <Metric
            label="Tokens"
            value={haveUsage ? fmtNum(totalTokens) : null}
            sub={haveUsage ? "all-time · in+out" : undefined}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 12 }}>
          {/* sessions table — real from the store, joined to live activity +
              per-Claude-session token tally. */}
          <div className="ch-card" style={{ padding: 0, minWidth: 0, overflow: "hidden" }}>
            <div
              style={{
                padding: "12px 16px",
                borderBottom: "1px solid var(--bd-soft)",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-0)" }}>Sessions</span>
              <span style={{ flex: 1 }} />
              <span className="mono tnum" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                {sessions.length}
              </span>
            </div>
            {sessions.length === 0 ? (
              <div
                className="mono"
                style={{
                  padding: "28px 16px",
                  textAlign: "center",
                  fontSize: 11.5,
                  color: "var(--fg-3)",
                }}
              >
                No sessions running. Press ⌘N to start one.
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr>
                    <Th>Session</Th>
                    <Th>Status</Th>
                    <Th>Workspace</Th>
                    <Th align="right">Turns</Th>
                    <Th align="right">Tokens</Th>
                    <Th align="right">$ est.</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {sessions.map(([session, meta]) => {
                    const ws = workspaces.find((w) => w.id === meta.workspaceId);
                    const badge = MODE_BY_ID[meta.mode].badge;
                    const created = createdBy.get(session) ?? 0;
                    const age = created > 0 ? fmtAge(created) : null;
                    const awaiting = awaitingSet.has(session);
                    const working = stateBy.get(session) === "working";
                    const st: StatusKey = awaiting ? "wait" : working ? "live" : "idle";
                    // Per-row tokens/turns/cost: real for Claude (transcript id),
                    // em-dash for Codex/Antigravity (no per-tmux id to join).
                    const su = meta.claudeId ? claudeBySession[meta.claudeId] : undefined;
                    const rowTokens =
                      meta.cli === "claude" && su ? su.tokensIn + su.tokensOut : null;
                    const rowTurns = meta.cli === "claude" && su ? su.turns : null;
                    return (
                      <tr
                        key={session}
                        style={{
                          borderBottom: "1px solid var(--bd-soft)",
                          cursor: "pointer",
                        }}
                        className="rail-file"
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
                          <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>
                            {SPEC_BY_CLI[meta.cli].label}
                            {ws && ` · tab ${ws.plate}`}
                            {age && ` · up ${age}`}
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
                          {/* Per-session cost is not derivable from the live
                              tally (no per-model split) — honest em-dash; the
                              aggregate estimate is in the Token usage card. */}
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

          {/* right column — attention queue + workspace + recent commits */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <AttentionQueue
              prompts={prompts}
              sessionMeta={sessionMeta}
              running={running}
              onRespond={respond}
              onOpen={open}
            />

            <div className="ch-card" style={{ padding: 14, minWidth: 0 }}>
              <div className="lbl" style={{ marginBottom: 10 }}>
                Workspace
              </div>
              <WorkspaceSummary git={git} running={running} />
            </div>

            <div className="ch-card" style={{ padding: 0, minWidth: 0 }}>
              <div
                style={{
                  padding: "10px 14px",
                  borderBottom: "1px solid var(--bd-soft)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span className="lbl">Recent commits</span>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                  git log /workspace
                </span>
              </div>
              <Commits commits={commits} running={running} isRepo={git?.isRepo ?? null} />
            </div>
          </div>
        </div>

        {/* bottom: activity chart + per-agent token usage */}
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

function runSub(n: number): string {
  return n === 0 ? "none yet" : "on the shared runtime";
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

// A row's numeric cell is bright when it has a real value, faint when em-dashed.
function cellColor(v: number | null): string {
  return v !== null ? "var(--fg-1)" : "var(--fg-3)";
}

// ── attention queue ─────────────────────────────────────────────────────────

function AttentionQueue({
  prompts,
  sessionMeta,
  running,
  onRespond,
  onOpen,
}: {
  prompts: PendingPrompt[];
  sessionMeta: Record<string, { cli: string; alias: string }>;
  running: boolean;
  onRespond: (session: string, allow: boolean) => void;
  onOpen: (session: string) => void;
}) {
  return (
    <div className="ch-card" style={{ padding: 0, minWidth: 0, overflow: "hidden" }}>
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
        <span className="lbl">Needs attention</span>
        <span style={{ flex: 1 }} />
        <span className="mono tnum" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
          {prompts.length}
        </span>
      </div>
      {prompts.length === 0 ? (
        <div
          className="mono"
          style={{ padding: "18px 14px", textAlign: "center", fontSize: 11, color: "var(--fg-3)" }}
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
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
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
                    onClick={() => onRespond(p.session, true)}
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
                    onClick={() => onRespond(p.session, false)}
                  >
                    Deny
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    style={{ justifyContent: "center" }}
                    onClick={() => onOpen(p.session)}
                  >
                    Open
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── activity chart ──────────────────────────────────────────────────────────

// 24 hourly buckets of turns/hour, split Claude vs Codex, from the real
// activity-history feed (prompt_submit = one turn boundary). Antigravity never
// emits hook events, so it's honestly absent (no third series). Empty history
// (no events captured yet) → honest empty note rather than a flat fake chart.
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
  // 24 buckets, index 0 = 23h ago … 23 = current hour.
  const claude = new Array(24).fill(0);
  const codex = new Array(24).fill(0);
  let any = false;
  for (const e of history) {
    if (e.kind !== "prompt_submit") continue; // count turn starts only
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
              title={`${String(i === 23 ? hourLabel(now) : hourLabel(now - (23 - i) * 3600000))} · claude ${c} · codex ${x}`}
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

// One row per agent with real on-disk data (Claude, Codex). Antigravity is
// listed but honestly marked "not installed" — never a fabricated bar.
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
      {/* Antigravity: not installed in the runtime image → no readable data. */}
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

// ── table cells ─────────────────────────────────────────────────────────────

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

// Branch + ahead/behind + changed-file count, or an honest one-liner.
function WorkspaceSummary({ git, running }: { git: GitStatus | null; running: boolean }) {
  if (git === null) {
    return <Note>{running ? "Reading workspace…" : "Runtime not running."}</Note>;
  }
  if (!git.isRepo) {
    return <Note>/workspace is not a git repository.</Note>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ flexShrink: 0, color: "var(--fg-2)" }}>{Ico.branch}</span>
        <span
          className="mono"
          style={{
            fontSize: 12,
            color: "var(--fg-0)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {git.branch ?? "(detached)"}
        </span>
        {git.ahead > 0 && (
          <span className="mono tnum" style={{ fontSize: 11, color: "var(--live)" }}>
            ↑{git.ahead}
          </span>
        )}
        {git.behind > 0 && (
          <span className="mono tnum" style={{ fontSize: 11, color: "var(--wait)" }}>
            ↓{git.behind}
          </span>
        )}
      </div>
      <div className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>
        {git.total === 0
          ? "Working tree clean."
          : `${git.total} changed ${git.total === 1 ? "file" : "files"}`}
      </div>
    </div>
  );
}

// The recent-commit list, or an honest one-liner per non-list state.
function Commits({
  commits,
  running,
  isRepo,
}: {
  commits: CommitInfo[] | null;
  running: boolean;
  isRepo: boolean | null;
}) {
  if (commits === null) {
    return <Note pad>{running ? "Reading commits…" : "Runtime not running."}</Note>;
  }
  if (commits.length === 0) {
    return <Note pad>{isRepo === false ? "Not a git repository." : "No commits yet."}</Note>;
  }
  return (
    <div className="scroll" style={{ maxHeight: 240, overflow: "auto" }}>
      {commits.map((c) => (
        <div
          key={c.hash}
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 10,
            padding: "7px 14px",
            borderBottom: "1px solid var(--bd-soft)",
          }}
        >
          <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)", flexShrink: 0 }}>
            {c.hash.slice(0, 7)}
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 11.5,
              color: "var(--fg-1)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={`${c.subject} — ${c.author}`}
          >
            {c.subject}
          </span>
          <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", flexShrink: 0 }}>
            {c.relative}
          </span>
        </div>
      ))}
    </div>
  );
}

function Note({ children, pad }: { children: React.ReactNode; pad?: boolean }) {
  return (
    <div
      className="mono"
      style={{
        padding: pad ? "28px 14px" : 0,
        textAlign: pad ? "center" : "left",
        fontSize: 11.5,
        color: "var(--fg-3)",
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

// A dashboard metric. `value === null` → em-dash + hatched bar (no reading yet /
// runtime down). A `fill` (0-100) draws a proportional bar; otherwise a flat one.
// `accent` tints the value + sub when the metric warrants attention (e.g. wait).
function Metric({
  label,
  value,
  sub,
  fill,
  accent,
}: {
  label: string;
  value?: string | null;
  sub?: string;
  fill?: number | null;
  accent?: "wait" | "live";
}) {
  const accentColor = accent === "wait" ? "var(--wait)" : accent === "live" ? "var(--live)" : null;
  return (
    <div
      className="ch-card"
      style={{ padding: 14, display: "flex", flexDirection: "column", gap: 6 }}
    >
      <div className="lbl">{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span
          className="mono tnum"
          style={{
            fontSize: 24,
            fontWeight: 500,
            color: value ? (accentColor ?? "var(--fg-0)") : "var(--fg-3)",
          }}
        >
          {value ?? "—"}
        </span>
        {value && sub && (
          <span className="mono tnum" style={{ fontSize: 11, color: accentColor ?? "var(--fg-3)" }}>
            {sub}
          </span>
        )}
      </div>
      {typeof fill === "number" && value ? (
        <div
          style={{ height: 4, borderRadius: 999, background: "var(--bg-3)", overflow: "hidden" }}
        >
          <div
            style={{
              height: "100%",
              width: `${Math.max(2, Math.min(100, fill))}%`,
              background: "var(--live)",
              opacity: 0.6,
            }}
          />
        </div>
      ) : (
        <div
          style={{
            height: 4,
            borderRadius: 999,
            background: value
              ? "var(--bg-3)"
              : "repeating-linear-gradient(45deg, var(--bg-3) 0 6px, transparent 6px 12px)",
            opacity: value ? 1 : 0.5,
          }}
        />
      )}
      {!sub && <div style={{ height: 14 }} />}
    </div>
  );
}

// ── formatters ──────────────────────────────────────────────────────────────

// Compact age from a Unix epoch (seconds): "<1m", "12m", "3h", "2d".
function fmtAge(epochSec: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - epochSec));
  if (s < 60) return "<1m";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Compact "time since" from an epoch-ms instant (the prompt was raised).
function fmtSince(epochMs: number): string {
  const s = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
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

// Human-readable bytes (binary units), matching the Containers view formatter.
function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "kB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
