import { CLIS, MODES, MODE_BY_ID, SHELL_SPEC, modesFor } from "../lib/catalog";
import type { Cli, Mode } from "../lib/ipc";
import { AgentGlyph } from "./primitives/AgentGlyph";

interface Props {
  cli: Cli;
  mode: Mode;
  setCli: (c: Cli) => void;
  setMode: (m: Mode) => void;
}

// Agent picker × permission-mode chooser. Stacked single column, shared by every
// launch popover (see LaunchPanel). Controlled by the parent via useLaunchChoice.
// The Shell pane type (plain bash) sits below the agents; it has no permission
// modes, so the mode chooser is replaced by a one-line note when it's selected.
export function LauncherBody({ cli, mode, setCli, setMode }: Props) {
  const allowed = modesFor(cli);
  const isShell = cli === "shell";
  return (
    <div className="launch-body">
      <section className="launch-col agents">
        <span className="col-label">Pane type</span>
        <div className="agent-list">
          {[...CLIS, SHELL_SPEC].map((c) => (
            <button
              type="button"
              key={c.id}
              className={`agent-row${c.id === cli ? " selected" : ""}`}
              aria-label={c.label}
              onClick={() => setCli(c.id)}
            >
              <span className="ar-glyph" aria-hidden="true">
                <AgentGlyph agent={c.id} size={20} color={`var(--a-${c.id})`} />
              </span>
              <span className="ar-text">
                <span className="ar-name">{c.label}</span>
              </span>
              <span className="ar-tick" aria-hidden="true">
                ●
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="launch-col modes">
        {isShell ? (
          <>
            <span className="col-label">Shell</span>
            <p className="mode-hint">
              Plain <span className="mono">bash</span> in the container — no agent, no permission
              modes. Runs in <span className="mono">/workspace</span>.
            </p>
          </>
        ) : (
          <>
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
          </>
        )}
      </section>
    </div>
  );
}
