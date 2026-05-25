/**
 * ContainerInspector — the "Containers" view. Ported from
 * design/screens/container-inspector.jsx, adapted to CodeHub's reality: there is
 * ONE shared runtime container (`codehub-runtime`), not a per-repo fleet. So the
 * left list holds the single runtime and the detail pane describes it.
 *
 * Real data: container name / state / image / id (container_status), docker
 * version (docker_info), the live attached sessions (sessionMeta), the fixed
 * /workspace mount, and host-env credential forwarding (agent_key_status,
 * presence-only). Resource gauges (cpu/mem/net/disk) and the live log stream
 * have no backend feed yet — rendered as em-dashes / an honest placeholder, with
 * entries in BACKEND_PLAN.md. Nothing is fabricated.
 */
import { AgentGlyph } from "@/app/components/primitives/AgentGlyph";
import { IconBtn } from "@/app/components/primitives/IconBtn";
import { Spark } from "@/app/components/primitives/Spark";
import { StatusBadge } from "@/app/components/primitives/StatusBadge";
import { StatusDot } from "@/app/components/primitives/StatusDot";
import type { StatusKey } from "@/app/components/primitives/StatusDot";
import { Tag } from "@/app/components/primitives/Tag";
import { Ico } from "@/app/components/primitives/icons";
import { CLIS, MODE_BY_ID, SPEC_BY_CLI } from "@/app/lib/catalog";
import {
  type Cli,
  type ContainerState,
  type ContainerStats,
  type ImageInfo,
  type MountInfo,
  type ProcessInfo,
  type RuntimeHealth,
  ipc,
} from "@/app/lib/ipc";
import { useOverlay } from "@/app/lib/overlay";
import { useStore } from "@/app/lib/store";
import { Button } from "@/app/ui/button";
import { useEffect, useMemo, useRef, useState } from "react";

// container_status state → the shared StatusDot/Badge vocabulary.
const STATE_DOT: Record<ContainerState, StatusKey> = {
  running: "live",
  starting: "wait",
  stopped: "off",
  missing: "off",
  unreachable: "err",
};

const CONTAINER_MOUNT = "/workspace";

// How many container_stats samples the gauge sparklines retain. At the 2s poll
// cadence below this is ~1 minute of history — enough to read a trend, small
// enough to stay cheap.
const STATS_WINDOW = 30;
const STATS_POLL_MS = 2000;

// rx+tx bytes/sec from the last two samples. null until two samples exist or if
// the interval is non-positive; a negative delta (counter reset on restart) is
// clamped to 0. Returns combined throughput — the gauge labels the direction.
function deriveNetRate(history: ContainerStats[]): number | null {
  if (history.length < 2) return null;
  const prev = history[history.length - 2];
  const cur = history[history.length - 1];
  const dRx = Math.max(0, cur.netRx - prev.netRx);
  const dTx = Math.max(0, cur.netTx - prev.netTx);
  return ((dRx + dTx) / STATS_POLL_MS) * 1000;
}

