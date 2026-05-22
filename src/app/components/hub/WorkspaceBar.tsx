import { Ico } from "../../components/primitives/icons";
import { useStore } from "../../lib/store";

// Container-level info bar, ported from design/screens/main-hub-a.jsx. The
// container identity, runtime state and Docker version are real (Tier-1
// docker_info); repo / branch / CI / tests / lint / cpu / mem / cost are a
// per-workspace telemetry feed we do not collect yet (BACKEND_PLAN.md) — shown
// as em-dashes rather than fabricated values.
export function WorkspaceBar() {
  const status = useStore((s) => s.status);
  const dockerInfo = useStore((s) => s.dockerInfo);
  const live = status?.state === "running";

  return (
    <div
      style={{
        height: 32,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "0 14px",
        borderBottom: "1px solid var(--bd-soft)",
        background: "var(--bg-1)",
        flexShrink: 0,
        fontFamily: "var(--mono)",
        fontSize: 11,
        color: "var(--fg-2)",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--fg-1)" }}>
        {Ico.container}
        <span>{status?.name ?? "codehub-runtime"}</span>
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }} title="Runtime state">
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: live ? "var(--live)" : "var(--fg-3)",
          }}
        />
        <span style={{ color: "var(--fg-1)" }}>{status?.state ?? "—"}</span>
      </span>
      {dockerInfo?.version && (
        <>
          <span className="vr" style={{ height: 14 }} />
          <span title="Docker daemon version">docker {dockerInfo.version}</span>
        </>
      )}

      <span style={{ flex: 1 }} />

      {/* per-workspace telemetry — not collected yet (BACKEND_PLAN.md) */}
      <span title="Mounted workspace">{Ico.files}&nbsp;/workspace</span>
      <span className="vr" style={{ height: 14 }} />
      <span title="CPU — pending">cpu —</span>
      <span title="Memory — pending">mem —</span>
      <span title="Cost — pending">$ —</span>
    </div>
  );
}
