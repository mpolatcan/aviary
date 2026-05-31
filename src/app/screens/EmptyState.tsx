/**
 * EmptyState — first-run / no-sessions hero.
 *
 * Two exports:
 *  - `EmptyHero` — just the hero column. Used inside the live Hub shell (App.tsx),
 *    which supplies its own sidebar + activity rail.
 *  - `EmptyState` — hero + a standalone aside, for the dev screen preview
 *    (#/__screens) where there is no surrounding shell.
 *
 * Design philosophy: agent-first, not setup-first. The hero leads with the value
 * prop and "New workspace" CTA, then shows agent cards as the primary content.
 * Docker status and API keys are guidance, not a gate — each surfaces inline
 * where it's relevant (Docker as an actionable banner, keys on agent cards).
 */
import { AGENT_META, AgentGlyph, type AgentId } from "@/app/components/primitives/AgentGlyph";
import { Logo } from "@/app/components/primitives/Logo";
import { Ico } from "@/app/components/primitives/icons";
import { CLIS } from "@/app/lib/catalog";
import type { AgentCli, Cli } from "@/app/lib/ipc";
import { ipc } from "@/app/lib/ipc";
import { useOverlay } from "@/app/lib/overlay";
import { useStore } from "@/app/lib/store";
import { Button } from "@/app/ui/button";
import { useCallback, useState } from "react";

export interface EmptyStateProps {
  onNew?: (cli?: Cli) => void;
}

const AGENT_DESC: Record<AgentCli, string> = {
  claude:
    "Long-context refactors and planned edits. Reads deeply across a codebase before it touches anything.",
  codex:
    "Snappy, iterative coding with safe shell tools. Best for focused diffs and quick turnarounds.",
  antigravity:
    "Multi-step automations and longer-running analyses. Built for profiling and multi-tool tasks.",
};

const RUNTIME_LABELS: Record<string, string> = {
  docker: "Docker Desktop",
  orbstack: "OrbStack",
};

