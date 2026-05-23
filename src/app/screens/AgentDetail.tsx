import { useEffect, useState } from "react";
import { AGENT_META, AgentGlyph } from "../components/primitives/AgentGlyph";
import { StatusDot } from "../components/primitives/StatusDot";
import { Ico } from "../components/primitives/icons";
import { type AgentCli, type AgentConfig, type ClaudeIntegrations, ipc } from "../lib/ipc";
import { useStore } from "../lib/store";

/**
 * Agent settings detail — design/screens/agent-settings.jsx, made FACTUAL.
 *
 * The design mocks accounts/providers/sub-agents/skills/plugins with sample
 * data; CodeHub's hard rule is to never fabricate. So this reads the agent's
 * REAL on-disk config in the runtime container:
 *   - account + MCP servers  → claude_integrations  (oauthAccount + mcpServers)
 *   - model + permission mode + sub-agents + skills + plugins + marketplaces
 *                            → claude_agent_config   (.claude.json / settings.json
 *                              / .claude/agents / .claude/skills / plugins)
 * Every section shows the truth, including an honest "none configured" empty
 * state. Only Claude Code exposes this config surface on disk; Codex and
 * Antigravity render their version/key + a note that no extra config is
 * surfaced, rather than inventing one.
 */
export function AgentDetail({ agent, onBack }: { agent: AgentCli; onBack: () => void }) {
  const meta = AGENT_META[agent];
  const version = useStore((s) => s.agentVersions?.[agent]?.version ?? null);
  const key = useStore((s) => s.keyStatus?.[agent] ?? null);
  const running = useStore((s) => s.status?.state === "running");

  const isClaude = agent === "claude";
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [integ, setInteg] = useState<ClaudeIntegrations | null>(null);
  const [loading, setLoading] = useState(isClaude);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!isClaude || !running) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    Promise.all([ipc.claudeAgentConfig(), ipc.claudeIntegrations()])
      .then(([c, i]) => {
        if (!alive) return;
        setConfig(c);
        setInteg(i);
        setErr(null);
      })
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [isClaude, running]);

  const account = integ?.account ?? null;
  const mcp = integ?.mcpServers ?? [];

  return (
    <div style={{ maxWidth: 820 }}>
      {/* hero */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 24 }}>
        <button
          type="button"
          onClick={onBack}
          className="mono"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 9px",
            background: "transparent",
            border: "1px solid var(--bd-soft)",
            borderRadius: 6,
            color: "var(--fg-2)",
            cursor: "pointer",
            fontSize: 11.5,
          }}
        >
          <span style={{ display: "inline-flex", transform: "scaleX(-1)" }}>{Ico.arrowR}</span>
          Agents
        </button>
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
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 3 }}>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: "var(--fg-0)" }}>
              {meta.name}
            </h1>
            <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>
              {version ?? "—"}
            </span>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontSize: 11.5,
                color: key?.present ? "var(--live)" : "var(--wait)",
              }}
            >
              <StatusDot status={key?.present ? "live" : "wait"} />
              {key?.present ? "Connected" : "Key needed"}
            </span>
          </div>
          <div style={{ fontSize: 12.5, color: "var(--fg-2)" }}>
            {isClaude
              ? "Configuration read live from the runtime container's Claude config — all factual, nothing stored by CodeHub."
              : "CodeHub surfaces this agent's version and host-key presence. No additional on-disk config is read for it."}
          </div>
        </div>
      </div>

      {!isClaude ? (
        <Empty
          note={`${meta.name} runs from a single provider; CodeHub doesn't read a per-agent config tree for it. Manage it inside its own CLI.`}
        />
      ) : !running ? (
        <Empty note="Runtime container is not running — start it to read the live Claude config." />
      ) : loading ? (
        <Empty note="Reading Claude config…" />
      ) : err ? (
        <Empty note={`Couldn't read config: ${err}`} />
      ) : (
        <>
          {/* Account */}
          <Section label="Account">
            {account ? (
              <Card>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-0)" }}>
                      {account.name ?? account.email ?? "—"}
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>
                      {[account.email, account.plan, account.org].filter(Boolean).join(" · ") ||
                        "—"}
                    </div>
                  </div>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      fontSize: 11.5,
                      color: "var(--live)",
                    }}
                  >
                    <StatusDot status="live" /> Signed in
                  </span>
                </div>
              </Card>
            ) : (
              <Empty note="No signed-in account found in the container's Claude config." />
            )}
          </Section>

          {/* Active model + permission mode */}
          <Section label="Active model & permissions">
            <Card>
              <div style={{ display: "flex", gap: 28 }}>
                <Field label="Model" value={config?.model ?? "—"} />
                <Field label="Default permission mode" value={config?.permissionMode ?? "—"} />
              </div>
            </Card>
          </Section>

          {/* MCP servers */}
          <Section label={`MCP servers · ${mcp.length}`}>
            {mcp.length === 0 ? (
              <Empty note="No MCP servers configured." />
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {mcp.map((m) => (
                  <Card key={`${m.scope}:${m.name}`}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <Badge text="MCP" accent="var(--a-codex)" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="mono" style={{ fontSize: 12.5, color: "var(--fg-0)" }}>
                          {m.name}
                        </div>
                        <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                          {m.transport} · {m.scope}
                          {m.target ? ` · ${m.target}` : ""}
                        </div>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </Section>

          {/* Sub-agents */}
          <Section label={`Sub-agents · ${config?.subagents.length ?? 0}`}>
            {!config?.subagents.length ? (
              <Empty note="No sub-agents in .claude/agents (user or project scope)." />
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {config.subagents.map((sa) => (
                  <Card key={`${sa.scope}:${sa.name}`}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <Badge text="SA" accent="var(--a-claude)" />
                      <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-0)" }}>
                        {sa.name}
                      </span>
                      <span style={{ flex: 1 }} />
                      <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>
                        {sa.scope}
                      </span>
                    </div>
                    {sa.description && (
                      <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginBottom: 6 }}>
                        {sa.description}
                      </div>
                    )}
                    <div
                      style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}
                    >
                      {sa.model && (
                        <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                          {sa.model}
                        </span>
                      )}
                      {sa.tools.map((t) => (
                        <Chip key={t} text={t} />
                      ))}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </Section>

          {/* Skills */}
          <Section label={`Skills · ${config?.skills.length ?? 0}`}>
            {!config?.skills.length ? (
              <Empty note="No skills in .claude/skills (user or project scope)." />
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                {config.skills.map((sk) => (
                  <Card key={`${sk.scope}:${sk.name}`}>
                    <div className="mono" style={{ fontSize: 11.5, color: "var(--fg-0)" }}>
                      {sk.name}
                    </div>
                    <div style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                      {sk.description ?? sk.scope}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </Section>

          {/* Plugins + marketplaces */}
          <Section label={`Plugins · ${config?.plugins.length ?? 0}`}>
            {!config?.plugins.length ? (
              <Empty note="No plugins enabled in ~/.claude.json." />
            ) : (
              <div className="ch-card" style={{ padding: 0, overflow: "hidden" }}>
                {config.plugins.map((p, i) => (
                  <div
                    key={`${p.name}@${p.marketplace ?? ""}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "11px 14px",
                      borderBottom:
                        i === config.plugins.length - 1 ? "none" : "1px solid var(--bd-soft)",
                    }}
                  >
                    <Badge text="P" accent="var(--fg-1)" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-0)" }}>
                        {p.name}
                      </span>
                      {p.marketplace && (
                        <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                          {" "}
                          · {p.marketplace}
                        </span>
                      )}
                    </div>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 5,
                        fontSize: 11.5,
                        color: p.enabled ? "var(--live)" : "var(--fg-2)",
                      }}
                    >
                      <StatusDot status={p.enabled ? "live" : "off"} />
                      {p.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {config && config.marketplaces.length > 0 && (
              <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)", marginTop: 8 }}>
                marketplaces: {config.marketplaces.join(", ")}
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div
        className="lbl"
        style={{
          fontSize: 11,
          color: "var(--fg-2)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          margin: "0 0 10px",
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="ch-card" style={{ padding: 14, marginBottom: 8 }}>
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--fg-3)", marginBottom: 3 }}>{label}</div>
      <div className="mono" style={{ fontSize: 13, color: "var(--fg-0)" }}>
        {value}
      </div>
    </div>
  );
}

function Empty({ note }: { note: string }) {
  return (
    <div
      style={{
        padding: "16px 14px",
        border: "1px dashed var(--bd)",
        borderRadius: 8,
        fontSize: 12,
        color: "var(--fg-2)",
        lineHeight: 1.5,
      }}
    >
      {note}
    </div>
  );
}

function Badge({ text, accent }: { text: string; accent: string }) {
  return (
    <span
      style={{
        width: 26,
        height: 26,
        borderRadius: 5,
        background: `color-mix(in oklab, ${accent} 16%, var(--bg-1))`,
        border: `1px solid color-mix(in oklab, ${accent} 35%, var(--bd))`,
        color: accent,
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        fontWeight: 600,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      {text}
    </span>
  );
}

function Chip({ text }: { text: string }) {
  return (
    <span
      className="mono"
      style={{
        fontSize: 10,
        padding: "1px 5px",
        background: "var(--bg-1)",
        border: "1px solid var(--bd)",
        borderRadius: 3,
        color: "var(--fg-1)",
      }}
    >
      {text}
    </span>
  );
}
