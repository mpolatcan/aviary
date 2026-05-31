/**
 * SpawnPane — the "New agent · configuring" pane (design hub configuring state).
 * Rendered IN the grid for a configuring leaf (a `__spawn-N` placeholder with a
 * draft but no tmux session yet). A centered card of horizontal rows — Agent /
 * Mode / Dir / Account — then "Spawn agent" commits the draft (creates the
 * session, swaps this slot for the live terminal). No head bar: the card titles
 * itself and carries its own cancel. The container isn't shown — it's always
 * inherited from the workspace (CodeHub runs one container per workspace).
 *
 * DIR is the agent's working directory (cwd). For an existing workspace it's a
 * folder BROWSER over the mounted /workspace — a multi-repo mount nests repos at
 * arbitrary depth, so the user drills the tree one level at a time (git repos
 * badged with their branch) instead of a flat depth-2 repo list. For a NEW
 * workspace (no container yet) it opens the native folder picker to choose the
 * host repo that gets mounted at /workspace.
 */
import { AGENT_META, AgentGlyph } from "@/app/components/primitives/AgentGlyph";
import {
  AUTO_ACCOUNT,
  HOST_ACCOUNT,
  accountProfileSubtitle,
  agentAccountState,
  providerTargetAgent,
} from "@/app/lib/accounts";
import { CLIS, MODE_BY_ID, modesFor } from "@/app/lib/catalog";
import { type Cli, type DirEntry, type Mode, ipc } from "@/app/lib/ipc";
import { useStore } from "@/app/lib/store";
import { Button } from "@/app/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/app/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/app/ui/select";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { Tip } from "./primitives/Tip";
import { Ico } from "./primitives/icons";

const WORKSPACE_ROOT = "/workspace";

function dirName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

// h-9 matches shadcn SelectTrigger's pinned height (its `data-[size]:h-9` resists
// override), so the raw-button rows (Dir browser, new-ws picker) line up with the
// Agent/Mode/Account Selects. text-sm likewise matches their value font size.
const ROW =
  "w-full h-9 px-3 flex items-center gap-2.5 justify-start text-sm bg-[var(--bg-1)] border border-[var(--bd)] rounded-lg text-[var(--fg-0)] hover:bg-[var(--bg-hover)] hover:border-[var(--bd-strong)]";
const ITEM = "text-[var(--fg-1)] focus:bg-[var(--bg-hover)] focus:text-[var(--fg-0)]";
const POPOVER = "bg-[var(--bg-2)] border-[var(--bd-strong)]";

// Leading icon + uppercase label column shared by every row.
function RowHead({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <>
      <span style={{ display: "inline-flex", color: "var(--fg-2)", width: 16, flexShrink: 0 }}>
        {icon}
      </span>
      <span className="lbl" style={{ width: 62, flexShrink: 0, color: "var(--fg-2)" }}>
        {label}
      </span>
    </>
  );
}

function RowValue({ value, meta }: { value: string; meta?: ReactNode }) {
  return (
    <>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          textAlign: "left",
          color: "var(--fg-0)",
          fontWeight: 500,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </span>
      {meta && (
        <span
          className="mono"
          style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)", flexShrink: 0 }}
        >
          {meta}
        </span>
      )}
    </>
  );
}

