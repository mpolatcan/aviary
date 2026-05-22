import { Ico } from "../../components/primitives/icons";

// Right activity rail, ported from design/screens/main-hub-a.jsx. The design
// shows a turn-event feed and an awaiting-input toast; both depend on an
// app-level event bus / permission-prompt stream the backend does not emit yet
// (today the CLIs' own prompts render inside the terminal). Rather than
// fabricate a feed, the rail shows an honest empty state until that backend
// surface exists (BACKEND_PLAN.md).
export function ActivityRail() {
  return (
    <aside
      style={{
        width: 280,
        flexShrink: 0,
        background: "var(--bg-1)",
        borderLeft: "1px solid var(--bd-soft)",
        display: "flex",
        flexDirection: "column",
        color: "var(--fg-1)",
      }}
    >
      <div
        style={{
          padding: "12px 14px",
          borderBottom: "1px solid var(--bd-soft)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span className="lbl">Activity</span>
      </div>

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          padding: 24,
          textAlign: "center",
          color: "var(--fg-3)",
        }}
      >
        <span style={{ opacity: 0.5 }}>{Ico.bell}</span>
        <p style={{ margin: 0, fontSize: 12, color: "var(--fg-2)", lineHeight: 1.5 }}>
          No activity yet.
        </p>
        <p style={{ margin: 0, fontSize: 11, color: "var(--fg-3)", lineHeight: 1.5 }}>
          Turn events and approval prompts will appear here.
        </p>
      </div>
    </aside>
  );
}
