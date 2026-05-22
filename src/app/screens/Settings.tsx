/**
 * Settings — sectioned left-nav + right pane. Ported from design/screens/settings.jsx.
 *
 * The "Agents & API keys" pane is wired to REAL data: each agent's version comes
 * from the Tier-1 `agent_versions` IPC and its connection state from
 * `agent_key_status` (host-env presence, never the value) — both fetched at
 * bootstrap. The "Stop all" danger-zone action is real (closeAllSessions).
 *
 * Still placeholder, by design: the "Defaults for new sessions" controls have no
 * backend yet (the persistent settings store is Tier-2/v1 — BACKEND_PLAN.md), so
 * they render disabled with an honest caption rather than faking persistence. The
 * deep agent config in design/screens/agent-settings.jsx (model providers, MCP,
 * sub-agents, skills, plugins, permission rules) is intentionally NOT ported —
 * CodeHub doesn't manage those (they live in each agent's own in-container
 * config), so the screen would be almost entirely fabricated controls.
 *
 * Copy note: keys are forwarded from the host environment, NOT an OS keychain
 * (BACKEND_PLAN.md decision) — wording corrected from the design.
 */
import { AGENT_META, AgentGlyph, type AgentId } from "@/app/components/primitives/AgentGlyph";
import { StatusDot } from "@/app/components/primitives/StatusDot";
import { Ico } from "@/app/components/primitives/icons";
import { CLIS } from "@/app/lib/catalog";
import { useStore } from "@/app/lib/store";
import { Button } from "@/app/ui/button";
import { type ReactNode, useState } from "react";

export interface SettingsProps {
  /** Kill every running session. Defaults to the store's closeAllSessions. */
  onStopAll?: () => void;
}

const NAV_GROUPS: { label: string; items: { key: string; label: string; soon?: boolean }[] }[] = [
  {
    label: "Workspace",
    items: [
      { key: "general", label: "General" },
      { key: "agents", label: "Agents & API keys" },
      { key: "runtime", label: "Container runtime" },
      { key: "repos", label: "Repositories" },
    ],
  },
  {
    label: "Experience",
    items: [
      { key: "shortcuts", label: "Keyboard shortcuts" },
      { key: "notifications", label: "Notifications" },
      { key: "appearance", label: "Appearance" },
    ],
  },
  {
    label: "Account",
    items: [
      { key: "billing", label: "Usage & billing", soon: true },
      { key: "team", label: "Team", soon: true },
    ],
  },
];

