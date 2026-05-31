import { STATUS, StatusDot } from "./StatusDot";
import type { StatusKey } from "./StatusDot";

export interface StatusBadgeProps {
  status?: StatusKey;
  children?: React.ReactNode;
}

export function StatusBadge({ status = "idle", children }: StatusBadgeProps) {
  const s = STATUS[status] ?? STATUS.idle;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontFamily: "var(--mono)",
        fontSize: "var(--fs-11)",
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        color: s.color,
        padding: "3px 7px",
        borderRadius: 4,
        background: `color-mix(in oklab, ${s.color} 12%, transparent)`,
      }}
    >
      <StatusDot status={status} pulse={status === "live"} />
      {children ?? s.label}
    </span>
  );
}
