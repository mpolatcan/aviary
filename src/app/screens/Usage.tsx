/**
 * Usage — real token analytics across the agents that persist on-disk session
 * data: Claude Code (transcripts) and Codex (rollout files). Adapted from
 * design/screens/usage.jsx, which mocks a multi-account billing/subscription
 * view (monthly $ budgets, seats, RPM caps, renewal dates). None of that is
 * readable without a provider billing API, so it is honestly marked "Coming
 * soon" rather than fabricated.
 *
 * WHAT IS REAL here:
 *  - Claude:  claude_usage  — token/turn/session counts (factual), per-model and
 *    per-day rollups, and the backend's DERIVED cost estimate (model × price
 *    table; shown verbatim, never recomputed, always labelled "estimated").
 *  - Codex:   codex_usage   — same, with Codex's own token split (input /
 *    cached-input / output / reasoning-output).
 *  - Codex:   codex_rate_limits — the ONE on-disk quota source. The latest
 *    rollout line's rate_limits (primary/secondary used_percent + window +
 *    resets_at) + plan_type → real quota meters with NO billing API. Claude has
 *    no on-disk equivalent, so its rate windows stay "Coming soon".
 *  - Antigravity: not installed in the runtime image → no readable data; listed
 *    honestly, never charted.
 *
 * Honesty contract: every token/turn/session count is factual; cost is an
 * estimate (dated, with unpriced-token volume called out); absent → em-dash /
 * "Coming soon" / "not installed". No invented totals.
 */
import { AGENT_META, AgentGlyph } from "@/app/components/primitives/AgentGlyph";
import { Segmented } from "@/app/components/primitives/Segmented";
import { Spark } from "@/app/components/primitives/Spark";
import { StatusBadge } from "@/app/components/primitives/StatusBadge";
import { Tag } from "@/app/components/primitives/Tag";
import { Ico } from "@/app/components/primitives/icons";
import {
  type ClaudeUsage,
  type CodexRateLimits,
  type CodexUsage,
  type DayUsage,
  ipc,
} from "@/app/lib/ipc";
import { useLauncher } from "@/app/lib/launcher";
import { useStore } from "@/app/lib/store";
import { Button } from "@/app/ui/button";
import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from "react";

type AgentFilter = "all" | "claude" | "codex";