export function Settings({ onStopAll }: SettingsProps) {
  // Only the "Agents & API keys" pane is designed; selecting others is a no-op
  // visual highlight until those panes are ported.
  const [active, setActive] = useState("agents");
  const keyStatus = useStore((s) => s.keyStatus);
  const agentVersions = useStore((s) => s.agentVersions);
  const sessionCount = useStore((s) => Object.keys(s.sessionMeta).length);
  const closeAllSessions = useStore((s) => s.closeAllSessions);

  const stopAll = () => {
    if (sessionCount === 0) return;
    if (!window.confirm(`Stop all ${sessionCount} running session(s)? Scrollback is kept.`)) return;
    (onStopAll ?? (() => void closeAllSessions()))();
  };

  return (
    <main
      style={{
        flex: 1,
        display: "flex",
        background: "var(--bg-1)",
        minWidth: 0,
        height: "100%",
        color: "var(--fg-1)",
      }}
    >
      {/* settings nav */}
      <nav
        style={{
          width: 220,
          flexShrink: 0,
          background: "var(--bg-1)",
          borderRight: "1px solid var(--bd-soft)",
          padding: "20px 12px",
          overflow: "auto",
        }}
      >
        <h2 style={{ margin: "0 6px 14px", fontSize: 17, fontWeight: 600, color: "var(--fg-0)" }}>
          Settings
        </h2>
        {NAV_GROUPS.map((group) => (
          <div key={group.label} style={{ marginBottom: 14 }}>
            <div className="lbl" style={{ padding: "0 6px 4px" }}>
              {group.label}
            </div>
            {group.items.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => !item.soon && setActive(item.key)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  width: "100%",
                  textAlign: "left",
                  padding: "7px 10px",
                  borderRadius: 6,
                  border: "none",
                  fontSize: 12.5,
                  fontFamily: "var(--sans)",
                  color: item.soon
                    ? "var(--fg-3)"
                    : active === item.key
                      ? "var(--fg-0)"
                      : "var(--fg-1)",
                  background: active === item.key ? "var(--bg-3)" : "transparent",
                  cursor: item.soon ? "default" : "pointer",
                  marginBottom: 1,
                }}
              >
                <span style={{ flex: 1 }}>{item.label}</span>
                {item.soon && (
                  <span className="mono" style={{ fontSize: 9.5, color: "var(--fg-3)" }}>
                    soon
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
      </nav>

      {/* pane */}
      <div style={{ flex: 1, overflow: "auto", padding: "24px 32px" }}>
        <div style={{ maxWidth: 720 }}>
          <h1
            style={{
              margin: "0 0 4px",
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              color: "var(--fg-0)",
            }}
          >
            Agents & API keys
          </h1>
          <p style={{ margin: "0 0 28px", color: "var(--fg-2)", fontSize: 13 }}>
            Configure the coding agents available in the spawn dialog. Keys are read from your host
            environment (e.g. <span className="mono">CLAUDE_CODE_OAUTH_TOKEN</span>) and forwarded
            into running containers — CodeHub never stores them.
          </p>

          <SectionHead label="Agents" />
          {CLIS.map((c) => {
            // Real Tier-1 reads; null until the bootstrap fetch resolves (or if a
            // binary/key is absent — then version/varName render as em-dash).
            const key = keyStatus?.[c.id];
            const ver = agentVersions?.[c.id];
            return (
              <AgentRow
                key={c.id}
                agent={c.id}
                name={c.label}
                version={ver?.version ?? null}
                present={key?.present ?? false}
                varName={key?.varName ?? null}
                source={key?.source ?? null}
              />
            );
          })}

          <div style={{ display: "flex", gap: 8, margin: "14px 0 32px" }}>
            <Button variant="outline" size="sm" disabled>
              {Ico.plus}Add custom agent
            </Button>
          </div>

          <SectionHead label="Defaults for new sessions" />
          {/* No persistent settings store yet (Tier-2/v1 — BACKEND_PLAN.md). These
              controls are shown disabled rather than faking persistence. */}
          <p style={{ margin: "0 0 8px", fontSize: 11.5, color: "var(--fg-2)" }}>
            Not configurable yet — these land with the settings store. For now, spawn-time options
            live in the ⌘N dialog.
          </p>
          <SettingRow
            label="Default agent"
            desc="Pre-selected in the spawn dialog (⌘N)."
            control={<SelectStub value="Claude Code" />}
          />
          <SettingRow
            label="Auto-approve safe commands"
            desc="Read-only operations (ls, cat, git status) run without prompting."
            control={<Toggle on />}
          />
          <SettingRow
            label="Approve writes"
            desc="Always ask before edits, branch ops, or shell execution."
            control={<Toggle on />}
          />
          <SettingRow
            label="Context budget"
            desc="Stop loading more context once this fills."
            control={<InputStub value="800k" suffix="tokens" />}
            last
          />

          <SectionHead label="Danger zone" tone="err" />
          <div
            className="ch-card"
            style={{
              padding: 14,
              borderColor: "color-mix(in oklab, var(--err) 30%, var(--bd))",
              background: "color-mix(in oklab, var(--err) 4%, var(--bg-2))",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>
                  Stop all running agents
                </div>
                <div style={{ fontSize: 11.5, color: "var(--fg-2)" }}>
                  SIGTERMs every session and persists their tmux scrollback.
                  {sessionCount > 0 ? ` ${sessionCount} running.` : " None running."}
                </div>
              </div>
              <span style={{ flex: 1 }} />
              <Button
                variant="destructive"
                size="sm"
                onClick={stopAll}
                disabled={sessionCount === 0}
              >
                Stop all
              </Button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

function SectionHead({ label, tone }: { label: string; tone?: "err" }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "24px 0 12px" }}>
      <span
        className="lbl"
        style={{ color: tone === "err" ? "var(--err)" : "var(--fg-1)", fontSize: 11 }}
      >
        {label}
      </span>
      <span style={{ flex: 1, height: 1, background: "var(--bd-soft)" }} />
    </div>
  );
}

// One agent card, all real data. `present` is host-env key presence (never the
// value); `varName`/`source` name where it came from; `version` is the binary's
// reported version (em-dash when the binary or feed is absent).
function AgentRow({
  agent,
  name,
  version,
  present,
  varName,
  source,
}: {
  agent: AgentId;
  name: string;
  version: string | null;
  present: boolean;
  varName: string | null;
  source: string | null;
}) {
  const meta = AGENT_META[agent];
  // Honest auth subline: the env var that's set, else what's missing.
  const authLine = present
    ? `${varName ?? "host env"}${source && source !== "env" ? ` · ${source}` : ""}`
    : "no host key set";
  return (
    <div
      className="ch-card"
      style={{ padding: 14, display: "flex", alignItems: "center", gap: 14, marginBottom: 8 }}
    >
      <div
        style={{
          width: 38,
          height: 38,
          borderRadius: 8,
          background: `color-mix(in oklab, ${meta.accent} 14%, var(--bg-1))`,
          border: `1px solid color-mix(in oklab, ${meta.accent} 30%, var(--bd))`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span style={{ transform: "scale(1.4)" }}>
          <AgentGlyph agent={agent} size={14} color={meta.accent} />
        </span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
          <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--fg-0)" }}>{name}</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>
            {version ?? "—"}
          </span>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--fg-2)", fontFamily: "var(--mono)" }}>
          {authLine}
        </div>
      </div>
      {present ? (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11.5,
            color: "var(--live)",
            whiteSpace: "nowrap",
          }}
        >
          <StatusDot status="live" /> Connected
        </span>
      ) : (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11.5,
            color: "var(--wait)",
            whiteSpace: "nowrap",
          }}
        >
          <StatusDot status="wait" /> Key needed
        </span>
      )}
    </div>
  );
}

function SettingRow({
  label,
  desc,
  control,
  last,
}: {
  label: string;
  desc: string;
  control: ReactNode;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 20,
        padding: "14px 0",
        borderBottom: last ? "none" : "1px solid var(--bd-soft)",
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, color: "var(--fg-0)", marginBottom: 2 }}>{label}</div>
        <div style={{ fontSize: 11.5, color: "var(--fg-2)" }}>{desc}</div>
      </div>
      {/* Dimmed + inert: this whole section has no backend yet, so the controls
          must not look clickable. */}
      <div aria-disabled style={{ opacity: 0.45, pointerEvents: "none" }}>
        {control}
      </div>
    </div>
  );
}

