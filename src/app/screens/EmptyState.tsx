/**
 * EmptyState — first-run / no-sessions hero. Ported from design/screens/empty-state.jsx.
 *
 * Two exports:
 *  - `EmptyHero` — just the hero column. Used inside the live Hub shell (App.tsx),
 *    which supplies its own sidebar + activity rail.
 *  - `EmptyState` — hero + a standalone aside, for the dev screen preview
 *    (#/__screens) where there is no surrounding shell.
 *
 * Data is real when the runtime is up: the docker pill reads docker_info, the
 * agent cards read agent_versions + agent_key_status, and the checklist derives
 * from those (Tier-1 IPC, BACKEND_PLAN.md). Before the runtime reports in, the
 * fields fall back to neutral placeholders.
 *
 * Copy note: keys are forwarded from the host environment, not an OS keychain.
 */
import { AGENT_META, AgentGlyph, type AgentId } from "@/app/components/primitives/AgentGlyph";
import { Logo } from "@/app/components/primitives/Logo";
import { StatusDot } from "@/app/components/primitives/StatusDot";
import { Ico } from "@/app/components/primitives/icons";
import { CLIS } from "@/app/lib/catalog";
import type { AgentCli, Cli } from "@/app/lib/ipc";
import { useStore } from "@/app/lib/store";
import { Button } from "@/app/ui/button";

export interface EmptyStateProps {
  onNew?: (cli?: Cli) => void;
}

// Static per-agent prose; version + key presence come from the store. Describes
// each agent's character — no fabricated metrics, just what the agent is good at.
const AGENT_DESC: Record<AgentCli, string> = {
  claude:
    "Long-context refactors and planned edits. Reads deeply across a codebase before it touches anything, and explains its reasoning as it goes.",
  codex:
    "Snappy, iterative coding with safe shell tools. Best for focused diffs and quick turnarounds where you stay in the loop.",
  antigravity:
    "Multi-step automations and longer-running analyses. Built for profiling and tasks that span many tool calls.",
};

