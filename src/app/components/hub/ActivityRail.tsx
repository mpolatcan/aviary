import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { AgentGlyph } from "../../components/primitives/AgentGlyph";
import { StatusDot } from "../../components/primitives/StatusDot";
import { Ico } from "../../components/primitives/icons";
import { fmtTokens, useSessionUsage } from "../../hooks/useSessionUsage";
import { type Cli, type GitStatus, type SessionActivity, ipc } from "../../lib/ipc";
import { useOverlay } from "../../lib/overlay";
import { useStore } from "../../lib/store";
import { DiffViewer } from "./DiffViewer";
import { FilesBrowser } from "./FilesBrowser";

// Right activity rail, ported from design/screens/main-hub-a.jsx.
//
// "Changes" is real: the /workspace working-tree status from
// `container_git_status` (branch + ahead/behind + changed files), polled while
// the runtime is up. "Activity" is real too: each session's live working/idle
// state from `session_activity` (derived from pane output flow). It shows
// *current* state per session, not a turn-by-turn history — a historical feed
// with token/cost per turn still needs per-turn capture (BACKEND_PLAN.md).
export function ActivityRail() {
  const status = useStore((s) => s.status);
  const running = status?.state === "running";

  // Poll the workspace git status while running + mounted. One-shot reads ~5s
  // apart; a failed read (container stopped mid-poll) clears to null → the
  // section falls back to its placeholder rather than freezing a stale list.
  const [git, setGit] = useState<GitStatus | null>(null);
  // Which diff is open lives in the overlay store so the Hub toolbar's Diff
  // button can open the same viewer (a path, "" for all-changes, or null).
  const diffPath = useOverlay((s) => s.diff);
  const setDiffPath = useOverlay((s) => s.setDiff);
  // Files browser open-state, also toolbar-driven (HubTabs Files button).
  const filesOpen = useOverlay((s) => s.files);
  const setFilesOpen = useOverlay((s) => s.setFiles);
  useEffect(() => {
    if (!running) {
      setGit(null);
      return;
    }
    let alive = true;
    const tick = () => {
      ipc
        .containerGitStatus()
        .then((g) => alive && setGit(g))
        .catch(() => alive && setGit(null));
    };
    tick();
    const h = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [running]);

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
      {/* Changes — real /workspace git status */}
      <div
        style={{
          padding: "12px 14px",
          borderBottom: "1px solid var(--bd-soft)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span className="lbl">Changes</span>
        {git?.branch && (
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              color: "var(--fg-2)",
              display: "flex",
              alignItems: "center",
              gap: 4,
              minWidth: 0,
            }}
          >
            <span style={{ flexShrink: 0 }}>{Ico.branch}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {git.branch}
            </span>
            {git.ahead > 0 && <span style={{ color: "var(--live)" }}>↑{git.ahead}</span>}
            {git.behind > 0 && <span style={{ color: "var(--wait)" }}>↓{git.behind}</span>}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {git?.isRepo && git.total > 0 && (
          <>
            <button
              type="button"
              onClick={() => setDiffPath("")}
              title="Review every change in one diff"
              className="rail-file"
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                fontSize: 10.5,
                color: "var(--fg-2)",
                padding: "2px 6px",
                borderRadius: 4,
              }}
            >
              Review all
            </button>
            <span className="mono tnum" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
              {git.total}
            </span>
          </>
        )}
      </div>
      <Changes git={git} running={running} onOpen={setDiffPath} />

      {/* Activity — real live per-session working/idle from session_activity */}
      <div
        style={{
          padding: "12px 14px",
          borderTop: "1px solid var(--bd-soft)",
          borderBottom: "1px solid var(--bd-soft)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span className="lbl">Activity</span>
      </div>
      <Activity running={running} />

      <DiffViewer path={diffPath} onClose={() => setDiffPath(null)} />
      <FilesBrowser open={filesOpen} onClose={() => setFilesOpen(false)} />
    </aside>
  );
}

// Live per-session activity: every running session with a working/idle dot +
// how long it's been quiet. State is real (session_activity, from output flow);
// clicking a row jumps to that session in the Hub. Honest empty when nothing
// runs. Not a turn history — see the file header.
function Activity({ running }: { running: boolean }) {
  const meta = useStore((s) => s.sessionMeta);
  const activity = useStore((s) => s.sessionActivity);
  const focusSession = useStore((s) => s.focusSession);
  const setView = useStore((s) => s.setView);
  const sessions = Object.entries(meta);

  if (!running) {
    return (
      <div style={{ flex: 1 }}>
        <Note>Runtime not running.</Note>
      </div>
    );
  }
  if (sessions.length === 0) {
    return (
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
        }}
      >
        <span style={{ opacity: 0.5 }}>{Ico.bell}</span>
        <p style={{ margin: 0, fontSize: 12, color: "var(--fg-2)", lineHeight: 1.5 }}>
          No sessions running.
        </p>
        <p style={{ margin: 0, fontSize: 11, color: "var(--fg-3)", lineHeight: 1.5 }}>
          Start one with ⌘N to see live activity.
        </p>
      </div>
    );
  }

  const open = (name: string) => {
    focusSession(name);
    setView("hub");
  };

  return (
    <div className="scroll" style={{ flex: 1, overflow: "auto", padding: "6px 8px" }}>
      {sessions.map(([name, m]) => {
        const act = activity[name];
        // Prefer the backend-sourced id (session_activity, registered at launch
        // and stable across a reload) over the in-memory store meta, which a
        // reload re-bootstraps without it. Same source the companion uses, so
        // both agree.
        const claudeId = act?.claudeId ?? (m.cli === "claude" ? m.claudeId : undefined);
        return (
          <ActivityRow
            key={name}
            alias={m.alias}
            cli={m.cli}
            claudeId={claudeId ?? undefined}
            act={act}
            onOpen={() => open(name)}
          />
        );
      })}
    </div>
  );
}

