import { useEffect, useState } from "react";
import { StatusDot } from "../../components/primitives/StatusDot";
import { type ContainerState, type ContainerStats, ipc } from "../../lib/ipc";
import { activeWorkspace, useStore } from "../../lib/store";
import { leavesList } from "../../lib/tree";

// Bottom status bar, ported from design/screens/main-hub-a.jsx (tabs) and
// main-hub-b.jsx (the compare grid). Runtime state, focused session and tab are
// real; cpu / mem / net are live from `container_stats` (polled ~2s while the
// runtime is up, em-dash before the first read or when down). The grid variant
// summarises every session's running/awaiting state (real, from session_activity
// + pending_prompts) instead of the single focused session.
const STATE_LABEL: Record<ContainerState, string> = {
  missing: "no runtime",
  stopped: "stopped",
  starting: "waking",
  running: "running",
  unreachable: "unreachable",
};

const STATE_COLOR: Record<ContainerState, string> = {
  missing: "var(--fg-3)",
  stopped: "var(--fg-3)",
  starting: "var(--wait)",
  running: "var(--live)",
  unreachable: "var(--err)",
};

const STATS_POLL_MS = 2000;

function fmtGiB(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

// Live cpu/mem/net snapshot, shared by both variants. Returns null until the
// runtime is up + the first poll lands.
function useRuntimeStats(): ContainerStats | null {
  const running = useStore((s) => s.status?.state === "running");
  const [stats, setStats] = useState<ContainerStats | null>(null);
  useEffect(() => {
    if (!running) {
      setStats(null);
      return;
    }
    let alive = true;
    const tick = () => {
      ipc
        .containerStats()
        .then((s) => alive && setStats(s))
        .catch(() => alive && setStats(null));
    };
    tick();
    const h = setInterval(tick, STATS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [running]);
  return stats;
}

const barStyle: React.CSSProperties = {
  height: 26,
  flexShrink: 0,
  background: "var(--bg-0)",
  borderTop: "1px solid var(--bd-soft)",
  display: "flex",
  alignItems: "center",
  padding: "0 12px",
  gap: 14,
  fontFamily: "var(--mono)",
  fontSize: 11,
  color: "var(--fg-2)",
};

export function HubStatusBar({ variant = "tabs" }: { variant?: "tabs" | "grid" }) {
  return variant === "grid" ? <GridStatusBar /> : <TabsStatusBar />;
}

function TabsStatusBar() {
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const active = useStore(activeWorkspace);
  const focused = active?.focused ?? null;
  const focusedAlias = useStore((s) => (focused ? s.sessionMeta[focused]?.alias : undefined));
  const stats = useRuntimeStats();

  const state: ContainerState = error ? "unreachable" : (status?.state ?? "starting");

  return (
    <div style={barStyle}>
      <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <span
          style={{ width: 6, height: 6, borderRadius: "50%", background: STATE_COLOR[state] }}
        />
        <span style={{ color: "var(--fg-1)" }}>{STATE_LABEL[state]}</span>
      </span>
      <span>session {focusedAlias ?? "—"}</span>
      <span>tab {active ? active.plate : "—"}</span>
      <span className="tnum" title="CPU">
        cpu {stats ? `${stats.cpuPct.toFixed(0)}%` : "—"}
      </span>
      <span className="tnum" title="Memory">
        mem{" "}
        {stats && stats.memLimit > 0
          ? `${fmtGiB(stats.memUsed)}/${fmtGiB(stats.memLimit)} GiB`
          : stats
            ? `${fmtGiB(stats.memUsed)} GiB`
            : "—"}
      </span>
      <span className="tnum" title="Network">
        net {stats ? `↓${(stats.netRx / 1024).toFixed(0)} KB` : "—"}
      </span>
      <span style={{ flex: 1 }} />
      <span>⌘N new</span>
      <span>⌘\ split</span>
      <span>⌘1–9 jump</span>
    </div>
  );
}

// Grid-mode variant (Hub B): a fleet summary — how many sessions are running vs
// awaiting input — plus total runtime cpu/mem. Counts are real (session_activity
// working state + pending_prompts). Token/cost totals are NOT summed here (the
// per-session figures are Claude-only via transcript and would be misleading as
// a mixed-CLI total) — Usage owns the authoritative aggregate.
function GridStatusBar() {
  const workspaces = useStore((s) => s.workspaces);
  const activity = useStore((s) => s.sessionActivity);
  const pending = useStore((s) => s.pendingPrompts);
  const stats = useRuntimeStats();

  const sessions = workspaces.flatMap((ws) => leavesList(ws.root));
  const awaiting = new Set(pending.map((p) => p.session));
  // Awaiting takes precedence; otherwise "working" (live output) counts as running.
  const awaitingCount = sessions.filter((s) => awaiting.has(s)).length;
  const runningCount = sessions.filter(
    (s) => !awaiting.has(s) && activity[s]?.state === "working",
  ).length;

  return (
    <div style={{ ...barStyle, gap: 18 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <StatusDot status="live" /> <span className="tnum">{runningCount}</span> running
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <StatusDot status="wait" /> <span className="tnum">{awaitingCount}</span> awaiting
        </span>
      </span>
      <span className="tnum" title="Total runtime CPU">
        cpu {stats ? `${stats.cpuPct.toFixed(0)}%` : "—"}
      </span>
      <span className="tnum" title="Memory">
        mem{" "}
        {stats && stats.memLimit > 0
          ? `${fmtGiB(stats.memUsed)}/${fmtGiB(stats.memLimit)} GiB`
          : stats
            ? `${fmtGiB(stats.memUsed)} GiB`
            : "—"}
      </span>
      <span title="Per-session tokens/cost live on the Usage screen">tokens / $ —</span>
      <span style={{ flex: 1 }} />
      <span>⌘1–9 focus</span>
      <span>⌘\ split</span>
    </div>
  );
}
