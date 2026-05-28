import { useState } from "react";
import { ContextGauge } from "../components/primitives/ContextGauge";
import { IconBtn } from "../components/primitives/IconBtn";
import { MetricStat } from "../components/primitives/MetricStat";
import { StatusBadge } from "../components/primitives/StatusBadge";
import { Ico } from "../components/primitives/icons";
import { fmtTokens, useSessionUsage } from "../hooks/useSessionUsage";
import { MODE_BY_ID, SPEC_BY_CLI } from "../lib/catalog";
import { useOverlay } from "../lib/overlay";
import { confirmCloseRunningSession, useStore } from "../lib/store";
import { leavesList } from "../lib/tree";

// Pane header, visually aligned with design/screens/main-hub-a.jsx:
// index + colored pane title + compact selector chip + expand/more/close, with
// the metric strip below. Values stay real; unknown telemetry renders as an
// em-dash rather than copying the mock's sample numbers.
export function PaneHead({
  session,
  index,
  draggable,
  onDragStart,
  onDragEnd,
}: {
  session: string;
  index?: number;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}) {
  const meta = useStore((s) => s.sessionMeta[session]);
  const agentVersions = useStore((s) => s.agentVersions);
  const activity = useStore((s) => s.sessionActivity[session]);
  const focused = useStore((s) =>
    s.workspaces.some((w) => w.groups.some((g) => g.focused === session)),
  );
  const siblings = useStore((s) => {
    for (const w of s.workspaces)
      for (const g of w.groups) {
        const ls = leavesList(g.root);
        if (ls.includes(session)) return ls.length;
      }
    return 1;
  });
  const awaiting = useStore((s) => s.pendingPrompts.some((p) => p.session === session));
  const closeSession = useStore((s) => s.closeSession);
  const renameSession = useStore((s) => s.renameSession);
  const focusSession = useStore((s) => s.focusSession);
  const focusMode = useOverlay((s) => s.focusMode);
  const setFocusMode = useOverlay((s) => s.setFocusMode);
  const [editing, setEditing] = useState(false);

  const claudeId = activity?.claudeId ?? (meta?.cli === "claude" ? meta.claudeId : undefined);
  const usage = useSessionUsage(claudeId);

  if (!meta) return null;

  const spec = SPEC_BY_CLI[meta.cli];
  const accent = `var(--a-${meta.cli})`;
  const badge = MODE_BY_ID[meta.mode].badge;
  const version = meta.cli === "shell" ? null : (agentVersions?.[meta.cli]?.version ?? null);
  const working = activity?.state === "working";
  const statusText = awaiting ? "Awaiting input" : working ? "Working" : "Idle";
  const canMax = siblings > 1;
  const isMax = focusMode && focused && canMax;

  return (
    <div
      style={{
        flex: "0 0 auto",
        background: awaiting ? `color-mix(in oklab, ${accent} 22%, var(--bg-1))` : "var(--bg-1)",
        borderBottom: awaiting
          ? `1px solid color-mix(in oklab, ${accent} 40%, var(--bd-soft))`
          : "1px solid var(--bd-soft)",
        color: "var(--fg-1)",
        userSelect: "none",
      }}
    >
      <div
        className="ch-pane-head"
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "7px 12px",
          cursor: draggable ? "grab" : undefined,
        }}
      >
        {typeof index === "number" && (
          <span
            className="mono"
            title={`Jump to pane ${index + 1} (⌘${index + 1})`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 18,
              height: 18,
              borderRadius: 4,
              fontSize: 10,
              fontWeight: 600,
              lineHeight: 1,
              color: focused ? "var(--bg-0)" : "var(--fg-2)",
              background: focused ? "var(--pri)" : "var(--bg-3)",
              border: `1px solid ${focused ? "var(--pri)" : "var(--bd-soft)"}`,
              flexShrink: 0,
            }}
          >
            {index + 1}
          </span>
        )}

        <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
          <span
            title={statusText}
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: accent,
              border: `1px solid color-mix(in oklab, ${accent} 60%, #000)`,
              boxShadow:
                working || awaiting
                  ? `0 0 0 3px color-mix(in oklab, ${accent} 22%, transparent)`
                  : "none",
              animation: working ? "ch-pulse 2s ease-in-out infinite" : "none",
              flexShrink: 0,
            }}
          />
          {editing ? (
            <input
              className="pane-name-input"
              defaultValue={meta.alias}
              maxLength={32}
              // biome-ignore lint/a11y/noAutofocus: rename input is opened by an explicit user action
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => {
                renameSession(session, e.currentTarget.value);
                setEditing(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  renameSession(session, e.currentTarget.value);
                  setEditing(false);
                } else if (e.key === "Escape") {
                  setEditing(false);
                }
              }}
            />
          ) : (
            <span
              className="mono"
              title="Double-click to rename"
              style={{ fontSize: 13, color: "var(--fg-0)", fontWeight: 500 }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditing(true);
              }}
            >
              {meta.alias}
            </span>
          )}
        </span>

        <button
          type="button"
          title={`${spec.label}${version ? ` · ${version}` : ""}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--fg-2)",
            background: "transparent",
            border: "1px solid transparent",
            borderRadius: 4,
            padding: "2px 5px",
            cursor: "default",
          }}
        >
          <span>{version ?? spec.label}</span>
          {Ico.chevD}
        </button>
        {badge && <span className={`mode-badge badge-${meta.mode}`}>{badge}</span>}
        {awaiting && <StatusBadge status="wait">Awaiting</StatusBadge>}

        <span style={{ flex: 1 }} />

        <IconBtn
          title={isMax ? "Restore split" : canMax ? "Maximize pane" : "Maximize — split first"}
          active={isMax}
          disabled={!canMax}
          style={{ width: 22, height: 22 }}
          onClick={(e) => {
            e.stopPropagation();
            if (isMax) {
              setFocusMode(false);
            } else {
              focusSession(session);
              setFocusMode(true);
            }
          }}
        >
          {isMax ? Ico.grid : Ico.expand}
        </IconBtn>
        <IconBtn
          title="More actions — right-click pane for split, copy, fullscreen…"
          style={{ width: 22, height: 22 }}
        >
          {Ico.more}
        </IconBtn>
        <IconBtn
          title="Close session (⌘W)"
          danger
          style={{ width: 22, height: 22 }}
          onClick={(e) => {
            e.stopPropagation();
            if (!confirmCloseRunningSession(session)) return;
            void closeSession(session);
          }}
        >
          {Ico.close}
        </IconBtn>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "4px 10px",
          background: "var(--bg-1)",
          borderTop: "1px solid var(--bd-soft)",
          fontSize: 10,
        }}
      >
        <ContextGauge used={usage?.contextUsed ?? 0} max={0} label="ctx" width={64} />
        <MetricStat label="turn" value={usage ? String(usage.turns) : "—"} />
        <MetricStat label="tok" value={usage ? fmtTokens(usage.tokensIn + usage.tokensOut) : "—"} />
        <MetricStat label="$" value="—" />
        <MetricStat label="edits" value={usage ? String(usage.edits) : "—"} />
        <span style={{ flex: 1 }} />
        <span
          className="mono"
          style={{
            fontSize: 10.5,
            color: awaiting ? "var(--wait)" : working ? "var(--live)" : "var(--fg-3)",
          }}
        >
          {awaiting ? "awaiting" : working ? "active" : "idle"}
        </span>
      </div>
    </div>
  );
}
