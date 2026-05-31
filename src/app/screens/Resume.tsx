/**
 * ResumeDrawer — a docked right-side drawer over the live hub (NOT a top-level
 * view), opened from the ActionBar "Resume" button, the command palette, or the
 * launcher's "Resume session" card. Resuming an agent session is per-workspace, so the drawer keeps
 * the hub mounted behind it: you pull a past session back INTO the current tab.
 *
 * Library of past agent conversations read from their on-disk session
 * transcripts. Two real sources, grouped by agent (matching the design):
 *   - Claude Code: claude_sessions, from the on-disk .claude project jsonl files.
 *   - Codex: codex_sessions, from the on-disk .codex rollout jsonl files.
 * Each row is a REAL transcript: its title is the conversation's own first user
 * prompt / ai-title, its branch / turn-count / timestamps are recorded facts,
 * never guessed. Antigravity persists no readable history, so it is omitted.
 *
 * Honesty (binding): the design's drawer rows carry per-session status
 * (paused/awaiting/done/failed), cost, token totals, a "live" dot and a failure
 * reason — CodeHub has no source for any of those on a transcript list (cost/edits
 * live in the per-id session-usage read, one docker exec per row), so they are
 * NOT rendered here rather than fabricated. The row shows what each transcript
 * factually carries: branch, age, turn count, model. The design's dock-left/right
 * toggle is omitted (not half-wired) — the drawer docks right; the ActionBar
 * Resume button / close toggle it.
 *
 * Resume action wires only to what the backend supports (docker.rs:710):
 *   - Claude reopens the exact conversation through the shared spawn dialog
 *     (true restore: the backend runs claude with its --resume flag).
 *   - Codex's createSession has no --resume path, so we honestly spawn a FRESH
 *     Codex session (labelled "New Codex") rather than pretend to restore it.
 */
import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { AgentGlyph } from "../components/primitives/AgentGlyph";
import { IconBtn } from "../components/primitives/IconBtn";
import { SearchInput } from "../components/primitives/SearchInput";
import { Tip } from "../components/primitives/Tip";
import { Ico } from "../components/primitives/icons";
import { slideLeft, slideRight } from "../hooks/useSlideIn";
import type { AgentCli, ClaudeSession, CodexSession } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useOverlay } from "../lib/overlay";
import { useStore } from "../lib/store";
import { Button } from "../ui/button";

// A merged, agent-tagged session row. Both source shapes share these fields, so
// the row renderer is agent-agnostic; only the resume action branches on `agent`.
interface ResumeRow {
  agent: Extract<AgentCli, "claude" | "codex">;
  id: string;
  title: string;
  branch: string | null;
  lastActive: string;
  turns: number;
  model: string | null;
}

// Agent display order + labels. Antigravity is intentionally absent (no readable
// transcript history), so it never renders an empty section.
const AGENT_ORDER: { agent: "claude" | "codex"; label: string }[] = [
  { agent: "claude", label: "Claude Code" },
  { agent: "codex", label: "Codex" },
];

// Time buckets for the filter pills (design resume.jsx All/Today/Week/Older).
// Real, derived from each transcript's lastActive timestamp — disjoint windows
// so the per-bucket counts sum to the All total.
type Bucket = "all" | "today" | "week" | "older";

function bucketOf(iso: string): Exclude<Bucket, "all"> {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "older";
  const days = (Date.now() - t) / 86_400_000;
  if (days < 1) return "today";
  if (days < 7) return "week";
  return "older";
}

