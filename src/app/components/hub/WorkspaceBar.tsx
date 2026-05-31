import { Tip } from "../../components/primitives/Tip";
import { Ico } from "../../components/primitives/icons";
import { activeWorkspace, useStore } from "../../lib/store";
import { workspaceLeaves } from "../../lib/tree";

// Workspace meta strip, ported from design/screens/main-hub-a.jsx. Sits BELOW
// the group grid, between the grid and the pane-actions bar (design order:
// grid → meta strip → actions → status).
//
// REAL, git-only: the /workspace working-tree summary from the shared
// container_git_status poll. This intentionally keeps the design's compact
// "repos + dirty" shape but drops the CI/tests/lint block per request.
const AGENT_CLIS = new Set(["claude", "codex", "antigravity"]);

export function WorkspaceBar() {
  const git = useStore((s) => s.gitStatus);
  const ws = useStore(activeWorkspace);
  const sessionMeta = useStore((s) => s.sessionMeta);

  // Count agent panes (exclude shell/utility panes) across all groups of the tab.
  const sessions = ws ? workspaceLeaves(ws) : [];
  const agentCount = sessions.filter((s) => AGENT_CLIS.has(sessionMeta[s]?.cli ?? "")).length;
  const groupCount = ws?.groups.length ?? 0;

  return (
    <div
      style={{
        height: 26,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "0 14px",
        borderTop: "1px solid var(--bd-soft)",
        background: "var(--bg-1)",
        fontFamily: "var(--mono)",
        fontSize: "var(--fs-11)",
        color: "var(--fg-2)",
      }}
    >
      <Tip text={git?.isRepo ? `/workspace · ${git.branch ?? "detached"}` : "/workspace"}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          {Ico.branch}
          {git?.isRepo ? (
            <>
              <span style={{ color: "var(--fg-1)" }}>{git.branch ?? "detached"}</span>
              <span style={{ color: "var(--fg-3)" }}>·</span>
              {git.total > 0 ? (
                <span style={{ color: "var(--wait)" }}>+{git.total} uncommitted</span>
              ) : (
                <span style={{ color: "var(--fg-3)" }}>clean</span>
              )}
              {git.ahead > 0 && <span style={{ color: "var(--fg-3)" }}>↑{git.ahead}</span>}
              {git.behind > 0 && <span style={{ color: "var(--fg-3)" }}>↓{git.behind}</span>}
            </>
          ) : (
            <span style={{ color: "var(--fg-3)" }}>/workspace</span>
          )}
        </span>
      </Tip>

      <span style={{ flex: 1 }} />

      <Tip text="Agent panes in this workspace">
        <span>
          {agentCount} agent{agentCount === 1 ? "" : "s"}
        </span>
      </Tip>
      {groupCount > 1 && <span style={{ color: "var(--fg-3)" }}>· {groupCount} groups</span>}
    </div>
  );
}
