/**
 * KV — a label/value row for detail panels (Integrations, About, Codex meters).
 * Phase-0 stub primitive: real, minimal. Renders a muted monospace label and a
 * brighter value; a null/undefined value shows an em-dash (honesty contract:
 * absent data is never fabricated).
 */
import type { CSSProperties, ReactNode } from "react";

export interface KVProps {
  label: ReactNode;
  value?: ReactNode;
  /** Render the value in the monospace face (ids, versions, paths). */
  mono?: boolean;
  style?: CSSProperties;
}

export function KV({ label, value, mono = false, style }: KVProps) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 12,
        padding: "4px 0",
        ...style,
      }}
    >
      <span style={{ fontSize: "var(--fs-12)", color: "var(--fg-2)" }}>{label}</span>
      <span
        style={{
          fontSize: "var(--fs-12)",
          color: empty ? "var(--fg-3)" : "var(--fg-0)",
          fontFamily: mono ? "var(--mono)" : undefined,
          textAlign: "right",
        }}
      >
        {empty ? "—" : value}
      </span>
    </div>
  );
}
