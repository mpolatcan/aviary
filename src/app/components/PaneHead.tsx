import { useState } from "react";
import { AgentGlyph } from "../components/primitives/AgentGlyph";
import { ContextGauge } from "../components/primitives/ContextGauge";
import { IconBtn } from "../components/primitives/IconBtn";
import { MetricStat } from "../components/primitives/MetricStat";
import { StatusDot } from "../components/primitives/StatusDot";
import { Ico } from "../components/primitives/icons";
import { fmtTokens, useSessionUsage } from "../hooks/useSessionUsage";
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
export function PaneHead({ session }: { session: string }) {
  const meta = useStore((s) => s.sessionMeta[session]);
  const agentVersions = useStore((s) => s.agentVersions);
  const activity = useStore((s) => s.sessionActivity[session]);
  const splitSession = useStore((s) => s.splitSession);
  const closeSession = useStore((s) => s.closeSession);
  const renameSession = useStore((s) => s.renameSession);
  const openDetail = useStore((s) => s.openDetail);
  const openKey = useLauncher((s) => s.openKey);
  const ctx = useLauncher((s) => s.ctx);
  const openLaunch = useLauncher((s) => s.open);
  const closeLaunch = useLauncher((s) => s.close);
  const [editing, setEditing] = useState(false);

  // Real per-session token tally, read from this Claude conversation's own
  // transcript (the --session-id it launched with). Only Claude sessions have a
  // transcript, so others keep em-dash placeholders; null = no usable data yet
  // (a session that hasn't responded) → em-dash too. The id prefers the
  // backend-sourced activity entry (registered at launch, stable across a
  // reload) and falls back to the in-memory store meta. Called above the `!meta`
  // guard so the hook count stays constant even as a session is torn down
  // (closeSession drops meta before the tree drops the leaf).
  const claudeId = activity?.claudeId ?? (meta?.cli === "claude" ? meta.claudeId : undefined);
  const usage = useSessionUsage(claudeId);

  if (!meta) return null;
  const spec = SPEC_BY_CLI[meta.cli];
  const accent = `var(--a-${meta.cli})`;
  const badge = MODE_BY_ID[meta.mode].badge;
  const version = agentVersions?.[meta.cli]?.version ?? null;
  const key = splitKey(session);
  const isOpen = openKey === key;
  // Real per-session signal from pane output flow (session_activity): the agent
  // is "working" while producing output, else quiet. The dot reflects that — it
  // means "is this agent working", independent of which pane you're looking at
  // (focus is shown by the pane border). Quiet conflates idle/waiting/done; we
  // don't fabricate which. Absent reading (pre-first-poll) → idle.
  const working = activity?.state === "working";
  const status = working ? "live" : "idle";

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
        <StatusDot status={status} pulse={working} />
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

      {/* metric row — turn + tokens are REAL for Claude (read from this session's
          transcript via --session-id; em-dash for other CLIs or before the first
          response). ctx/cost/edits stay em-dash: no reliable per-session source
          (cost lives on Usage with its estimate disclosure). */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "0 12px 7px" }}>
        <ContextGauge used={0} max={0} label="ctx" width={90} />
        <span className="vr" style={{ height: 16 }} />
        <MetricStat label="turn" value={usage ? String(usage.turns) : "—"} />
        <MetricStat
          label="tokens"
          value={usage ? fmtTokens(usage.tokensIn + usage.tokensOut) : "—"}
        />
        <MetricStat label="cost" value="—" />
        <MetricStat label="edits" value="—" />
        <span style={{ flex: 1 }} />
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 10.5,
            color: working ? "var(--live)" : "var(--fg-3)",
          }}
        >
          {working && (
            <span style={{ width: 4, height: 4, borderRadius: "50%", background: "var(--live)" }} />
          )}
          {working ? "working" : "idle"}
        </span>
      </div>
    </div>
  );
}
