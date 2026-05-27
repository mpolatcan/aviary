/**
 * NewWorkspace — the 3-step "new workspace" wizard. Ported from
 * design/screens/new-workspace.jsx, adapted to CodeHub's real architecture.
 *
 * A workspace here is a saved name + host directory pointer (config.savedWorkspaces);
 * opening it creates or reuses that workspace's own container. So the design's
 * fabricated surfaces are corrected to the honest ones:
 *   - Step 2 "Container size / $cost / keychain / sleep-30min" → the current
 *     workspace container panel (SharedRuntimePanel): host-env keys, no sizing
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
import { Segmented } from "@/app/components/primitives/Segmented";
import { Ico } from "@/app/components/primitives/icons";
import {
  AccountCard,
  AgentCard,
  FormRow,
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
import { type Cli, type ImageInfo, type Mode, ipc } from "@/app/lib/ipc";
import { useOverlay } from "@/app/lib/overlay";
import { useStore } from "@/app/lib/store";
import { Button } from "@/app/ui/button";
import { type ReactNode, useEffect, useRef, useState } from "react";

const STEPS = ["Repository", "Container", "Name & launch"] as const;

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

  const defaultDir = workspaceInfo?.effective ?? null;
  const [repoDir, setRepoDir] = useState<string | null>(null);
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
  const { agentAccounts, defaultKey, effectiveAccountChoice, selectedAccount } =
    agentAccountState(agent, accountProfiles, keyStatus, accountChoice);

  useEffect(() => {
    void loadAccountProfiles();
  }, [loadAccountProfiles]);

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
      const id = savedWorkspaceIdRef.current ?? (await saveWorkspace(title, dir));
      savedWorkspaceIdRef.current = id;
      await openSavedWorkspace(id); // marks lastOpened + ensures the mount points here
      await newPlate(agent, mode, undefined, prompt.trim() || undefined, selectedAccount, {
        title,
        dir,
        savedWorkspaceId: id,
      });
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
          width: "52rem",
          maxWidth: "calc(100vw - 48px)",
          maxHeight: "calc(100% - 56px)",
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
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--fg-0)" }}>
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

        {/* body */}
        <div style={{ padding: "18px", overflow: "auto", flex: 1 }}>
          {step === 1 && (
            <FormRow label="Repository">
              <RepositoryPicker value={dir} onChange={setRepoDir} />
              <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)", marginTop: 8 }}>
                The host folder bound at /workspace. Agents in this workspace read and write here.
              </div>
            </FormRow>
          )}

          {step === 2 && (
            <>
              <FormRow label="Container">
                <SharedRuntimePanel />
              </FormRow>
              <FormRow label="Base image">
                <BaseImagePanel />
              </FormRow>
            </>
          )}

          {step === 3 && (
            <>
              <FormRow label="Workspace name">
                <input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setTouchedName(true);
                  }}
                  placeholder="e.g. honey-badger"
                  spellCheck={false}
                  // biome-ignore lint/a11y/noAutofocus: first field of the final step
                  autoFocus
                  style={{
                    width: "100%",
                    background: "var(--bg-0)",
                    border: "1px solid var(--bd)",
                    borderRadius: 8,
                    padding: "9px 12px",
                    fontSize: 13,
                    color: "var(--fg-0)",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
              </FormRow>

              <FormRow label="First agent">
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
                <div
                  className="mono"
                  style={{ fontSize: 10.5, color: "var(--fg-3)", marginTop: 6 }}
                >
                  {MODE_BY_ID[mode].hint}
                </div>
              </FormRow>

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
                <div
                  className="mono"
                  style={{ fontSize: 10.5, color: "var(--fg-3)", marginTop: 6 }}
                >
                  Used for the first agent in this workspace. Manage saved accounts in Settings.
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
                    minHeight: 64,
                    fontFamily: "var(--mono)",
                    fontSize: 12,
                    color: "var(--fg-1)",
                    lineHeight: 1.5,
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
              </FormRow>
            </>
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
            style={{ fontSize: 11, color: launchError ? "var(--err)" : "var(--fg-2)" }}
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
          <Button size="sm" style={{ padding: "6px 14px" }} disabled={!dir || saving} onClick={next}>
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
            fontSize: 13,
            color: "var(--fg-0)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {image?.tag ?? dash}
        </div>
        <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-2)", marginTop: 2 }}>
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
            fontSize: 10,
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
            fontSize: 12,
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
            fontSize: 12,
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
