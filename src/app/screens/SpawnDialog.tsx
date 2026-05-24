/**
 * SpawnDialog — "New agent session" modal. Ported from design/screens/spawn-dialog.jsx.
 *
 * Real surfaces: agent selection (CLIS catalog), permission mode, an
 * `initialPrompt` textarea, the Tier-3 account picker (label-only profiles +
 * host-env presence), and the Tier-2 repository picker (the real /workspace
 * mount + native folder change + MRU recents + a "restart runtime to apply"
 * affordance). The shared container is still a single runtime (per-session reuse
 * / sizing remain Tier-3). Cost estimate stays omitted (no usage capture).
 *
 * Copy note: the design said "secrets stay in the keychain". CodeHub forwards
 * keys from the host environment instead (see BACKEND_PLAN.md), so that wording
 * is corrected throughout. Account profiles store an env var NAME, never a value.
 */
import { AGENT_META, AgentGlyph, type AgentId } from "@/app/components/primitives/AgentGlyph";
import { Segmented } from "@/app/components/primitives/Segmented";
import { StatusBadge } from "@/app/components/primitives/StatusBadge";
import { Tag } from "@/app/components/primitives/Tag";
import { Ico } from "@/app/components/primitives/icons";
import { CLIS, MODE_BY_ID, modesFor } from "@/app/lib/catalog";
import type { AgentCli, Cli, Mode } from "@/app/lib/ipc";
import { useStore } from "@/app/lib/store";
import { Button } from "@/app/ui/button";
import { type ReactNode, useState } from "react";

export interface SpawnDialogProps {
  /**
   * Called with the chosen agent, permission mode, initial prompt + optional
   * account-profile id (undefined → the default host-env credential) on launch.
   */
  onLaunch?: (cli: Cli, mode: Mode, initialPrompt: string, account?: string) => void;
  onCancel?: () => void;
  /** Pre-selected agent (from the persisted default). Defaults to Claude. */
  defaultCli?: Cli;
  /** True when invoked from a pane split / tab-add (adjusts the head + footer copy). */
  splitting?: boolean;
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

export function SpawnDialog({
  onLaunch,
  onCancel,
  defaultCli = "claude",
  splitting,
}: SpawnDialogProps) {
  const [agent, setAgentRaw] = useState<Cli>(defaultCli);
  const [mode, setMode] = useState<Mode>("standard");
  const [prompt, setPrompt] = useState("");
  // Selected account-profile id; undefined → the default host-env credential.
  const [account, setAccount] = useState<string | undefined>(undefined);

  const keyStatus = useStore((s) => s.keyStatus);
  const accountProfiles = useStore((s) => s.accountProfiles);

  // Switching agent clamps the mode to what that agent supports (e.g.
  // Antigravity → Standard only) and resets the account (profiles are per-agent).
  const setAgent = (next: Cli) => {
    setAgentRaw(next);
    if (!modesFor(next).includes(mode)) setMode("standard");
    setAccount(undefined);
  };
  const modes = modesFor(agent);
  // Account profiles for the selected agent (the default host-env is implicit).
  const agentAccounts = accountProfiles.filter((p) => p.agent === agent);
  const defaultKey = agent === "shell" ? null : (keyStatus?.[agent as AgentCli] ?? null);

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
            {splitting ? "Split — new agent in this tab" : "New agent session"}
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

          <FormRow label="Mode">
            <Segmented
              value={mode}
              onChange={setMode}
              options={modes.map((m) => ({ key: m, label: MODE_BY_ID[m].label }))}
            />
            <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)", marginTop: 6 }}>
              {MODE_BY_ID[mode].hint}
            </div>
          </FormRow>

          {/* Account — label-only profiles (Tier-3). The default forwards the
              canonical host-env key; each profile remaps the CLI's credential var
              onto another host env var BY NAME (no secret stored). */}
          <FormRow label="Account">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
              <AccountCard
                title="Host environment"
                sub={
                  defaultKey?.present
                    ? `${defaultKey.varName} · present`
                    : defaultKey
                      ? "no key on host"
                      : "default credential"
                }
                present={defaultKey?.present ?? true}
                selected={account === undefined}
                onSelect={() => setAccount(undefined)}
              />
              {agentAccounts.map((p) => (
                <AccountCard
                  key={p.id}
                  title={p.label}
                  sub={`${p.varName} · ${p.present ? "present" : "missing"}`}
                  present={p.present}
                  selected={account === p.id}
                  onSelect={() => setAccount(p.id)}
                />
              ))}
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)", marginTop: 6 }}>
              Accounts map to host env vars (names, never values). Manage them in Settings → Agents.
            </div>
          </FormRow>

          {/* Repository — the real host directory bound at /workspace (Tier-2).
              Shared by every agent in the runtime; changing it needs a container
              recreate, surfaced below. */}
          <FormRow label="Repository">
            <RepositoryPicker />
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

            {/* Real runtime facts, shown as read-only indicators rather than
                per-spawn toggles — the runtime config is fixed (single shared
                container), so a checkbox here would be a lie. Each line reflects
                how the shared runtime actually behaves. Container SIZING is a
                Tier-3 deferral; it's marked "Coming soon", not faked. The
                per-turn cost estimate is omitted entirely (no usage capture). */}
            <div
              style={{
                marginTop: 8,
                display: "flex",
                flexWrap: "wrap",
                gap: "6px 16px",
                fontSize: 11,
                color: "var(--fg-2)",
              }}
            >
              <RuntimeFact on>Workspace mounted read-write</RuntimeFact>
              <RuntimeFact on>API keys forwarded from host environment</RuntimeFact>
              <RuntimeFact>Network: bridge (host networking off)</RuntimeFact>
              <RuntimeFact soon>Container sizing</RuntimeFact>
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
            onClick={() => onLaunch?.(agent, mode, prompt, account)}
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