export function EmptyHero({ onNew }: EmptyStateProps) {
  const dockerInfo = useStore((s) => s.dockerInfo);
  const dockerRuntime = useStore((s) => s.dockerRuntime);
  const keyStatus = useStore((s) => s.keyStatus);
  const status = useStore((s) => s.status);
  const setView = useStore((s) => s.setView);
  const setSettingsSection = useStore((s) => s.setSettingsSection);
  const openWizard = useOverlay((s) => s.setNewWorkspace);

  const [starting, setStarting] = useState<string | null>(null);

  const daemonUp = dockerInfo?.reachable || status?.state === "running";
  const installed = dockerRuntime?.installed ?? [];
  const nothingInstalled = installed.length === 0 && dockerRuntime !== null;

  const goToKeys = () => {
    setSettingsSection("agents");
    setView("settings");
  };

  const handleStartRuntime = useCallback(async (runtime: string) => {
    setStarting(runtime);
    try {
      await ipc.startDockerApp(runtime);
    } catch (e) {
      console.warn("start_docker_app failed", e);
    }
  }, []);

  return (
    <main
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        background: "var(--bg-1)",
        position: "relative",
        color: "var(--fg-1)",
      }}
    >
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "radial-gradient(ellipse at 50% 30%, var(--bg-2), var(--bg-1) 70%)",
          }}
        />
      </div>

      <div
        className="scroll"
        style={{
          flex: 1,
          overflow: "auto",
          padding: "36px 48px 30px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          position: "relative",
        }}
      >
        <div style={{ maxWidth: 880, width: "100%" }}>
          {/* hero header */}
          <div style={{ textAlign: "center", marginBottom: 28 }}>
            {dockerInfo !== null && (
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 10px",
                  border: "1px solid var(--bd)",
                  borderRadius: 999,
                  fontSize: "var(--fs-11)",
                  color: "var(--fg-2)",
                  fontFamily: "var(--mono)",
                  marginBottom: 18,
                }}
              >
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: "50%",
                    background: daemonUp ? "var(--live)" : "var(--wait)",
                  }}
                />
                {daemonUp ? "docker daemon connected" : "waiting for docker daemon"}
                {dockerInfo?.version && (
                  <span style={{ color: "var(--fg-3)" }}>· {dockerInfo.version}</span>
                )}
              </div>
            )}
            <h1
              style={{
                margin: 0,
                fontSize: "var(--fs-26)",
                fontWeight: 600,
                letterSpacing: "-0.02em",
                color: "var(--fg-0)",
                lineHeight: 1.15,
              }}
            >
              Run coding agents,
              <br />
              <span style={{ color: "var(--fg-2)" }}>side by side, in containers.</span>
            </h1>
            <p
              style={{
                margin: "10px auto 0",
                maxWidth: 480,
                fontSize: "var(--fs-13)",
                color: "var(--fg-2)",
                lineHeight: 1.55,
              }}
            >
              Each session spawns a fresh tmux in a per-workspace container — your repo is mounted
              and credentials are stored securely in your OS keychain.
            </p>
            <div style={{ marginTop: 16 }}>
              <Button onClick={() => openWizard(true)}>{Ico.plus}New workspace</Button>
            </div>
          </div>

          {/* Docker not running banner — only when we've checked and daemon is down */}
          {dockerInfo !== null && !daemonUp && (
            <DockerBanner
              installed={installed}
              nothingInstalled={nothingInstalled}
              starting={starting}
              onStart={handleStartRuntime}
            />
          )}

          {/* agent cards — primary content */}
          <div className="lbl" style={{ marginBottom: 10 }}>
            Choose an agent to get started
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 10,
              marginBottom: 20,
            }}
          >
            {CLIS.map((c) => (
              <AgentCard
                key={c.id}
                agent={c.id}
                name={c.label}
                desc={AGENT_DESC[c.id]}
                keySet={keyStatus?.[c.id]?.present ?? false}
                onStart={() => onNew?.(c.id)}
                onSetupKey={goToKeys}
              />
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}

function DockerBanner({
  installed,
  nothingInstalled,
  starting,
  onStart,
}: {
  installed: string[];
  nothingInstalled: boolean;
  starting: string | null;
  onStart: (runtime: string) => void;
}) {
  if (nothingInstalled) {
    return (
      <div
        className="ch-card"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "14px 16px",
          marginBottom: 20,
          borderColor: "color-mix(in oklab, var(--err) 30%, var(--bd))",
          background: "color-mix(in oklab, var(--err) 4%, var(--bg-2))",
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: "color-mix(in oklab, var(--err) 12%, var(--bg-1))",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            color: "var(--err)",
          }}
        >
          {Ico.container}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: "var(--fs-13)", fontWeight: 500, color: "var(--fg-0)" }}>
            No container runtime found
          </div>
          <div style={{ fontSize: "var(--fs-12)", color: "var(--fg-2)", lineHeight: 1.45 }}>
            Install{" "}
            <a
              href="https://www.docker.com/products/docker-desktop/"
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--pri)", textDecoration: "none" }}
            >
              Docker Desktop
            </a>{" "}
            or{" "}
            <a
              href="https://orbstack.dev"
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--pri)", textDecoration: "none" }}
            >
              OrbStack
            </a>{" "}
            to run containers.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="ch-card"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "14px 16px",
        marginBottom: 20,
        borderColor: "color-mix(in oklab, var(--wait) 35%, var(--bd))",
        background: "color-mix(in oklab, var(--wait) 5%, var(--bg-2))",
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          background: "color-mix(in oklab, var(--wait) 12%, var(--bg-1))",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          color: "var(--wait)",
        }}
      >
        {Ico.container}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: "var(--fs-13)", fontWeight: 500, color: "var(--fg-0)" }}>
          Container runtime is not running
        </div>
        <div style={{ fontSize: "var(--fs-12)", color: "var(--fg-2)" }}>
          Start {installed.length === 1 ? RUNTIME_LABELS[installed[0]] : "a runtime"} to launch
          agents.
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {installed.map((rt) => (
          <Button
            key={rt}
            size="sm"
            variant={installed.length > 1 ? "outline" : "default"}
            disabled={starting !== null}
            onClick={() => onStart(rt)}
          >
            {starting === rt ? "Starting..." : `Start ${RUNTIME_LABELS[rt] ?? rt}`}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function EmptyState({ onNew }: EmptyStateProps) {
  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0, height: "100%", color: "var(--fg-1)" }}>
      <aside
        style={{
          width: 240,
          flexShrink: 0,
          background: "var(--bg-1)",
          borderRight: "1px solid var(--bd-soft)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: "12px 14px 10px", borderBottom: "1px solid var(--bd-soft)" }}>
          <Logo />
        </div>
        <div style={{ padding: "10px 10px 6px" }}>
          <Button
            onClick={() => onNew?.()}
            style={{ justifyContent: "space-between", width: "100%" }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {Ico.plus}New agent
            </span>
            <span style={{ display: "flex", gap: 2, opacity: 0.7 }}>
              <span className="kbd">⌘</span>
              <span className="kbd">N</span>
            </span>
          </Button>
        </div>
        <div style={{ padding: "10px 10px 4px" }}>
          <div className="lbl" style={{ padding: "0 4px 6px" }}>
            Views
          </div>
          <div className="side-item active">
            {Ico.hub}
            <span style={{ flex: 1 }}>Hub</span>
          </div>
          <div className="side-item" style={{ opacity: 0.4 }}>
            {Ico.settings}
            <span style={{ flex: 1 }}>Settings</span>
          </div>
        </div>
        <div style={{ flex: 1, padding: "14px 10px 4px" }}>
          <div className="lbl" style={{ padding: "0 4px 6px" }}>
            Sessions · 0
          </div>
        </div>
      </aside>
      <EmptyHero onNew={onNew} />
    </div>
  );
}

function AgentCard({
  agent,
  name,
  desc,
  keySet,
  onStart,
  onSetupKey,
}: {
  agent: AgentId;
  name: string;
  desc: string;
  keySet?: boolean;
  onStart?: () => void;
  onSetupKey?: () => void;
}) {
  const meta = AGENT_META[agent];
  return (
    <button
      type="button"
      className="ch-card-interactive"
      onClick={keySet ? onStart : onSetupKey}
      style={{
        padding: 16,
        borderRadius: 10,
        background: "var(--bg-2)",
        border: "1px solid var(--bd)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        position: "relative",
        cursor: "pointer",
        color: "inherit",
        font: "inherit",
        textAlign: "left",
        width: "100%",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            background: `color-mix(in oklab, ${meta.accent} 16%, var(--bg-1))`,
            border: `1px solid color-mix(in oklab, ${meta.accent} 35%, var(--bd))`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <span style={{ transform: "scale(1.4)" }}>
            <AgentGlyph agent={agent} size={14} color={meta.accent} />
          </span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span style={{ fontSize: "var(--fs-14)", fontWeight: 600, color: "var(--fg-0)" }}>
              {name}
            </span>
          </div>
        </div>
      </div>
      <p style={{ margin: 0, fontSize: "var(--fs-12)", color: "var(--fg-2)", lineHeight: 1.5 }}>
        {desc}
      </p>
      {keySet ? (
        <div
          className="mono"
          style={{
            fontSize: "var(--fs-11)",
            color: "var(--pri)",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          Start with {name} {Ico.arrowR}
        </div>
      ) : (
        <div
          className="mono"
          style={{
            fontSize: "var(--fs-11)",
            color: "var(--fg-3)",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          Set up API key {Ico.arrowR}
        </div>
      )}
    </button>
  );
}