export function EmptyHero({ onNew }: EmptyStateProps) {
  const dockerInfo = useStore((s) => s.dockerInfo);
  const keyStatus = useStore((s) => s.keyStatus);
  const agentVersions = useStore((s) => s.agentVersions);
  const status = useStore((s) => s.status);
  const startRuntime = useStore((s) => s.startRuntime);

  const daemonUp = dockerInfo?.reachable ?? status?.state === "running";
  // The runtime auto-starts at launch, but if it's stopped/missing afterwards
  // (manual `docker stop`, a stop from the Containers screen) offer to bring it
  // back in-app. "starting" disables the button while it spins up. The daemon
  // itself being down is a separate, host-level fix (start Docker Desktop).
  const state = status?.state;
  const canStart = daemonUp && (state === "stopped" || state === "missing");
  const starting = state === "starting";

  return (
    <main
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        background: "var(--bg-1)",
        position: "relative",
        color: "var(--fg-1)",
      }}
    >
      <div style={{ position: "absolute", inset: 0, opacity: 0.4, pointerEvents: "none" }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "repeating-linear-gradient(0deg, transparent 0 19px, var(--bd-soft) 19px 20px), radial-gradient(ellipse at 50% 30%, var(--bg-2), var(--bg-1) 70%)",
          }}
        />
      </div>

      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: "60px 60px 30px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          position: "relative",
        }}
      >
        <div style={{ maxWidth: 880, width: "100%" }}>
          <div style={{ textAlign: "center", marginBottom: 36 }}>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "5px 10px",
                border: "1px solid var(--bd)",
                borderRadius: 999,
                fontSize: 11,
                color: "var(--fg-2)",
                fontFamily: "var(--mono)",
                marginBottom: 22,
              }}
            >
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  background: daemonUp ? "var(--live)" : "var(--wait)",
                }}
              />
              {daemonUp ? "docker daemon connected" : "waiting for docker daemon"}
              {dockerInfo?.version && (
                <span style={{ color: "var(--fg-3)" }}>· {dockerInfo.version}</span>
              )}
            </div>
            <h1
              style={{
                margin: 0,
                fontSize: 36,
                fontWeight: 600,
                letterSpacing: "-0.02em",
                color: "var(--fg-0)",
              }}
            >
              Run coding agents,
              <br />
              <span style={{ color: "var(--fg-2)" }}>side by side, in containers.</span>
            </h1>
            <p
              style={{
                margin: "14px auto 0",
                maxWidth: 520,
                fontSize: 14,
                color: "var(--fg-2)",
                lineHeight: 1.55,
              }}
            >
              Each session spawns a fresh tmux on a shared Docker runtime — your repo is mounted,
              your API keys are forwarded from the host environment, and you can compare agents in
              split panes.
            </p>
          </div>

          {(canStart || starting) && (
            <div
              className="ch-card"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: "12px 16px",
                marginBottom: 20,
                borderColor: "color-mix(in oklab, var(--wait) 35%, var(--bd))",
                background: "color-mix(in oklab, var(--wait) 5%, var(--bg-2))",
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-0)" }}>
                  {starting ? "Runtime is starting…" : "Runtime is stopped"}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--fg-2)" }}>
                  {starting
                    ? "Agents become available once it's running."
                    : "Start the shared container to launch agents."}
                </div>
              </div>
              <Button size="sm" disabled={starting} onClick={() => void startRuntime()}>
                {starting ? "Starting…" : "Start runtime"}
              </Button>
            </div>
          )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 12,
              marginBottom: 28,
            }}
          >
            {CLIS.map((c) => (
              <BigAgentCard
                key={c.id}
                agent={c.id}
                name={c.label}
                desc={AGENT_DESC[c.id]}
                version={agentVersions?.[c.id]?.version ?? "—"}
                keySet={keyStatus?.[c.id]?.present ?? false}
                onStart={() => onNew?.(c.id)}
              />
            ))}
          </div>

          <div className="ch-card" style={{ padding: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <span className="lbl">Setup</span>
            </div>
            <ChecklistItem
              done={daemonUp}
              label="Docker daemon connected"
              sub={daemonUp ? "runtime reachable" : "start Docker Desktop"}
            />
            <ChecklistItem
              done={keyStatus?.claude?.present ?? false}
              label="Claude Code key"
              sub={
                keyStatus?.claude?.present
                  ? `${keyStatus.claude.varName} present`
                  : "Set CLAUDE_CODE_OAUTH_TOKEN in your host environment."
              }
              action={keyStatus?.claude?.present ? undefined : "How to"}
            />
            <ChecklistItem
              done={keyStatus?.codex?.present ?? false}
              label="OpenAI key for Codex"
              sub={
                keyStatus?.codex?.present
                  ? `${keyStatus.codex.varName} present`
                  : "Set OPENAI_API_KEY in your host environment."
              }
              action={keyStatus?.codex?.present ? undefined : "How to"}
            />
            <ChecklistItem
              done={keyStatus?.antigravity?.present ?? false}
              label="Google API key for Antigravity"
              sub={
                keyStatus?.antigravity?.present
                  ? `${keyStatus.antigravity.varName} present`
                  : "Set GOOGLE_API_KEY to enable the Antigravity agent."
              }
              action={keyStatus?.antigravity?.present ? undefined : "How to"}
            />
          </div>

          <div style={{ textAlign: "center", marginTop: 28, fontSize: 12, color: "var(--fg-2)" }}>
            <span>
              Press <span className="kbd">⌘</span>
              <span className="kbd" style={{ marginLeft: 2 }}>
                N
              </span>{" "}
              to start your first agent.
            </span>
          </div>
        </div>
      </div>
    </main>
  );
}

