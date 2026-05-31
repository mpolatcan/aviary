import type { CSSProperties, MouseEventHandler } from "react";
import { Tip } from "./Tip";
import { Ico } from "./icons";

// IDE-style "toggle a pane of type X" chip for the Hub ActionBar. Ported from
// design/screens/workspace.jsx `PaneAddBtn` — icon-only (the design hides the
// label; the title carries the affordance), color-coded per pane type via the
// `--pa-c` custom prop so the types stay recognizable across the chrome.
//
// Files / Shell / Diff are docked-viewer TOGGLES (active = the viewer is open).
// The design's `kind="agent"` is intentionally absent: spawning an agent goes
// through the SpawnSplitBtn + rich launcher, not a bare chip.
export type PaneAddKind = "files" | "shell" | "diff";

const MAP: Record<
  PaneAddKind,
  { label: string; color: string; icon: keyof typeof Ico; toggle: boolean }
> = {
  files: { label: "Files", color: "var(--idle)", icon: "files", toggle: true },
  shell: { label: "Shell", color: "var(--live)", icon: "terminal", toggle: true },
  diff: { label: "Diff", color: "var(--wait)", icon: "diff", toggle: true },
};

export function PaneAddBtn({
  kind,
  kbd,
  active = false,
  showLabel = false,
  onClick,
}: {
  kind: PaneAddKind;
  kbd: string;
  active?: boolean;
  showLabel?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
}) {
  const m = MAP[kind];
  const titlePrefix = m.toggle ? (active ? "Hide" : "Show") : "New";
  const suffix = m.toggle ? " pane" : "";
  return (
    <Tip text={`${titlePrefix} ${m.label}${suffix} · ${kbd}`}>
      <button
        type="button"
        className={`pane-add-btn${m.toggle && active ? " active" : ""}${showLabel ? " with-label" : ""}`}
        aria-pressed={m.toggle ? active : undefined}
        onClick={onClick}
        style={{ "--pa-c": m.color } as CSSProperties}
      >
        {Ico[m.icon]}
        {showLabel && (
          <span style={{ fontSize: "var(--fs-11)", fontFamily: "var(--mono)", fontWeight: 500 }}>
            {m.label}
          </span>
        )}
      </button>
    </Tip>
  );
}
