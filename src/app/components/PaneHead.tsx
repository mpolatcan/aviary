import { useState } from "react";
import { AgentGlyph } from "../components/primitives/AgentGlyph";
import { IconBtn } from "../components/primitives/IconBtn";
import { MetricStat } from "../components/primitives/MetricStat";
import { StatusBadge } from "../components/primitives/StatusBadge";
import { StatusDot } from "../components/primitives/StatusDot";
import { Ico } from "../components/primitives/icons";
import { fmtTokens, useSessionUsage } from "../hooks/useSessionUsage";
import { MODE_BY_ID, SPEC_BY_CLI } from "../lib/catalog";
import { splitKey, useLauncher } from "../lib/launcher";
import { confirmCloseRunningSession, useStore } from "../lib/store";
import type { SplitDir } from "../lib/tree";

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
  // Awaiting-input signal for this pane (← pending_prompts / live agent-event,
  // §7). Real for Claude/Codex; empty for Antigravity + until the BE track
  // lands. A pending prompt overrides the working/idle dot with "wait".
  const awaiting = useStore((s) => s.pendingPrompts.some((p) => p.session === session));
  const closeSession = useStore((s) => s.closeSession);
  const renameSession = useStore((s) => s.renameSession);
  const openDetail = useStore((s) => s.openDetail);
  const openLaunch = useLauncher((s) => s.open);
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
  // Shell panes have no CLI version to show; agent versions are keyed by agent.
  const version = meta.cli === "shell" ? null : (agentVersions?.[meta.cli]?.version ?? null);
  const key = splitKey(session);
  // Real per-session signal from pane output flow (session_activity): the agent
  // is "working" while producing output, else quiet. The dot reflects that — it
  // means "is this agent working", independent of which pane you're looking at
  // (focus is shown by the pane border). Quiet conflates idle/waiting/done; we
  // don't fabricate which. Absent reading (pre-first-poll) → idle.
  const working = activity?.state === "working";
  // Awaiting input wins over working/idle — it's a hard "this pane needs you".
  const status = awaiting ? "wait" : working ? "live" : "idle";

  // Open the shared spawn modal with this pane as the split target; SpawnModal
  // reads the dir/session from the launch context and calls splitSession.
  const armSplit = (dir: SplitDir) => openLaunch(key, { dir, session });

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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "var(--panehead-py, 7px) 12px 5px",
        }}
      >
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

        {awaiting && <StatusBadge status="wait">Awaiting</StatusBadge>}

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

        {/* split — opens the shared spawn modal targeting this pane */}
        <span style={{ display: "inline-flex", gap: 2 }}>
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

        <IconBtn
          title="Close session (⌘W)"
          danger
          style={{ width: 20, height: 20 }}
          onClick={(e) => {
            e.stopPropagation();
            if (!confirmCloseRunningSession(session)) return;
            void closeSession(session);
          }}
        >
          {Ico.close}
        </IconBtn>
      </div>

      {/* metric row — ctx + turn + tokens + edits are REAL for Claude (read from
          this session's transcript via --session-id; em-dash for other CLIs or
          before the first response). ctx is the live context footprint (tokens
          read last turn) shown as a bare count: the transcript has no window max
          and it varies by model/version, so no fabricated used/max ratio. cost
          stays em-dash: an estimate, surfaced on Usage with its disclosure. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "0 12px var(--panehead-py, 7px)",
        }}
      >
        <MetricStat label="ctx" value={usage ? fmtTokens(usage.contextUsed) : "—"} />
        <span className="vr" style={{ height: 16 }} />
        <MetricStat label="turn" value={usage ? String(usage.turns) : "—"} />
        <MetricStat
          label="tokens"
          value={usage ? fmtTokens(usage.tokensIn + usage.tokensOut) : "—"}
        />
        <MetricStat label="cost" value="—" />
        <MetricStat label="edits" value={usage ? String(usage.edits) : "—"} />
        <span style={{ flex: 1 }} />
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 10.5,
            color: awaiting ? "var(--wait)" : working ? "var(--live)" : "var(--fg-3)",
          }}
        >
          {(working || awaiting) && (
            <span
              style={{
                width: 4,
                height: 4,
                borderRadius: "50%",
                background: awaiting ? "var(--wait)" : "var(--live)",
              }}
            />
          )}
          {awaiting ? "awaiting" : working ? "working" : "idle"}
        </span>
      </div>
    </div>
  );
}
