import type { AgentCli, Cli, Mode } from "./ipc";

export interface ModeSpec {
  id: Mode;
  label: string;
  hint: string;
  badge: string;
}

export const MODES: ModeSpec[] = [
  { id: "standard", label: "Standard", hint: "Agent asks before edits and commands.", badge: "" },
  {
    id: "auto",
    label: "Auto",
    hint: "Auto-accepts edits in the workspace, still sandboxed.",
    badge: "AUTO",
  },
  {
    id: "yolo",
    label: "YOLO",
    hint: "Skips all approvals & sandbox — the container is the boundary.",
    badge: "YOLO",
  },
];

export const MODE_BY_ID: Record<Mode, ModeSpec> = Object.fromEntries(
  MODES.map((m) => [m.id, m]),
) as Record<Mode, ModeSpec>;

// Permission modes per agent. Antigravity's launch flags are unverified, so it
// offers Standard only. Shell is not an agent (no modes) — see `modesFor`.
export const MODE_SUPPORT: Record<AgentCli, Mode[]> = {
  claude: ["standard", "auto", "yolo"],
  codex: ["standard", "auto", "yolo"],
  antigravity: ["standard"],
};

// Permission modes a pane type offers. Shell runs plain bash with no agent
// guardrails to relax, so it has the single "standard" mode; agents defer to
// MODE_SUPPORT.
export function modesFor(cli: Cli): Mode[] {
  return cli === "shell" ? ["standard"] : MODE_SUPPORT[cli];
}

export interface CliSpec {
  id: Cli;
  // Full product name for the launcher row (e.g. "Claude Code").
  label: string;
  // Short name used to number default sessions (e.g. "Claude 1").
  alias: string;
}

// The launchable AI agents (the launcher's Agent column). Shell is offered
// separately (SHELL_SPEC) since it's a pane type, not an agent. Typed with
// `id: AgentCli` so agent-keyed lookups (keyStatus/agentVersions) stay sound.
export const CLIS: (CliSpec & { id: AgentCli })[] = [
  { id: "claude", label: "Claude Code", alias: "Claude" },
  { id: "codex", label: "Codex", alias: "Codex" },
  { id: "antigravity", label: "Antigravity", alias: "Antigravity" },
];

// The non-agent shell pane (Workspace screen's SHELL type): a plain bash session
// in the container.
export const SHELL_SPEC: CliSpec = { id: "shell", label: "Shell", alias: "Shell" };

// Spec lookup covering every pane type (agents + shell), since a session's
// `meta.cli` can be any of them.
export const SPEC_BY_CLI: Record<Cli, CliSpec> = Object.fromEntries(
  [...CLIS, SHELL_SPEC].map((c) => [c.id, c]),
) as Record<Cli, CliSpec>;