// One live session row: working/idle dot + identity + quiet-duration, and — for
// Claude sessions — a real turn + token tally from that session's transcript.
// Its own component so the per-session usage poll is a top-level hook (not
// called inside a map callback). Token line is omitted, never zero-faked, until
// the transcript has usable data.
function ActivityRow({
  alias,
  cli,
  claudeId,
  act,
  onOpen,
}: {
  alias: string;
  cli: Cli;
  claudeId: string | undefined;
  act: SessionActivity | undefined;
  onOpen: () => void;
}) {
  const working = act?.state === "working";
  const usage = useSessionUsage(claudeId);
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${alias} — jump to session`}
      className="rail-file"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "6px",
        borderRadius: 4,
        border: "none",
        background: "transparent",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <StatusDot status={working ? "live" : "idle"} pulse={working} />
      <AgentGlyph agent={cli} size={12} color={`var(--a-${cli})`} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          className="mono"
          style={{
            display: "block",
            fontSize: 11.5,
            color: "var(--fg-0)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {alias}
        </span>
        {usage && (
          <span className="mono tnum" style={{ fontSize: 10, color: "var(--fg-3)" }}>
            {usage.turns} turn{usage.turns === 1 ? "" : "s"} ·{" "}
            {fmtTokens(usage.tokensIn + usage.tokensOut)} tok
          </span>
        )}
      </span>
      <span
        className="mono"
        style={{ fontSize: 10.5, color: working ? "var(--live)" : "var(--fg-3)", flexShrink: 0 }}
      >
        {working ? "working" : act ? `idle ${fmtIdle(act.idleMs)}` : "idle"}
      </span>
    </button>
  );
}

// Compact quiet-duration: "3s" / "2m" / "1h".
function fmtIdle(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

// The changed-files list, or an honest one-liner for each non-list state.
// Each row opens that file's diff via `onOpen`.
function Changes({
  git,
  running,
  onOpen,
}: {
  git: GitStatus | null;
  running: boolean;
  onOpen: (path: string) => void;
}) {
  if (git === null) {
    return <Note>{running ? "Reading workspace…" : "Runtime not running."}</Note>;
  }
  if (!git.isRepo) {
    return <Note>/workspace is not a git repository.</Note>;
  }
  if (git.total === 0) {
    return <Note>Working tree clean.</Note>;
  }
  return (
    <div className="scroll" style={{ maxHeight: 260, overflow: "auto", padding: "6px 8px" }}>
      {git.files.map((f) => {
        const { label, color } = decode(f.status);
        return (
          <button
            type="button"
            key={f.path}
            onClick={() => onOpen(f.path)}
            title={`${f.path} — view diff`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "4px 6px",
              borderRadius: 4,
              border: "none",
              background: "transparent",
              cursor: "pointer",
              textAlign: "left",
              fontFamily: "var(--mono)",
              fontSize: 11.5,
            }}
            className="rail-file"
          >
            <span className="tnum" style={{ width: 16, flexShrink: 0, color, textAlign: "center" }}>
              {label}
            </span>
            <span
              dir="rtl"
              style={{
                color: "var(--fg-1)",
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                textAlign: "left",
              }}
            >
              {f.path}
            </span>
          </button>
        );
      })}
      {git.total > git.files.length && (
        <div
          className="mono"
          style={{ padding: "6px", fontSize: 10.5, color: "var(--fg-3)", textAlign: "center" }}
        >
          +{git.total - git.files.length} more
        </div>
      )}
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div
      className="mono"
      style={{ padding: "14px", fontSize: 11, color: "var(--fg-3)", lineHeight: 1.5 }}
    >
      {children}
    </div>
  );
}

// A porcelain XY code → a single-glyph label + accent. Untracked is "?" (dim);
// otherwise the first non-space of XY drives it: A added, M modified, D deleted,
// R renamed. Maps onto the three semantic accents (add→live, mod/rename→wait,
// del→err).
function decode(xy: string): { label: string; color: string } {
  if (xy === "??") return { label: "?", color: "var(--fg-3)" };
  const c = xy.trim().charAt(0) || xy.charAt(0);
  switch (c) {
    case "A":
      return { label: "A", color: "var(--live)" };
    case "D":
      return { label: "D", color: "var(--err)" };
    case "R":
      return { label: "R", color: "var(--wait)" };
    default:
      return { label: "M", color: "var(--wait)" };
  }
}
