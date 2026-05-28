/**
 * ContainerInspector — the "Containers" / "Workspaces" view. Each workspace runs
 * in its own per-workspace container (`codehub-ws-<key>`). The left list shows
 * one card per workspace container; the detail pane describes the selected one.
 *
 * Real data: container name / state / image / id (container_status), docker
 * version (docker_info), the live attached sessions (sessionMeta), the fixed
 * /workspace mount, and credential presence (agent_key_status). Resource gauges
 * (cpu/mem/net/disk) and the live log stream are
 * polled from real container_stats / container_logs. Nothing is fabricated.
 */
import { AgentGlyph } from "@/app/components/primitives/AgentGlyph";
import { IconBtn } from "@/app/components/primitives/IconBtn";
import { Spark } from "@/app/components/primitives/Spark";
import { StatusBadge } from "@/app/components/primitives/StatusBadge";
import { StatusDot } from "@/app/components/primitives/StatusDot";
import type { StatusKey } from "@/app/components/primitives/StatusDot";
import { Tag } from "@/app/components/primitives/Tag";
import { Ico } from "@/app/components/primitives/icons";
import { MODE_BY_ID, SPEC_BY_CLI } from "@/app/lib/catalog";
import {
  type Cli,
  type ContainerState,
  type ContainerStats,
  type ImageInfo,
  type MountInfo,
  type RuntimeHealth,
  type WorkspaceContainer,
  ipc,
} from "@/app/lib/ipc";
import { useLauncher } from "@/app/lib/launcher";
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
  const dockerInfo = useStore((s) => s.dockerInfo);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const sessionActivity = useStore((s) => s.sessionActivity);
  const pendingPrompts = useStore((s) => s.pendingPrompts);
  const pendingSet = useMemo(() => new Set(pendingPrompts.map((p) => p.session)), [pendingPrompts]);
  const workspaces = useStore((s) => s.workspaces);
  const focusSession = useStore((s) => s.focusSession);
  const setView = useStore((s) => s.setView);
  const switchWorkspace = useStore((s) => s.switchWorkspace);
  const openLauncher = useLauncher((s) => s.open);
  const setNewWorkspace = useOverlay((s) => s.setNewWorkspace);
  const setShell = useOverlay((s) => s.setShell);

  // Fleet of per-workspace containers. Polled ~3s so a lifecycle action
  // (start/stop/restart/remove) shows up without a manual refresh. Each entry
  // already carries its container's real state/id/image.
  const [fleet, setFleet] = useState<WorkspaceContainer[]>([]);
  useEffect(() => {
    let alive = true;
    const tick = () => {
      ipc
        .listWorkspaceContainers()
        .then((c) => alive && setFleet(c))
        .catch(() => alive && setFleet([]));
    };
    tick();
    const h = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, []);

  // Selected container key from the fleet. Null when the fleet is empty (no
  // workspace containers exist yet). Switching clears the live stats + sparkline
  // window so two containers' series never splice together.
  const [selected, setSelected] = useState<string | null>(null);
  const [fleetFilter, setFleetFilter] = useState<"all" | "running" | "stopped">("all");
  const [wsStats, setWsStats] = useState<ContainerStats | null>(null);
  const [history, setHistory] = useState<ContainerStats[]>([]);
  const selectContainer = (key: string | null) => {
    setSelected(key);
    setWsStats(null);
    setHistory([]);
  };
  const selectedWs = selected ? fleet.find((c) => c.key === selected) : undefined;
  // Auto-select the first fleet entry when nothing is selected yet (initial load)
  // or when the selected workspace was pruned / removed. Falls back to null when
  // the fleet is empty so the detail pane shows an honest empty state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectContainer is stable (only calls setState fns).
  useEffect(() => {
    if (selected && !fleet.some((c) => c.key === selected)) {
      selectContainer(fleet[0]?.key ?? null);
    } else if (!selected && fleet.length > 0) {
      selectContainer(fleet[0].key);
    }
  }, [selected, fleet]);

  // Resolved identity for the detail pane: the selected workspace container's
  // status carried in the fleet listing (no extra status poll needed). Null when
  // the fleet is empty (no workspace containers exist yet).
  const vmStatus = selectedWs?.status ?? null;
  const name = vmStatus?.name ?? selected ?? "—";
  const compactName = compactContainerName(name, selected ?? undefined);
  const state: ContainerState = vmStatus?.state ?? "missing";
  const dot = STATE_DOT[state];
  const image = vmStatus?.image ?? "—";
  const id = vmStatus?.id ?? null;
  const running = state === "running";

  // Sessions attached to the container in view, filtered by containerKey. Agent
  // lists exclude the docked bash shell; lifecycle confirms still count every
  // tmux session because restart/stop affects utilities too.
  const attachedSessions = useMemo(
    () =>
      selected ? Object.entries(sessionMeta).filter(([, m]) => m.containerKey === selected) : [],
    [sessionMeta, selected],
  );
  const sessions = useMemo(
    () => attachedSessions.filter(([, m]) => m.cli !== "shell"),
    [attachedSessions],
  );

  useEffect(() => {
    if (!selected || !running) {
      setWsStats(null);
      return;
    }
    let alive = true;
    const tick = () => {
      ipc
        .containerStats(selected)
        .then((s) => alive && setWsStats(s))
        .catch(() => alive && setWsStats(null));
    };
    tick();
    const h = setInterval(tick, STATS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [selected, running]);
  const stats = wsStats;

  // Rolling window of the last N samples (newest last) so the gauges draw a real
  // sparkline of where each metric has actually been — not a fabricated series.
  // Cleared whenever the container goes down so a restart starts fresh.
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
        .containerLogs(200, selected ?? undefined)
        .then((l) => alive && setLogs(l))
        .catch(() => alive && setLogs(null));
    };
    tick();
    const h = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [running, selected]);

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
      .containerMounts(selected ?? undefined)
      .then((m) => alive && setMounts(m))
      .catch(() => alive && setMounts(null));
    return () => {
      alive = false;
    };
  }, [running, selected]);

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
      .containerImage(selected ?? undefined)
      .then((i) => alive && setImageInfo(i))
      .catch(() => alive && setImageInfo(null));
    return () => {
      alive = false;
    };
  }, [running, selected]);

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
        .containerHealth(selected ?? undefined)
        .then((h) => alive && setHealth(h))
        .catch(() => alive && setHealth(null));
    };
    tick();
    const h = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [running, selected]);


  const open = (session: string) => {
    focusSession(session);
    setView("hub");
  };

  const workspaceLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const ws of workspaces) labels[ws.containerKey] = `Workspace ${ws.plate}`;
    return labels;
  }, [workspaces]);
  const selectedWorkspaceLabel = selected
    ? (workspaceLabels[selected] ?? labelWorkspaceKey(selected))
    : "No workspace";
  const selectedAppWorkspace = selected
    ? (workspaces.find((w) => w.containerKey === selected) ?? null)
    : null;
  const openSelectedWorkspace = () => {
    if (selectedAppWorkspace) switchWorkspace(selectedAppWorkspace.id);
    setView("hub");
  };
  const openShell = () => {
    openSelectedWorkspace();
    setShell(true);
  };
  const attachAgent = () => {
    openSelectedWorkspace();
    openLauncher("inspector-attach");
  };

  // Per-container busy tracking so lifecycle actions only disable the affected container.
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  const lifecycleBusy = selected ? busyKeys.has(selected) : false;
  const loadFleet = () =>
    ipc
      .listWorkspaceContainers()
      .then(setFleet)
      .catch(() => setFleet([]));
  const lifecycle = (key: string, action: () => Promise<unknown>) => {
    if (busyKeys.has(key)) return;
    setBusyKeys((s) => new Set(s).add(key));
    void action()
      .then(loadFleet)
      .finally(() =>
        setBusyKeys((s) => {
          const n = new Set(s);
          n.delete(key);
          return n;
        }),
      );
  };
  const doStart = () => selected && lifecycle(selected, () => ipc.containerStart(selected));
  const doStop = () => selected && lifecycle(selected, () => ipc.containerStop(selected));
  const doRestart = () => selected && lifecycle(selected, () => ipc.containerRestart(selected));
  const doRemove = () => {
    if (!selected || busyKeys.has(selected)) return;
    const key = selected;
    setBusyKeys((s) => new Set(s).add(key));
    void ipc
      .removeWorkspaceContainer(key)
      .then(() => {
        selectContainer(fleet.find((c) => c.key !== key)?.key ?? null);
        return loadFleet();
      })
      .finally(() =>
        setBusyKeys((s) => {
          const n = new Set(s);
          n.delete(key);
          return n;
        }),
      );
  };

  // Fleet counts for the header line.
  const runningCount = fleet.filter((c) => c.status.state === "running").length;
  const stoppedCount = fleet.filter((c) => c.status.state !== "running").length;
  const visibleFleet = useMemo(
    () =>
      fleet.filter((c) => {
        if (fleetFilter === "running") return c.status.state === "running";
        if (fleetFilter === "stopped") return c.status.state !== "running";
        return true;
      }),
    [fleet, fleetFilter],
  );
  // Per-card session groupings for the left list (each card shows ITS container's
  // attached agents, independent of which card is selected).
  const sessionsFor = (key: string) =>
    Object.entries(sessionMeta).filter(([, m]) => m.containerKey === key && m.cli !== "shell");

  const pruneStopped = async () => {
    const stopped = fleet.filter((c) => c.status.state !== "running");
    if (stopped.length === 0) return;
    await Promise.all(stopped.map((c) => ipc.removeWorkspaceContainer(c.key)));
    if (selected && stopped.some((c) => c.key === selected)) {
      selectContainer(fleet.find((c) => c.status.state === "running")?.key ?? null);
    }
    await loadFleet();
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
            {`${runningCount} running · ${stoppedCount} stopped · 1 container per workspace`}
            {dockerInfo?.version && ` · docker ${dockerInfo.version}`}
          </span>
          <span style={{ flex: 1 }} />
          {stoppedCount > 0 && (
            <Button size="sm" variant="outline" onClick={() => void pruneStopped()}>
              Prune stopped
            </Button>
          )}
          <Button size="sm" onClick={() => setNewWorkspace(true)}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {Ico.plus}New workspace
            </span>
          </Button>
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* list — one card per per-workspace container */}
        <div
          style={{
            flex: "0 0 320px",
            borderRight: "1px solid var(--bd-soft)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              padding: "10px 14px",
              display: "flex",
              gap: 6,
              borderBottom: "1px solid var(--bd-soft)",
            }}
          >
            {(["all", "running", "stopped"] as const).map((f) => (
              <Button
                key={f}
                size="xs"
                variant={fleetFilter === f ? "outline" : "ghost"}
                onClick={() => setFleetFilter(f)}
                style={{ textTransform: "capitalize" }}
              >
                {f}
              </Button>
            ))}
          </div>
          <div
            className="scroll"
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              gap: 6,
              overflow: "auto",
              padding: 8,
            }}
          >
            {fleet.length === 0 && (
              <div
                className="mono"
                style={{
                  padding: "28px 14px",
                  textAlign: "center",
                  fontSize: 11.5,
                  color: "var(--fg-3)",
                }}
              >
                No workspace containers yet. Create one from the hub.
              </div>
            )}
            {fleet.length > 0 && visibleFleet.length === 0 && (
              <div
                className="mono"
                style={{
                  padding: "28px 14px",
                  textAlign: "center",
                  fontSize: 11.5,
                  color: "var(--fg-3)",
                }}
              >
                No containers match this filter.
              </div>
            )}
            {visibleFleet.map((c) => (
              <ContainerCard
                key={c.key}
                active={selected === c.key}
                onSelect={() => selectContainer(c.key)}
                state={c.status.state}
                workspace={workspaceLabels[c.key] ?? labelWorkspaceKey(c.key)}
                containerKey={c.key}
                name={c.status.name}
                image={c.status.image}
                agents={sessionsFor(c.key).map(([, m]) => m.cli)}
                // Only the selected workspace polls live stats; others show em-dash
                // rather than a fabricated number.
                stats={selected === c.key ? wsStats : null}
              />
            ))}
          </div>
        </div>

        {/* detail */}
        <div className="scroll" style={{ flex: 1, overflow: "auto", padding: "18px 22px", display: "flex", flexDirection: "column" }}>
          {/* hero */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 14 }}>
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
                  {compactName}
                </h2>
                <StatusBadge status={dot} />
              </div>
              <div
                className="mono"
                title={name}
                style={{
                  fontSize: 11.5,
                  color: "var(--fg-2)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {selectedWorkspaceLabel} · {image}
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
              sessionCount={attachedSessions.length}
              kind="workspace"
              busy={lifecycleBusy}
              onShell={running && selectedAppWorkspace ? openShell : undefined}
              onStart={doStart}
              onStop={doStop}
              onRestart={doRestart}
              onRemove={doRemove}
            />
          </div>

          {/* metrics row — live container_stats (em-dash until the first poll
              resolves, or whenever the runtime is down). */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 10,
              marginBottom: 14,
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

          {/* attached agents + mounts (side by side) */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
              marginBottom: 14,
            }}
          >
            <div className="ch-card" style={{ padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 8, gap: 8 }}>
                <span className="lbl">Attached agents · {sessions.length}</span>
                <span style={{ flex: 1 }} />
                {selectedAppWorkspace && (
                  <Button size="xs" variant="outline" onClick={attachAgent}>
                    {Ico.plus}
                    Attach agent
                  </Button>
                )}
              </div>
              {sessions.length === 0 ? (
                <div
                  className="mono"
                  style={{ fontSize: 11.5, color: "var(--fg-3)", padding: "6px 0" }}
                >
                  No agents attached. Press ⌘N or use Attach agent to start one.
                </div>
              ) : (
                sessions.map(([session, meta]) => {
                  const act = sessionActivity[session];
                  const awaiting = pendingSet.has(session);
                  const ws = workspaces.find((w) => w.id === meta.workspaceId);
                  const badge = MODE_BY_ID[meta.mode].badge;
                  const stLabel = awaiting
                    ? "awaiting"
                    : act?.state === "working"
                      ? "working"
                      : "idle";
                  const stColor = awaiting
                    ? "var(--wait)"
                    : act?.state === "working"
                      ? "var(--live)"
                      : "var(--fg-3)";
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
                      <StatusDot
                        status={awaiting ? "wait" : act?.state === "working" ? "live" : "idle"}
                        pulse={act?.state === "working"}
                      />
                      <AgentGlyph agent={meta.cli} size={13} color={`var(--a-${meta.cli})`} />
                      <span className="mono" style={{ fontSize: 12, color: "var(--fg-0)" }}>
                        {meta.alias}
                      </span>
                      {badge && <span className={`mode-badge badge-${meta.mode}`}>{badge}</span>}
                      <span style={{ flex: 1 }} />
                      <span className="mono" style={{ fontSize: 10.5, color: stColor }}>
                        {SPEC_BY_CLI[meta.cli].label}
                        {ws && ` · tab ${ws.plate}`}
                        {` · ${stLabel}`}
                      </span>
                      <IconBtn title="Open in Hub" onClick={() => open(session)}>
                        {Ico.arrowR}
                      </IconBtn>
                    </div>
                  );
                })
              )}
              {/* image info inline (design layout) */}
              {imageInfo && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 0 0",
                    marginTop: 6,
                    borderTop: "1px solid var(--bd-soft)",
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                    color: "var(--fg-2)",
                  }}
                >
                  <span className="lbl" style={{ letterSpacing: "0.08em" }}>
                    Image
                  </span>
                  <span style={{ color: "var(--fg-1)" }}>{imageInfo.tag ?? "—"}</span>
                  <span style={{ flex: 1 }} />
                  {imageInfo.size != null && (
                    <span style={{ color: "var(--fg-3)" }}>{fmtBytes(imageInfo.size)}</span>
                  )}
                </div>
              )}
            </div>

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

          {/* logs — tail of `docker logs`, polled by container_logs (~4s). */}
          <div className="ch-card" style={{ padding: 0, flex: 1, minHeight: 120, display: "flex", flexDirection: "column" }}>
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
              {running && (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    fontSize: 11,
                    color: "var(--live)",
                  }}
                >
                  <StatusDot status="live" pulse /> Live
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