export function ResumeDrawer() {
  const open = useOverlay((s) => s.resume);
  const setResume = useOverlay((s) => s.setResume);
  const side = useOverlay((s) => s.resumeSide);
  const setSide = useOverlay((s) => s.setResumeSide);
  const status = useStore((s) => s.status);
  const newAgent = useStore((s) => s.newAgent);
  const state = status?.state ?? "missing";
  const running = state === "running";

  // Both readers polled together (~12s) WHILE the drawer is open: transcripts
  // appear/grow as agents work. Alive-guarded; a failed read resolves that source
  // to [] (honest — "none"), null only while the first read is still in flight.
  const [claude, setClaude] = useState<ClaudeSession[] | null>(null);
  const [codex, setCodex] = useState<CodexSession[] | null>(null);
  const [query, setQuery] = useState("");
  const [bucket, setBucket] = useState<Bucket>("all");

  useEffect(() => {
    if (!open || !running) {
      setClaude(null);
      setCodex(null);
      return;
    }
    let alive = true;
    const tick = () => {
      ipc
        .claudeSessions()
        .then((s) => alive && setClaude(s))
        .catch(() => alive && setClaude([]));
      ipc
        .codexSessions()
        .then((s) => alive && setCodex(s))
        .catch(() => alive && setCodex([]));
    };
    tick();
    const h = setInterval(tick, 12000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [open, running]);

  // Merge + sort newest-first once either source resolves.
  const loading = claude === null || codex === null;
  const all: ResumeRow[] = useMemo(() => {
    const rows: ResumeRow[] = [];
    for (const s of claude ?? []) rows.push({ agent: "claude", ...pick(s) });
    for (const s of codex ?? []) rows.push({ agent: "codex", ...pick(s) });
    rows.sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive));
    return rows;
  }, [claude, codex]);

  // Live substring filter over title + branch (case-insensitive) — a real
  // client-side filter, the design's "filter sessions…" box.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (r) => r.title.toLowerCase().includes(q) || (r.branch?.toLowerCase().includes(q) ?? false),
    );
  }, [all, query]);

  // Per-bucket counts over the query-filtered set, so the pills reflect the
  // current search. All / Today / Week / Older partition the same rows.
  const bucketCounts = useMemo(() => {
    const c = { all: filtered.length, today: 0, week: 0, older: 0 };
    for (const r of filtered) c[bucketOf(r.lastActive)] += 1;
    return c;
  }, [filtered]);

  // Apply the active time bucket on top of the text filter.
  const shown = useMemo(
    () => (bucket === "all" ? filtered : filtered.filter((r) => bucketOf(r.lastActive) === bucket)),
    [filtered, bucket],
  );

  // Group the shown rows by agent, preserving the newest-first order. The
  // section's "showing" count reflects the active filters; the header badge is
  // the true unfiltered total. Sections with no rows after filtering are hidden.
  const sections = useMemo(
    () =>
      AGENT_ORDER.map(({ agent, label }) => ({
        agent,
        label,
        rows: shown.filter((r) => r.agent === agent),
        total: all.filter((r) => r.agent === agent).length,
      })).filter((s) => s.rows.length > 0),
    [shown, all],
  );

  // Claude → true restore via `--resume`. Codex → no backend resume path, so spawn
  // a fresh Codex session honestly (not a restore). Both still go through the
  // shared spawn dialog so account selection is consistent.
  const resume = (row: ResumeRow) => {
    setResume(false);
    // Inline configuring pane (newAgent switches to the Hub). Claude resumes its
    // transcript via --resume; other CLIs have no backend resume path, so they
    // honestly start a fresh session of that agent.
    newAgent(row.agent, row.agent === "claude" ? row.id : undefined);
  };

  if (!open) return null;

  return (
    <motion.aside
      {...(side === "left" ? slideLeft : slideRight)}
      style={{
        width: 350,
        flexShrink: 0,
        background: "var(--bg-1)",
        ...(side === "left"
          ? { borderRight: "1px solid var(--bd-soft)" }
          : { borderLeft: "1px solid var(--bd-soft)" }),
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        color: "var(--fg-1)",
      }}
    >
      {/* header */}
      <div
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--bd-soft)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ display: "inline-flex", color: "var(--fg-1)" }}>{Ico.clock}</span>
        <span style={{ fontSize: "var(--fs-13)", fontWeight: 500, color: "var(--fg-0)" }}>
          Resume session
        </span>
        {!loading && all.length > 0 && (
          <span
            className="mono"
            style={{
              fontSize: "var(--fs-10)",
              color: "var(--fg-3)",
              background: "var(--bg-3)",
              padding: "1px 6px",
              borderRadius: 999,
            }}
          >
            {all.length}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {/* Dock side toggle (design resume.jsx) — flip the drawer left/right. */}
        <div
          style={{
            display: "inline-flex",
            border: "1px solid var(--bd-soft)",
            borderRadius: 4,
            overflow: "hidden",
          }}
        >
          <IconBtn
            title="Dock left"
            active={side === "left"}
            onClick={() => setSide("left")}
            size={22}
            style={{ borderRadius: 0 }}
          >
            {Ico.sidebarL}
          </IconBtn>
          <IconBtn
            title="Dock right"
            active={side === "right"}
            onClick={() => setSide("right")}
            size={22}
            style={{ borderRadius: 0 }}
          >
            {Ico.sidebarR}
          </IconBtn>
        </div>
        <IconBtn title="Close drawer (⌘R)" onClick={() => setResume(false)}>
          {Ico.close}
        </IconBtn>
      </div>

      {/* search */}
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--bd-soft)" }}>
        <SearchInput value={query} onChange={setQuery} placeholder="filter sessions…" />

        {/* Time-bucket pills (design resume.jsx). Counts are real — derived from
            each transcript's lastActive over the current text-filtered set. */}
        <div style={{ display: "flex", gap: 4, marginTop: 8, flexWrap: "wrap" }}>
          <Pill active={bucket === "all"} onClick={() => setBucket("all")}>
            All · {bucketCounts.all}
          </Pill>
          <Pill active={bucket === "today"} onClick={() => setBucket("today")}>
            Today · {bucketCounts.today}
          </Pill>
          <Pill active={bucket === "week"} onClick={() => setBucket("week")}>
            Week · {bucketCounts.week}
          </Pill>
          <Pill active={bucket === "older"} onClick={() => setBucket("older")}>
            Older · {bucketCounts.older}
          </Pill>
        </div>
      </div>

      {/* body — sessions grouped by agent */}
      <div className="scroll" style={{ flex: 1, overflow: "auto", padding: "4px 0 12px" }}>
        {!running ? (
          <Note>Runtime not running — no transcripts to read.</Note>
        ) : loading ? (
          <Note>Reading session transcripts…</Note>
        ) : all.length === 0 ? (
          <Note>
            No past Claude or Codex conversations yet. Sessions appear here once an agent has run.
          </Note>
        ) : filtered.length === 0 ? (
          <Note>No sessions match “{query}”.</Note>
        ) : sections.length === 0 ? (
          <Note>No sessions in this time range.</Note>
        ) : (
          sections.map((sec) => (
            <AgentSection
              key={sec.agent}
              agent={sec.agent}
              label={sec.label}
              showing={sec.rows.length}
              total={sec.total}
            >
              {sec.rows.map((row) => (
                <DrawerRow
                  key={`${row.agent}-${row.id}`}
                  row={row}
                  busy={false}
                  disabled={!running}
                  onResume={() => resume(row)}
                />
              ))}
            </AgentSection>
          ))
        )}
      </div>
    </motion.aside>
  );
}