export function ContainerInspector() {
  const status = useStore((s) => s.status);
  const dockerInfo = useStore((s) => s.dockerInfo);
  const keyStatus = useStore((s) => s.keyStatus);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const workspaces = useStore((s) => s.workspaces);
  const focusSession = useStore((s) => s.focusSession);
  const setView = useStore((s) => s.setView);
  const startRuntime = useStore((s) => s.startRuntime);
  const stopRuntime = useStore((s) => s.stopRuntime);
  const restartRuntime = useStore((s) => s.restartRuntime);
  const newPlate = useStore((s) => s.newPlate);
  const setNewWorkspace = useOverlay((s) => s.setNewWorkspace);

  const name = status?.name ?? "codehub-runtime";
  const state = status?.state ?? "missing";
  const dot = STATE_DOT[state];
  const image = status?.image ?? "—";
  const id = status?.id ?? null;
  const sessions = Object.entries(sessionMeta);

  // Live container_stats come from the single app-wide poll (useContainerStatsPoll)
  // via the store — the gauges READ it rather than firing their own poll.
  const stats = useStore((s) => s.containerStats);
  // Rolling window of the last N samples (newest last) so the gauges can draw a
  // real sparkline of where each metric has actually been — not a fabricated
  // series. Cleared whenever the runtime goes down so a restart starts fresh.
  const [history, setHistory] = useState<ContainerStats[]>([]);
  const running = state === "running";
  useEffect(() => {
    if (!running || !stats) {
      setHistory([]);
      return;
    }
    setHistory((h) => [...h, stats].slice(-STATS_WINDOW));
  }, [running, stats]);

  // Net I/O as a per-second rate from the last two cumulative samples (the design
  // shows "KB/s", not a running total). Honest: needs ≥2 samples + a positive
  // interval, else null → em-dash. Bytes are monotonic; a counter reset (restart)
  // yields a negative delta which we clamp to 0 rather than show a bogus spike.
  const netRate = useMemo(() => deriveNetRate(history), [history]);

  // Tail the container log while running + mounted. Same one-shot polling
  // contract as stats (no backend stream); slower cadence (~4s) since logs are
  // bulkier. `null` while down / before first read → honest placeholder.
  const [logs, setLogs] = useState<string[] | null>(null);
  useEffect(() => {
    if (!running) {
      setLogs(null);
      return;
    }
    let alive = true;
    const tick = () => {
      ipc
        .containerLogs(200)
        .then((l) => alive && setLogs(l))
        .catch(() => alive && setLogs(null));
    };
    tick();
    const h = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [running]);

  // Mounts are fixed for the container's lifetime — fetch once when it comes up,
  // no polling. `null` while down / before the read → fall back to the known
  // /workspace mount description rather than an empty card.
  const [mounts, setMounts] = useState<MountInfo[] | null>(null);
  useEffect(() => {
    if (!running) {
      setMounts(null);
      return;
    }
    let alive = true;
    ipc
      .containerMounts()
      .then((m) => alive && setMounts(m))
      .catch(() => alive && setMounts(null));
    return () => {
      alive = false;
    };
  }, [running]);

  // Image identity (tag/digest/created/size) is fixed for the container's
  // lifetime — fetch once like mounts; `null` while down / pre-read → em-dash.
  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);
  useEffect(() => {
    if (!running) {
      setImageInfo(null);
      return;
    }
    let alive = true;
    ipc
      .containerImage()
      .then((i) => alive && setImageInfo(i))
      .catch(() => alive && setImageInfo(null));
    return () => {
      alive = false;
    };
  }, [running]);

  // Liveness — uptime, restart count, OOM flag. Polled ~5s (one cheap `docker
  // inspect`) rather than fetched once: an auto-restart bumps restartCount,
  // sets oomKilled and resets startedAt without necessarily surfacing as a
  // not-running blip, so a once-per-transition read could miss the very events
  // these indicators exist to show. Same one-shot/alive-guard contract as the
  // other polls; `null` while down / pre-read → the hero omits the liveness
  // text rather than showing a fake age.
  const [health, setHealth] = useState<RuntimeHealth | null>(null);
  useEffect(() => {
    if (!running) {
      setHealth(null);
      return;
    }
    let alive = true;
    const tick = () => {
      ipc
        .containerHealth()
        .then((h) => alive && setHealth(h))
        .catch(() => alive && setHealth(null));
    };
    tick();
    const h = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [running]);

  // Processes via `docker top`, polled while running + mounted (~3s). Same
  // one-shot contract as stats/logs; `null` while down / pre-first-read → honest
  // placeholder rather than an empty table.
  const [procs, setProcs] = useState<ProcessInfo[] | null>(null);
  useEffect(() => {
    if (!running) {
      setProcs(null);
      return;
    }
    let alive = true;
    const tick = () => {
      ipc
        .containerTop()
        .then((p) => alive && setProcs(p))
        .catch(() => alive && setProcs(null));
    };
    tick();
    const h = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [running]);

  const open = (session: string) => {
    focusSession(session);
    setView("hub");
  };

  // Exec shell — spawn a plain bash pane in the shared runtime and jump to it,
  // the same path the Hub's "+ shell" control uses (newPlate("shell")).
  const execShell = () => {
    void newPlate("shell", "standard");
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
            Workspaces
          </h1>
          <span className="mono" style={{ fontSize: 12, color: "var(--fg-2)" }}>
            {state === "running" ? "1 running" : `0 running · ${state}`}
            {dockerInfo?.version && ` · docker ${dockerInfo.version}`}
          </span>
          <span style={{ flex: 1 }} />
          <Button size="sm" onClick={() => setNewWorkspace(true)}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {Ico.plus}New workspace
            </span>
          </Button>
        </div>
        <p className="mono" style={{ margin: "6px 0 0", fontSize: 11, color: "var(--fg-3)" }}>
          CodeHub runs every session on one shared runtime container.
        </p>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* list — the single shared runtime */}
        <div
          style={{
            flex: "0 0 320px",
            borderRight: "1px solid var(--bd-soft)",
            display: "flex",
            flexDirection: "column",
            padding: 8,
          }}
        >
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 7,
              background: "var(--bg-3)",
              border: "1px solid var(--bd-strong)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
              <StatusDot status={dot} pulse={dot === "live"} />
              <span
                className="mono"
                style={{ fontSize: 11.5, color: "var(--fg-0)", fontWeight: 500, flex: 1 }}
              >
                {name}
              </span>
              <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>
                {/* split only the final :tag so a registry port (host:443/img) is safe */}
                {image.replace(/:([^:/]+)$/, " $1")}
              </span>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginTop: 6,
              }}
            >
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                {sessions.length === 0 ? (
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                    no sessions
                  </span>
                ) : (
                  sessions.map(([session, meta]) => (
                    <AgentGlyph
                      key={session}
                      agent={meta.cli}
                      size={11}
                      color={`var(--a-${meta.cli})`}
                    />
                  ))
                )}
              </div>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                {stats
                  ? `cpu ${stats.cpuPct.toFixed(0)}% · mem ${fmtBytes(stats.memUsed)}`
                  : "cpu — · mem —"}
              </span>
            </div>
          </div>
        </div>

        {/* detail */}
        <div className="scroll" style={{ flex: 1, overflow: "auto", padding: 22 }}>
          {/* hero */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 18 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 8,
                background: "var(--bg-3)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: dot === "live" ? "var(--live)" : "var(--fg-2)",
              }}
            >
              <span style={{ transform: "scale(1.6)" }}>{Ico.container}</span>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <h2 className="mono" style={{ margin: 0, fontSize: 17, fontWeight: 500 }}>
                  {name}
                </h2>
                <StatusBadge status={dot} />
              </div>
              <div className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>
                {image}
                {id && ` · ${id.slice(0, 12)}`}
                {(() => {
                  const up = health?.startedAt ? fmtUptime(health.startedAt) : null;
                  return up ? ` · up ${up}` : "";
                })()}
                {health && health.restartCount != null && health.restartCount > 0 && (
                  <span className="tnum">
                    {` · ${health.restartCount} restart${health.restartCount === 1 ? "" : "s"}`}
                  </span>
                )}
                {health?.oomKilled && <span style={{ color: "var(--err)" }}> · OOM-killed</span>}
              </div>
            </div>
            <RuntimeControls
              state={state}
              sessionCount={Object.keys(sessionMeta).length}
              onStart={() => void startRuntime()}
              onStop={() => void stopRuntime()}
              onRestart={() => void restartRuntime()}
              onExec={execShell}
            />
          </div>

          {/* metrics row — live container_stats (em-dash until the first poll
              resolves, or whenever the runtime is down). */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 10,
              marginBottom: 18,
            }}
          >
            <GaugeCard
              label="CPU"
              value={stats ? `${stats.cpuPct.toFixed(1)}%` : null}
              fill={stats ? Math.min(100, stats.cpuPct) : null}
              spark={history.map((s) => s.cpuPct)}
            />
            <GaugeCard
              label="Memory"
              value={stats ? fmtBytes(stats.memUsed) : null}
              sub={stats && stats.memLimit > 0 ? `/ ${fmtBytes(stats.memLimit)}` : undefined}
              fill={stats && stats.memLimit > 0 ? (stats.memUsed / stats.memLimit) * 100 : null}
              spark={history.map((s) => s.memUsed)}
            />
            <GaugeCard
              label="Net I/O"
              value={netRate != null ? `${fmtBytes(netRate)}/s` : null}
              sub={stats ? `↓${fmtBytes(stats.netRx)} ↑${fmtBytes(stats.netTx)}` : undefined}
              spark={history.map((s) => s.netRx + s.netTx)}
            />
            <GaugeCard
              label="Disk"
              value={stats ? fmtBytes(stats.disk) : null}
              spark={history.map((s) => s.disk)}
            />
          </div>

          {/* runtime image identity — real `docker image inspect` */}
          <ImageCard image={imageInfo} />

          {/* attached sessions + mounts */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
              marginBottom: 18,
            }}
          >
            <div className="ch-card" style={{ padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 8, gap: 8 }}>
                <span className="lbl">Attached sessions · {sessions.length}</span>
              </div>
              {sessions.length === 0 ? (
                <div
                  className="mono"
                  style={{ fontSize: 11.5, color: "var(--fg-3)", padding: "6px 0" }}
                >
                  No sessions attached. Press ⌘N to start one.
                </div>
              ) : (
                sessions.map(([session, meta]) => {
                  const ws = workspaces.find((w) => w.id === meta.workspaceId);
                  const badge = MODE_BY_ID[meta.mode].badge;
                  return (
                    <div
                      key={session}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "7px 8px",
                        background: "var(--bg-3)",
                        borderRadius: 6,
                        marginBottom: 4,
                      }}
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
                      </span>
                      <IconBtn title="Open in Hub" onClick={() => open(session)}>
                        {Ico.arrowR}
                      </IconBtn>
                    </div>
                  );
                })
              )}
            </div>

            {/* minWidth:0 so a long host path can ellipsize instead of widening
                the grid track past the card. */}
            <div className="ch-card" style={{ padding: 14, minWidth: 0 }}>
              <div className="lbl" style={{ marginBottom: 8 }}>
                Mounts{mounts && mounts.length > 0 && ` · ${mounts.length}`}
              </div>
              {mounts && mounts.length > 0 ? (
                mounts.map((m) => (
                  <Mount
                    key={m.destination}
                    container={m.destination}
                    host={m.source}
                    mode={m.rw ? "rw" : "ro"}
                  />
                ))
              ) : (
                // No real read yet (down / pre-fetch) — describe the fixed mount
                // without inventing a host path.
                <Mount container={CONTAINER_MOUNT} mode="rw" host={null} />
              )}
              <p
                className="mono"
                style={{ margin: "8px 0 0", fontSize: 10.5, color: "var(--fg-3)" }}
              >
                Sessions share the runtime's bind mounts; work lives under {CONTAINER_MOUNT}.
              </p>
            </div>
          </div>

          {/* forwarded credentials — presence only, never values */}
          <div className="ch-card" style={{ padding: 0, marginBottom: 18 }}>
            <div
              style={{
                padding: "10px 14px",
                borderBottom: "1px solid var(--bd-soft)",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span className="lbl">Forwarded credentials</span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                from host environment · values never read
              </span>
            </div>
            <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 4 }}>
              {CLIS.map((c) => {
                const ks = keyStatus?.[c.id];
                return (
                  <CredRow
                    key={c.id}
                    cli={c.id}
                    label={c.label}
                    present={ks?.present ?? false}
                    varName={ks?.varName ?? null}
                  />
                );
              })}
            </div>
          </div>

          {/* processes — `docker top`, polled by container_top (~3s). */}
          <div className="ch-card" style={{ padding: 0, marginBottom: 18 }}>
            <div
              style={{
                padding: "10px 14px",
                borderBottom: "1px solid var(--bd-soft)",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span className="lbl">Processes</span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                docker top {name}
              </span>
              <span style={{ flex: 1 }} />
              {procs && procs.length > 0 && (
                <span className="mono tnum" style={{ fontSize: 10, color: "var(--fg-3)" }}>
                  {procs.length}
                </span>
              )}
            </div>
            <ProcessTable procs={procs} running={running} />
          </div>

          {/* logs — tail of `docker logs`, polled by container_logs (~4s). */}
          <div className="ch-card" style={{ padding: 0 }}>
            <div
              style={{
                padding: "10px 14px",
                borderBottom: "1px solid var(--bd-soft)",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span className="lbl">Container log</span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                docker logs {name}
              </span>
              <span style={{ flex: 1 }} />
              {logs && logs.length > 0 && (
                <span className="mono tnum" style={{ fontSize: 10, color: "var(--fg-3)" }}>
                  last {logs.length} lines
                </span>
              )}
            </div>
            <LogPanel lines={logs} running={running} name={name} />
          </div>
        </div>
      </div>
    </main>
  );
}

// Human-readable bytes: 1.2 GB, 412 MB, 8.0 kB. Binary (1024) units to match
// how `docker stats` reports memory.
function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "kB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// Compact uptime from an RFC 3339 start time: "<1m", "12m", "3h", "2d". Returns
// null when the timestamp is unparseable (the hero then omits the uptime rather
// than showing NaN). Coarse on purpose — the hero only needs a glanceable age.
function fmtUptime(rfc3339: string): string | null {
  const start = Date.parse(rfc3339);
  if (Number.isNaN(start)) return null;
  const s = Math.max(0, Math.floor((Date.now() - start) / 1000));
  if (s < 60) return "<1m";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Strip the `sha256:` prefix and shorten a digest/id to 12 hex chars, the way
// `docker images` displays them. Returns null untouched so callers em-dash.
function shortSha(s: string | null): string | null {
  if (!s) return null;
  const hex = s.startsWith("sha256:") ? s.slice("sha256:".length) : s;
  return hex.length > 12 ? hex.slice(0, 12) : hex;
}

// The runtime image's identity from `docker image inspect` — all real, each
// field em-dashed when absent (e.g. a locally-built image has no repo digest).
function ImageCard({ image }: { image: ImageInfo | null }) {
  const dash = "—";
  const created = image?.created ? image.created.replace("T", " ").slice(0, 19) : dash;
  return (
    <div className="ch-card" style={{ padding: 14, marginBottom: 18, minWidth: 0 }}>
      <div className="lbl" style={{ marginBottom: 10 }}>
        Image
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 24px" }}>
        <ImageKv k="Tag" v={image?.tag ?? dash} />
        <ImageKv k="Size" v={image?.size != null ? fmtBytes(image.size) : dash} />
        <ImageKv k="Digest" v={shortSha(image?.digest ?? null) ?? dash} />
        <ImageKv k="Created" v={created} />
        <ImageKv k="Image ID" v={shortSha(image?.id ?? null) ?? dash} />
        <ImageKv k="Platform" v={image?.os && image?.arch ? `${image.os}/${image.arch}` : dash} />
      </div>
    </div>
  );
}

// One mono key/value row for the Image card; value right-aligned + ellipsized so
// a long tag/digest can't widen its grid track.
function ImageKv({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
      <span style={{ fontSize: 11.5, color: "var(--fg-2)", flexShrink: 0 }}>{k}</span>
      <span style={{ flex: 1, borderBottom: "1px dotted var(--bd-soft)", minWidth: 8 }} />
      <span
        className="mono tnum"
        style={{
          fontSize: 11,
          color: "var(--fg-1)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
        title={v}
      >
        {v}
      </span>
    </div>
  );
}

// One metric. `value === null` → em-dash + hatched bar (no reading yet / runtime
// down). With a value: shows it (+ optional `sub`), and a proportional bar when
// `fill` (0-100) is given — CPU/memory have a meaningful ratio; net/disk don't,
// so they render value-only.
function GaugeCard({
  label,
  value,
  sub,
  fill,
  spark,
}: {
  label: string;
  value?: string | null;
  sub?: string;
  fill?: number | null;
  // Real per-poll history for this metric (newest last). A line is drawn once
  // ≥2 samples exist; before that the card falls back to the fill/flat bar so it
  // never invents a curve from a single point.
  spark?: number[];
}) {
  const hasSpark = !!spark && spark.length >= 2;
  return (
    <div
      className="ch-card"
      style={{ padding: 12, display: "flex", flexDirection: "column", gap: 4 }}
    >
      <div className="lbl" style={{ fontSize: 10 }}>
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
        <span
          className="mono tnum"
          style={{ fontSize: 18, color: value ? "var(--fg-0)" : "var(--fg-3)", fontWeight: 500 }}
        >
          {value ?? "—"}
        </span>
        {value && sub && (
          <span className="mono tnum" style={{ fontSize: 11, color: "var(--fg-3)" }}>
            {sub}
          </span>
        )}
      </div>
      {hasSpark ? (
        // Real trend line over the rolling window. Width 100% via a flexed wrapper
        // so it tracks the responsive grid track; height matches the old bar.
        <div style={{ height: 20, width: "100%" }}>
          <Spark data={spark} w={150} h={20} color="var(--live)" fill />
        </div>
      ) : value && typeof fill === "number" ? (
        <div style={{ height: 20, borderRadius: 4, background: "var(--bg-3)", overflow: "hidden" }}>
          <div
            style={{
              height: "100%",
              width: `${Math.max(2, Math.min(100, fill))}%`,
              background: "var(--live)",
              opacity: 0.55,
            }}
          />
        </div>
      ) : (
        <div
          style={{
            height: 20,
            borderRadius: 4,
            background: value
              ? "var(--bg-3)"
              : "repeating-linear-gradient(45deg, var(--bg-3) 0 6px, transparent 6px 12px)",
            opacity: value ? 1 : 0.5,
          }}
        />
      )}
    </div>
  );
}

// Container log tail. `lines === null` → honest placeholder (down / pre-first
// read); empty array → "no output yet"; otherwise the raw lines, newest at the
// bottom, auto-scrolled to the tail on each refresh.
function LogPanel({
  lines,
  running,
  name,
}: {
  lines: string[] | null;
  running: boolean;
  name: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Keep pinned to the newest line when fresh tails arrive. `lines` is the
  // trigger even though the body only touches the ref.
  // biome-ignore lint/correctness/useExhaustiveDependencies: lines is the intended re-scroll trigger.
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  if (lines === null) {
    return (
      <div
        style={{
          padding: "28px 14px",
          textAlign: "center",
          fontFamily: "var(--mono)",
          fontSize: 11.5,
          color: "var(--fg-3)",
          lineHeight: 1.6,
        }}
      >
        {running ? (
          "Reading container log…"
        ) : (
          <>
            Container is not running.
            <br />
            Start it to tail <span style={{ color: "var(--fg-1)" }}>docker logs {name}</span>.
          </>
        )}
      </div>
    );
  }

  if (lines.length === 0) {
    return (
      <div
        className="mono"
        style={{ padding: "28px 14px", textAlign: "center", fontSize: 11.5, color: "var(--fg-3)" }}
      >
        No log output yet.
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="scroll"
      style={{
        maxHeight: 280,
        overflow: "auto",
        padding: "10px 14px",
        fontFamily: "var(--mono)",
        fontSize: 11,
        lineHeight: 1.55,
        color: "var(--fg-1)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: log lines have no stable id; a refreshed tail is a full replace, not a reorder.
        <div key={i}>{line || " "}</div>
      ))}
    </div>
  );
}

// Process list from `docker top`. `procs === null` → honest placeholder (down /
// pre-first read); empty array → "no processes"; otherwise a compact table.
// Command is the wide column (truncates); PID/user/time stay narrow + tabular.
function ProcessTable({
  procs,
  running,
}: {
  procs: ProcessInfo[] | null;
  running: boolean;
}) {
  if (procs === null) {
    return (
      <div
        className="mono"
        style={{ padding: "28px 14px", textAlign: "center", fontSize: 11.5, color: "var(--fg-3)" }}
      >
        {running ? "Reading processes…" : "Container is not running."}
      </div>
    );
  }
  if (procs.length === 0) {
    return (
      <div
        className="mono"
        style={{ padding: "28px 14px", textAlign: "center", fontSize: 11.5, color: "var(--fg-3)" }}
      >
        No processes reported.
      </div>
    );
  }
  return (
    <div className="scroll" style={{ maxHeight: 280, overflow: "auto" }}>
      {procs.map((p) => (
        <div
          key={`${p.pid}-${p.command}`}
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 10,
            padding: "5px 14px",
            fontFamily: "var(--mono)",
            fontSize: 11.5,
          }}
        >
          <span className="tnum" style={{ width: 52, flexShrink: 0, color: "var(--fg-2)" }}>
            {p.pid}
          </span>
          <span style={{ width: 72, flexShrink: 0, color: "var(--fg-3)" }}>{p.user || "—"}</span>
          {p.time && (
            <span className="tnum" style={{ width: 64, flexShrink: 0, color: "var(--fg-3)" }}>
              {p.time}
            </span>
          )}
          <span
            title={p.command}
            style={{
              color: "var(--fg-1)",
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {p.command}
          </span>
        </div>
      ))}
    </div>
  );
}

// One mount row: host path → container path + rw/ro tag. `host === null` keeps
// the host side as an em-dash (no real read yet) rather than fabricating a path.
function Mount({
  container,
  host,
  mode,
}: {
  container: string;
  host: string | null;
  mode: "rw" | "ro";
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 0",
        fontFamily: "var(--mono)",
        fontSize: 11.5,
      }}
    >
      <span
        title={host ?? undefined}
        style={{
          color: host ? "var(--fg-2)" : "var(--fg-3)",
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          direction: "rtl",
          textAlign: "left",
        }}
      >
        {host ?? "—"}
      </span>
      <span style={{ color: "var(--fg-3)" }}>→</span>
      <span style={{ color: "var(--fg-1)", flexShrink: 0 }}>{container}</span>
      <Tag color={mode === "rw" ? "var(--live)" : "var(--fg-2)"}>{mode}</Tag>
    </div>
  );
}

function CredRow({
  cli,
  label,
  present,
  varName,
}: {
  cli: Cli;
  label: string;
  present: boolean;
  varName: string | null;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 6px",
        borderRadius: 4,
        fontFamily: "var(--mono)",
        fontSize: 11.5,
      }}
    >
      <AgentGlyph agent={cli} size={11} color={`var(--a-${cli})`} />
      <span style={{ color: "var(--fg-1)", minWidth: 110 }}>{label}</span>
      <span style={{ color: present ? "var(--fg-1)" : "var(--fg-3)", flex: 1, minWidth: 0 }}>
        {present ? (varName ?? "set") : "not set"}
      </span>
      <StatusDot status={present ? "live" : "off"} />
    </div>
  );
}

// Runtime lifecycle controls in the inspector hero. Start when the container is
// down; Restart/Stop when it's up. Stop/Restart kill every attached tmux session
// (the bollard execs die with the container), so both gate behind a confirm that
// names how many live sessions go with it. `starting` shows a disabled spinner
// label; `unreachable` (daemon down) offers nothing actionable.
function RuntimeControls({
  state,
  sessionCount,
  onStart,
  onStop,
  onRestart,
  onExec,
}: {
  state: ContainerState;
  sessionCount: number;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onExec: () => void;
}) {
  const sessionsClause =
    sessionCount > 0
      ? ` This kills ${sessionCount} attached session${sessionCount === 1 ? "" : "s"}.`
      : "";
  const confirmStop = () => {
    if (window.confirm(`Stop the runtime?${sessionsClause}`)) onStop();
  };
  const confirmRestart = () => {
    if (window.confirm(`Restart the runtime?${sessionsClause}`)) onRestart();
  };

  if (state === "starting") {
    return (
      <Button size="sm" variant="outline" disabled>
        Starting…
      </Button>
    );
  }
  if (state === "stopped" || state === "missing") {
    return (
      <Button size="sm" onClick={onStart}>
        {state === "missing" ? "Create & start" : "Start"}
      </Button>
    );
  }
  if (state === "running") {
    return (
      <div style={{ display: "flex", gap: 8 }}>
        <Button size="sm" variant="outline" onClick={onExec}>
          Exec shell
        </Button>
        <Button size="sm" variant="outline" onClick={confirmRestart}>
          Restart
        </Button>
        <Button size="sm" variant="destructive" onClick={confirmStop}>
          Stop
        </Button>
      </div>
    );
  }
  return null;
}