export function Usage() {
  const status = useStore((s) => s.status);
  const openLaunch = useLauncher((s) => s.open);
  const state = status?.state ?? "missing";
  const running = state === "running";

  const [filter, setFilter] = useState<AgentFilter>("all");

  // One-shot polls (~10s). Each clears to null on failure (honest note). Claude
  // + Codex token analytics and Codex's on-disk rate-limit meters.
  const [claude, setClaude] = useState<ClaudeUsage | null>(null);
  const [codex, setCodex] = useState<CodexUsage | null>(null);
  const [rates, setRates] = useState<CodexRateLimits | null>(null);
  useEffect(() => {
    if (!running) {
      setClaude(null);
      setCodex(null);
      setRates(null);
      return;
    }
    let alive = true;
    const poll = <T,>(fn: () => Promise<T | null>, set: Dispatch<SetStateAction<T | null>>) => {
      const tick = () => {
        fn()
          .then((v) => {
            if (alive) set(v);
          })
          .catch(() => {
            if (alive) set(null);
          });
      };
      tick();
      return setInterval(tick, 10000);
    };
    const h1 = poll(() => ipc.claudeUsage(), setClaude);
    const h2 = poll(() => ipc.codexUsage(), setCodex);
    const h3 = poll(() => ipc.codexRateLimits(), setRates);
    return () => {
      alive = false;
      clearInterval(h1);
      clearInterval(h2);
      clearInterval(h3);
    };
  }, [running]);

  const claudeHas = claude !== null && claude.turns > 0;
  const codexHas = codex !== null && codex.turns > 0;

  // Aggregate real figures for the summary strip.
  const totalTokens =
    (claude ? claude.totals.input + claude.totals.output : 0) +
    (codex ? codex.totals.input + codex.totals.output : 0);
  const totalTurns = (claude?.turns ?? 0) + (codex?.turns ?? 0);
  const totalCost = (claude?.estCostUsd ?? 0) + (codex?.estCostUsd ?? 0);
  const totalSessions = (claude?.sessions ?? 0) + (codex?.sessions ?? 0);
  const avgPerTurn = totalTurns > 0 ? totalCost / totalTurns : 0;

  // CSV export from the real per-day rollups (both agents, merged by date).
  const exportCsv = useMemo(() => makeCsvExporter(claude, codex), [claude, codex]);

  const showClaude = filter === "all" || filter === "claude";
  const showCodex = filter === "all" || filter === "codex";

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
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 14 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em" }}>
            Usage
          </h1>
          <span className="mono" style={{ fontSize: 12, color: "var(--fg-2)" }}>
            {running
              ? `${totalSessions} sessions · ${totalTurns} turns · ${fmtUsd(totalCost)} est.`
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
          <Button size="sm" onClick={() => openLaunch("newtab")}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {Ico.plus}New agent
            </span>
          </Button>
        </div>

        {/* aggregate strip — all real */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <SummaryCell
            label="tokens · all-time"
            value={running ? fmtNum(totalTokens) : "—"}
            subtle={running ? "input + output · Claude + Codex" : "runtime not running"}
          />
          <SummaryCell
            label="turns · all-time"
            value={running ? String(totalTurns) : "—"}
            subtle={
              running && totalTurns > 0 ? `${fmtUsd(avgPerTurn)} est. avg / turn` : "no turns yet"
            }
          />
          <SummaryCell
            label="est. cost · all-time"
            value={running ? `≈ ${fmtUsd(totalCost)}` : "—"}
            subtle="estimate — not billed"
          />
          <SummaryCell
            label="codex quota"
            value={running ? rateHeadline(rates) : "—"}
            subtle={running ? rateHeadlineSub(rates) : "runtime not running"}
            tone={rateTone(rates)}
          />
        </div>
      </div>

      {/* filter row */}
      <div
        style={{
          padding: "10px 28px",
          borderBottom: "1px solid var(--bd-soft)",
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: "var(--bg-1)",
        }}
      >
        <Segmented<AgentFilter>
          value={filter}
          onChange={setFilter}
          options={[
            { key: "all", label: "All" },
            { key: "claude", label: "Claude" },
            { key: "codex", label: "Codex" },
          ]}
        />
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>
          token counts factual · cost estimated
        </span>
      </div>

      <div
        className="scroll"
        style={{
          flex: 1,
          overflow: "auto",
          padding: "20px 28px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {!running ? (
          <Note>Runtime not running — no usage data to read.</Note>
        ) : claude === null && codex === null ? (
          <Note>Reading session transcripts…</Note>
        ) : (
          <>
            {showClaude &&
              (claudeHas ? (
                <AgentUsageCard
                  agent="claude"
                  usage={claude as ClaudeUsage}
                  totals={claudeTotalsToCard(claude as ClaudeUsage)}
                  rateMeters={null}
                />
              ) : (
                <EmptyAgentCard
                  agent="claude"
                  note={
                    claude === null
                      ? "Reading transcripts…"
                      : "No Claude turns recorded yet. Usage appears once an agent responds."
                  }
                />
              ))}

            {showCodex &&
              (codexHas ? (
                <AgentUsageCard
                  agent="codex"
                  usage={codex as CodexUsage}
                  totals={codexTotalsToTokenTotals(codex as CodexUsage)}
                  rateMeters={rates}
                />
              ) : (
                <EmptyAgentCard
                  agent="codex"
                  note={
                    codex === null
                      ? "Reading rollout files…"
                      : "No Codex turns recorded yet. Usage appears once an agent responds."
                  }
                />
              ))}

            {/* Antigravity — not installed → honest, never charted. */}
            {filter === "all" && (
              <div
                className="ch-card"
                style={{
                  padding: "14px 18px",
                  display: "flex",
                  alignItems: "center",
                  gap: 11,
                  opacity: 0.7,
                }}
              >
                <AgentGlyph agent="antigravity" size={20} color="var(--a-antigravity)" />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, color: "var(--fg-1)" }}>
                    {AGENT_META.antigravity.name}
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>
                    Not installed in the runtime image — no readable usage data.
                  </div>
                </div>
                <Tag>not installed</Tag>
              </div>
            )}

            {/* Subscription / billing — honestly deferred. */}
            {filter === "all" && <ComingSoon />}
          </>
        )}

        {/* rate transparency footer — the prices the estimate used. */}
        {(claudeHas || codexHas) && <RatesFooter claude={claude} codex={codex} />}
      </div>
    </main>
  );
}

// ── per-agent usage card ────────────────────────────────────────────────────

interface CardTokenTotals {
  input: number;
  output: number;
  cache: number;
  reasoning: number | null; // Codex-only; null for Claude
}

