/**
 * WorkspaceTab — tab showing repo name + a stack of agent glyphs.
 * Used in the Hub top bar. References main-hub-a.jsx for shape.
 */
import { AGENT_META, AgentGlyph } from "@/app/components/primitives/AgentGlyph";
import type { AgentId } from "@/app/components/primitives/AgentGlyph";
import { StatusDot } from "@/app/components/primitives/StatusDot";
import type { StatusKey } from "@/app/components/primitives/StatusDot";

export interface WorkspaceTabAgent {
  id: string;
  agent: AgentId;
  status: StatusKey;
}

export interface WorkspaceTabProps {
  repo: string;
  branch?: string;
  agents?: WorkspaceTabAgent[];
  active?: boolean;
  onClick?: () => void;
}

export function WorkspaceTab({
  repo,
  branch = "main",
  agents = [],
  active = false,
  onClick,
}: WorkspaceTabProps) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "0 12px",
        height: 34,
        borderRight: "1px solid var(--bd-soft)",
        cursor: "pointer",
        background: active ? "var(--bg-1)" : "transparent",
        borderBottom: active ? "none" : "1px solid var(--bd-soft)",
        color: active ? "var(--fg-0)" : "var(--fg-2)",
        transition: "background .12s, color .12s",
        flexShrink: 0,
        position: "relative",
      }}
    >
      {/* Agent glyphs stacked horizontally */}
      {agents.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          {agents.map((a) => {
            const meta = AGENT_META[a.agent];
            const accent = meta?.accent ?? "var(--fg-2)";
            return (
              <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                <AgentGlyph agent={a.agent} size={12} color={active ? accent : undefined} />
                <StatusDot status={a.status} pulse={a.status === "live"} />
              </div>
            );
          })}
        </div>
      )}

      {/* Repo name */}
      <span
        style={{
          fontFamily: "var(--mono)",
          fontSize: "var(--fs-12)",
          fontWeight: active ? 500 : 400,
        }}
      >
        {repo}
      </span>

      {/* Branch */}
      {branch && (
        <span style={{ fontFamily: "var(--mono)", fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
          {branch}
        </span>
      )}
    </div>
  );
}
