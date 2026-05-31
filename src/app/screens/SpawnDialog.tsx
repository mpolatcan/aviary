/**
 * SpawnDialog — "Add agent" modal. Fields: Agent, Mode, Account, and (for an
 * existing workspace with sub-repos) the Working directory the agent starts in
 * — its cwd within /workspace, so a multi-repo workspace can scope an agent to
 * one repo. Container is deliberately NOT a field: it's inherited from the
 * workspace. Repo *mounting* + the initial prompt still belong to the wizard.
 */
import { AGENT_META, AgentGlyph } from "@/app/components/primitives/AgentGlyph";
import { FormRow, MODEL_HINT } from "@/app/components/spawn-form";
import {
  AUTO_ACCOUNT,
  HOST_ACCOUNT,
  accountProfileSubtitle,
  agentAccountState,
} from "@/app/lib/accounts";
import { CLIS, MODE_BY_ID, modesFor } from "@/app/lib/catalog";
import { type Cli, type Mode, type RepoInfo, ipc } from "@/app/lib/ipc";
import { useStore } from "@/app/lib/store";
import { MAX_GROUP_PANES } from "@/app/lib/tree";
import { Button } from "@/app/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/ui/select";
import { useEffect, useState } from "react";

export interface GroupChoice {
  id: string;
  name: string;
  color: string;
  count: number;
  full?: boolean;
}

export const NEW_GROUP = "__new_group__";

export interface SpawnDialogProps {
  onLaunch?: (
    cli: Cli,
    mode: Mode,
    initialPrompt: string,
    account?: string,
    targetGroupId?: string,
    cwd?: string,
  ) => void;
  onCancel?: () => void;
  defaultCli?: Cli;
  splitting?: boolean;
  groups?: GroupChoice[];
  standalone?: boolean;
  workspaceName?: string;
  // Per-workspace container key of the workspace this agent joins. When set, the
  // dialog offers a "Working directory" picker (the repos under that workspace's
  // /workspace mount). Absent for a brand-new workspace (no repos to scope to yet).
  workspaceKey?: string;
}

const WORKSPACE_ROOT = "/workspace";

