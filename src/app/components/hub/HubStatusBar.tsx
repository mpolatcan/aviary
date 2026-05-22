import type { ContainerState } from "../../lib/ipc";
import { activeWorkspace, useStore } from "../../lib/store";

// Bottom status bar, ported from design/screens/main-hub-a.jsx. Runtime state,
// focused session and tab are real; cpu / mem / net are a runtime telemetry feed
// not collected yet (BACKEND_PLAN.md) — shown as em-dashes.
const STATE_LABEL: Record<ContainerState, string> = {
  missing: "no runtime",
  stopped: "stopped",
  starting: "waking",
  running: "running",
  unreachable: "unreachable",
};

const STATE_COLOR: Record<ContainerState, string> = {
  missing: "var(--fg-3)",
  stopped: "var(--fg-3)",
  starting: "var(--wait)",
  running: "var(--live)",
  unreachable: "var(--err)",
};

export function HubStatusBar() {
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const active = useStore(activeWorkspace);
  const focused = active?.focused ?? null;
  const focusedAlias = useStore((s) => (focused ? s.sessionMeta[focused]?.alias : undefined));

  const state: ContainerState = error ? "unreachable" : (status?.state ?? "starting");

  return (
    <div
      style={{
        height: 26,
        flexShrink: 0,
        background: "var(--bg-0)",
        borderTop: "1px solid var(--bd-soft)",
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        gap: 14,
        fontFamily: "var(--mono)",
        fontSize: 11,
        color: "var(--fg-2)",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <span
          style={{ width: 6, height: 6, borderRadius: "50%", background: STATE_COLOR[state] }}
        />
        <span style={{ color: "var(--fg-1)" }}>{STATE_LABEL[state]}</span>
      </span>
      <span>session {focusedAlias ?? "—"}</span>
      <span>tab {active ? active.plate : "—"}</span>
      <span title="CPU — pending">cpu —</span>
      <span title="Memory — pending">mem —</span>
      <span title="Net — pending">net —</span>
      <span style={{ flex: 1 }} />
      <span>⌘N new</span>
      <span>⌘\ split</span>
      <span>⌘1–9 jump</span>
    </div>
  );
}
