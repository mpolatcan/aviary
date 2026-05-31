/**
 * NewWorkspace — the 3-step "new workspace" wizard. Ported from
 * design/screens/new-workspace.jsx, adapted to CodeHub's real architecture.
 *
 * A workspace here is a saved name + host directory pointer (config.savedWorkspaces);
 * opening it creates or reuses that workspace's own container. So the design's
 * fabricated surfaces are corrected to the honest ones:
 *   - Step 2 "Container size / $cost / keychain / sleep-30min" → the current
 *     workspace container panel (SharedRuntimePanel): keychain creds, no sizing
 *     to fake. The size/cost/lifecycle rows are dropped, not invented.
 *   - Step 1 "Repositories" (plural, N repos) → one Repository: the real folder
 *     bound at /workspace (RepositoryPicker, the same picker the spawn dialog uses).
 *   - Step 3 adds the genuinely-needed inputs: a workspace name, the first agent,
 *     its mode, account, and an optional initial prompt.
 *
 * On finish it persists the workspace (saveWorkspace), marks it opened, and spawns
 * the first agent tab. Reuses the shared spawn-form pieces so it can't drift from
 * the spawn dialog.
 */
import { IconBtn } from "@/app/components/primitives/IconBtn";
import { Tip } from "@/app/components/primitives/Tip";
import { Ico } from "@/app/components/primitives/icons";
import { FormRow } from "@/app/components/spawn-form";
import {
  AUTO_ACCOUNT,
  HOST_ACCOUNT,
  accountProfileSubtitle,
  agentAccountState,
} from "@/app/lib/accounts";
import { CLIS, MODE_BY_ID, modesFor } from "@/app/lib/catalog";
import { type Cli, type ImageInfo, type Mode, ipc } from "@/app/lib/ipc";
import { useOverlay } from "@/app/lib/overlay";
import { containerKeyFor, useStore } from "@/app/lib/store";
import { Button } from "@/app/ui/button";
import { Input } from "@/app/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/ui/select";
import { Slider } from "@/app/ui/slider";
import { Textarea } from "@/app/ui/textarea";
import { type ReactNode, useEffect, useRef, useState } from "react";

const STEPS = ["Repository", "Container", "Name & launch"] as const;

// Match the agent-pane (SpawnPane) select styling so the wizard's pickers read as
// the same control: bordered, rounded, hover-lit trigger; tinted popover;
// focus-highlighted items. (SpawnPane's ROW/ITEM/POPOVER constants, inlined here.)
const SELECT_TRIGGER =
  "mono w-full h-9 px-3 text-sm bg-[var(--bg-1)] border border-[var(--bd)] rounded-lg text-[var(--fg-0)] hover:bg-[var(--bg-hover)] hover:border-[var(--bd-strong)]";
const SELECT_CONTENT = "z-[70] bg-[var(--bg-2)] border-[var(--bd-strong)]";
const SELECT_ITEM = "text-[var(--fg-1)] focus:bg-[var(--bg-hover)] focus:text-[var(--fg-0)]";

// Trailing path segment of the mounted dir → a sensible default workspace name.
function dirName(p: string | null | undefined): string {
  if (!p) return "";
  return p.split("/").filter(Boolean).pop() ?? "";
}