function GaugeCard({
  label,
  value,
  sub,
  spark,
}: {
  label: string;
  value?: string | null;
  sub?: string;
  fill?: number | null;
  spark?: number[];
}) {
  const hasSpark = !!spark && spark.length >= 2;
  return (
    <div
      className="ch-card"
      style={{
        padding: 0,
        display: "flex",
        alignItems: "stretch",
        overflow: "hidden",
        minHeight: 56,
      }}
    >
      <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", justifyContent: "center", flexShrink: 0, minWidth: 80, gap: 1 }}>
        <div className="lbl" style={{ fontSize: 9.5 }}>{label}</div>
        <span
          className="mono tnum"
          style={{ fontSize: 16, color: value ? "var(--fg-0)" : "var(--fg-3)", fontWeight: 500, lineHeight: 1.1 }}
        >
          {value ?? "—"}
        </span>
        {value && sub && (
          <span className="mono tnum" style={{ fontSize: 10, color: "var(--fg-3)", lineHeight: 1.2 }}>
            {sub}
          </span>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
        {hasSpark ? (
          <Spark data={spark} w={200} h={56} color="var(--live)" fill responsive />
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              background: value
                ? "var(--bg-3)"
                : "repeating-linear-gradient(135deg, var(--bg-3) 0 4px, transparent 4px 8px)",
              opacity: value ? 0.3 : 0.25,
            }}
          />
        )}
      </div>
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
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "var(--mono)",
          fontSize: 11.5,
          color: "var(--fg-3)",
          lineHeight: 1.6,
          textAlign: "center",
        }}
      >
        {running ? (
          "Reading container log…"
        ) : (
          <span>
            Container is not running.
            <br />
            Start it to tail <span style={{ color: "var(--fg-1)" }}>docker logs {name}</span>.
          </span>
        )}
      </div>
    );
  }

  if (lines.length === 0) {
    return (
      <div
        className="mono"
        style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11.5, color: "var(--fg-3)" }}
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
        flex: 1,
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

