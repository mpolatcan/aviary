/**
 * SpawnDialog — "New agent session" modal. Ported from design/screens/spawn-dialog.jsx.
 *
 * Real surfaces: agent selection (CLIS catalog), permission mode, an
 * `initialPrompt` textarea, the account picker (host env + keychain profiles),
 * and the Tier-2 repository picker (the real /workspace
 * mount + native folder change + MRU recents + a "restart runtime to apply"
 * affordance). Sessions run in the active workspace container; sizing remains
 * Tier-3. Cost estimate stays omitted (no usage capture).
 *
 * Account profiles either point at an env var NAME or at a keychain-backed vault
 * profile id. Secret values never cross the frontend boundary.
 *
 * The form pieces (agent/account cards, the /workspace picker, the container
 * panel) live in `components/spawn-form` so the new-workspace wizard reuses the
 * exact same honest surfaces — no copy-paste drift.
 */
import { Segmented } from "@/app/components/primitives/Segmented";
import { Tag } from "@/app/components/primitives/Tag";
import {
  AccountCard,
  AgentCard,
  FormRow,
  PROMPT_TEMPLATES,
  RepositoryPicker,
  SharedRuntimePanel,
} from "@/app/components/spawn-form";
import {
  AUTO_ACCOUNT,
  HOST_ACCOUNT,
  accountProfileSubtitle,
  agentAccountState,
} from "@/app/lib/accounts";
import { CLIS, MODE_BY_ID, modesFor } from "@/app/lib/catalog";
import type { Cli, Mode } from "@/app/lib/ipc";
import { useStore } from "@/app/lib/store";
import { MAX_GROUP_PANES } from "@/app/lib/tree";
import { Button } from "@/app/ui/button";
import { useEffect, useState } from "react";

/** A group of the active workspace the agent can be spawned into (design Group row). */
export interface GroupChoice {
  id: string;
  name: string;
  color: string;
  count: number;
  full?: boolean;
}

/** Sentinel target → create a fresh group in the active workspace, then spawn into it. */
export const NEW_GROUP = "__new_group__";

export interface SpawnDialogProps {
  /**
   * Called with the chosen agent, permission mode, initial prompt + optional
   * account-profile id (undefined → the default host-env credential). The final
   * arg is the spawn target: undefined → a new workspace tab (the default),
   * a group id → into that group of the active workspace, NEW_GROUP → a fresh
   * group in the active workspace.
   */
  onLaunch?: (
    cli: Cli,
    mode: Mode,
    initialPrompt: string,
    account?: string,
    targetGroupId?: string,
  ) => void;
  onCancel?: () => void;
  /** Pre-selected agent (from the persisted default). Defaults to Claude. */
  defaultCli?: Cli;
  /** True when invoked from a pane split / tab-add (adjusts the head + footer copy). */
  splitting?: boolean;
  /**
   * Groups of the active workspace (design Group row). When present (and not
   * splitting), the dialog offers spawning into one of them or a new group,
   * with "New tab" as the default. Omitted → the launch always opens a new tab.
   */
  groups?: GroupChoice[];
  /**
   * Standalone (dev-preview) mount — there is no live hub behind the modal, so
   * the dialog paints its own opaque base + a skeleton hub to blur. In the live
   * SpawnModal this is false: the real hub sits behind the scrim and shows
   * through the blur (design spawn-dialog.jsx: blur over the actual MainHubA).
   */
  standalone?: boolean;
  /** User-facing active workspace name, shown beside the design's dialog title. */
  workspaceName?: string;
}

