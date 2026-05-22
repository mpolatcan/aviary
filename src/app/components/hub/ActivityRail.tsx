import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Ico } from "../../components/primitives/icons";
import { type GitStatus, ipc } from "../../lib/ipc";
import { useStore } from "../../lib/store";

// Right activity rail, ported from design/screens/main-hub-a.jsx.
//
// "Changes" is real: the /workspace working-tree status from
// `container_git_status` (branch + ahead/behind + changed files), polled while
// the runtime is up. The "Activity" feed (turn events / approval prompts) still
// depends on an app-level event bus the backend does not emit yet — today the
// CLIs' own prompts render inside the terminal — so it stays an honest empty
// state until that surface exists (BACKEND_PLAN.md).
export function ActivityRail() {
  const status = useStore((s) => s.status);
  const running = status?.state === "running";

  // Poll the workspace git status while running + mounted. One-shot reads ~5s
  // apart; a failed read (container stopped mid-poll) clears to null → the
  // section falls back to its placeholder rather than freezing a stale list.
  const [git, setGit] = useState<GitStatus | null>(null);
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
          <span className="mono tnum" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
            {git.total}
          </span>
        )}
      </div>
      <Changes git={git} running={running} />

      {/* Activity — honest empty until the turn-event bus exists */}
      <div
        style={{
          padding: "12px 14px",
          borderTop: "1px solid var(--bd-soft)",
          borderBottom: "1px solid var(--bd-soft)",
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

// The changed-files list, or an honest one-liner for each non-list state.
function Changes({ git, running }: { git: GitStatus | null; running: boolean }) {
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
          <div
            key={f.path}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "4px 6px",
              borderRadius: 4,
              fontFamily: "var(--mono)",
              fontSize: 11.5,
            }}
          >
            <span
              className="tnum"
              style={{ width: 16, flexShrink: 0, color, textAlign: "center" }}
              title={`status ${f.status.trim() || f.status}`}
            >
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
              title={f.path}
            >
              {f.path}
            </span>
          </div>
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
