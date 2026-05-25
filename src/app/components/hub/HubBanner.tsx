import type { ReactNode } from "react";

// A full-width notice strip that docks flush at the top of the hub main region,
// above the tab bar's content. Ported from design/screens/hub-states.jsx
// `HubBanner`. Tone drives the accent (error / warning / info / ok); the body is
// an icon + title + optional message, with an actions slot pinned right.
//
// Presentational only — it fabricates nothing. Callers pass real copy and wire
// the action buttons to real store actions (see the Disconnected banner in
// HubView, the one live caller today).

export type BannerTone = "err" | "warn" | "info" | "ok";

const TONE_COLOR: Record<BannerTone, string> = {
  err: "var(--err)",
  warn: "var(--wait)",
  info: "var(--pri)",
  ok: "var(--live)",
};

export interface HubBannerProps {
  tone?: BannerTone;
  icon?: ReactNode;
  title: ReactNode;
  message?: ReactNode;
  /** Right-aligned action slot (buttons, retry counters, etc.). */
  actions?: ReactNode;
}

export function HubBanner({ tone = "warn", icon, title, message, actions }: HubBannerProps) {
  const toneColor = TONE_COLOR[tone];
  return (
    <div
      // biome-ignore lint/a11y/useSemanticElements: a multi-tone notice strip is a generic live region, not an <output>
      role="status"
      style={{
        flexShrink: 0,
        background: `color-mix(in oklab, ${toneColor} 14%, var(--bg-1))`,
        borderBottom: `1px solid color-mix(in oklab, ${toneColor} 35%, var(--bd-soft))`,
        padding: "8px 16px",
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: 13,
      }}
    >
      {icon && <span style={{ color: toneColor, display: "inline-flex" }}>{icon}</span>}
      <span style={{ color: "var(--fg-0)", fontWeight: 500 }}>{title}</span>
      {message && <span style={{ color: "var(--fg-2)" }}>· {message}</span>}
      <span style={{ flex: 1 }} />
      {actions}
    </div>
  );
}
