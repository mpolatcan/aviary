/**
 * SpawnDialog — "New agent session" modal. Ported from design/screens/spawn-dialog.jsx.
 *
 * P2 scope: presentational + real agent selection (wired to the CLIS catalog and
 * an `initialPrompt` textarea). Account / container-reuse / repo-picker / cost
 * are Tier-3 backend features that don't exist yet — rendered with placeholder
 * data and marked, per BACKEND_PLAN.md. The real spawn path (create_session +
 * initial prompt) is wired in P3 via the `onLaunch` prop.
 *
 * Copy note: the design said "secrets stay in the keychain". CodeHub forwards
 * keys from the host environment instead (see BACKEND_PLAN.md), so that wording
 * is corrected throughout.
 */
import { AGENT_META, AgentGlyph, type AgentId } from "@/app/components/primitives/AgentGlyph";
import { StatusBadge } from "@/app/components/primitives/StatusBadge";
import { Tag } from "@/app/components/primitives/Tag";
import { Ico } from "@/app/components/primitives/icons";
import { CLIS } from "@/app/lib/catalog";
import type { AgentCli, Cli } from "@/app/lib/ipc";
import { Button } from "@/app/ui/button";
import { type ReactNode, useState } from "react";

export interface SpawnDialogProps {
  /** Called with the chosen agent + initial prompt when the user launches. */
  onLaunch?: (cli: Cli, initialPrompt: string) => void;
  onCancel?: () => void;
}

// Per-agent model/window hint shown under the glyph. Static catalog copy.
const MODEL_HINT: Record<AgentCli, string> = {
  claude: "opus-4.7 · 1M",
  codex: "o4-mini · 200k",
  antigravity: "g-2.5 · 1M",
};

const PROMPT_TEMPLATES = [
  "Fix lint errors",
  "Write tests for…",
  "Review recent diff",
  "+ Templates",
];

export function SpawnDialog({ onLaunch, onCancel }: SpawnDialogProps) {
  const [agent, setAgent] = useState<Cli>("claude");
  const [prompt, setPrompt] = useState("");

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "var(--bg-1)",
        minHeight: 0,
        overflow: "hidden",
        color: "var(--fg-1)",
      }}
    >
      <FauxHubBg />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(6,7,9,0.72)",
          backdropFilter: "blur(3px)",
          WebkitBackdropFilter: "blur(3px)",
        }}
      />

      {/* modal */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 720,
          maxHeight: "calc(100% - 48px)",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-2)",
          border: "1px solid var(--bd-strong)",
          borderRadius: 12,
          boxShadow: "var(--shadow-3)",
          overflow: "hidden",
        }}
      >
        {/* head */}
        <div
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid var(--bd-soft)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--fg-0)" }}>
            New agent session
          </span>
          <span style={{ flex: 1 }} />
          <span className="kbd">esc</span>
        </div>

        {/* form */}
        <div style={{ padding: "18px 18px 6px", overflow: "auto" }}>
          <FormRow label="Agent">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
              {CLIS.map((c) => (
                <AgentCard
                  key={c.id}
                  agent={c.id}
                  selected={agent === c.id}
                  onSelect={() => setAgent(c.id)}
                />
              ))}
            </div>
          </FormRow>

          {/* Account — Tier 3 (multi-credential accounts not implemented). Placeholder. */}
          <FormRow label="Account">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
              <PlaceholderCard title="Host environment" sub="keys forwarded from env" selected />
              <PlaceholderCard title="Add account…" sub="coming soon" muted />
              <PlaceholderCard title="Add account…" sub="coming soon" muted />
            </div>
          </FormRow>

          {/* Repository — Tier 2 (workspace picker) not wired yet. Placeholder path. */}
          <FormRow label="Repository">
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <Pill active>
                {Ico.files}
                <span>Local path</span>
              </Pill>
              <Pill>
                {Ico.branch}
                <span>Git URL</span>
              </Pill>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                background: "var(--bg-1)",
                border: "1px solid var(--bd)",
                borderRadius: 8,
                padding: "9px 12px",
              }}
            >
              {Ico.files}
              <span className="mono" style={{ fontSize: 12.5 }}>
                /workspace
              </span>
              <span style={{ flex: 1 }} />
              <Button variant="outline" size="xs" disabled>
                Change
              </Button>
            </div>
          </FormRow>

          {/* Container — single shared runtime today; reuse/sizing is Tier 3. */}
          <FormRow label="Container">
            <div
              style={{
                padding: "12px 14px",
                display: "flex",
                alignItems: "center",
                gap: 14,
                background: "color-mix(in oklab, var(--live) 8%, var(--bg-1))",
                border: "1px solid color-mix(in oklab, var(--live) 40%, var(--bd))",
                borderRadius: 8,
              }}
            >
              <span
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  background: "var(--fg-0)",
                  color: "var(--bg-0)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                {Ico.check}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--fg-0)" }}>
                    Shared runtime
                  </span>
                  <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>
                    codehub-runtime
                  </span>
                  <StatusBadge status="live">Running</StatusBadge>
                </div>
                <div
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 10.5,
                    color: "var(--fg-2)",
                  }}
                >
                  workspace mounted at /workspace · per-session reuse coming soon
                </div>
              </div>
              <Tag color="var(--live)">~instant</Tag>
            </div>
          </FormRow>

          <FormRow label="Initial prompt" optional>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe the first task for the agent…"
              spellCheck={false}
              style={{
                width: "100%",
                resize: "vertical",
                background: "var(--bg-0)",
                border: "1px solid var(--bd)",
                borderRadius: 8,
                padding: "10px 12px",
                minHeight: 76,
                fontFamily: "var(--mono)",
                fontSize: 12,
                color: "var(--fg-1)",
                lineHeight: 1.5,
                outline: "none",
                boxSizing: "border-box",
              }}
            />
            <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
              {PROMPT_TEMPLATES.map((t) => (
                <button
                  key={t}
                  type="button"
                  // "+ Templates" is an inert affordance for now (no picker yet, P2);
                  // the rest drop their text into the prompt.
                  onClick={() => {
                    if (!t.startsWith("+")) setPrompt(t);
                  }}
                  style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
                >
                  <Tag>{t}</Tag>
                </button>
              ))}
            </div>
          </FormRow>
        </div>

        {/* foot */}
        <div
          style={{
            padding: "12px 18px",
            borderTop: "1px solid var(--bd-soft)",
            background: "var(--bg-1)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexShrink: 0,
          }}
        >
          {/* Cost estimate is Tier 3 (no usage capture yet). Omitted rather than faked. */}
          <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>
            spawns a fresh tmux window in the shared runtime
          </span>
          <span style={{ flex: 1 }} />
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            style={{ padding: "6px 14px" }}
            onClick={() => onLaunch?.(agent, prompt)}
          >
            Launch agent
            <span className="kbd" style={{ marginLeft: 6 }}>
              ⏎
            </span>
          </Button>
        </div>
      </div>
    </div>
  );
}