// Minimal presentational controls matching the design's monochrome style.
// Real wiring (to the Tier-2 config store) lands when these panes go live.
function Toggle({ on }: { on?: boolean }) {
  return (
    <span
      style={{
        width: 32,
        height: 18,
        borderRadius: 999,
        background: on ? "var(--fg-0)" : "var(--bg-3)",
        border: `1px solid ${on ? "var(--fg-0)" : "var(--bd-strong)"}`,
        display: "inline-flex",
        alignItems: "center",
        padding: "0 2px",
        cursor: "pointer",
        position: "relative",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 1,
          left: on ? 16 : 1,
          width: 14,
          height: 14,
          borderRadius: "50%",
          background: on ? "var(--bg-0)" : "var(--fg-1)",
          transition: "left .15s",
        }}
      />
    </span>
  );
}

function SelectStub({ value }: { value: string }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        border: "1px solid var(--bd)",
        borderRadius: 6,
        background: "var(--bg-1)",
        fontSize: 12,
        color: "var(--fg-0)",
        cursor: "pointer",
        minWidth: 160,
        justifyContent: "space-between",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <AgentGlyph agent="claude" size={11} color="var(--a-claude)" />
        {value}
      </span>
      <span style={{ color: "var(--fg-2)" }}>{Ico.chevD}</span>
    </div>
  );
}

function InputStub({ value, suffix }: { value: string; suffix: string }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        border: "1px solid var(--bd)",
        borderRadius: 6,
        background: "var(--bg-1)",
        fontFamily: "var(--mono)",
        fontSize: 12,
        minWidth: 140,
      }}
    >
      <span style={{ color: "var(--fg-0)" }}>{value}</span>
      <span style={{ flex: 1 }} />
      <span style={{ color: "var(--fg-3)", fontSize: 11 }}>{suffix}</span>
    </div>
  );
}
