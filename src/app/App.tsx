import { useEffect } from "react";
import { Grid } from "./components/Grid";
import { LauncherDialog } from "./components/LauncherDialog";
import { Masthead } from "./components/Masthead";
import { Rail } from "./components/Rail";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { autoSplitDir, useKeyboard } from "./hooks/useKeyboard";
import { useLauncher } from "./lib/launcher";
import { activeWorkspace, initLifecycle, useStore } from "./lib/store";

const FLEURON_CORNERS = ["tl", "tr", "bl", "br"] as const;

export function App() {
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const active = useStore(activeWorkspace);
  const newPlate = useStore((s) => s.newPlate);
  const splitSession = useStore((s) => s.splitSession);
  const openLauncher = useLauncher((s) => s.openLauncher);
  const focused = active?.focused ?? null;
  const focusedAlias = useStore((s) => (focused ? s.sessionMeta[focused]?.alias : undefined));

  useKeyboard();
  useEffect(() => {
    void initLifecycle();
  }, []);

  const state = error ? "unreachable" : (status?.state ?? null);

  // Rail "+" — add a session to the current tab by splitting its focused pane
  // along its longer axis; fall back to a new tab when nothing is open. The
  // launcher dialog picks agent × mode.
  const newSessionHere = async () => {
    const { activeWorkspaceId, workspaces } = useStore.getState();
    const ws = workspaces.find((w) => w.id === activeWorkspaceId);
    if (!ws?.focused) {
      const c = await openLauncher("New tab");
      if (c) await newPlate(c.cli, c.mode);
      return;
    }
    const c = await openLauncher("New session");
    if (!c) return;
    await splitSession(ws.focused, autoSplitDir(ws.focused), c.cli, c.mode);
  };

  return (
    <div className="grid h-full grid-rows-[56px_40px_1fr_28px]">
      <Masthead state={state} />
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
        <Rail onNewHere={newSessionHere} />
      </main>
      <StatusBar
        state={state}
        sessionName={focusedAlias}
        plate={active ? String(active.plate) : null}
      />
      <LauncherDialog />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-center select-none">
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