// Normalize either source shape into the shared row fields.
function pick(s: ClaudeSession | CodexSession) {
  return {
    id: s.id,
    title: s.title,
    branch: s.branch,
    lastActive: s.lastActive,
    turns: s.turns,
    model: s.model,
  };
}

function AgentSection({
  agent,
  label,
  showing,
  total,
  children,
}: {
  agent: "claude" | "codex";
  label: string;
  showing: number;
  total: number;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "6px 14px 5px",
        }}
      >
        <AgentGlyph agent={agent} size={12} color={`var(--a-${agent})`} />
        <span
          className="mono"
          style={{ fontSize: "var(--fs-12)", color: "var(--fg-1)", fontWeight: 500 }}
        >
          {label}
        </span>
        <span className="mono" style={{ fontSize: "var(--fs-10)", color: "var(--fg-3)" }}>
          {showing === total ? `${total}` : `showing ${showing} / ${total}`}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>{children}</div>
    </div>
  );
}

function DrawerRow({
  row,
  busy,
  disabled,
  onResume,
}: {
  row: ResumeRow;
  busy: boolean;
  disabled: boolean;
  onResume: () => void;
}) {
  const age = fmtAge(row.lastActive);
  const accent = `var(--a-${row.agent})`;
  // Codex can't truly restore (no backend `--resume`), so the action is honestly
  // labelled "New Codex" — it spawns a fresh session, it does not reopen this one.
  const action = row.agent === "claude" ? "Resume" : "New Codex";
  return (
    <div
      className="rail-file"
      style={{
        padding: "8px 14px 8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        borderLeft: `2px solid ${accent}`,
        marginLeft: 8,
        borderBottom: "1px solid var(--bd-soft)",
      }}
    >
      {/* row 1 — agent glyph + branch + age */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <AgentGlyph agent={row.agent} size={12} color={accent} />
        {row.branch ? (
          <Tip text={row.branch}>
            <span
              className="mono"
              style={{
                fontSize: "var(--fs-11)",
                color: "var(--fg-2)",
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
                minWidth: 0,
              }}
            >
              <span style={{ display: "inline-flex", color: "var(--fg-3)" }}>{Ico.branch}</span>
              {row.branch}
            </span>
          </Tip>
        ) : (
          <Tip text={row.id}>
            <span
              className="mono tnum"
              style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)", flex: 1, minWidth: 0 }}
            >
              {row.id.slice(0, 8)}
            </span>
          </Tip>
        )}
        {age && (
          <span
            className="mono"
            style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)", flexShrink: 0 }}
          >
            {age}
          </span>
        )}
      </div>

      {/* row 2 — title (2-line clamp) */}
      <Tip text={row.title}>
        <div
          style={{
            fontSize: "var(--fs-12)",
            color: "var(--fg-1)",
            lineHeight: 1.4,
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          {row.title}
        </div>
      </Tip>

      {/* row 3 — turns + model + action */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontFamily: "var(--mono)",
          fontSize: "var(--fs-11)",
          color: "var(--fg-3)",
        }}
      >
        <span className="tnum">
          turns <span style={{ color: "var(--fg-2)" }}>{row.turns}</span>
        </span>
        {row.model && (
          <Tip text={row.model}>
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
              }}
            >
              {row.model}
            </span>
          </Tip>
        )}
        <span style={{ flex: 1 }} />
        <Button size="xs" variant="outline" onClick={onResume} disabled={disabled}>
          {busy ? "Opening…" : action}
        </Button>
      </div>
    </div>
  );
}

// A time-bucket filter pill. Active = filled chip; idle = ghost. (design's
// `.btn xs` / `.btn xs ghost` pair, expressed in our token palette.)
function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mono"
      style={{
        padding: "3px 9px",
        borderRadius: 5,
        fontSize: "var(--fs-11)",
        background: active ? "var(--bg-3)" : "transparent",
        border: `1px solid ${active ? "var(--bd-soft)" : "transparent"}`,
        color: active ? "var(--fg-0)" : "var(--fg-2)",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mono"
      style={{
        padding: "32px 16px",
        textAlign: "center",
        fontSize: "var(--fs-12)",
        color: "var(--fg-3)",
      }}
    >
      {children}
    </div>
  );
}

// Compact relative age from an RFC3339 timestamp: "just now" / "12m ago" / "3h
// ago" / "2d ago". Returns null when the timestamp is missing or unparseable, so
// the row simply omits the age rather than showing a bogus one.
function fmtAge(iso: string): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const secs = Math.floor((Date.now() - t) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}
