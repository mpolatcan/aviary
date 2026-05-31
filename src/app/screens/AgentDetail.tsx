import { useEffect, useState } from "react";
import { AGENT_META, AgentGlyph } from "../components/primitives/AgentGlyph";
import { StatusDot } from "../components/primitives/StatusDot";
import { Tab } from "../components/primitives/TabBar";
import { Tip } from "../components/primitives/Tip";
import { Ico } from "../components/primitives/icons";
import { CLIS } from "../lib/catalog";
import { type AgentCli, type AgentConfig, ipc } from "../lib/ipc";
import { useStore } from "../lib/store";
import { Button } from "../ui/button";

/**
 * Agent settings detail — design/screens/agent-settings.jsx, made FACTUAL.
 *
 * The design mocks accounts/providers/sub-agents/skills/plugins with sample
 * data; CodeHub's hard rule is to never fabricate. So this reads the agent's
 * REAL on-disk config in the runtime container:
 *   - model + permission mode + sub-agents + skills + plugins + marketplaces
 *                            → claude_agent_config   (.claude.json / settings.json
 *                              / .claude/agents / .claude/skills / plugins)
 * Every section shows the truth, including an honest "none configured" empty
 * state. Only Claude Code exposes this config surface on disk; Codex and
 * Antigravity render their version/key + a note that no extra config is
 * surfaced, rather than inventing one.
 */
