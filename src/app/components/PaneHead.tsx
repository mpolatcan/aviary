import { useState } from "react";
import { AgentGlyph } from "../components/primitives/AgentGlyph";
import { ContextGauge } from "../components/primitives/ContextGauge";
import { IconBtn } from "../components/primitives/IconBtn";
import { MetricStat } from "../components/primitives/MetricStat";
import { StatusDot } from "../components/primitives/StatusDot";
import { Ico } from "../components/primitives/icons";
import { MODE_BY_ID, SPEC_BY_CLI } from "../lib/catalog";
import type { Cli, Mode } from "../lib/ipc";
import { splitKey, useLauncher } from "../lib/launcher";
import { useStore } from "../lib/store";
import type { SplitDir } from "../lib/tree";
import { LaunchPanel } from "./LaunchPanel";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";

// Pane header, ported from design/screens/main-hub-a.jsx (TerminalPane*). Two
// rows: identity (status · glyph · name · agent · mode) + a metric row
// (ContextGauge + MetricStat ×4). Identity, rename, split and close are wired to
// the live store. The metric values are placeholders pending a per-session
// telemetry feed (tokens / cost / turns / context) — see BACKEND_PLAN.md; shown
// as em-dashes rather than fabricated numbers.
export function PaneHead({ session, focused }: { session: string; focused: boolean }) {
  const meta = useStore((s) => s.sessionMeta[session]);
  const agentVersions = useStore((s) => s.agentVersions);
  const splitSession = useStore((s) => s.splitSession);
  const closeSession = useStore((s) => s.closeSession);
  const renameSession = useStore((s) => s.renameSession);
  const openDetail = useStore((s) => s.openDetail);
  const openKey = useLauncher((s) => s.openKey);
  const ctx = useLauncher((s) => s.ctx);
  const openLaunch = useLauncher((s) => s.open);
  const closeLaunch = useLauncher((s) => s.close);
  const [editing, setEditing] = useState(false);

  if (!meta) return null;
  const spec = SPEC_BY_CLI[meta.cli];
  const accent = `var(--a-${meta.cli})`;
  const badge = MODE_BY_ID[meta.mode].badge;
  const version = agentVersions?.[meta.cli]?.version ?? null;
  const key = splitKey(session);
  const isOpen = openKey === key;
  // Focus is the one real per-pane signal we have: the pane you're looking at is
  // "live", the rest sit idle. No fabricated activity state.
  const status = focused ? "live" : "idle";

  const armSplit = (dir: SplitDir) => openLaunch(key, { dir, session });
  const launch = (cli: Cli, mode: Mode) => {
    const dir = ctx?.dir ?? "row";
    closeLaunch();
    void splitSession(session, dir, cli, mode);
  };

  return (
    <div
      style={{
        flex: "0 0 auto",
        background: "var(--bg-1)",
        borderBottom: "1px solid var(--bd-soft)",
        color: "var(--fg-1)",
        userSelect: "none",
      }}
    >
      {/* identity row */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px 5px" }}>
        <StatusDot status={status} pulse={focused} />
        <AgentGlyph agent={meta.cli} size={13} color={accent} />

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
            style={{ fontSize: 12, color: "var(--fg-0)", fontWeight: 500 }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          >
            {meta.alias}
          </span>
        )}

        <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-2)" }}>
          {spec.label}
        </span>
        {version && (
          <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
            {version}
          </span>
        )}
        {badge && <span className={`mode-badge badge-${meta.mode}`}>{badge}</span>}

        <span style={{ flex: 1 }} />

        <IconBtn
          title="Open session detail"
          style={{ width: 20, height: 20 }}
          onClick={(e) => {
            e.stopPropagation();
            openDetail(session);
          }}
        >
          {Ico.expand}
        </IconBtn>

        {/* split — same anchored launcher popover as every other surface */}
        <Popover open={isOpen} onOpenChange={(o) => !o && closeLaunch()}>
          <PopoverAnchor asChild>
            {/* Stop mousedown reaching the pane-leaf focus handler: its DOM-focus
                steal trips Radix's focus-outside dismiss and closes instantly. */}
            <span
              style={{ display: "inline-flex", gap: 2 }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <IconBtn
                title="Split below"
                style={{ width: 20, height: 20 }}
                onClick={(e) => {
                  e.stopPropagation();
                  armSplit("col");
                }}
              >
                {Ico.splitH}
              </IconBtn>
              <IconBtn
                title="Split right (⌘\)"
                style={{ width: 20, height: 20 }}
                onClick={(e) => {
                  e.stopPropagation();
                  armSplit("row");
                }}
              >
                {Ico.splitV}
              </IconBtn>
            </span>
          </PopoverAnchor>
          <PopoverContent align="end" className="modal-panel popover-launch">
            {isOpen && <LaunchPanel kicker="Split — adds to this tab" onLaunch={launch} />}
          </PopoverContent>
        </Popover>

        <IconBtn
          title="Close session (⌘W)"
          danger
          style={{ width: 20, height: 20 }}
          onClick={(e) => {
            e.stopPropagation();
            void closeSession(session);
          }}
        >
          {Ico.close}
        </IconBtn>
      </div>

      {/* metric row — placeholder telemetry (BACKEND_PLAN.md) */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "0 12px 7px" }}>
        <ContextGauge used={0} max={0} label="ctx" width={90} />
        <span className="vr" style={{ height: 16 }} />
        <MetricStat label="turn" value="—" />
        <MetricStat label="tokens" value="—" />
        <MetricStat label="cost" value="—" />
        <MetricStat label="edits" value="—" />
        <span style={{ flex: 1 }} />
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 10.5,
            color: focused ? "var(--live)" : "var(--fg-3)",
          }}
        >
          {focused && (
            <span style={{ width: 4, height: 4, borderRadius: "50%", background: "var(--live)" }} />
          )}
          {focused ? "active" : "idle"}
        </span>
      </div>
    </div>
  );
}