export function NewWorkspace() {
  const close = useOverlay((s) => s.setNewWorkspace);
  const workspaceInfo = useStore((s) => s.workspaceInfo);
  const running = useStore((s) => s.status?.state === "running");
  const saveWorkspace = useStore((s) => s.saveWorkspace);
  const openSavedWorkspace = useStore((s) => s.openSavedWorkspace);
  const newPlate = useStore((s) => s.newPlate);
  const defaultAgent = useStore((s) => s.config?.defaultAgent ?? "claude") as Cli;
  const keyStatus = useStore((s) => s.keyStatus);
  const accountProfiles = useStore((s) => s.accountProfiles);
  const loadAccountProfiles = useStore((s) => s.loadAccountProfiles);
  const cloneRepoIntoWorkspace = useStore((s) => s.cloneRepoIntoWorkspace);

  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [touchedName, setTouchedName] = useState(false);
  const [agent, setAgentRaw] = useState<Cli>(defaultAgent);
  const [mode, setMode] = useState<Mode>("standard");
  const [accountChoice, setAccountChoice] = useState<string>(AUTO_ACCOUNT);
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const savedWorkspaceIdRef = useRef<string | null>(null);
  // GitHub repos picked in the wizard, keyed by their resolved host mount dir →
  // nameWithOwner. After the workspace opens, each is cloned in the BACKGROUND
  // into its container (see finish) — picking itself never clones.
  const [githubClones, setGithubClones] = useState<Record<string, string>>({});

  const defaultDir = workspaceInfo?.effective ?? null;
  const [repoDir, setRepoDir] = useState<string | null>(null);
  const [extraDirs, setExtraDirs] = useState<string[]>([]);
  const [cpus, setCpus] = useState(2);
  const [memGiB, setMemGiB] = useState(4);
  const dir = repoDir ?? defaultDir;

  useEffect(() => {
    if (!repoDir && defaultDir) setRepoDir(defaultDir);
  }, [defaultDir, repoDir]);

  // Suggest a name from the chosen dir until the user types their own.
  useEffect(() => {
    if (!touchedName) setName(dirName(dir));
  }, [dir, touchedName]);

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
  const accountOptions: { value: string; label: string; sub: string; present: boolean }[] = [
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
    })),
  ];

  useEffect(() => {
    void loadAccountProfiles();
  }, [loadAccountProfiles]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally clears error when ANY input changes.
  useEffect(() => {
    setLaunchError(null);
  }, [agent, mode, accountChoice, dir]);

  const dismiss = () => close(false);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  const finish = async () => {
    if (!dir || saving) return;
    setSaving(true);
    setLaunchError(null);
    try {
      const title = name.trim() || dirName(dir) || "Untitled workspace";
      // `dir` is the primary repo (mounts at /workspace); extraDirs mount beside
      // it at /workspace/<basename>. Skip any that duplicate the primary.
      const id =
        savedWorkspaceIdRef.current ??
        (await saveWorkspace(
          title,
          dir,
          extraDirs.filter((d) => d !== dir),
        ));
      savedWorkspaceIdRef.current = id;
      await openSavedWorkspace(id); // marks lastOpened + ensures the mount points here
      await newPlate(agent, mode, undefined, prompt.trim() || undefined, selectedAccount, {
        title,
        dir,
        savedWorkspaceId: id,
      });
      // Background-clone every picked GitHub repo into the now-open workspace
      // container. Tracked via the store (repoClones → CloneBanner) so the user
      // sees progress/errors; the wizard closes immediately and the repo fills in
      // at /workspace as the clone lands (Files panel auto-reloads).
      const wsKey = containerKeyFor({ title, savedWorkspaceId: id });
      const allMounts = [dir, ...extraDirs.filter((d) => d !== dir)];
      for (const p of allMounts) {
        const nwo = githubClones[p];
        if (!nwo) continue;
        const base = p.split("/").filter(Boolean).pop() ?? p;
        const target = allMounts.length > 1 ? `/workspace/${base}` : "/workspace";
        void cloneRepoIntoWorkspace(wsKey, nwo, target);
      }
      dismiss();
    } catch (e) {
      setLaunchError(String(e).replace(/^Error:\s*/, ""));
      await loadAccountProfiles();
    } finally {
      setSaving(false);
    }
  };

  const next = () => {
    if (saving) return;
    if (step < 3) setStep(step + 1);
    else void finish();
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 60 }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          dismiss();
        }
        if (e.key === "Enter" && (e.metaKey || step < 3)) {
          // ⏎ advances steps 1-2; on step 3 require ⌘⏎ so it doesn't fire while
          // typing in the name field / prompt.
          e.preventDefault();
          next();
        }
      }}
    >
      {/* scrim over the live Welcome list behind */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(6,7,9,0.55)",
          backdropFilter: "blur(14px) saturate(120%)",
          WebkitBackdropFilter: "blur(14px) saturate(120%)",
        }}
        onClick={dismiss}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,0.45) 100%)",
          pointerEvents: "none",
        }}
      />

      {/* wizard card */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "40rem",
          maxWidth: "calc(100vw - 48px)",
          maxHeight: "calc(100vh - 56px)",
          background: "var(--bg-2)",
          border: "1px solid var(--bd-strong)",
          borderRadius: 14,
          boxShadow: "var(--shadow-3)",
          display: "flex",
          flexDirection: "column",
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
          <h2
            style={{ margin: 0, fontSize: "var(--fs-14)", fontWeight: 600, color: "var(--fg-0)" }}
          >
            New workspace
          </h2>
          <span style={{ flex: 1 }} />
          <span className="kbd">esc</span>
        </div>

        {/* stepper */}
        <div
          style={{
            padding: "12px 18px",
            borderBottom: "1px solid var(--bd-soft)",
            background: "var(--bg-1)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
          }}
        >
          {STEPS.map((label, i) => {
            const n = i + 1;
            return (
              <Step key={label} n={n} label={label} done={step > n} current={step === n}>
                {i < STEPS.length - 1 && <Bar done={step > n} />}
              </Step>
            );
          })}
        </div>

        {/* body — fixed height so the card never resizes between steps. Each step
            is a full-height flex column: list/scroll regions take fixed heights and
            the primary controls anchor to the bottom, so nothing reflows. */}
        <div
          style={{
            padding: "18px",
            height: 440,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {step === 1 && (
            <RepoStep
              dir={dir}
              setRepoDir={setRepoDir}
              extraDirs={extraDirs}
              setExtraDirs={setExtraDirs}
              onPickGithub={(hostPath, nwo) =>
                setGithubClones((prev) => ({ ...prev, [hostPath]: nwo }))
              }
            />
          )}

          {step === 2 && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                height: "100%",
                justifyContent: "space-between",
              }}
            >
              <ContainerResourceStep
                cpus={cpus}
                setCpus={setCpus}
                memGiB={memGiB}
                setMemGiB={setMemGiB}
              />
              <FormRow label="Base image">
                <BaseImagePanel />
              </FormRow>
            </div>
          )}

          {step === 3 && (
            <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
              <FormRow label="Workspace name">
                <Input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setTouchedName(true);
                  }}
                  placeholder="e.g. honey-badger"
                  spellCheck={false}
                  autoFocus
                  className="mono h-auto rounded-lg px-3.5 py-2.5 text-sm"
                />
              </FormRow>

              {/* agent + mode share one row; both selects fill their half-width */}
              <FormRow label="First agent">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div>
                    <div className="lbl" style={{ marginBottom: 6 }}>
                      Agent
                    </div>
                    <Select value={agent} onValueChange={(v) => setAgent(v as Cli)}>
                      <SelectTrigger className={SELECT_TRIGGER}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className={SELECT_CONTENT}>
                        {CLIS.map((c) => (
                          <SelectItem key={c.id} value={c.id} className={SELECT_ITEM}>
                            {c.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <div className="lbl" style={{ marginBottom: 6 }}>
                      Mode
                    </div>
                    <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
                      <SelectTrigger className={SELECT_TRIGGER}>
                        <SelectValue />
                      </SelectTrigger>
                      {/* Items show the label only; the longer description rides a
                          hover tooltip so the list stays compact. */}
                      <SelectContent className={SELECT_CONTENT}>
                        {modes.map((m) => (
                          <Tip
                            key={m}
                            text={MODE_BY_ID[m].hint}
                            side="right"
                            delay={200}
                            className="z-[80] max-w-56"
                          >
                            <SelectItem value={m} className={SELECT_ITEM}>
                              {MODE_BY_ID[m].label}
                            </SelectItem>
                          </Tip>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </FormRow>

              <FormRow label="Account">
                <Select value={effectiveAccountChoice} onValueChange={setAccountChoice}>
                  <SelectTrigger className={SELECT_TRIGGER}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className={SELECT_CONTENT}>
                    {accountOptions.map((opt) => (
                      <SelectItem
                        key={opt.value}
                        value={opt.value}
                        className={SELECT_ITEM}
                        disabled={opt.value !== HOST_ACCOUNT && !opt.present}
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
              </FormRow>

              {/* initial prompt — grows to fill the rest of the step's height */}
              <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                <div
                  className="lbl"
                  style={{ color: "var(--fg-1)", marginBottom: 8, display: "flex", gap: 8 }}
                >
                  Initial prompt
                  <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
                    optional
                  </span>
                </div>
                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="First message handed to the agent once it launches…"
                  spellCheck={false}
                  className="mono resize-none text-sm"
                  style={{ flex: 1, minHeight: 64 }}
                />
              </div>
            </div>
          )}
        </div>

        {/* footer */}
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
          <span
            className="mono"
            style={{ fontSize: "var(--fs-11)", color: launchError ? "var(--err)" : "var(--fg-2)" }}
          >
            {launchError
              ? launchError
              : saving
                ? "Saving workspace and launching the first agent..."
                : step === 3
                  ? running
                    ? "Saves the workspace and spawns the first agent"
                    : "Saves the workspace — start the runtime to launch agents"
                  : `Step ${step} of ${STEPS.length}`}
          </span>
          <span style={{ flex: 1 }} />
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => (step > 1 ? setStep(step - 1) : dismiss())}
          >
            {step > 1 ? "Back" : "Cancel"}
          </Button>
          <Button
            size="sm"
            style={{ padding: "6px 14px" }}
            disabled={!dir || saving}
            onClick={next}
          >
            {saving ? "Launching..." : step < 3 ? "Continue" : "Save & launch"}
            <span className="kbd" style={{ marginLeft: 6 }}>
              {step < 3 ? "⏎" : "⌘⏎"}
            </span>
          </Button>
        </div>
      </div>
    </div>
  );
}

// The runtime's pinned base image (design/screens/new-workspace.jsx "Base image").
// Real, from `docker image inspect` (ipc.containerImage) — the same source the
// Containers view uses. The design's hard-coded toolchain list is dropped (it
// would be a fabrication); the honest, obtainable facts (tag, platform) are
// shown instead, each em-dashed when absent. Every CodeHub workspace shares this
// one pinned image, so the "pinned" badge only appears when the image is tagged.
function BaseImagePanel() {
  const [image, setImage] = useState<ImageInfo | null>(null);
  useEffect(() => {
    let alive = true;
    ipc
      .containerImage()
      .then((i) => alive && setImage(i))
      .catch(() => alive && setImage(null));
    return () => {
      alive = false;
    };
  }, []);

  const dash = "—";
  const platform = image?.os && image?.arch ? `${image.os}/${image.arch}` : dash;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 14px",
        background: "var(--bg-1)",
        border: "1px solid var(--bd-soft)",
        borderRadius: 8,
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 6,
          background: "var(--bg-3)",
          border: "1px solid var(--bd-soft)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--fg-1)",
          flexShrink: 0,
        }}
      >
        {Ico.container}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="mono"
          style={{
            fontSize: "var(--fs-13)",
            color: "var(--fg-0)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {image?.tag ?? dash}
        </div>
        <div
          className="mono"
          style={{ fontSize: "var(--fs-11)", color: "var(--fg-2)", marginTop: 2 }}
        >
          bundles every agent's runtime · {platform}
        </div>
      </div>
      {image?.tag && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontFamily: "var(--mono)",
            fontSize: "var(--fs-10)",
            color: "var(--live)",
            padding: "2px 8px",
            borderRadius: 999,
            background: "color-mix(in oklab, var(--live) 12%, transparent)",
            flexShrink: 0,
          }}
        >
          <span
            aria-hidden="true"
            style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--live)" }}
          />
          pinned
        </span>
      )}
    </div>
  );
}

