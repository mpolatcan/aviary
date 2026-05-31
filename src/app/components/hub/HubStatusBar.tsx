import { motion } from "motion/react";
import { IconBtn } from "../../components/primitives/IconBtn";
import { Spark } from "../../components/primitives/Spark";
import { StatusDot } from "../../components/primitives/StatusDot";
import { Ico } from "../../components/primitives/icons";
import { deriveLiveStatus } from "../../lib/activity";
import type { ContainerState } from "../../lib/ipc";
import { deriveNetRate, netRateSeries } from "../../lib/metrics";
import { useOverlay } from "../../lib/overlay";
import { activeWorkspace, useStore } from "../../lib/store";
import { workspaceLeaves } from "../../lib/tree";
import { WorkspaceGraphs } from "./DetailsPanel";

// Bottom region of the Hub. ONE element whose height animates: collapsed it's the
// one-line status bar (runtime + lifecycle + inline metric sparklines + chevron);
// expanded (the chevron / ⌘I) it grows to reveal the full-size resource graphs
// BELOW that line — the line stays put as the panel's header, so collapse/expand
// is a single smooth height tween, not a component swap. cpu/mem/net/disk are live
// from container_stats (~2s poll, em-dash before the first read or when down).
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

// Coarse uptime from an RFC 3339 start time, for the runtime tooltip. null when
// unparseable so the caller omits it rather than showing NaN.
function fmtUptime(rfc3339: string): string | null {
  const start = Date.parse(rfc3339);
  if (Number.isNaN(start)) return null;
  const s = Math.max(0, Math.floor((Date.now() - start) / 1000));
  if (s < 60) return "<1m";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const EASE = [0.22, 1, 0.36, 1] as const;
const LINE_H = 30;
const GRAPHS_H = 126;

const regionStyle: React.CSSProperties = {
  flexShrink: 0,
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  background: "var(--bg-0)",
  borderTop: "1px solid var(--bd-soft)",
};

// The always-visible status line (the region's header in both states). No bg /
// border of its own — the region provides those.
const lineStyle: React.CSSProperties = {
  height: LINE_H,
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  padding: "0 10px",
  gap: 10,
  fontFamily: "var(--mono)",
  fontSize: 11,
  color: "var(--fg-2)",
  // Clip rather than spill/overlap when side panels narrow the main region.
  whiteSpace: "nowrap",
  overflow: "hidden",
  minWidth: 0,
};

const graphsSlotStyle: React.CSSProperties = {
  height: GRAPHS_H,
  flexShrink: 0,
  borderTop: "1px solid var(--bd-soft)",
  background: "var(--bg-1)",
  overflow: "hidden",
};

const vr = <span className="vr" style={{ height: 14, flexShrink: 0 }} />;

// One metric in the collapsed line: label + value + a small inline sparkline. The
// sparkline uses the shared statsHistory window; `calm` keeps an idle/flat series
// as a quiet baseline instead of amplified noise.
function MiniMetric({
  label,
  value,
  series,
  accent,
  title,
}: {
  label: string;
  value: string;
  series: number[];
  accent: string;
  title: string;
}) {
  return (
    <span
      className="tnum"
      title={title}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}
    >
      <span style={{ color: "var(--fg-3)" }}>{label}</span>
      <span style={{ color: "var(--fg-1)" }}>{value}</span>
      <span style={{ width: 40, height: 16, display: "inline-block", opacity: 0.9 }}>
        {series.length >= 2 && (
          <Spark data={series} w={40} h={16} color={accent} fill responsive calm />
        )}
      </span>
    </span>
  );
}