// One read-only runtime indicator. `on` = an active runtime behavior (filled
// dot); `soon` = a deferred capability ("Coming soon" tag); neither = a stated
// fact (hollow dot). Not interactive — these describe the shared runtime, they
// don't toggle anything (no per-spawn backend flag exists).
function RuntimeFact({
  on,
  soon,
  children,
}: {
  on?: boolean;
  soon?: boolean;
  children: ReactNode;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        aria-hidden="true"
        style={{
          width: 12,
          height: 12,
          flexShrink: 0,
          borderRadius: 3,
          border: `1px solid ${on ? "var(--live)" : "var(--bd-strong)"}`,
          background: on ? "var(--live)" : "transparent",
          color: "var(--bg-0)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {on && Ico.check}
      </span>
      <span style={{ color: soon ? "var(--fg-3)" : "var(--fg-2)" }}>{children}</span>
      {soon && (
        <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>
          Coming soon
        </span>
      )}
    </span>
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

// One selectable account card: the default host-env credential, or a label-only
// profile. A status dot reflects whether its host env var is present.
function AccountCard({
  title,
  sub,
  present,
  selected,
  onSelect,
}: {
  title: string;
  sub: string;
  present: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        textAlign: "left",
        padding: "10px 12px",
        background: selected ? "var(--bg-3)" : "var(--bg-1)",
        border: `1px solid ${selected ? "var(--fg-2)" : "var(--bd)"}`,
        borderRadius: 8,
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 3,
        minHeight: 52,
        justifyContent: "center",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: present ? "var(--live)" : "var(--err)",
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--fg-0)" }}>{title}</span>
      </div>
      <div className="mono" style={{ fontSize: 10, color: "var(--fg-2)" }}>
        {sub}
      </div>
    </button>
  );
}

// The real /workspace mount picker (Tier-2). Shows the effective host dir, lets
// the user change it via the native folder dialog or an MRU recent, and — since
// the mount source is fixed at container create-time — surfaces a "restart
// runtime to apply" affordance when the choice differs from what's mounted.
function RepositoryPicker() {
  const dash = "—";
  const workspaceInfo = useStore((s) => s.workspaceInfo);
  const recents = useStore((s) => s.config?.recentWorkspaces ?? []);
  const running = useStore((s) => s.status?.state === "running");
  const pickWorkspaceDir = useStore((s) => s.pickWorkspaceDir);
  const selectWorkspaceDir = useStore((s) => s.selectWorkspaceDir);
  const recreateRuntime = useStore((s) => s.recreateRuntime);

  const effective = workspaceInfo?.effective ?? null;
  const needsRecreate = workspaceInfo?.needsRecreate ?? false;
  // Other recents (exclude the one currently selected).
  const otherRecents = recents.filter((p) => p !== effective).slice(0, 4);

  const restart = () => {
    if (
      window.confirm(
        "Restart the runtime to apply the new workspace? This ends every running session (scrollback is kept in tmux).",
      )
    ) {
      void recreateRuntime();
    }
  };

  return (
    <>
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
        <span
          className="mono"
          style={{
            fontSize: 12.5,
            color: "var(--fg-1)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={effective ?? undefined}
        >
          {effective ?? dash}
        </span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
          /workspace
        </span>
        <Button variant="outline" size="xs" onClick={() => void pickWorkspaceDir()}>
          Change…
        </Button>
      </div>

      {otherRecents.length > 0 && (
        <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
          {otherRecents.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => void selectWorkspaceDir(p)}
              title={p}
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
            >
              <Tag>{shortPath(p)}</Tag>
            </button>
          ))}
        </div>
      )}

      {needsRecreate && (
        <div
          style={{
            marginTop: 8,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 11px",
            background: "color-mix(in oklab, var(--wait) 10%, var(--bg-1))",
            border: "1px solid color-mix(in oklab, var(--wait) 40%, var(--bd))",
            borderRadius: 8,
          }}
        >
          <span style={{ fontSize: 11.5, color: "var(--fg-1)", flex: 1 }}>
            Workspace changed — restart the runtime to mount it. Affects every session.
          </span>
          <Button variant="outline" size="xs" disabled={!running} onClick={restart}>
            Restart now
          </Button>
        </div>
      )}
    </>
  );
}

// Compact a host path for an MRU chip: the last two segments, ellipsized.
function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  const tail = parts.slice(-2).join("/");
  return parts.length > 2 ? `…/${tail}` : `/${tail}`;
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