export function SpawnDialog({
  onLaunch,
  onCancel,
  defaultCli = "claude",
  splitting,
  groups,
  standalone,
  workspaceName,
}: SpawnDialogProps) {
  const [agent, setAgentRaw] = useState<Cli>(defaultCli);
  const [mode, setMode] = useState<Mode>("standard");
  const [prompt, setPrompt] = useState("");
  // Selected account-profile id. AUTO prefers host auth when present, otherwise
  // the newest stored profile for the selected agent.
  const [accountChoice, setAccountChoice] = useState<string>(AUTO_ACCOUNT);
  // Spawn target: "" → a new workspace tab (default, preserves the historic
  // surface behaviour); a group id → into that group of the active workspace;
  // NEW_GROUP → a fresh group in the active workspace.
  const [target, setTarget] = useState<string>("");
  const showGroups = !splitting && !!groups && groups.length > 0;

  const keyStatus = useStore((s) => s.keyStatus);
  const accountProfiles = useStore((s) => s.accountProfiles);
  const loadAccountProfiles = useStore((s) => s.loadAccountProfiles);

  // Switching agent clamps the mode to what that agent supports (e.g.
  // Antigravity → Standard only) and resets the account (profiles are per-agent).
  const setAgent = (next: Cli) => {
    setAgentRaw(next);
    if (!modesFor(next).includes(mode)) setMode("standard");
    setAccountChoice(AUTO_ACCOUNT);
  };
  const modes = modesFor(agent);
  const { agentAccounts, defaultKey, effectiveAccountChoice, selectedAccount } =
    agentAccountState(agent, accountProfiles, keyStatus, accountChoice);

  useEffect(() => {
    void loadAccountProfiles();
  }, [loadAccountProfiles]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        // Live modal: transparent so the real hub shows through the blurred
        // scrim. Standalone preview: opaque base + skeleton hub to blur.
        background: standalone ? "var(--bg-1)" : "transparent",
        minHeight: 0,
        overflow: "hidden",
        color: "var(--fg-1)",
      }}
    >
      {standalone && <FauxHubBg />}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(6,7,9,0.55)",
          backdropFilter: "blur(14px) saturate(120%)",
          WebkitBackdropFilter: "blur(14px) saturate(120%)",
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
            {splitting
              ? "Split — new agent in this tab"
              : workspaceName
                ? "Add agent to workspace"
                : "New agent session"}
          </span>
          {workspaceName && (
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>
              {workspaceName}
            </span>
          )}
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
                selected={effectiveAccountChoice === HOST_ACCOUNT}
                onSelect={() => setAccountChoice(HOST_ACCOUNT)}
              />
              {agentAccounts.map((p) => (
                <AccountCard
                  key={p.id}
                  title={p.label}
                  sub={accountProfileSubtitle(p)}
                  present={p.present}
                  disabled={!p.present}
                  selected={effectiveAccountChoice === p.id}
                  onSelect={() => setAccountChoice(p.id)}
                />
              ))}
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)", marginTop: 6 }}>
              Accounts use host env vars or keychain-backed profiles. Manage them in Settings →
              Agents.
            </div>
          </FormRow>

          {/* Repository — the real host directory bound at /workspace (Tier-2). */}
          <FormRow label="Repo binding" optional>
            <RepositoryPicker />
          </FormRow>

          {/* Container — per-workspace container. */}
          <FormRow label="Container">
            <SharedRuntimePanel />
          </FormRow>

          {/* Group — where the agent's pane lands. Real (tree.ts pane groups):
              "New tab" opens a fresh workspace (the historic default for every
              launch surface); the rest add the pane into a group of the active
              workspace, or a brand-new group. Hidden while splitting (a split
              always lands in the active group) and when no workspace exists. */}
          {showGroups && (
            <FormRow label="Group">
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <GroupTargetChip
                  label="New tab"
                  selected={target === ""}
                  onSelect={() => setTarget("")}
                />
                {groups?.map((g) => (
                  <GroupTargetChip
                    key={g.id}
                    label={g.name}
                    count={g.count}
                    full={g.full}
                    dot={g.color}
                    selected={target === g.id && !g.full}
                    disabled={g.full}
                    onSelect={() => {
                      if (!g.full) setTarget(g.id);
                    }}
                  />
                ))}
                <GroupTargetChip
                  label="+ new group"
                  selected={target === NEW_GROUP}
                  onSelect={() => setTarget(NEW_GROUP)}
                />
              </div>
              {groups.some((g) => g.full) && (
                <div
                  className="mono"
                  style={{ marginTop: 6, fontSize: 10.5, color: "var(--fg-3)" }}
                >
                  Full groups are capped at {MAX_GROUP_PANES} panes. Add a new group to keep the
                  grid readable.
                </div>
              )}
            </FormRow>
          )}

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
            attaches to workspace container · fresh tmux session
          </span>
          <span style={{ flex: 1 }} />
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            style={{ padding: "6px 14px" }}
            onClick={() => onLaunch?.(agent, mode, prompt, selectedAccount, target || undefined)}
          >
            Add agent
            <span className="kbd" style={{ marginLeft: 6 }}>
              ⏎
            </span>
          </Button>
        </div>
      </div>
    </div>
  );
}

// Target chip for the Group row (design/screens/spawn-dialog.jsx GroupChip):
// optional color dot + label + pane count, --pri border when selected.
function GroupTargetChip({
  label,
  count,
  full,
  dot,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  count?: number;
  full?: boolean;
  dot?: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 9px",
        borderRadius: 5,
        background: selected ? "var(--bg-3)" : "transparent",
        border: `1px solid ${
          selected
            ? "var(--pri)"
            : full
              ? "color-mix(in oklab, var(--wait) 30%, var(--bd))"
              : "var(--bd)"
        }`,
        fontSize: 12,
        color: disabled ? "var(--fg-3)" : selected ? "var(--fg-0)" : "var(--fg-2)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.7 : 1,
      }}
    >
      {dot && (
        <span
          aria-hidden="true"
          style={{ width: 7, height: 7, borderRadius: "50%", background: dot }}
        />
      )}
      <span>{label}</span>
      {count !== undefined && (
        <span
          className="mono"
          style={{ fontSize: 10, color: full ? "var(--wait)" : "var(--fg-3)" }}
        >
          · {full ? `${count}/${MAX_GROUP_PANES}` : count}
        </span>
      )}
    </button>
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
