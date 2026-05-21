import { useEffect } from "react";
import { Grid } from "./components/Grid";
import { Masthead } from "./components/Masthead";
import { Rail } from "./components/Rail";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { useKeyboard } from "./hooks/useKeyboard";
import { activeWorkspace, initLifecycle, useStore } from "./lib/store";

const FLEURON_CORNERS = ["tl", "tr", "bl", "br"] as const;

export function App() {
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const active = useStore(activeWorkspace);
  const focused = active?.focused ?? null;
  const focusedAlias = useStore((s) => (focused ? s.sessionMeta[focused]?.alias : undefined));

  useKeyboard();
  useEffect(() => {
    void initLifecycle();
  }, []);

  const state = error ? "unreachable" : (status?.state ?? null);

  return (
    <div className="grid h-full grid-rows-[56px_40px_1fr_28px]">
      <Masthead />
      <TabBar />
      <main className="relative flex overflow-hidden bg-bg-deep">
        <div className="work-area">
          {FLEURON_CORNERS.map((c) => (
            <span key={c} className={`frame-fleuron ${c}`}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <use href="#fleuron" />
              </svg>
            </span>
          ))}
          {active?.root ? (
            <div className="grid-root">
              <Grid ws={active} />
            </div>
          ) : (
            <EmptyState />
          )}
        </div>
        <Rail />
      </main>
      <StatusBar
        state={state}
        sessionName={focusedAlias}
        plate={active ? String(active.plate) : null}
      />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-center select-none">
      <svg className="bird empty-bird text-text-ghost" width={220} height={110} aria-hidden="true">
        <use href="#bird-flight" />
      </svg>
      <h1 className="font-mono text-[length:var(--fs-xl)] font-medium text-text">
        <span className="text-accent">No</span> sessions <span className="text-accent">yet</span>.
      </h1>
      <p className="font-mono text-[length:var(--fs-sm)] text-text-dim">
        Open a tab to start an AI coding agent.
      </p>
      <p className="font-pixel text-[length:var(--fs-pixel)] uppercase tracking-[0.06em] text-text-faint">
        <kbd className="text-accent">＋</kbd> new tab · or wait for the runtime to wake
      </p>
    </div>
  );
}