// Runtime identity: status dot + state text + container name. Tooltip carries the
// liveness detail (uptime / restarts / OOM).
function RuntimeIndicator() {
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const active = useStore(activeWorkspace);
  const health = useStore((s) => s.containerHealth);

  const state: ContainerState = error ? "unreachable" : (status?.state ?? "starting");
  const oom = health?.oomKilled === true;
  const dotStatus = oom
    ? "err"
    : state === "running"
      ? "live"
      : state === "starting"
        ? "wait"
        : "off";
  const stateColor =
    dotStatus === "live"
      ? "var(--live)"
      : dotStatus === "wait"
        ? "var(--wait)"
        : dotStatus === "err"
          ? "var(--err)"
          : "var(--fg-3)";
  const runtimeName = active?.containerKey ?? status?.name ?? "—";
  const healthBits: string[] = [];
  const up = health?.startedAt ? fmtUptime(health.startedAt) : null;
  if (up) healthBits.push(`up ${up}`);
  if (health?.restartCount)
    healthBits.push(`${health.restartCount} restart${health.restartCount === 1 ? "" : "s"}`);
  if (oom) healthBits.push("OOM-killed");
  const title = `Runtime: ${STATE_LABEL[state]}${healthBits.length ? ` · ${healthBits.join(" · ")}` : ""}`;

  return (
    <span
      style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flexShrink: 1 }}
      title={title}
    >
      <StatusDot status={dotStatus} pulse={state === "running"} />
      <span style={{ color: stateColor }}>{STATE_LABEL[state]}</span>
      {vr}
      <span style={{ color: "var(--fg-3)", display: "inline-flex" }}>{Ico.container}</span>
      <span
        style={{
          color: "var(--fg-1)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {runtimeName}
      </span>
    </span>
  );
}

// Single chevron that expands / collapses the graph region (also ⌘I). Up =
// expand, down = collapse.
function ExpandChevron() {
  const details = useOverlay((s) => s.details);
  const setDetails = useOverlay((s) => s.setDetails);
  return (
    <IconBtn
      title={details ? "Collapse graphs (⌘I)" : "Expand graphs (⌘I)"}
      active={details}
      onClick={() => setDetails(!details)}
      style={{ width: 24, height: 24, flexShrink: 0 }}
    >
      <span
        style={{
          display: "inline-flex",
          color: details ? "var(--live)" : undefined,
          transform: details ? "rotate(0deg)" : "rotate(180deg)",
          transition: "transform .18s, color .12s",
        }}
      >
        {Ico.chevD}
      </span>
    </IconBtn>
  );
}

export function HubStatusBar({ variant = "tabs" }: { variant?: "tabs" | "grid" }) {
  const details = useOverlay((s) => s.details);
  return (
    <motion.div
      initial={false}
      animate={{ height: details ? LINE_H + GRAPHS_H : LINE_H }}
      transition={{ duration: 0.26, ease: EASE }}
      style={regionStyle}
    >
      {variant === "grid" ? <GridStatusLine /> : <TabsStatusLine />}
      {/* graphs region — revealed below the line as the region grows; always
          mounted (cheap, reads the shared poll), clipped + faded when collapsed */}
      <motion.div
        initial={false}
        animate={{ opacity: details ? 1 : 0 }}
        transition={{ duration: 0.2, ease: EASE }}
        style={graphsSlotStyle}
      >
        <WorkspaceGraphs />
      </motion.div>
    </motion.div>
  );
}