// One stepper node + the connector bar that follows it. `done` = a completed
// earlier step (check), `current` = the active step (filled, bold label).
function Step({
  n,
  label,
  done,
  current,
  children,
}: {
  n: number;
  label: string;
  done?: boolean;
  current?: boolean;
  children?: ReactNode;
}) {
  const filled = done || current;
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 24,
            height: 24,
            borderRadius: "50%",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "var(--mono)",
            fontSize: "var(--fs-12)",
            fontWeight: 600,
            background: filled ? "var(--pri)" : "var(--bg-3)",
            color: filled ? "var(--bg-0)" : "var(--fg-2)",
            border: `1px solid ${filled ? "var(--pri)" : "var(--bd-soft)"}`,
          }}
        >
          {done ? Ico.check : n}
        </span>
        <span
          style={{
            fontSize: "var(--fs-12)",
            fontWeight: current ? 600 : 400,
            color: current ? "var(--fg-0)" : done ? "var(--fg-1)" : "var(--fg-2)",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
      </div>
      {children}
    </>
  );
}

function Bar({ done }: { done?: boolean }) {
  return (
    <div
      style={{
        flex: 1,
        height: 2,
        background: done ? "var(--pri)" : "var(--bd-soft)",
        borderRadius: 1,
      }}
    />
  );
}

