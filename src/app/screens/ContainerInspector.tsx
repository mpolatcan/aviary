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
  type MountInfo,
  ipc,
} from "@/app/lib/ipc";
import { useStore } from "@/app/lib/store";
import { useEffect, useRef, useState } from "react";

// container_status state → the shared StatusDot/Badge vocabulary.
const STATE_DOT: Record<ContainerState, StatusKey> = {
  running: "live",
  starting: "wait",
  stopped: "off",
  missing: "off",
  unreachable: "err",
};

const CONTAINER_MOUNT = "/workspace";

export function ContainerInspector() {
  const status = useStore((s) => s.status);
  const dockerInfo = useStore((s) => s.dockerInfo);
  const keyStatus = useStore((s) => s.keyStatus);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const workspaces = useStore((s) => s.workspaces);
  const focusSession = useStore((s) => s.focusSession);
  const setView = useStore((s) => s.setView);

  const name = status?.name ?? "codehub-runtime";
  const state = status?.state ?? "missing";
  const dot = STATE_DOT[state];
  const image = status?.image ?? "—";
  const id = status?.id ?? null;
  const sessions = Object.entries(sessionMeta);

  // Poll container_stats while the runtime is up and this view is mounted (the
  // gauges are only visible here). One-shot reads, ~2s apart; a failed read
  // (container stopped mid-poll) clears back to em-dash rather than freezing a
  // stale number. No backend event stream — polling is the contract.
  const [stats, setStats] = useState<ContainerStats | null>(null);
  const running = state === "running";
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
    const h = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [running]);

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
            Containers
          </h1>
          <span className="mono" style={{ fontSize: 12, color: "var(--fg-2)" }}>
            {state === "running" ? "1 running" : `0 running · ${state}`}
            {dockerInfo?.version && ` · docker ${dockerInfo.version}`}
          </span>
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
              </div>
            </div>
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
            />
            <GaugeCard
              label="Memory"
              value={stats ? fmtBytes(stats.memUsed) : null}
              sub={stats && stats.memLimit > 0 ? `/ ${fmtBytes(stats.memLimit)}` : undefined}
              fill={stats && stats.memLimit > 0 ? (stats.memUsed / stats.memLimit) * 100 : null}
            />
            <GaugeCard
              label="Net I/O"
              value={stats ? `↓${fmtBytes(stats.netRx)}` : null}
              sub={stats ? `↑${fmtBytes(stats.netTx)}` : undefined}
            />
            <GaugeCard label="Disk" value={stats ? fmtBytes(stats.disk) : null} />
          </div>

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

// One metric. `value === null` → em-dash + hatched bar (no reading yet / runtime
// down). With a value: shows it (+ optional `sub`), and a proportional bar when
// `fill` (0-100) is given — CPU/memory have a meaningful ratio; net/disk don't,
// so they render value-only.
function GaugeCard({
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
      {value && typeof fill === "number" ? (
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