function TabsStatusLine() {
  const details = useOverlay((s) => s.details);
  const stats = useStore((s) => s.containerStats);
  const history = useStore((s) => s.statsHistory);
  const netRate = deriveNetRate(history);

  return (
    <div style={lineStyle}>
      <RuntimeIndicator />

      {/* inline metric sparklines — only when collapsed; when expanded the
          full-size graphs below replace them (no duplication) */}
      {!details && (
        <>
          {vr}
          <MiniMetric
            label="cpu"
            value={stats ? `${stats.cpuPct.toFixed(0)}%` : "—"}
            series={history.map((s) => s.cpuPct)}
            accent="var(--live)"
            title="CPU"
          />
          {vr}
          <MiniMetric
            label="mem"
            value={
              stats && stats.memLimit > 0
                ? `${fmtGiB(stats.memUsed)}/${fmtGiB(stats.memLimit)} GiB`
                : stats
                  ? `${fmtGiB(stats.memUsed)} GiB`
                  : "—"
            }
            series={history.map((s) => s.memUsed)}
            accent="var(--pri)"
            title="Memory"
          />
          {vr}
          <MiniMetric
            label="net"
            value={netRate != null ? `${fmtBytes(netRate)}/s` : "—"}
            series={netRateSeries(history)}
            accent="var(--wait)"
            title="Network I/O (rate)"
          />
          {vr}
          <MiniMetric
            label="disk"
            value={stats ? fmtBytes(stats.disk) : "—"}
            series={history.map((s) => s.disk)}
            accent="var(--idle)"
            title="Disk"
          />
        </>
      )}

      <span style={{ flex: 1 }} />

      <ExpandChevron />
      {!details && (
        <>
          {vr}
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
            <span>⌘K palette</span>
            <span>⌘\ split</span>
          </span>
        </>
      )}
    </div>
  );
}

// Grid-mode variant (Hub B): a fleet summary — how many sessions are running vs
// awaiting input — plus total runtime cpu/mem/disk. Counts are real
// (session_activity working state + pending_prompts). Token/cost totals are NOT
// summed here (per-session figures are Claude-only via transcript and would
// mislead as a mixed-CLI total) — Usage owns the authoritative aggregate.
function GridStatusLine() {
  const details = useOverlay((s) => s.details);
  const workspaces = useStore((s) => s.workspaces);
  const activity = useStore((s) => s.sessionActivity);
  const pending = useStore((s) => s.pendingPrompts);
  const stats = useStore((s) => s.containerStats);
  const history = useStore((s) => s.statsHistory);

  const sessions = workspaces.flatMap((ws) => workspaceLeaves(ws));
  const awaiting = new Set(pending.map((p) => p.session));
  // Awaiting takes precedence; otherwise a session counts as running when the
  // shared hook-truth status is "live" (a turn in flight) — not merely when raw
  // output is flowing, so a redrawing spinner no longer inflates the count.
  const awaitingCount = sessions.filter((s) => awaiting.has(s)).length;
  const runningCount = sessions.filter((s) => {
    const act = activity[s];
    return act != null && !awaiting.has(s) && deriveLiveStatus(act, false).status === "live";
  }).length;

  return (
    <div style={{ ...lineStyle, gap: 12 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <StatusDot status="live" /> <span className="tnum">{runningCount}</span> running
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <StatusDot status="wait" /> <span className="tnum">{awaitingCount}</span> awaiting
        </span>
      </span>

      {!details && (
        <>
          {vr}
          <MiniMetric
            label="cpu"
            value={stats ? `${stats.cpuPct.toFixed(0)}%` : "—"}
            series={history.map((s) => s.cpuPct)}
            accent="var(--live)"
            title="Total runtime CPU"
          />
          {vr}
          <MiniMetric
            label="mem"
            value={
              stats && stats.memLimit > 0
                ? `${fmtGiB(stats.memUsed)}/${fmtGiB(stats.memLimit)} GiB`
                : stats
                  ? `${fmtGiB(stats.memUsed)} GiB`
                  : "—"
            }
            series={history.map((s) => s.memUsed)}
            accent="var(--pri)"
            title="Memory"
          />
          {vr}
          <MiniMetric
            label="disk"
            value={stats ? fmtBytes(stats.disk) : "—"}
            series={history.map((s) => s.disk)}
            accent="var(--idle)"
            title="Disk"
          />
        </>
      )}

      <span style={{ flex: 1 }} />

      <ExpandChevron />
      {!details && (
        <>
          {vr}
          <span style={{ color: "var(--fg-3)", flexShrink: 1, overflow: "hidden" }}>
            ⌘1–9 focus
          </span>
        </>
      )}
    </div>
  );
}
