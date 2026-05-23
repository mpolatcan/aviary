/**
 * SessionDetail — the focused-session view. Opened from a pane's expand button
 * (PaneHead → openDetail). One session's live terminal fills the left; a tabbed
 * inspector on the right reuses the existing workspace backends.
 *
 * Honesty note: CodeHub runs every session on ONE shared runtime, so git and
 * container reads are workspace/runtime-wide, not per-session — the inspector is
 * labelled accordingly. The header metric strip (ctx / turn / tokens / edits) IS
 * per-session and REAL for Claude — read from this session's transcript via the
 * shared useSessionUsage hook (same source as the pane header). It is omitted for
 * non-Claude CLIs / before the first response, and cost stays off (it's an
 * estimate, surfaced only on the Usage screen with its disclosure).
 */
import { useEffect, useState } from "react";
import { PaneMount } from "../components/PaneMount";
import { DiffBody, diffCounts, parseDiff } from "../components/hub/DiffBody";
import { AgentGlyph } from "../components/primitives/AgentGlyph";
import { IconBtn } from "../components/primitives/IconBtn";
import { StatusDot } from "../components/primitives/StatusDot";
import { Ico } from "../components/primitives/icons";
import { fmtTokens, useSessionUsage } from "../hooks/useSessionUsage";
import { MODE_BY_ID, SPEC_BY_CLI } from "../lib/catalog";
import { ipc } from "../lib/ipc";
import { useStore } from "../lib/store";

type Tab = "diff" | "logs";

export function SessionDetail({ session }: { session: string }) {
  const meta = useStore((s) => s.sessionMeta[session]);
  const agentVersions = useStore((s) => s.agentVersions);
  const activity = useStore((s) => s.sessionActivity[session]);
  const running = useStore((s) => s.status?.state === "running");
  const closeDetail = useStore((s) => s.closeDetail);
  const closeSession = useStore((s) => s.closeSession);
  const [tab, setTab] = useState<Tab>("diff");

  // Real per-session token tally from this Claude conversation's transcript —
  // same hook + claudeId derivation as the pane header (prefer the backend
  // activity entry, reload-stable; fall back to in-memory store meta). Called
  // above the `!meta` guard so the hook count stays constant as a session is
  // torn down from this view (close drops meta before the tree drops the leaf).
  const claudeId = activity?.claudeId ?? (meta?.cli === "claude" ? meta.claudeId : undefined);
  const usage = useSessionUsage(claudeId);

  // Branch is workspace-wide (single runtime). Fetch once when running; it
  // changes rarely and is only a header label, so no polling.
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    if (!running) {
      setBranch(null);
      return;
    }
    let alive = true;
    ipc
      .containerGitStatus()
      .then((s) => alive && setBranch(s.branch))
      .catch(() => alive && setBranch(null));
    return () => {
      alive = false;
    };
  }, [running]);

  if (!meta) return null;
  const spec = SPEC_BY_CLI[meta.cli];
  const accent = `var(--a-${meta.cli})`;
  const badge = MODE_BY_ID[meta.mode].badge;
  const version = meta.cli === "shell" ? null : (agentVersions?.[meta.cli]?.version ?? null);

  return (
    <main
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        background: "var(--bg-1)",
        color: "var(--fg-1)",
      }}
    >
      {/* header — breadcrumb back to Hub + session identity + branch */}
      <div
        style={{
          height: 48,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 14px",
          borderBottom: "1px solid var(--bd-soft)",
          background: "var(--bg-1)",
        }}
      >
        <button
          type="button"
          onClick={closeDetail}
          className="mono"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 8px",
            background: "transparent",
            border: "1px solid var(--bd-soft)",
            borderRadius: 6,
            color: "var(--fg-2)",
            cursor: "pointer",
            fontSize: 11.5,
          }}
        >
          <span style={{ display: "inline-flex", transform: "scaleX(-1)" }}>{Ico.arrowR}</span>
          Hub
        </button>

        <span className="vr" style={{ height: 18 }} />

        <StatusDot status={running ? "live" : "off"} pulse={running} />
        <AgentGlyph agent={meta.cli} size={14} color={accent} />
        <span className="mono" style={{ fontSize: 13, color: "var(--fg-0)", fontWeight: 500 }}>
          {meta.alias}
        </span>
        <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>
          {spec.label}
          {version && ` · ${version}`}
        </span>
        {badge && <span className={`mode-badge badge-${meta.mode}`}>{badge}</span>}

        {/* per-session metric strip — REAL for Claude (transcript via the shared
            useSessionUsage hook); rendered only when there's usable data. ctx is
            the live context footprint (last-turn read), shown as a bare count: no
            window max is recorded and it varies by model, so no fabricated ratio.
            cost is omitted — an estimate, surfaced only on Usage. */}
        {usage && (
          <span
            className="mono tnum"
            style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 11 }}
          >
            <span className="vr" style={{ height: 16 }} />
            <Metric label="ctx" value={fmtTokens(usage.contextUsed)} />
            <Metric label="turn" value={String(usage.turns)} />
            <Metric label="tokens" value={fmtTokens(usage.tokensIn + usage.tokensOut)} />
            <Metric label="edits" value={String(usage.edits)} />
          </span>
        )}

        <span style={{ flex: 1 }} />

        {branch && (
          <span
            className="mono"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11,
              color: "var(--fg-2)",
            }}
          >
            <span style={{ display: "inline-flex", color: "var(--fg-3)" }}>{Ico.branch}</span>
            {branch}
          </span>
        )}

        <IconBtn
          title="Close session"
          danger
          onClick={() => {
            void closeSession(session);
          }}
        >
          {Ico.close}
        </IconBtn>
      </div>

      {/* body — terminal | inspector */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* left: the live terminal, reparented in via PaneMount. Reuse the same
            pane-leaf / pane-body chrome so xterm fits exactly as in the grid. */}
        <div className="pane-leaf focused" style={{ flex: 1, minWidth: 0 }}>
          <div className="pane-body">
            <PaneMount session={session} />
          </div>
        </div>

        {/* right: tabbed inspector — reuses workspace-wide backends */}
        <div
          style={{
            flex: "0 0 460px",
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            borderLeft: "1px solid var(--bd-soft)",
            background: "var(--bg-1)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "stretch",
              height: 38,
              flexShrink: 0,
              borderBottom: "1px solid var(--bd-soft)",
              padding: "0 8px",
              gap: 2,
            }}
          >
            <TabBtn
              icon={Ico.diff}
              label="Diff"
              active={tab === "diff"}
              onClick={() => setTab("diff")}
            />
            <TabBtn
              icon={Ico.files}
              label="Logs"
              active={tab === "logs"}
              onClick={() => setTab("logs")}
            />
          </div>
          <p
            className="mono"
            style={{ margin: 0, padding: "6px 12px", fontSize: 10, color: "var(--fg-3)" }}
          >
            Workspace-wide — every session shares the runtime's /workspace + container log.
          </p>
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            {tab === "diff" ? <DiffTab running={running} /> : <LogsTab running={running} />}
          </div>
        </div>
      </div>
    </main>
  );
}