export function AgentDetail({
  agent,
  onBack,
  onSwitch,
}: {
  agent: AgentCli;
  onBack: () => void;
  // Switch to another agent's detail in place (the design's agent tab bar). When
  // omitted the tab bar is hidden and only the back affordance shows.
  onSwitch?: (agent: AgentCli) => void;
}) {
  const meta = AGENT_META[agent];
  const version = useStore((s) => s.agentVersions?.[agent]?.version ?? null);
  const key = useStore((s) => s.keyStatus?.[agent] ?? null);
  const keyStatus = useStore((s) => s.keyStatus);
  const running = useStore((s) => s.status?.state === "running");

  const isClaude = agent === "claude";
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [loading, setLoading] = useState(isClaude);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!isClaude || !running) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    ipc
      .claudeAgentConfig()
      .then((c) => {
        if (!alive) return;
        setConfig(c);
        setErr(null);
      })
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [isClaude, running]);

  return (
    <div style={{ maxWidth: 820 }}>
      {/* agent tab bar — switch agents in place (design agent-settings.jsx). The
          back chip returns to the Agents card list (settings.jsx Agents pane). */}
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          gap: 2,
          height: 44,
          marginBottom: 22,
          borderBottom: "1px solid var(--bd-soft)",
        }}
      >
        <Tip text="Back to Agents">
          <button
            type="button"
            onClick={onBack}
            className="mono"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              alignSelf: "center",
              padding: "5px 9px",
              marginRight: 6,
              background: "transparent",
              border: "1px solid var(--bd-soft)",
              borderRadius: 6,
              color: "var(--fg-2)",
              cursor: "pointer",
              fontSize: "var(--fs-12)",
            }}
          >
            <span style={{ display: "inline-flex", transform: "scaleX(-1)" }}>{Ico.arrowR}</span>
            Agents
          </button>
        </Tip>
        {CLIS.map((c) => (
          <AgentTab
            key={c.id}
            agent={c.id}
            name={c.label}
            active={c.id === agent}
            present={keyStatus?.[c.id]?.present ?? false}
            onClick={() => c.id !== agent && onSwitch?.(c.id)}
          />
        ))}
        <span style={{ flex: 1 }} />
        {/* No custom-agent backend yet — inert, mirrors the Settings stub. */}
        <Tip text="Custom agents aren't supported yet">
          <span style={{ display: "inline-flex" }} className="self-center">
            <Button variant="outline" size="xs" disabled className="mono">
              {Ico.plus}Custom agent
            </Button>
          </span>
        </Tip>
      </div>

      {/* hero */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 24 }}>
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
            <h1
              style={{ margin: 0, fontSize: "var(--fs-20)", fontWeight: 600, color: "var(--fg-0)" }}
            >
              {meta.name}
            </h1>
            <span className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--fg-2)" }}>
              {version ?? "—"}
            </span>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontSize: "var(--fs-12)",
                color: key?.present ? "var(--live)" : "var(--wait)",
              }}
            >
              <StatusDot status={key?.present ? "live" : "wait"} />
              {key?.present ? "Connected" : "Key needed"}
            </span>
          </div>
          <div style={{ fontSize: "var(--fs-13)", color: "var(--fg-2)" }}>
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
        <Empty
          note={
            err.includes("503") || err.includes("no running")
              ? "Start a workspace container to view the live Claude config."
              : `Couldn't read config: ${err}`
          }
        />
      ) : (
        <>
          {/* Providers + active model — same visual structure as the design, but
              backed only by the model/provider facts the Claude CLI exposes. */}
          <Section label="Model providers · 1">
            <ProviderRow
              name="Claude CLI config"
              sub="Native Claude Code provider · read from runtime config"
              model={config?.model ?? null}
              active
            />
            <div style={{ display: "flex", gap: 8, margin: "10px 0 28px", flexWrap: "wrap" }}>
              <Tip text="Provider writes need backend support">
                <span style={{ display: "inline-flex" }}>
                  <Button variant="outline" size="sm" disabled>
                    {Ico.plus}Add provider
                  </Button>
                </span>
              </Tip>
              <ProviderTemplate label="OpenAI-compatible" />
              <ProviderTemplate label="AWS Bedrock" />
              <ProviderTemplate label="Vertex AI" />
              <ProviderTemplate label="Ollama" />
            </div>
          </Section>

          <Section label="Active model">
            <Card>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 10,
                  marginBottom: 10,
                  flexWrap: "wrap",
                }}
              >
                <span style={{ fontSize: "var(--fs-13)", fontWeight: 500, color: "var(--fg-0)" }}>
                  Active model
                </span>
                <span style={{ fontSize: "var(--fs-12)", color: "var(--fg-2)" }}>
                  used by new Claude agents; managed in Claude's own config
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 12px",
                  background: "var(--bg-1)",
                  border: "1px solid var(--bd)",
                  borderRadius: 7,
                }}
              >
                <Badge text="CL" accent="var(--a-claude)" />
                <span className="mono" style={{ fontSize: "var(--fs-13)", color: "var(--fg-0)" }}>
                  {config?.model ?? "Claude CLI default"}
                </span>
                <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
                  permission {config?.permissionMode ?? "default"}
                </span>
                <span style={{ flex: 1 }} />
                <span style={{ color: "var(--fg-2)" }}>{Ico.chevD}</span>
              </div>
              <div
                style={{
                  marginTop: 10,
                  display: "flex",
                  gap: 6,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <span className="lbl" style={{ fontSize: "var(--fs-11)", marginRight: 4 }}>
                  quick switch
                </span>
                <ModelChip text={config?.model ?? "CLI default"} active />
              </div>
            </Card>
          </Section>

          {/* Permission rules — the literal allow/ask/deny tool-rule strings from
              settings.json, read-only. The design mocked this as an interactive
              segmented matrix over invented action labels; CodeHub renders the
              REAL rules verbatim (no editing — those rules are managed in the
              agent's own config). allow=live / ask=wait / deny=err mirrors the
              design's color language. */}
          <PermissionRules config={config} />

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
                      <span
                        className="mono"
                        style={{ fontSize: "var(--fs-13)", color: "var(--fg-0)" }}
                      >
                        {sa.name}
                      </span>
                      <span style={{ flex: 1 }} />
                      <span
                        className="mono"
                        style={{ fontSize: "var(--fs-10)", color: "var(--fg-3)" }}
                      >
                        {sa.scope}
                      </span>
                    </div>
                    {sa.description && (
                      <div
                        style={{ fontSize: "var(--fs-12)", color: "var(--fg-2)", marginBottom: 6 }}
                      >
                        {sa.description}
                      </div>
                    )}
                    <div
                      style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}
                    >
                      {sa.model && (
                        <span
                          className="mono"
                          style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}
                        >
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
                    <div
                      className="mono"
                      style={{ fontSize: "var(--fs-12)", color: "var(--fg-0)" }}
                    >
                      {sk.name}
                    </div>
                    <div style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
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
                      <span
                        className="mono"
                        style={{ fontSize: "var(--fs-13)", color: "var(--fg-0)" }}
                      >
                        {p.name}
                      </span>
                      {p.marketplace && (
                        <span
                          className="mono"
                          style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}
                        >
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
                        fontSize: "var(--fs-12)",
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
              <div
                className="mono"
                style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)", marginTop: 8 }}
              >
                marketplaces: {config.marketplaces.join(", ")}
              </div>
            )}
          </Section>

          <Section label="Auto behaviors">
            <Card>
              <SettingLine
                label="Auto mode at start"
                desc="Claude Code owns this behavior; CodeHub only reports the default permission mode."
                value={config?.permissionMode ?? "default"}
              />
              <SettingLine
                label="Plan before edit"
                desc="No readable CodeHub setting yet. Add backend support before making this editable."
                value="not exposed"
              />
              <SettingLine
                label="Self-review diff"
                desc="No readable CodeHub setting yet. Kept as an honest disabled design affordance."
                value="not exposed"
                last
              />
            </Card>
          </Section>
        </>
      )}
    </div>
  );
}

