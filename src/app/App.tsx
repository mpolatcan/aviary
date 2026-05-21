import { Masthead } from "./components/Masthead";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { useContainerStatus } from "./hooks/useContainerStatus";

export function App() {
  const { status, error } = useContainerStatus();
  const state = error ? "unreachable" : (status?.state ?? null);

  return (
    <div className="grid h-full grid-rows-[56px_40px_1fr_28px]">
      <Masthead state={state} />
      <TabBar />
      <main className="relative overflow-hidden bg-pane">
        <EmptyState />
      </main>
      <StatusBar state={state} />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center select-none">
      <svg className="bird text-text-ghost" width={220} height={110} aria-hidden="true">
        <use href="#bird-flight" />
      </svg>
      <h1 className="font-mono text-[22px] font-medium text-text">
        <span className="text-accent">No</span> sessions <span className="text-accent">yet</span>.
      </h1>
      <p className="font-mono text-[13px] text-text-dim">Open a tab to start an AI coding agent.</p>
      <p className="font-pixel text-[length:var(--fs-pixel)] uppercase tracking-[0.06em] text-text-faint">
        <kbd className="text-accent">＋</kbd> new tab · or wait for the runtime to wake
      </p>
    </div>
  );
}