function AgentUsageCard({
  agent,
  usage,
  totals,
  rateMeters,
}: {
  agent: "claude" | "codex";
  usage: ClaudeUsage | CodexUsage;
  totals: CardTokenTotals;
  rateMeters: CodexRateLimits | null;
}) {
  const tokens = totals.input + totals.output;
  // last-13-days sparkline of total tokens/day, oldest→newest (Spark expects it).
  const spark = usage.byDay
    .slice(-13)
    .map((d) => d.totals.input + d.totals.output + d.totals.cacheRead + d.totals.cacheCreation);

  return (
    <div className="ch-card" style={{ padding: 0, display: "flex", overflow: "hidden" }}>
      {/* LEFT — identity + sparkline */}
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
              {usage.sessions} sessions · {usage.turns} turns
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

      {/* CENTER — meters + breakdown */}
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
        {/* Codex rate meters — the ONE real on-disk quota source. */}
        {agent === "codex" && rateMeters && hasAnyRate(rateMeters) && (
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
            <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
              plan <span style={{ color: "var(--fg-1)" }}>{rateMeters.planType ?? "—"}</span> · from
              the latest rollout line
            </div>
            <div style={{ height: 1, background: "var(--bd-soft)" }} />
          </div>
        )}

        {/* token breakdown — factual */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
          <Stat label="Input" value={fmtNum(totals.input)} />
          <Stat label="Output" value={fmtNum(totals.output)} />
          <Stat label="Cache" value={fmtNum(totals.cache)} />
          {totals.reasoning !== null ? (
            <Stat label="Reasoning" value={fmtNum(totals.reasoning)} />
          ) : (
            <Stat label="Tokens" value={fmtNum(tokens)} />
          )}
        </div>

        {/* per-model rollup */}
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

        {/* estimate footer */}
        <div
          style={{
            marginTop: "auto",
            padding: "10px 0 0",
            borderTop: "1px dashed var(--bd-soft)",
            display: "flex",
            alignItems: "baseline",
            gap: 10,
            flexWrap: "wrap",
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
            est. cost
          </span>
          <span
            className="mono tnum"
            style={{ fontSize: 16, fontWeight: 500, color: "var(--fg-0)" }}
          >
            ≈ {fmtUsd(usage.estCostUsd)}
          </span>
          <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
            rates as of {usage.ratesAsOf}
          </span>
          {usage.unpricedTokens > 0 && (
            <span className="mono" style={{ fontSize: 10.5, color: "var(--wait)" }}>
              · {fmtNum(usage.unpricedTokens)} unpriced tokens excluded
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// One quota meter from Codex's on-disk rate_limits. Every field nullable →
// em-dash when absent; never a fabricated used/max.
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
  // A meter line with no used_percent carries no signal — skip it entirely
  // rather than render an empty bar.
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
      <span className="lbl" style={{ flex: 1 }}>
        model
      </span>
      <NumCell head>turns</NumCell>
      <NumCell head>tokens</NumCell>
      <NumCell head wide>
        est. cost
      </NumCell>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="lbl-soft">{label}</span>
      <span className="mono tnum" style={{ fontSize: 16, color: "var(--fg-0)", fontWeight: 500 }}>
        {value}
      </span>
    </div>
  );
}

// An agent with a real reader but no recorded turns yet — honest empty, not a
// fabricated card.
function EmptyAgentCard({ agent, note }: { agent: "claude" | "codex"; note: string }) {
  return (
    <div
      className="ch-card"
      style={{ padding: "14px 18px", display: "flex", alignItems: "center", gap: 11 }}
    >
      <AgentGlyph agent={agent} size={20} color={`var(--a-${agent})`} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, color: "var(--fg-1)" }}>{AGENT_META[agent].name}</div>
        <div className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>
          {note}
        </div>
      </div>
    </div>
  );
}

// Subscription / billing surfaces from the design that need a provider billing
// API — honestly deferred rather than mocked.
function ComingSoon() {
  return (
    <div
      className="ch-card"
      style={{
        padding: "14px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        borderStyle: "dashed",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-1)" }}>
          Subscriptions &amp; budgets
        </span>
        <Tag>coming soon</Tag>
      </div>
      <div className="mono" style={{ fontSize: 11, color: "var(--fg-3)", lineHeight: 1.6 }}>
        Plan billing, monthly $ budgets, team seats and RPM caps need a provider billing API.
        CodeHub reads no billing data — these stay omitted rather than estimated. Codex's on-disk
        rate windows above are the one quota source that is real.
      </div>
    </div>
  );
}

// ── summary cell ────────────────────────────────────────────────────────────

function SummaryCell({
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
      className="ch-card"
      style={{ padding: 14, display: "flex", flexDirection: "column", gap: 6 }}
    >
      <div className="lbl">{label}</div>
      <span
        className="mono tnum"
        style={{ fontSize: 22, color: valueColor, fontWeight: 500, letterSpacing: "-0.02em" }}
      >
        {value}
      </span>
      <div className="mono" style={{ fontSize: 11, color: subColor }}>
        {subtle}
      </div>
    </div>
  );
}

// Rate transparency footer — the per-model prices the estimate used.
function RatesFooter({
  claude,
  codex,
}: {
  claude: ClaudeUsage | null;
  codex: CodexUsage | null;
}) {
  // De-dupe rate families across both agents (they may share entries).
  const seen = new Set<string>();
  const all = [...(claude?.rates ?? []), ...(codex?.rates ?? [])].filter((r) => {
    if (seen.has(r.family)) return false;
    seen.add(r.family);
    return true;
  });
  if (all.length === 0) return null;
  const asOf = claude?.ratesAsOf ?? codex?.ratesAsOf ?? "";
  return (
    <div
      className="mono"
      style={{ marginTop: 4, fontSize: 10.5, color: "var(--fg-3)", lineHeight: 1.7 }}
    >
      Estimate rates (USD per million tokens, as of {asOf}):{" "}
      {all.map((r, i) => (
        <span key={r.family}>
          {i > 0 && " · "}
          {r.family} {fmtRate(r.inputPerMtok)}/{fmtRate(r.outputPerMtok)} in/out
        </span>
      ))}
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

// ── data helpers ────────────────────────────────────────────────────────────

// Collapse a ClaudeUsage's TokenTotals into the card shape (no reasoning split).
function claudeTotalsToCard(u: ClaudeUsage): CardTokenTotals {
  return {
    input: u.totals.input,
    output: u.totals.output,
    cache: u.totals.cacheRead + u.totals.cacheCreation,
    reasoning: null,
  };
}

// Collapse a CodexUsage's split totals into the card shape (with reasoning).
function codexTotalsToTokenTotals(u: CodexUsage): CardTokenTotals {
  return {
    input: u.totals.input,
    output: u.totals.output,
    cache: u.totals.cachedInput,
    reasoning: u.totals.reasoningOutput,
  };
}

// Per-model token total, works for either agent's model shape.
function modelTokens(m: ClaudeUsage["byModel"][number] | CodexUsage["byModel"][number]): number {
  if ("cacheRead" in m.totals) {
    return m.totals.input + m.totals.output + m.totals.cacheRead + m.totals.cacheCreation;
  }
  return m.totals.input + m.totals.output + m.totals.cachedInput + m.totals.reasoningOutput;
}

function hasAnyRate(r: CodexRateLimits): boolean {
  return r.primaryUsedPct !== null || r.secondaryUsedPct !== null;
}

// Headline figure for the summary strip's Codex quota cell.
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

// Build a CSV-download click handler from the real per-day rollups. Merges
// Claude + Codex by date; cost is the estimate (labelled in the header row).
function makeCsvExporter(claude: ClaudeUsage | null, codex: CodexUsage | null): () => void {
  return () => {
    const rows: string[] = ["date,agent,input_tokens,output_tokens,cache_tokens,est_cost_usd"];
    const add = (agent: string, days: DayUsage[]) => {
      for (const d of days) {
        const cache = d.totals.cacheRead + d.totals.cacheCreation;
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

// ── formatters ──────────────────────────────────────────────────────────────

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

// Rate like "$15" or "$3.75" (trailing-zero-trimmed).
function fmtRate(n: number): string {
  return `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

// Window length: minutes → "3h" / "5h" / "45m" / "7d".
function fmtWindow(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes >= 60) return `${(minutes / 60).toFixed(1)}h`;
  return `${minutes}m`;
}

// A reset instant (RFC3339 string OR an epoch-seconds string) → "in 02:14",
// "in 3d", or the raw value if unparseable. Honest about what's on disk.
function fmtResets(resetsAt: string): string {
  let ms: number;
  const asNum = Number(resetsAt);
  if (Number.isFinite(asNum) && resetsAt.trim() !== "") {
    // epoch seconds (Codex writes these) — or ms if very large.
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
