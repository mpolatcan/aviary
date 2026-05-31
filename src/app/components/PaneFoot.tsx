import { ContextGauge } from "../components/primitives/ContextGauge";
import { MetricStat } from "../components/primitives/MetricStat";
import { Ico } from "../components/primitives/icons";
import { fmtTokens, useCodexUsage, useSessionUsage } from "../hooks/useSessionUsage";
import { useStore } from "../lib/store";

// Pane FOOTER telemetry strip — moved out of PaneHead so the live tally sits at the
// bottom of the agent pane, reading as a status bar beneath the terminal. Shows the
// working dir, a context-window gauge (used / model max), the turn count, and total
// tokens. ALWAYS rendered from pane open: before the first turn there's no transcript
// yet, so the tally falls back to zeros (the gauge em-dashes an unknown window) rather
// than the strip popping in only once usage exists.
export function PaneFoot({ session }: { session: string }) {
  const meta = useStore((s) => s.sessionMeta[session]);
  const activity = useStore((s) => s.sessionActivity[session]);
  // Workspace mount dir — fallback label when the pane runs at the mount root.
  const wsDir = useStore((s) => {
    const m = s.sessionMeta[session];
    return m ? s.workspaces.find((w) => w.id === m.workspaceId)?.dir : undefined;
  });

  // Per-pane telemetry: Claude reads its transcript by claudeId, Codex its rollout
  // by codexId (notify thread-id). BOTH hooks run unconditionally and above the meta
  // guard (Rules of Hooks); the unused one gets a null id → null. The two usage
  // shapes are identical (turns / tokens / contextUsed / contextWindow).
  const claudeId = activity?.claudeId ?? (meta?.cli === "claude" ? meta.claudeId : undefined);
  const codexId = meta?.cli === "codex" ? (activity?.codexId ?? undefined) : undefined;
  const claudeUsage = useSessionUsage(claudeId ?? null);
  const codexUsage = useCodexUsage(codexId ?? null);
  const usage = claudeUsage ?? codexUsage;

  if (!meta) return null;

  // Zeros until the first turn produces a transcript (gauge em-dashes the unknown
  // window); keeps the strip in place from pane open instead of mounting on turn 1.
  const u = usage ?? { contextUsed: 0, contextWindow: 0, turns: 0, tokensIn: 0, tokensOut: 0 };

  // Working dir this pane targets: cwd basename when pinned to a sub-dir, else the
  // workspace mount's own folder name.
  const dirBase = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
  const workingDir =
    meta.cwd && meta.cwd !== "/workspace"
      ? dirBase(meta.cwd)
      : wsDir
        ? dirBase(wsDir)
        : "workspace";

  // A picked pane color tints the footer to match the head; the gauge/metrics
  // grounded on a dark mix so their default text stays legible over the fill.
  const tint = meta.color;

  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "5px 12px",
        background: tint ? `color-mix(in oklab, ${tint} 22%, var(--bg-1))` : "var(--bg-1)",
        borderTop: tint
          ? `1px solid color-mix(in oklab, ${tint} 40%, var(--bd-soft))`
          : "1px solid var(--bd-soft)",
        overflow: "hidden",
      }}
    >
      <span
        title={meta.cwd ?? wsDir ?? undefined}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          minWidth: 0,
          maxWidth: 160,
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--fg-2)",
        }}
      >
        <span style={{ display: "inline-flex", flexShrink: 0, color: "var(--fg-3)" }}>
          {Ico.files}
        </span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {workingDir}
        </span>
      </span>
      <span className="vr" style={{ height: 14 }} />
      <ContextGauge used={u.contextUsed} max={u.contextWindow} width={64} />
      <span className="vr" style={{ height: 14 }} />
      <MetricStat label="turn" value={String(u.turns)} />
      <MetricStat label="tok" value={fmtTokens(u.tokensIn + u.tokensOut)} />
    </div>
  );
}
