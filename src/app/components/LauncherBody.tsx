import { CLIS, MODES, MODE_BY_ID, MODE_SUPPORT } from "../lib/catalog";
import type { Cli, Mode } from "../lib/ipc";

interface Props {
  cli: Cli;
  mode: Mode;
  setCli: (c: Cli) => void;
  setMode: (m: Mode) => void;
  // "cols" = two-column dialog; "stack" = single column for the popover.
  layout?: "cols" | "stack";
}

// Agent picker × permission-mode chooser. Controlled by the parent (dialog or
// popover) via useLaunchChoice.
export function LauncherBody({ cli, mode, setCli, setMode, layout = "cols" }: Props) {
  const allowed = MODE_SUPPORT[cli];
  return (
    <div className={layout === "cols" ? "launch-body" : "launch-body stack"}>
      <section className="launch-col agents">
        <span className="col-label">Agent</span>
        <div className="agent-list">
          {CLIS.map((c) => (
            <button
              type="button"
              key={c.id}
              className={`agent-row${c.id === cli ? " selected" : ""}`}
              aria-label={c.label}
              onClick={() => setCli(c.id)}
            >
              <svg className="bird" aria-hidden="true">
                <use href={c.bird} />
              </svg>
              <span className="ar-text">
                <span className="ar-name">{c.label}</span>
                <span className="ar-species">{c.species}</span>
              </span>
              <span className="ar-tick" aria-hidden="true">
                ●
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="launch-col modes">
        <span className="col-label">Permission mode</span>
        <div className="mode-seg">
          {MODES.map((m) => {
            const ok = allowed.includes(m.id);
            return (
              <button
                type="button"
                key={m.id}
                className={`mode-opt mode-${m.id}${m.id === mode ? " selected" : ""}${ok ? "" : " disabled"}`}
                aria-pressed={m.id === mode}
                disabled={!ok}
                onClick={() => ok && setMode(m.id)}
              >
                {m.label}
              </button>
            );
          })}
        </div>
        <p className="mode-hint">{MODE_BY_ID[mode].hint}</p>
        <p className="mode-warn">
          ⚠ Bypasses the agent's own guardrails. Safe because the runtime container is isolated.
        </p>
      </section>
    </div>
  );
}
