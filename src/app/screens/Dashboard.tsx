/**
 * Dashboard — a real, read-only overview of the one shared runtime: the live
 * sessions, the runtime's resource use, and the /workspace git state (status +
 * recent commits). Adapted from design/screens/dashboard.jsx, which assumes a
 * multi-container fleet with per-session token/cost/turn telemetry CodeHub does
 * not track. Rather than fabricate those, this shows only what the backend
 * actually reports — sessions, container_stats, container_git_status,
 * container_git_log — and omits the cost/usage/attention surfaces until there's
 * a real feed for them (BACKEND_PLAN.md). Nothing here is invented.
 *
 * The "Claude tokens" metric is the one usage figure with a real feed: the
 * all-time input+output total summed from Claude's on-disk transcripts (the
 * same claude_usage read that backs the Usage screen, deduped). It's a token
 * COUNT only — cost stays an estimate confined to the Usage screen.
 */
import { AgentGlyph } from "@/app/components/primitives/AgentGlyph";
import { IconBtn } from "@/app/components/primitives/IconBtn";
import { Ico } from "@/app/components/primitives/icons";
import { MODE_BY_ID, SPEC_BY_CLI } from "@/app/lib/catalog";
import {
  type ClaudeUsage,
  type CommitInfo,
  type ContainerStats,
  type GitStatus,
  type SessionInfo,
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

  // Live runtime stats (~2s) + workspace git status (~5s) + recent commits
  // (~10s, they change rarely). Each is a one-shot poll with the same alive
  // guard as the Containers view; a failed read clears to null → honest note.
  const [stats, setStats] = useState<ContainerStats | null>(null);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  // Live tmux sessions (~5s) — joined by name to sessionMeta for the real
  // per-session uptime (`session_created`). null while down / pre-read.
  const [tmux, setTmux] = useState<SessionInfo[] | null>(null);
  // All-time Claude token analytics (~15s — transcripts grow slowly). The token
  // total is factual; cost is omitted here (estimate lives on the Usage screen).
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);

  useEffect(() => {
    if (!running) {
      setStats(null);
      setGit(null);
      setCommits(null);
      setTmux(null);
      setUsage(null);
      return;
    }
    let alive = true;
    const poll = <T,>(fn: () => Promise<T>, set: (v: T | null) => void, ms: number) => {
      const tick = () => {
        fn()
          .then((v) => alive && set(v))
          .catch(() => alive && set(null));
      };
      tick();
      return setInterval(tick, ms);
    };
    const h1 = poll(() => ipc.containerStats(), setStats, 2000);
    const h2 = poll(() => ipc.containerGitStatus(), setGit, 5000);
    const h3 = poll(() => ipc.containerGitLog(12), setCommits, 10000);
    const h4 = poll(() => ipc.listSessions(), setTmux, 5000);
    const h5 = poll(() => ipc.claudeUsage(), setUsage, 15000);
    return () => {
      alive = false;
      clearInterval(h1);
      clearInterval(h2);
      clearInterval(h3);
      clearInterval(h4);
      clearInterval(h5);
    };
  }, [running]);

  // session name → created epoch (seconds), for the per-session uptime.
  const createdBy = new Map((tmux ?? []).map((s) => [s.name, s.created]));

  const open = (session: string) => {
    focusSession(session);
    setView("hub");
  };

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
            {sessions.length} {sessions.length === 1 ? "session" : "sessions"} · runtime {state}
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
        {/* metric row — all real (sessions count + live container_stats + git +
            all-time Claude token total). */}
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
            label="Workspace changes"
            value={git?.isRepo ? String(git.total) : git === null ? null : "—"}
            sub={git?.isRepo && git.branch ? git.branch : undefined}
          />
          <Metric
            label="Claude tokens"
            value={usage ? fmtNum(usage.totals.input + usage.totals.output) : null}
            sub={usage ? "all-time · in+out" : undefined}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 12 }}>
          {/* sessions — real from the store */}
          <div className="ch-card" style={{ padding: 0, minWidth: 0 }}>
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
              <div style={{ padding: "6px 8px" }}>
                {sessions.map(([session, meta]) => {
                  const ws = workspaces.find((w) => w.id === meta.workspaceId);
                  const badge = MODE_BY_ID[meta.mode].badge;
                  const created = createdBy.get(session) ?? 0;
                  const age = created > 0 ? fmtAge(created) : null;
                  return (
                    <div
                      key={session}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px 8px",
                        borderRadius: 6,
                      }}
                      className="rail-file"
                    >
                      <AgentGlyph agent={meta.cli} size={13} color={`var(--a-${meta.cli})`} />
                      <span className="mono" style={{ fontSize: 12, color: "var(--fg-0)" }}>
                        {meta.alias}
                      </span>
                      {badge && <span className={`mode-badge badge-${meta.mode}`}>{badge}</span>}
                      <span style={{ flex: 1 }} />
                      <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-2)" }}>
                        {SPEC_BY_CLI[meta.cli].label}
                        {ws && ` · tab ${ws.plate}`}
                        {age && ` · up ${age}`}
                      </span>
                      <IconBtn title="Open in Hub" onClick={() => open(session)}>
                        {Ico.arrowR}
                      </IconBtn>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* right column — workspace status + recent commits */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
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
      </div>
    </main>
  );
}

function runSub(n: number): string {
  return n === 0 ? "none yet" : "on the shared runtime";
}

// Compact age from a Unix epoch (seconds): "<1m", "12m", "3h", "2d". Coarse on
// purpose — the sessions row only needs a glanceable uptime.
function fmtAge(epochSec: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - epochSec));
  if (s < 60) return "<1m";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Compact token count: 1_234_567 → "1.2M", 12_300 → "12.3K", 540 → "540".
// Mirrors the Usage screen formatter (small, kept local like fmtBytes).
function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) {
    const decimals = n >= 10_000 ? 0 : 1;
    // Rounding can push a high-900Ks value to "1000K"; promote it to M instead.
    if (Number((n / 1_000).toFixed(decimals)) >= 1_000) {
      return `${(n / 1_000_000).toFixed(1)}M`;
    }
    return `${(n / 1_000).toFixed(decimals)}K`;
  }
  return String(n);
}

// Human-readable bytes (binary units), matching the Containers view formatter.
function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "kB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// A dashboard metric. `value === null` → em-dash + hatched bar (no reading yet /
// runtime down). A `fill` (0-100) draws a proportional bar; otherwise a flat one.
function Metric({
  label,
  value,
  sub,
  fill,
}: {
  label: string;
  value?: string | null;
  sub?: string;
  fill?: number | null;
}) {
  return (
    <div
      className="ch-card"
      style={{ padding: 14, display: "flex", flexDirection: "column", gap: 6 }}
    >
      <div className="lbl">{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span
          className="mono tnum"
          style={{ fontSize: 24, fontWeight: 500, color: value ? "var(--fg-0)" : "var(--fg-3)" }}
        >
          {value ?? "—"}
        </span>
        {value && sub && (
          <span className="mono tnum" style={{ fontSize: 11, color: "var(--fg-3)" }}>
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
    <div className="scroll" style={{ maxHeight: 320, overflow: "auto" }}>
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