// Runtime lifecycle controls in the inspector hero. Start when the container is
// down; Restart/Stop when it's up. Stop/Restart kill every attached tmux session
// (the bollard execs die with the container), so both gate behind a confirm that
// names how many live sessions go with it. `starting` shows a disabled spinner
// label; `unreachable` (daemon down) offers nothing actionable.
function RuntimeControls({
  state,
  sessionCount,
  kind = "workspace",
  busy,
  onShell,
  onStart,
  onStop,
  onRestart,
  onRemove,
}: {
  state: ContainerState;
  sessionCount: number;
  kind?: string;
  busy?: boolean;
  onShell?: () => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onRemove?: () => void;
}) {
  const sessionsClause =
    sessionCount > 0
      ? ` This kills ${sessionCount} attached session${sessionCount === 1 ? "" : "s"}.`
      : "";
  const confirmStop = () => {
    if (window.confirm(`Stop the ${kind}?${sessionsClause}`)) onStop();
  };
  const confirmRestart = () => {
    if (window.confirm(`Restart the ${kind}?${sessionsClause}`)) onRestart();
  };
  const confirmRemove = () => {
    if (
      onRemove &&
      window.confirm(
        `Remove this ${kind} container? Bind-mounted /workspace files are preserved; container-local state is lost.`,
      )
    )
      onRemove();
  };

  if (state === "starting" || busy) {
    return (
      <Button size="sm" variant="outline" disabled>
        {busy ? "Working…" : "Starting…"}
      </Button>
    );
  }
  if (state === "stopped" || state === "missing") {
    return (
      <div style={{ display: "flex", gap: 8 }}>
        <Button size="sm" onClick={onStart}>
          {state === "missing" ? "Create & start" : "Start"}
        </Button>
        {onRemove && state === "stopped" && (
          <Button size="sm" variant="destructive" onClick={confirmRemove}>
            Remove
          </Button>
        )}
      </div>
    );
  }
  if (state === "running") {
    return (
      <div style={{ display: "flex", gap: 8 }}>
        {onShell && (
          <Button size="sm" variant="outline" onClick={onShell}>
            Exec shell
          </Button>
        )}
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

// One row in the left fleet list — a per-workspace container. A button
// (selectable); the active one gets an accent border. Stats are passed in
// (null → em-dash) rather than fetched here so each card stays a pure render
// of data the parent already owns.
// Fallback label for a container with no matching SAVED workspace (an orphan
// from a prior run). Append the key suffix so it stays distinct from the live
// "Workspace N" — otherwise two ws-N containers collide on the same bare label.
function labelWorkspaceKey(key: string) {
  const m = /^ws-(\d+)-(.+)/.exec(key);
  if (m) {
    const suffix = m[2].length > 8 ? m[2].slice(-8) : m[2];
    return `Workspace ${m[1]} · ${suffix}`;
  }
  const plain = /^ws-(\d+)$/.exec(key);
  return plain ? `Workspace ${plain[1]}` : truncateMiddle(key, 24);
}

function compactContainerName(name: string, key?: string) {
  const raw = name && name !== "—" ? name : (key ?? name);
  const stripped = raw.replace(/^codehub-ws-/, "");
  return truncateMiddle(stripped || raw, 24);
}

function compactContainerSuffix(name: string, key: string) {
  const raw = (name || key).replace(/^codehub-ws-/, "");
  const parts = raw.split("-");
  const suffix = parts[parts.length - 1] || raw;
  return suffix.length > 8 ? suffix.slice(-8) : suffix;
}

function truncateMiddle(value: string, max: number) {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 3) * 0.58);
  const tail = max - 3 - head;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function ContainerCard({
  active,
  onSelect,
  state,
  workspace,
  containerKey,
  name,
  image,
  agents,
  stats,
}: {
  active: boolean;
  onSelect: () => void;
  state: ContainerState;
  workspace: string;
  containerKey: string;
  name: string;
  image: string;
  agents: Cli[];
  stats: ContainerStats | null;
}) {
  const dot = STATE_DOT[state];
  const compactName = compactContainerName(name, containerKey);
  const suffix = compactContainerSuffix(name, containerKey);
  const imageLabel = image.replace(/:([^:/]+)$/, " $1");
  const dim = state !== "running" && state !== "starting";
  return (
    <button
      type="button"
      onClick={onSelect}
      title={`${workspace} · ${name}`}
      style={{
        all: "unset",
        cursor: "pointer",
        display: "block",
        width: "100%",
        boxSizing: "border-box",
        padding: "10px 12px",
        borderRadius: 7,
        background: active ? "var(--bg-3)" : "var(--bg-1)",
        border: `1px solid ${active ? "var(--bd-strong)" : "var(--bd-soft)"}`,
        opacity: dim ? 0.62 : 1,
        transition: "background .12s, border-color .12s, box-shadow .12s",
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = "var(--bg-2)";
          e.currentTarget.style.borderColor = "var(--bd)";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = "var(--bg-1)";
          e.currentTarget.style.borderColor = "var(--bd-soft)";
        }
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <StatusDot status={dot} pulse={dot === "live"} />
        <span
          className="mono"
          style={{
            fontSize: 12,
            color: "var(--fg-0)",
            fontWeight: 500,
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {workspace}
        </span>
        <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", flexShrink: 0 }}>
          {suffix}
        </span>
      </div>
      <div
        className="mono"
        style={{
          fontSize: 10.5,
          color: "var(--fg-2)",
          marginBottom: 4,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {compactName}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {agents.length === 0 ? (
            <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
              no sessions
            </span>
          ) : (
            agents.map((cli, i) => (
              <AgentGlyph
                // biome-ignore lint/suspicious/noArrayIndexKey: glyphs are a positional count, no stable id.
                key={i}
                agent={cli}
                size={11}
                color={`var(--a-${cli})`}
              />
            ))
          )}
        </div>
        <span
          className="mono tnum"
          style={{ fontSize: 10.5, color: "var(--fg-3)", whiteSpace: "nowrap" }}
        >
          {stats
            ? `cpu ${stats.cpuPct.toFixed(0)}% · mem ${fmtBytes(stats.memUsed)}`
            : "cpu — · mem —"}
        </span>
      </div>
      <div
        className="mono"
        style={{
          marginTop: 4,
          fontSize: 9.5,
          color: "var(--fg-3)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {imageLabel}
      </div>
    </button>
  );
}