// Standalone variant (dev preview) — hero plus a self-contained aside.
export function EmptyState({ onNew }: EmptyStateProps) {
  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0, height: "100%", color: "var(--fg-1)" }}>
      <aside
        style={{
          width: 240,
          flexShrink: 0,
          background: "var(--bg-1)",
          borderRight: "1px solid var(--bd-soft)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: "12px 14px 10px", borderBottom: "1px solid var(--bd-soft)" }}>
          <Logo />
        </div>
        <div style={{ padding: "10px 10px 6px" }}>
          <Button
            onClick={() => onNew?.()}
            style={{ justifyContent: "space-between", width: "100%" }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {Ico.plus}New agent
            </span>
            <span style={{ display: "flex", gap: 2, opacity: 0.7 }}>
              <span className="kbd">⌘</span>
              <span className="kbd">N</span>
            </span>
          </Button>
        </div>
        <div style={{ padding: "10px 10px 4px" }}>
          <div className="lbl" style={{ padding: "0 4px 6px" }}>
            Views
          </div>
          <div className="side-item active">
            {Ico.hub}
            <span style={{ flex: 1 }}>Hub</span>
          </div>
          <div className="side-item" style={{ opacity: 0.4 }}>
            {Ico.settings}
            <span style={{ flex: 1 }}>Settings</span>
          </div>
        </div>
        <div style={{ flex: 1, padding: "14px 10px 4px" }}>
          <div className="lbl" style={{ padding: "0 4px 6px" }}>
            Sessions · 0
          </div>
        </div>
      </aside>
      <EmptyHero onNew={onNew} />
    </div>
  );
}

function BigAgentCard({
  agent,
  name,
  desc,
  version,
  keySet,
  onStart,
}: {
  agent: AgentId;
  name: string;
  desc: string;
  version: string;
  keySet?: boolean;
  onStart?: () => void;
}) {
  const meta = AGENT_META[agent];
  return (
    <div
      style={{
        padding: 20,
        borderRadius: 12,
        background: "var(--bg-2)",
        border: "1px solid var(--bd)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        position: "relative",
        minHeight: 200,
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 10,
          background: `color-mix(in oklab, ${meta.accent} 16%, var(--bg-1))`,
          border: `1px solid color-mix(in oklab, ${meta.accent} 35%, var(--bd))`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span style={{ transform: "scale(1.6)" }}>
          <AgentGlyph agent={agent} size={14} color={meta.accent} />
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-0)" }}>{name}</span>
        <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>
          {version}
        </span>
      </div>
      <p style={{ margin: 0, fontSize: 12.5, color: "var(--fg-2)", lineHeight: 1.5 }}>{desc}</p>
      <div style={{ flex: 1 }} />
      {keySet ? (
        <Button variant="outline" size="sm" style={{ alignSelf: "flex-start" }} onClick={onStart}>
          Start with {name}
          <span style={{ marginLeft: 4 }}>{Ico.arrowR}</span>
        </Button>
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: "var(--wait)",
            fontSize: 11.5,
          }}
        >
          <StatusDot status="wait" /> Add API key to enable
        </div>
      )}
    </div>
  );
}

function ChecklistItem({
  done,
  label,
  sub,
  action,
}: {
  done?: boolean;
  label: string;
  sub: string;
  action?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 0",
        borderTop: "1px solid var(--bd-soft)",
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          border: `1.5px solid ${done ? "var(--live)" : "var(--bd-strong)"}`,
          background: done ? "var(--live)" : "transparent",
          color: done ? "var(--bg-0)" : "var(--fg-3)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 10,
          flexShrink: 0,
        }}
      >
        {done && Ico.check}
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12.5, color: done ? "var(--fg-1)" : "var(--fg-0)" }}>{label}</div>
        <div className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>
          {sub}
        </div>
      </div>
      {action && (
        <Button variant="outline" size="xs">
          {action}
        </Button>
      )}
    </div>
  );
}
