/**
 * PaneTypeChip — a small labelled chip distinguishing a pane's kind (agent /
 * shell / files). Phase-0 stub primitive: real component, minimal styling. The
 * parallel fleet composes it into the Workspace + Hub headers.
 */
import type { CSSProperties } from "react";

export type PaneKind = "agent" | "shell" | "files";

export interface PaneTypeChipProps {
  kind: PaneKind;
  style?: CSSProperties;
}

const META: Record<PaneKind, { label: string; accent: string }> = {
  agent: { label: "agent", accent: "var(--a-claude)" },
  shell: { label: "shell", accent: "var(--a-shell)" },
  files: { label: "files", accent: "var(--fg-2)" },
};

export function PaneTypeChip({ kind, style }: PaneTypeChipProps) {
  const { label, accent } = META[kind];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontFamily: "var(--mono)",
        fontSize: "var(--fs-10)",
        lineHeight: 1,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: accent,
        background: `color-mix(in oklab, ${accent} 12%, transparent)`,
        border: `1px solid color-mix(in oklab, ${accent} 32%, transparent)`,
        padding: "2px 6px",
        borderRadius: 4,
        ...style,
      }}
    >
      {label}
    </span>
  );
}