function ResourceSlider({
  label,
  unit,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <div
      style={{
        padding: "14px 16px",
        background: "var(--bg-1)",
        border: "1px solid var(--bd-soft)",
        borderRadius: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: "var(--fs-13)", fontWeight: 500, color: "var(--fg-0)" }}>
          {label}
        </span>
        <span style={{ flex: 1 }} />
        <span
          className="mono tnum"
          style={{ fontSize: "var(--fs-20)", fontWeight: 500, color: "var(--fg-0)" }}
        >
          {value}
        </span>
        <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
          {unit}
        </span>
      </div>
      <Slider
        min={min}
        max={max}
        step={1}
        value={[value]}
        onValueChange={([v]) => onChange(v)}
        className="w-full"
      />
      <div
        className="mono"
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "var(--fs-10)",
          color: "var(--fg-3)",
          marginTop: 4,
        }}
      >
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

function ContainerResourceStep({
  cpus,
  setCpus,
  memGiB,
  setMemGiB,
}: {
  cpus: number;
  setCpus: (n: number) => void;
  memGiB: number;
  setMemGiB: (n: number) => void;
}) {
  return (
    <FormRow label="Container resources">
      <div
        className="mono"
        style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)", marginBottom: 12 }}
      >
        local Docker resources for this workspace
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <ResourceSlider label="CPU" unit="vCPU" value={cpus} min={1} max={8} onChange={setCpus} />
        <ResourceSlider
          label="Memory"
          unit="GiB"
          value={memGiB}
          min={1}
          max={16}
          onChange={setMemGiB}
        />
      </div>
    </FormRow>
  );
}