// One header metric: muted label + emphasized value, sitting inline in the
// session-detail header strip. Mirrors the pane header's MetricStat spirit but
// laid out horizontally to fit the single-row header.
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span style={{ color: "var(--fg-3)" }}>{label}</span>
      <span style={{ color: "var(--fg-0)", fontWeight: 500 }}>{value}</span>
    </span>
  );
}

function TabBtn({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "0 12px",
        background: "transparent",
        border: "none",
        borderBottom: active ? "2px solid var(--fg-0)" : "2px solid transparent",
        color: active ? "var(--fg-0)" : "var(--fg-2)",
        cursor: "pointer",
        fontSize: 12,
        fontWeight: 500,
      }}
    >
      <span style={{ display: "inline-flex" }}>{icon}</span>
      {label}
    </button>
  );
}

// Combined working-tree diff (container_git_diff_all), polled ~4s so the
// inspector tracks edits as the agent makes them. Reuses DiffBody so there is
// one diff renderer across the app.
function DiffTab({ running }: { running: boolean }) {
  const [diff, setDiff] = useState<string | null>(null);
  useEffect(() => {
    if (!running) {
      setDiff("");
      return;
    }
    let alive = true;
    const tick = () => {
      ipc
        .containerGitDiffAll()
        .then((d) => alive && setDiff(d))
        .catch(() => alive && setDiff(""));
    };
    tick();
    const h = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [running]);

  const counts = diff ? diffCounts(parseDiff(diff)) : null;

  return (
    <>
      {counts && (counts.added > 0 || counts.removed > 0) && (
        <div
          className="mono tnum"
          style={{
            flexShrink: 0,
            padding: "6px 12px",
            fontSize: 11,
            color: "var(--fg-2)",
            borderBottom: "1px solid var(--bd-soft)",
          }}
        >
          <span style={{ color: "var(--live)" }}>+{counts.added}</span>{" "}
          <span style={{ color: "var(--err)" }}>−{counts.removed}</span>
        </div>
      )}
      <DiffBody
        diff={running ? diff : ""}
        emptyLabel={
          running
            ? "No tracked changes — the working tree is clean."
            : "Runtime not running — start it to see changes."
        }
        style={{ flex: 1, minHeight: 0 }}
      />
    </>
  );
}

// Tail of the runtime container log (container_logs), polled ~4s — the same
// one-shot/alive-guard contract as the Containers view.
function LogsTab({ running }: { running: boolean }) {
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    if (!running) {
      setLines(null);
      return;
    }
    let alive = true;
    const tick = () => {
      ipc
        .containerLogs(200)
        .then((l) => alive && setLines(l))
        .catch(() => alive && setLines(null));
    };
    tick();
    const h = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [running]);

  if (lines === null) {
    return (
      <div
        className="mono"
        style={{ padding: "28px 14px", textAlign: "center", fontSize: 11.5, color: "var(--fg-3)" }}
      >
        {running ? "Reading container log…" : "Runtime not running."}
      </div>
    );
  }
  if (lines.length === 0) {
    return (
      <div
        className="mono"
        style={{ padding: "28px 14px", textAlign: "center", fontSize: 11.5, color: "var(--fg-3)" }}
      >
        No log output yet.
      </div>
    );
  }
  return (
    <div
      className="scroll"
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "auto",
        padding: "10px 14px",
        background: "var(--bg-0)",
        fontFamily: "var(--mono)",
        fontSize: 11,
        lineHeight: 1.55,
        color: "var(--fg-1)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: log lines have no stable id; a refreshed tail is a full replace, not a reorder.
        <div key={i}>{line || " "}</div>
      ))}
    </div>
  );
}
