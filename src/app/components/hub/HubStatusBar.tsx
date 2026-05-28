import { StatusDot } from "../../components/primitives/StatusDot";
import { Ico } from "../../components/primitives/icons";
import { useBurnRate } from "../../hooks/useBurnRate";
import type { ContainerState, ContainerStats } from "../../lib/ipc";
import { activeWorkspace, useStore } from "../../lib/store";
import { workspaceLeaves } from "../../lib/tree";

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

function fmtGiB(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

// Adaptive byte unit for cumulative net I/O — KB for small, MB/GB as it grows,
// so a long-lived container reads "251 MB" not "257077 KB".
function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

// Live cpu/mem/net snapshot, shared by both variants. Reads the single app-wide
// poll (useContainerStatsPoll) from the store; null until the runtime is up + the
// first poll lands.
function useRuntimeStats(): ContainerStats | null {
  return useStore((s) => s.containerStats);
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
  // Clip rather than spill/overlap when side panels narrow the main region.
  overflow: "hidden",
  minWidth: 0,
};

export function HubStatusBar({ variant = "tabs" }: { variant?: "tabs" | "grid" }) {
  return variant === "grid" ? <GridStatusBar /> : <TabsStatusBar />;
}

function TabsStatusBar() {
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const active = useStore(activeWorkspace);
  const stats = useRuntimeStats();

  const state: ContainerState = error ? "unreachable" : (status?.state ?? "starting");
  const dotStatus = state === "running" ? "live" : state === "starting" ? "wait" : "off";
  const runtimeName = active?.containerKey ?? status?.name ?? "—";
  const runtimeTitle = status?.name ?? active?.containerKey ?? undefined;

  return (
    <div style={barStyle}>
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          minWidth: 0,
          maxWidth: 220,
          flexShrink: 1,
        }}
        title={`Runtime: ${STATE_LABEL[state]}`}
      >
        <StatusDot status={dotStatus} pulse={state === "running"} />
        {Ico.container}
        <span
          style={{
            color: "var(--fg-1)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={runtimeTitle}
        >
          {runtimeName}
        </span>
      </span>
      <span className="vr" style={{ height: 14 }} />
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
        net {stats ? `↓${fmtBytes(stats.netRx)}` : "—"}
      </span>
      <BurnRate />
      <span style={{ flex: 1 }} />
      {/* Discoverability hints — shrink/clip first (overflow), so the stats above
          stay legible when the bar is squeezed by open panels. */}
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          minWidth: 0,
          flexShrink: 1,
          overflow: "hidden",
          whiteSpace: "nowrap",
          color: "var(--fg-3)",
        }}
      >
        <span className="vr" style={{ height: 14 }} />
        <span>⌘K palette</span>
        <span>⌘\ split</span>
        <span>⌘1–9 jump</span>
      </span>
    </div>
  );
}

// Spend-rate ($/h) derived from the cumulative est. cost climb (useBurnRate).
// Em-dash until two samples span enough wall-clock to divide. Token-derived
// estimate, never a billed figure — the tooltip says so.
function BurnRate() {
  const rate = useBurnRate();
  return (
    <span
      className="tnum"
      title="Spend rate — token-derived estimate (rolling), not a billed amount"
      style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--fg-1)" }}
    >
      {rate !== null && (
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: "var(--pri)",
            boxShadow: "0 0 6px var(--pri)",
          }}
        />
      )}
      burn {rate !== null ? `$${rate.toFixed(2)}/h` : "—"}
    </span>
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

  const sessions = workspaces.flatMap((ws) => workspaceLeaves(ws));
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
      <BurnRate />
      <span style={{ flex: 1 }} />
      <span>⌘1–9 focus</span>
      <span>⌘\ split</span>
    </div>
  );
}