function dirName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export function SpawnDialog({
  onLaunch,
  onCancel,
  defaultCli = "claude",
  splitting,
  groups,
  standalone,
  workspaceName,
  workspaceKey,
}: SpawnDialogProps) {
  const [agent, setAgentRaw] = useState<Cli>(defaultCli);
  const [mode, setMode] = useState<Mode>("standard");
  const [accountChoice, setAccountChoice] = useState<string>(AUTO_ACCOUNT);
  const [target, setTarget] = useState<string>("");
  const [cwd, setCwd] = useState<string>(WORKSPACE_ROOT);
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const showGroups = !splitting && !!groups && groups.length > 0;

  // Repos under this workspace's /workspace mount → the "Working directory"
  // choices. Only fetched for an existing workspace (one with a container).
  useEffect(() => {
    if (!workspaceKey) return;
    let alive = true;
    ipc
      .containerRepos(workspaceKey)
      .then((r) => alive && setRepos(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [workspaceKey]);
  // Repos UNDER /workspace (a single repo at the mount root IS /workspace, so it
  // adds no choice). Only worth a picker when ≥1 sub-repo gives a real choice.
  const subRepos = repos.filter((r) => r.path !== WORKSPACE_ROOT);
  const showCwd = !!workspaceKey && subRepos.length > 0;

  const keyStatus = useStore((s) => s.keyStatus);
  const accountProfiles = useStore((s) => s.accountProfiles);
  const loadAccountProfiles = useStore((s) => s.loadAccountProfiles);

  const setAgent = (next: Cli) => {
    setAgentRaw(next);
    if (!modesFor(next).includes(mode)) setMode("standard");
    setAccountChoice(AUTO_ACCOUNT);
  };
  const modes = modesFor(agent);
  const { agentAccounts, defaultKey, effectiveAccountChoice, selectedAccount } = agentAccountState(
    agent,
    accountProfiles,
    keyStatus,
    accountChoice,
  );

  useEffect(() => {
    void loadAccountProfiles();
  }, [loadAccountProfiles]);

  const accountOptions: {
    value: string;
    label: string;
    sub: string;
    present: boolean;
    disabled?: boolean;
  }[] = [
    {
      value: HOST_ACCOUNT,
      label: "Default",
      sub: defaultKey?.present ? "credential active" : defaultKey ? "no credential" : "auto-select",
      present: defaultKey?.present ?? true,
    },
    ...agentAccounts.map((p) => ({
      value: p.id,
      label: p.label,
      sub: accountProfileSubtitle(p),
      present: p.present,
      disabled: !p.present,
    })),
  ];

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
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

      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 420,
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
          <span style={{ fontSize: "var(--fs-14)", fontWeight: 600, color: "var(--fg-0)" }}>
            {splitting ? "Split — new agent" : workspaceName ? "Add agent" : "New agent"}
          </span>
          {workspaceName && (
            <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-2)" }}>
              {workspaceName}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <span className="kbd">esc</span>
        </div>

        {/* form */}
        <div style={{ padding: "18px 18px 10px" }}>
          <FormRow label="Agent">
            <Select value={agent} onValueChange={(v) => setAgent(v as Cli)}>
              <SelectTrigger className="w-full h-10 bg-[var(--bg-1)] border-[var(--bd)] text-[var(--fg-0)] hover:bg-[var(--bg-hover)]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-[var(--bg-2)] border-[var(--bd-strong)]">
                {CLIS.map((c) => {
                  const meta = AGENT_META[c.id];
                  return (
                    <SelectItem
                      key={c.id}
                      value={c.id}
                      className="text-[var(--fg-1)] focus:bg-[var(--bg-hover)] focus:text-[var(--fg-0)]"
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <AgentGlyph agent={c.id} size={14} color={meta.accent} />
                        <span>{c.label}</span>
                        <span
                          className="mono"
                          style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}
                        >
                          {MODEL_HINT[c.id]}
                        </span>
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </FormRow>

          <FormRow label="Mode">
            <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
              <SelectTrigger className="w-full h-10 bg-[var(--bg-1)] border-[var(--bd)] text-[var(--fg-0)] hover:bg-[var(--bg-hover)]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-[var(--bg-2)] border-[var(--bd-strong)]">
                {modes.map((m) => (
                  <SelectItem
                    key={m}
                    value={m}
                    className="text-[var(--fg-1)] focus:bg-[var(--bg-hover)] focus:text-[var(--fg-0)]"
                  >
                    {MODE_BY_ID[m].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div
              className="mono"
              style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)", marginTop: 6 }}
            >
              {MODE_BY_ID[mode].hint}
            </div>
          </FormRow>

          {showCwd && (
            <FormRow label="Working directory">
              <Select value={cwd} onValueChange={setCwd}>
                <SelectTrigger className="w-full h-10 bg-[var(--bg-1)] border-[var(--bd)] text-[var(--fg-0)] hover:bg-[var(--bg-hover)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[var(--bg-2)] border-[var(--bd-strong)]">
                  <SelectItem
                    value={WORKSPACE_ROOT}
                    className="text-[var(--fg-1)] focus:bg-[var(--bg-hover)] focus:text-[var(--fg-0)]"
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <span className="mono">/workspace</span>
                      <span
                        className="mono"
                        style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}
                      >
                        workspace root
                      </span>
                    </span>
                  </SelectItem>
                  {subRepos.map((r) => (
                    <SelectItem
                      key={r.path}
                      value={r.path}
                      className="text-[var(--fg-1)] focus:bg-[var(--bg-hover)] focus:text-[var(--fg-0)]"
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <span>{dirName(r.path)}</span>
                        {r.branch && (
                          <span
                            className="mono"
                            style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}
                          >
                            {r.branch}
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div
                className="mono"
                style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)", marginTop: 6 }}
              >
                The agent starts here inside the workspace container.
              </div>
            </FormRow>
          )}

          <FormRow label="Account">
            <Select value={effectiveAccountChoice} onValueChange={setAccountChoice}>
              <SelectTrigger className="w-full h-10 bg-[var(--bg-1)] border-[var(--bd)] text-[var(--fg-0)] hover:bg-[var(--bg-hover)]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-[var(--bg-2)] border-[var(--bd-strong)]">
                {accountOptions.map((opt) => (
                  <SelectItem
                    key={opt.value}
                    value={opt.value}
                    disabled={opt.disabled}
                    className="text-[var(--fg-1)] focus:bg-[var(--bg-hover)] focus:text-[var(--fg-0)]"
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          background: opt.present ? "var(--live)" : "var(--err)",
                          flexShrink: 0,
                        }}
                      />
                      <span>{opt.label}</span>
                      <span
                        className="mono"
                        style={{ fontSize: "var(--fs-10)", color: "var(--fg-3)" }}
                      >
                        {opt.sub}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div
              className="mono"
              style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)", marginTop: 6 }}
            >
              Credentials stored in OS keychain
            </div>
          </FormRow>

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
                  style={{ marginTop: 6, fontSize: "var(--fs-11)", color: "var(--fg-3)" }}
                >
                  Full groups are capped at {MAX_GROUP_PANES} panes. Add a new group to keep the
                  grid readable.
                </div>
              )}
            </FormRow>
          )}
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
          <span style={{ flex: 1 }} />
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            style={{ padding: "6px 14px" }}
            onClick={() =>
              onLaunch?.(
                agent,
                mode,
                "",
                selectedAccount,
                target || undefined,
                showCwd ? cwd : undefined,
              )
            }
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
        fontSize: "var(--fs-12)",
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
          style={{ fontSize: "var(--fs-10)", color: full ? "var(--wait)" : "var(--fg-3)" }}
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