function RepoStep({
  dir,
  setRepoDir,
  extraDirs,
  setExtraDirs,
  onPickGithub,
}: {
  dir: string | null;
  setRepoDir: (d: string | null) => void;
  extraDirs: string[];
  setExtraDirs: (d: string[]) => void;
  onPickGithub: (hostPath: string, nameWithOwner: string) => void;
}) {
  const githubStatus = useStore((s) => s.githubStatus);
  const githubRepos = useStore((s) => s.githubRepos);
  const loadGithubRepos = useStore((s) => s.loadGithubRepos);
  const connected = githubStatus?.connected ?? false;
  const [localPath, setLocalPath] = useState("");
  // The repo (nameWithOwner) currently being resolved, and the last pick error.
  // Clicking a GitHub repo resolves its host mount dir (~/CodeHub/<repo>) and adds
  // it; the actual clone runs in the background after the workspace opens.
  const [picking, setPicking] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  useEffect(() => {
    if (connected) void loadGithubRepos();
  }, [connected, loadGithubRepos]);

  const allDirs = dir ? [dir, ...extraDirs] : [];
  const addDir = (d: string) => {
    if (!d || allDirs.includes(d)) return;
    if (!dir) setRepoDir(d);
    else setExtraDirs([...extraDirs, d]);
  };
  const removeDir = (d: string) => {
    if (d === dir) {
      const next = extraDirs[0] ?? null;
      setRepoDir(next);
      setExtraDirs(extraDirs.slice(1));
    } else {
      setExtraDirs(extraDirs.filter((x) => x !== d));
    }
  };
  const browseLocal = async () => {
    const path = await ipc.pickDirectory().catch(() => null);
    if (path) addDir(path); // add straight away — no extra confirm step
  };
  const pickRepo = async (nameWithOwner: string) => {
    if (picking) return;
    setPicking(nameWithOwner);
    setPickError(null);
    try {
      const hostPath = await ipc.githubRepoDir(nameWithOwner);
      addDir(hostPath);
      onPickGithub(hostPath, nameWithOwner);
    } catch (e) {
      setPickError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setPicking(null);
    }
  };
  const submitLocal = () => {
    const p = localPath.trim();
    if (p) addDir(p);
    setLocalPath("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* selected repos — fills the remaining space and scrolls; the add controls
          stay pinned below. Always rendered (empty state when none) so the section
          height never jumps between an empty and a populated list. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          marginBottom: 14,
        }}
      >
        <div className="lbl" style={{ color: "var(--fg-1)", marginBottom: 8 }}>
          Selected · {allDirs.length}
        </div>
        {/* bordered drop-area so the selected region reads as a defined panel even
            when it holds one repo or none — fills the available height, scrolls. */}
        <div
          className="scroll"
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 4,
            border: "1px solid var(--bd-soft)",
            background: "var(--bg-1)",
            borderRadius: 8,
            padding: 8,
          }}
        >
          {allDirs.length === 0 ? (
            <div
              className="mono"
              style={{
                flex: 1,
                minHeight: 56,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                textAlign: "center",
                color: "var(--fg-3)",
                fontSize: "var(--fs-12)",
                padding: "0 12px",
              }}
            >
              No repositories yet — add one below.
            </div>
          ) : (
            allDirs.map((d) => {
              const basename = d.split("/").filter(Boolean).pop() ?? d;
              const isGh = d.startsWith("/tmp/codehub-gh-");
              return (
                <div
                  key={d}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 10px",
                    background: "var(--bg-2)",
                    border: "1px solid var(--bd-soft)",
                    borderRadius: 6,
                    fontFamily: "var(--mono)",
                    fontSize: "var(--fs-11)",
                    color: "var(--fg-1)",
                    flexShrink: 0,
                  }}
                >
                  {isGh ? Ico.search : Ico.branch}
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {basename}
                  </span>
                  <span
                    className="mono"
                    style={{
                      fontSize: "var(--fs-9)",
                      padding: "1px 5px",
                      borderRadius: 3,
                      background: "var(--bg-3)",
                      border: "1px solid var(--bd-soft)",
                      color: "var(--fg-3)",
                    }}
                  >
                    {isGh ? "github" : "local"}
                  </span>
                  <span style={{ color: "var(--fg-3)", flexShrink: 0 }}>
                    {/* One repo → mounts at the root; two or more → every repo
                        (the first included) nests under /workspace. */}
                    {allDirs.length > 1 ? `→ /workspace/${basename}` : "→ /workspace"}
                  </span>
                  <IconBtn title="Remove repository" onClick={() => removeDir(d)} size={22}>
                    {Ico.close}
                  </IconBtn>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* add controls — pinned to the bottom of the step */}
      <div style={{ flexShrink: 0 }}>
        {/* local folder — input + browse button */}
        <FormRow label="Local folder">
          <div style={{ display: "flex", gap: 8 }}>
            <Input
              className="mono flex-1 text-xs"
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitLocal();
                }
              }}
              placeholder="/path/to/project"
              spellCheck={false}
            />
            <Button variant="outline" size="sm" onClick={() => void browseLocal()}>
              {Ico.files} Browse…
            </Button>
          </div>
        </FormRow>

        {/* GitHub repos */}
        <FormRow label="GitHub">
          {!connected ? (
            <div
              className="mono"
              style={{ fontSize: "var(--fs-12)", color: "var(--fg-3)", padding: "6px 0" }}
            >
              Not connected. Set up GitHub in Settings → Source control to browse repos here.
            </div>
          ) : githubRepos.length === 0 ? (
            <div
              className="mono"
              style={{ fontSize: "var(--fs-12)", color: "var(--fg-3)", padding: "6px 0" }}
            >
              No repos found for this token.
            </div>
          ) : (
            <div
              className="scroll"
              style={{
                maxHeight: 120,
                overflow: "auto",
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              {githubRepos.map((repo) => {
                const [owner, name] = repo.nameWithOwner.includes("/")
                  ? repo.nameWithOwner.split(/\/(.+)/)
                  : ["", repo.nameWithOwner];
                // A repo is "added" once its cloned host dir (…/<owner>-<name>) is
                // among the selected mounts; matched on the trailing path segment.
                const slug = name;
                const already = allDirs.some((d) => d.split("/").filter(Boolean).pop() === slug);
                const busy = picking === repo.nameWithOwner;
                const disabled = already || busy || picking !== null;
                return (
                  <button
                    type="button"
                    key={repo.nameWithOwner}
                    disabled={disabled}
                    onClick={() => void pickRepo(repo.nameWithOwner)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 12px",
                      background: already ? "var(--bg-3)" : "var(--bg-2)",
                      border: `1px solid ${already ? "var(--bd)" : "var(--bd-soft)"}`,
                      borderRadius: 6,
                      cursor: disabled ? "default" : "pointer",
                      opacity: already || (picking !== null && !busy) ? 0.6 : 1,
                      color: "inherit",
                      font: "inherit",
                      textAlign: "left",
                      width: "100%",
                      flexShrink: 0,
                    }}
                  >
                    <span style={{ display: "inline-flex", lineHeight: 0 }}>
                      {busy ? Ico.spinner : Ico.files}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span
                        className="mono"
                        style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}
                      >
                        {owner ? `${owner}/` : ""}
                      </span>
                      <span
                        className="mono"
                        style={{ fontSize: "var(--fs-12)", color: "var(--fg-0)", fontWeight: 500 }}
                      >
                        {name}
                      </span>
                      {repo.private && (
                        <span
                          className="mono"
                          style={{ fontSize: "var(--fs-9)", color: "var(--fg-3)", marginLeft: 6 }}
                        >
                          private
                        </span>
                      )}
                    </div>
                    <span
                      className="mono"
                      style={{ fontSize: "var(--fs-10)", color: "var(--fg-3)" }}
                    >
                      {already ? "added" : busy ? "adding…" : "add"}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {pickError && (
            <div
              className="mono"
              style={{ fontSize: "var(--fs-11)", color: "var(--err)", padding: "6px 0 0" }}
            >
              {pickError}
            </div>
          )}
        </FormRow>

        <div
          className="mono"
          style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)", padding: "8px 4px 0" }}
        >
          {allDirs.length > 1
            ? "Each repo mounts at /workspace/{repo-name}; /workspace is the shared parent."
            : "A single repo mounts directly at /workspace."}
        </div>
      </div>
    </div>
  );
}