// One agent tab in the detail's top bar. Glyph + name + a real key-presence
// subline (connected / key needed) — no fabricated provider counts. The active
// tab carries the design's 2px underline.
function AgentTab({
  agent,
  name,
  active,
  present,
  onClick,
}: {
  agent: AgentCli;
  name: string;
  active: boolean;
  present: boolean;
  onClick: () => void;
}) {
  const meta = AGENT_META[agent];
  return (
    <Tab active={active} onClick={onClick}>
      <AgentGlyph agent={agent} size={13} color={meta.accent} />
      {name}
      <span
        className="mono"
        style={{ fontSize: "var(--fs-11)", color: present ? "var(--live)" : "var(--fg-3)" }}
      >
        · {present ? "connected" : "key needed"}
      </span>
    </Tab>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div
        className="lbl"
        style={{
          fontSize: "var(--fs-11)",
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

function ProviderRow({
  name,
  sub,
  model,
  active,
}: {
  name: string;
  sub: string;
  model: string | null;
  active?: boolean;
}) {
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Badge text="CL" accent="var(--a-claude)" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
            <span style={{ fontSize: "var(--fs-13)", fontWeight: 500, color: "var(--fg-0)" }}>
              {name}
            </span>
            {active && <Chip text="default" />}
          </div>
          <div className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-2)" }}>
            {sub}
          </div>
        </div>
        <span
          className="mono"
          style={{ fontSize: "var(--fs-11)", color: model ? "var(--fg-1)" : "var(--fg-3)" }}
        >
          {model ?? "CLI default"}
        </span>
      </div>
    </Card>
  );
}

function ProviderTemplate({ label }: { label: string }) {
  return (
    <Tip text="Provider template needs backend support before it can be configured">
      <span
        className="mono"
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding: "5px 8px",
          borderRadius: 6,
          background: "var(--bg-2)",
          border: "1px solid var(--bd)",
          color: "var(--fg-3)",
          fontSize: "var(--fs-11)",
        }}
      >
        {label}
      </span>
    </Tip>
  );
}

function ModelChip({ text, active }: { text: string; active?: boolean }) {
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "4px 8px",
        borderRadius: 5,
        background: active ? "var(--bg-3)" : "transparent",
        border: `1px solid ${active ? "var(--pri)" : "var(--bd)"}`,
        color: active ? "var(--fg-0)" : "var(--fg-2)",
        fontSize: "var(--fs-11)",
      }}
    >
      {text}
    </span>
  );
}

function SettingLine({
  label,
  desc,
  value,
  last,
}: {
  label: string;
  desc: string;
  value: string;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "10px 0",
        borderBottom: last ? "none" : "1px solid var(--bd-soft)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "var(--fs-13)", color: "var(--fg-0)", marginBottom: 2 }}>
          {label}
        </div>
        <div style={{ fontSize: "var(--fs-12)", color: "var(--fg-2)" }}>{desc}</div>
      </div>
      <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-2)" }}>
        {value}
      </span>
    </div>
  );
}

// Read-only list of the agent's literal permission rules. Each row is one rule
// string verbatim from settings.json, tagged with its bucket; the bucket color
// follows the design (allow=live / ask=wait / deny=err). All-empty → an honest
// note, never invented rules.
function PermissionRules({ config }: { config: AgentConfig | null }) {
  const groups = [
    { bucket: "allow", color: "var(--live)", rules: config?.permissionAllow ?? [] },
    { bucket: "ask", color: "var(--wait)", rules: config?.permissionAsk ?? [] },
    { bucket: "deny", color: "var(--err)", rules: config?.permissionDeny ?? [] },
  ] as const;
  const flat = groups.flatMap((g) => g.rules.map((rule) => ({ ...g, rule })));

  return (
    <Section label={`Permission rules · ${flat.length}`}>
      {flat.length === 0 ? (
        <Empty note="No explicit allow / ask / deny rules in settings.json — Claude Code falls back to its built-in defaults under the permission mode above." />
      ) : (
        <div className="ch-card" style={{ padding: 0, overflow: "hidden" }}>
          {flat.map((r, i) => (
            <div
              key={`${r.bucket}:${r.rule}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 14px",
                borderBottom: i === flat.length - 1 ? "none" : "1px solid var(--bd-soft)",
              }}
            >
              <span
                className="mono"
                style={{
                  width: 42,
                  flexShrink: 0,
                  fontSize: "var(--fs-10)",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: r.color,
                }}
              >
                {r.bucket}
              </span>
              <span
                className="mono"
                style={{ fontSize: "var(--fs-12)", color: "var(--fg-0)", wordBreak: "break-all" }}
              >
                {r.rule}
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function Empty({ note }: { note: string }) {
  return (
    <div
      style={{
        padding: "16px 14px",
        border: "1px dashed var(--bd)",
        borderRadius: 8,
        fontSize: "var(--fs-12)",
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
        fontSize: "var(--fs-10)",
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
        fontSize: "var(--fs-10)",
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