export function SpawnPane({ id }: { id: string }) {
  const draft = useStore((s) => s.spawnDrafts[id]);
  const ws = useStore((s) => s.workspaces.find((w) => w.id === draft?.workspaceId));
  const update = useStore((s) => s.updateSpawnDraft);
  const commit = useStore((s) => s.commitSpawn);
  const cancel = useStore((s) => s.cancelSpawn);
  const keyStatus = useStore((s) => s.keyStatus);
  const accountProfiles = useStore((s) => s.accountProfiles);
  const loadAccountProfiles = useStore((s) => s.loadAccountProfiles);
  const providers = useStore((s) => s.providers);
  const loadProviders = useStore((s) => s.loadProviders);

  const [accountChoice, setAccountChoice] = useState<string>(AUTO_ACCOUNT);

  const workspaceKey = ws?.containerKey;
  // A NEW-workspace draft has no container yet (the dir it picks becomes the
  // /workspace mount); an existing workspace browses the dirs inside its mount.
  const isNewWs = !!draft?.workspaceDir;

  useEffect(() => {
    void loadAccountProfiles();
    void loadProviders();
  }, [loadAccountProfiles, loadProviders]);

  if (!draft) return null;

  const agent = draft.cli;
  const mode = draft.mode;
  const cwd = draft.cwd ?? WORKSPACE_ROOT;
  const resuming = !!draft.resume;
  const modes = modesFor(agent);
  // Launch-wired providers for this agent (enabled + token stored), offered in
  // the account picker as an alternative credential. Selecting one routes its
  // id through the `account` param; the backend injects its harness env.
  const agentProviders = providers.filter(
    (p) => providerTargetAgent(p.kind) === agent && p.enabled && p.hasToken,
  );
  const isProviderChoice = agentProviders.some((p) => p.id === accountChoice);
  const base = agentAccountState(agent, accountProfiles, keyStatus, accountChoice);
  const { agentAccounts, defaultKey } = base;
  const effectiveAccountChoice = isProviderChoice ? accountChoice : base.effectiveAccountChoice;
  const selectedAccount = isProviderChoice ? accountChoice : base.selectedAccount;

  const setAgent = (next: Cli) => {
    update(id, { cli: next, mode: modesFor(next).includes(mode) ? mode : "standard" });
    setAccountChoice(AUTO_ACCOUNT);
  };

  const spawn = () => {
    update(id, { account: selectedAccount, cwd });
    void commit(id);
  };

  const pickMount = async () => {
    const path = await ipc.pickDirectory().catch(() => null);
    if (path) update(id, { workspaceDir: path, cwd: WORKSPACE_ROOT });
  };

  const accountOptions = [
    {
      value: HOST_ACCOUNT,
      label: "Default",
      sub: defaultKey?.present ? "credential active" : defaultKey ? "no credential" : "auto-select",
      present: defaultKey?.present ?? true,
      disabled: false,
    },
    ...agentAccounts.map((p) => ({
      value: p.id,
      label: p.label,
      sub: accountProfileSubtitle(p),
      present: p.present,
      disabled: !p.present,
    })),
    ...agentProviders.map((p) => ({
      value: p.id,
      label: p.name,
      sub: `provider · ${p.model ?? p.models[0] ?? p.kind}`,
      present: true,
      disabled: false,
    })),
  ];
  const accountActive = accountOptions.find((o) => o.value === effectiveAccountChoice);

  // NEW-workspace DIR row: the host folder the native picker chose, to be mounted
  // at /workspace. (Existing workspaces use the WorkdirBrowser instead.)
  const newWsValue = draft.workspaceDir ? dirName(draft.workspaceDir) : "Choose a folder…";

  return (
    <div
      className="pane-body"
      onKeyDown={(e) => {
        // ⌘1–3 swap the agent quickly (matches the tip).
        if ((e.metaKey || e.ctrlKey) && ["1", "2", "3"].includes(e.key) && !resuming) {
          const c = CLIS[Number(e.key) - 1];
          if (c) {
            e.preventDefault();
            setAgent(c.id);
            return;
          }
        }
        if (
          e.key === "Enter" &&
          (e.metaKey || !(e.target as HTMLElement).closest("[role=combobox]"))
        ) {
          e.preventDefault();
          spawn();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          cancel(id);
        }
      }}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-0)",
        overflow: "auto",
        padding: 24,
      }}
    >
      <div style={{ width: "min(420px, 100%)", display: "flex", flexDirection: "column" }}>
        {/* header */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            marginBottom: 22,
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              // Purple draft styling — matches the dashed pane frame + Spawn button
              // (theme primary), not the per-agent accent.
              border: "1.5px dashed color-mix(in oklab, var(--pri) 55%, var(--bd))",
              background: "color-mix(in oklab, var(--pri) 12%, var(--bg-1))",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <AgentGlyph agent={agent} size={22} color="var(--pri)" />
          </div>
          <span style={{ fontSize: "var(--fs-16)", fontWeight: 600, color: "var(--fg-0)" }}>
            {resuming ? "Resume agent" : "New agent"}
          </span>
          <span
            style={{
              fontSize: "var(--fs-13)",
              color: "var(--fg-2)",
              textAlign: "center",
              maxWidth: 320,
            }}
          >
            {resuming ? (
              <>
                Continue this {AGENT_META[agent]?.name ?? agent} session.{" "}
                <span className="kbd">⏎</span> to resume.
              </>
            ) : (
              <>
                Pick the agent, folder, and mode. <span className="kbd">⏎</span> to spawn.
              </>
            )}
          </span>
        </div>

        {/* rows */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* AGENT */}
          <Select value={agent} onValueChange={(v) => setAgent(v as Cli)} disabled={resuming}>
            <SelectTrigger className={ROW} aria-label="Agent">
              <RowHead
                icon={<AgentGlyph agent={agent} size={15} color="var(--fg-2)" />}
                label="Agent"
              />
              <RowValue value={AGENT_META[agent]?.name ?? agent} />
            </SelectTrigger>
            <SelectContent position="popper" sideOffset={6} className={POPOVER}>
              {CLIS.map((c, i) => (
                <SelectItem key={c.id} value={c.id} className={ITEM}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <AgentGlyph agent={c.id} size={14} color={AGENT_META[c.id].accent} />
                    <span>{c.label}</span>
                    <span className="kbd" style={{ marginLeft: 4 }}>{`⌘${i + 1}`}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* MODE */}
          <Select value={mode} onValueChange={(v) => update(id, { mode: v as Mode })}>
            <SelectTrigger className={ROW} aria-label="Mode">
              <RowHead icon={Ico.gauge} label="Mode" />
              <RowValue value={MODE_BY_ID[mode].label} />
            </SelectTrigger>
            <SelectContent position="popper" sideOffset={6} className={POPOVER}>
              {modes.map((m) => (
                <SelectItem key={m} value={m} className={ITEM}>
                  {MODE_BY_ID[m].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* DIR — the agent's cwd. New ws: pick the host folder to mount.
              Existing ws: browse the mounted /workspace tree. */}
          {isNewWs ? (
            <button type="button" className={ROW} onClick={pickMount}>
              <RowHead icon={Ico.files} label="Dir" />
              <RowValue value={newWsValue} meta="browse" />
              <span style={{ display: "inline-flex", color: "var(--fg-2)", flexShrink: 0 }}>
                {Ico.chevD}
              </span>
            </button>
          ) : workspaceKey ? (
            <WorkdirBrowser
              workspaceKey={workspaceKey}
              rootLabel={ws?.dir ? dirName(ws.dir) : "workspace"}
              value={cwd}
              onChange={(p) => update(id, { cwd: p })}
            />
          ) : (
            <div className={ROW} style={{ cursor: "default", opacity: 0.6 }}>
              <RowHead icon={Ico.files} label="Dir" />
              <RowValue value="workspace" meta="root" />
            </div>
          )}

          {/* ACCOUNT */}
          <Select value={effectiveAccountChoice} onValueChange={setAccountChoice}>
            <SelectTrigger className={ROW} aria-label="Account">
              <RowHead icon={Ico.settings} label="Account" />
              <RowValue
                value={accountActive?.label ?? "Default"}
                meta={
                  <span
                    style={{
                      display: "inline-block",
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: accountActive?.present === false ? "var(--err)" : "var(--live)",
                    }}
                  />
                }
              />
            </SelectTrigger>
            <SelectContent position="popper" sideOffset={6} className={POPOVER}>
              {accountOptions.map((opt) => (
                <SelectItem
                  key={opt.value}
                  value={opt.value}
                  disabled={opt.disabled}
                  className={ITEM}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: opt.present ? "var(--live)" : "var(--err)",
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
        </div>

        {/* spawn */}
        <Button size="sm" style={{ width: "100%", marginTop: 16 }} onClick={spawn}>
          {Ico.plus}
          {resuming ? "Resume agent" : "Spawn agent"}
          <span className="kbd" style={{ marginLeft: 6 }}>
            ⏎
          </span>
        </Button>

        {/* tip */}
        <div
          className="mono"
          style={{
            marginTop: 14,
            fontSize: "var(--fs-11)",
            color: "var(--fg-3)",
            textAlign: "center",
          }}
        >
          {resuming
            ? "Esc cancel · Tab next field"
            : "⌘1–3 swap agent · Esc cancel · Tab next field"}
        </div>
      </div>
    </div>
  );
}

// One folder row inside the WorkdirBrowser popover. Mirrors shadcn SelectItem
// (rounded-sm · py-1.5 · px-2 · text-sm · hover bg-hover) so the browser reads as
// the same surface as the Agent/Mode/Account dropdowns.
const BROWSE_ROW =
  "w-full flex items-center gap-2 rounded-sm py-1.5 px-2 text-sm text-left text-[var(--fg-1)] hover:bg-[var(--bg-hover)] cursor-pointer";

function crumbStyle(active: boolean): CSSProperties {
  return {
    background: "none",
    border: "none",
    padding: "1px 3px",
    fontSize: "var(--fs-11)",
    cursor: "pointer",
    color: active ? "var(--fg-0)" : "var(--fg-2)",
    fontWeight: active ? 600 : 400,
  };
}

/**
 * Working-directory browser for an EXISTING workspace. A multi-repo mount nests
 * repos at arbitrary depth, so instead of a flat repo dropdown the user drills
 * the /workspace tree one level at a time (git repos badged with their branch)
 * and commits the folder the agent should start in as its cwd. Backed by the
 * `container_browse_dirs` IPC (one exec per level).
 */
function WorkdirBrowser({
  workspaceKey,
  rootLabel,
  value,
  onChange,
}: {
  workspaceKey: string;
  rootLabel: string;
  value: string;
  onChange: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [nav, setNav] = useState(value); // dir currently being browsed
  const [navBranch, setNavBranch] = useState<string | null>(null);
  const [selBranch, setSelBranch] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    ipc
      .containerBrowseDirs(nav, workspaceKey)
      .then((e) => alive && setEntries(e))
      .catch(() => alive && setEntries([]))
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, nav, workspaceKey]);

  const rel = (p: string) => (p === WORKSPACE_ROOT ? "" : p.slice(WORKSPACE_ROOT.length + 1));
  const crumbs = nav === WORKSPACE_ROOT ? [] : rel(nav).split("/");

  // Start each browse from the current selection.
  const toggle = (o: boolean) => {
    setOpen(o);
    if (o) {
      setNav(value);
      setNavBranch(selBranch);
    }
  };
  // depth -1 → root; else /workspace/<crumbs[0..=depth]>. A jumped-to ancestor's
  // repo branch is unknown until re-entered from its parent listing → null.
  const jumpCrumb = (depth: number) => {
    setNav(
      depth < 0 ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}/${crumbs.slice(0, depth + 1).join("/")}`,
    );
    setNavBranch(null);
  };
  const drill = (e: DirEntry) => {
    setNav(`${nav}/${e.name}`);
    setNavBranch(e.branch);
  };
  const useFolder = () => {
    onChange(nav);
    setSelBranch(navBranch);
    setOpen(false);
  };

  const triggerName = value === WORKSPACE_ROOT ? rootLabel : dirName(value);
  const triggerMeta = value === WORKSPACE_ROOT ? "mount root" : `/${rel(value)}`;

  return (
    <Popover open={open} onOpenChange={toggle}>
      <PopoverTrigger asChild>
        <button type="button" className={ROW} aria-label="Working directory">
          <RowHead icon={Ico.files} label="Dir" />
          <span
            style={{
              flex: 1,
              minWidth: 0,
              display: "inline-flex",
              alignItems: "baseline",
              gap: 8,
              textAlign: "left",
            }}
          >
            <span
              style={{
                color: "var(--fg-0)",
                fontWeight: 500,
                flexShrink: 0,
                maxWidth: "55%",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {triggerName}
            </span>
            <span
              className="mono"
              style={{
                fontSize: "var(--fs-11)",
                color: "var(--fg-3)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {selBranch ?? triggerMeta}
            </span>
          </span>
          <span style={{ display: "inline-flex", color: "var(--fg-2)", flexShrink: 0 }}>
            {Ico.chevD}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="p-0 w-[var(--radix-popover-trigger-width)] overflow-hidden bg-[var(--bg-2)] border-[var(--bd-strong)]"
      >
        {/* breadcrumb */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 2,
            flexWrap: "wrap",
            padding: "8px 12px",
            borderBottom: "1px solid var(--bd)",
          }}
        >
          <button
            type="button"
            className="mono"
            onClick={() => jumpCrumb(-1)}
            style={crumbStyle(crumbs.length === 0)}
          >
            workspace
          </button>
          {crumbs.map((c, i) => (
            <span
              key={crumbs.slice(0, i + 1).join("/")}
              style={{ display: "inline-flex", alignItems: "center", gap: 2, minWidth: 0 }}
            >
              <span style={{ color: "var(--fg-3)" }}>/</span>
              <button
                type="button"
                className="mono"
                onClick={() => jumpCrumb(i)}
                style={crumbStyle(i === crumbs.length - 1)}
              >
                {c}
              </button>
            </span>
          ))}
        </div>

        {/* listing — click a folder to drill in */}
        <div className="scroll" style={{ maxHeight: 240, overflow: "auto", padding: 4 }}>
          {loading ? (
            <div
              className="mono"
              style={{ padding: "10px 8px", fontSize: "var(--fs-11)", color: "var(--fg-3)" }}
            >
              Loading…
            </div>
          ) : entries.length === 0 ? (
            <div
              className="mono"
              style={{ padding: "10px 8px", fontSize: "var(--fs-11)", color: "var(--fg-3)" }}
            >
              No subfolders
            </div>
          ) : (
            entries.map((e) => (
              <button key={e.name} type="button" onClick={() => drill(e)} className={BROWSE_ROW}>
                <span style={{ display: "inline-flex", color: "var(--fg-2)", flexShrink: 0 }}>
                  {Ico.files}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    textAlign: "left",
                    color: "var(--fg-0)",
                    fontWeight: 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {e.name}
                </span>
                {e.isRepo && (
                  <span
                    className="mono"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 3,
                      fontSize: "var(--fs-11)",
                      color: "var(--fg-3)",
                      flexShrink: 0,
                      maxWidth: 120,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span style={{ display: "inline-flex", flexShrink: 0 }}>{Ico.branch}</span>
                    {e.branch ?? "git"}
                  </span>
                )}
                <span style={{ display: "inline-flex", color: "var(--fg-3)", flexShrink: 0 }}>
                  {Ico.chevR}
                </span>
              </button>
            ))
          )}
        </div>

        {/* commit the folder currently being browsed as the cwd */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            borderTop: "1px solid var(--bd)",
          }}
        >
          <Tip text={nav}>
            <span
              className="mono"
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: "var(--fs-11)",
                color: "var(--fg-2)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {nav}
            </span>
          </Tip>
          <Button variant="outline" size="xs" onClick={useFolder}>
            Use this folder
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
