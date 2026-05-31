import { formatK } from "@/app/lib/format";

export interface ContextGaugeProps {
  used: number;
  max: number;
  label?: string;
  width?: number;
}

export function ContextGauge({ used, max, label = "ctx", width = 110 }: ContextGaugeProps) {
  // Guard max <= 0 so an unset/zero context window yields 0%, not NaN%.
  const pct = max > 0 ? Math.min(1, used / max) : 0;
  const color = pct > 0.85 ? "var(--err)" : pct > 0.7 ? "var(--wait)" : "var(--fg-1)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, height: 18 }}>
      <span style={{ fontFamily: "var(--mono)", fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
        {label}
      </span>
      <span
        style={{
          width,
          height: 6,
          borderRadius: 999,
          background: "var(--bg-3)",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <span
          style={{
            display: "block",
            width: `${pct * 100}%`,
            height: "100%",
            background: color,
            borderRadius: "inherit",
          }}
        />
      </span>
      <span
        className="mono tnum"
        style={{ fontSize: "var(--fs-12)", color: "var(--fg-0)", fontWeight: 500 }}
      >
        {max > 0 ? (
          <>
            {formatK(used)}
            <span style={{ color: "var(--fg-3)", fontWeight: 400 }}> / {formatK(max)}</span>
          </>
        ) : (
          // No context-window feed yet: em-dash, not a fake "0 / 0".
          <span style={{ color: "var(--fg-3)" }}>—</span>
        )}
      </span>
    </span>
  );
}