function FormRow({
  label,
  optional,
  children,
}: {
  label: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <span className="lbl" style={{ color: "var(--fg-1)" }}>
          {label}
        </span>
        {optional && (
          <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
            optional
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function AgentCard({
  agent,
  selected,
  onSelect,
}: {
  agent: AgentId;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const meta = AGENT_META[agent];
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        textAlign: "left",
        padding: "12px 14px",
        background: selected ? "var(--bg-3)" : "var(--bg-1)",
        border: `1px solid ${selected ? "var(--fg-2)" : "var(--bd)"}`,
        borderRadius: 8,
        cursor: "pointer",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {selected && (
        <span
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: "var(--fg-0)",
            color: "var(--bg-0)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {Ico.check}
        </span>
      )}
      <AgentGlyph agent={agent} size={18} color={meta.accent} />
      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-0)", marginTop: 2 }}>
        {meta.name}
      </div>
      <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-2)" }}>
        {agent in MODEL_HINT ? MODEL_HINT[agent as AgentCli] : ""}
      </div>
    </button>
  );
}

function PlaceholderCard({
  title,
  sub,
  selected,
  muted,
}: {
  title: string;
  sub: string;
  selected?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      style={{
        padding: "10px 12px",
        background: selected ? "var(--bg-3)" : "var(--bg-1)",
        border: `1px solid ${selected ? "var(--fg-2)" : "var(--bd)"}`,
        borderRadius: 8,
        opacity: muted ? 0.5 : 1,
        display: "flex",
        flexDirection: "column",
        gap: 3,
        minHeight: 52,
        justifyContent: "center",
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 500, color: "var(--fg-0)" }}>{title}</div>
      <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-2)" }}>
        {sub}
      </div>
    </div>
  );
}

function Pill({ active, children }: { active?: boolean; children: ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "4px 9px",
        borderRadius: 5,
        background: active ? "var(--bg-3)" : "transparent",
        border: `1px solid ${active ? "var(--bd-strong)" : "var(--bd)"}`,
        fontSize: 11.5,
        color: active ? "var(--fg-0)" : "var(--fg-2)",
        cursor: "pointer",
      }}
    >
      {children}
    </span>
  );
}

function FauxHubBg() {
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", minHeight: 0 }}>
      <div
        style={{ width: 264, background: "var(--bg-1)", borderRight: "1px solid var(--bd-soft)" }}
      />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "var(--bg-1)" }}>
        <div style={{ height: 74, borderBottom: "1px solid var(--bd-soft)" }} />
        <div style={{ flex: 1, display: "flex", gap: 1, background: "var(--bd-soft)" }}>
          <div style={{ flex: 1, background: "var(--bg-0)" }} />
          <div style={{ flex: 1, background: "var(--bg-0)" }} />
        </div>
      </div>
    </div>
  );
}
