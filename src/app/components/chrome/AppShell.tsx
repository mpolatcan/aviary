/**
 * AppShell — macOS-style title bar + left rail slot + main content slot.
 * Composes the window chrome (traffic lights + title bar) from design/components.jsx AppChrome.
 * Does NOT replace the existing App.tsx — used only in the gallery and future screens.
 */
import type { ReactNode } from "react";

export interface AppShellProps {
  title?: string;
  rail?: ReactNode;
  railFramed?: boolean;
  children: ReactNode;
}

export function AppShell({ title = "CodeHub", rail, railFramed = true, children }: AppShellProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: "var(--bg-1)",
        overflow: "hidden",
      }}
    >
      {/* Title bar / traffic lights */}
      <div
        style={{
          height: 32,
          background: "var(--bg-0)",
          borderBottom: "1px solid var(--bd-soft)",
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          gap: 10,
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", gap: 6 }}>
          <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#3d3d3d" }} />
          <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#3d3d3d" }} />
          <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#3d3d3d" }} />
        </div>
        <div
          style={{
            flex: 1,
            textAlign: "center",
            fontSize: "var(--fs-12)",
            color: "var(--fg-2)",
            fontFamily: "var(--mono)",
            letterSpacing: 0.3,
          }}
        >
          {title}
        </div>
        <div style={{ width: 40 }} />
      </div>

      {/* Body: optional rail + main area */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {rail && !railFramed ? (
          rail
        ) : rail ? (
          <div
            style={{
              flexShrink: 0,
              borderRight: "1px solid var(--bd-soft)",
              background: "var(--bg-0)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {rail}
          </div>
        ) : null}
        <div style={{ flex: 1, overflow: "hidden" }}>{children}</div>
      </div>
    </div>
  );
}
