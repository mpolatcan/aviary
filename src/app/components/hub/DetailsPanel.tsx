/**
 * WorkspaceGraphs — the full-size CPU / Memory / Net / Disk sparkline row that the
 * bottom bar reveals when expanded (status-bar chevron / ⌘I). NOT a standalone
 * panel: HubStatusBar owns the bottom region and animates its height open/closed,
 * keeping the status line as the expanded panel's header. This is purely the
 * graphs row that drops in below that line.
 *
 * Real data only: stats come from the shared app-wide poll (useContainerStatsPoll
 * → store.containerStats/statsHistory). Em-dash before the first read or when the
 * runtime is down.
 */
import { Spark } from "@/app/components/primitives/Spark";
import { deriveNetRate, netRateSeries } from "@/app/lib/metrics";
import { useStore } from "@/app/lib/store";

export function WorkspaceGraphs() {
  const stats = useStore((s) => s.containerStats);
  // Shared rolling window from the app-wide poll (cleared on container switch).
  const history = useStore((s) => s.statsHistory);

  const netRate = deriveNetRate(history);
  const netSeries = netRateSeries(history);

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        gap: 8,
        padding: 10,
        boxSizing: "border-box",
        color: "var(--fg-1)",
      }}
    >
      <GaugeCell
        label="CPU"
        value={stats ? `${stats.cpuPct.toFixed(1)}%` : null}
        spark={history.map((s) => s.cpuPct)}
        accent="var(--live)"
      />
      <GaugeCell
        label="Memory"
        value={stats ? fmtBytes(stats.memUsed) : null}
        sub={stats && stats.memLimit > 0 ? `of ${fmtBytes(stats.memLimit)}` : undefined}
        spark={history.map((s) => s.memUsed)}
        accent="var(--pri)"
      />
      <GaugeCell
        label="Net I/O"
        value={netRate != null ? `${fmtBytes(netRate)}/s` : null}
        sub={stats ? `↓${fmtBytes(stats.netRx)}  ↑${fmtBytes(stats.netTx)}` : undefined}
        spark={netSeries}
        accent="var(--wait)"
      />
      <GaugeCell
        label="Disk"
        value={stats ? fmtBytes(stats.disk) : null}
        spark={history.map((s) => s.disk)}
        accent="var(--idle)"
      />
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

// Human-readable bytes (binary units, matching `docker stats`).
function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "kB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// One metric cell in the horizontal dock: label + accent value (top), optional
// sub, and a full-bleed sparkline below that grows to fill the cell height.
function GaugeCell({
  label,
  value,
  sub,
  spark,
  accent,
}: {
  label: string;
  value?: string | null;
  sub?: string;
  spark?: number[];
  accent: string;
}) {
  const hasSpark = !!spark && spark.length >= 2;
  return (
    <div
      className="ch-card"
      style={{
        flex: 1,
        minWidth: 0,
        padding: "9px 12px 8px",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="lbl" style={{ fontSize: "var(--fs-10)" }}>
          {label}
        </span>
        <span style={{ flex: 1 }} />
        <span
          className="mono tnum"
          style={{
            fontSize: "var(--fs-16)",
            fontWeight: 600,
            lineHeight: 1,
            color: value ? accent : "var(--fg-3)",
          }}
        >
          {value ?? "—"}
        </span>
      </div>
      {value && sub && (
        <div
          className="mono tnum"
          style={{
            fontSize: "var(--fs-10)",
            color: "var(--fg-3)",
            marginTop: 2,
            textAlign: "right",
          }}
        >
          {sub}
        </div>
      )}
      <div
        style={{
          flex: 1,
          minHeight: 20,
          position: "relative",
          marginTop: 6,
          borderRadius: 5,
          overflow: "hidden",
          background: "color-mix(in oklab, var(--bg-2) 55%, transparent)",
        }}
      >
        {/* faint gridlines so an idle / flat metric reads as a chart with low
            activity, not an empty void */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "linear-gradient(to bottom, color-mix(in oklab, var(--bd) 70%, transparent) 1px, transparent 1px)",
            backgroundSize: "100% 25%",
            opacity: 0.7,
            pointerEvents: "none",
          }}
        />
        {hasSpark && (
          <div style={{ position: "absolute", inset: 0 }}>
            <Spark data={spark} w={300} h={60} color={accent} fill responsive calm />
          </div>
        )}
      </div>
    </div>
  );
}
