import { useState } from "react";
import type { Cli, Mode } from "../lib/ipc";
import { useLaunchChoice } from "../lib/launcher";
import { useStore } from "../lib/store";
import { LauncherBody } from "./LauncherBody";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

// New-tab quick-launch: a popover anchored to the "+" button. Pick agent ×
// mode, hit Open. The fuller dialog (LauncherDialog) backs splits / ⌘T.
export function NewTabPopover() {
  const [open, setOpen] = useState(false);
  const newPlate = useStore((s) => s.newPlate);

  const launch = (cli: Cli, mode: Mode) => {
    setOpen(false);
    void newPlate(cli, mode);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Open a new tab (⌘T)"
          aria-keyshortcuts="Meta+T"
          className="group flex items-center gap-[7px] px-[14px] border-r border-rule-soft text-text-dim hover:text-accent transition-colors data-[state=open]:text-accent"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <span className="text-[15px] leading-none">＋</span>
          <span className="flex flex-col leading-[1.05] text-left">
            <span className="font-pixel text-[length:var(--fs-pixel)] uppercase tracking-[0.06em]">
              new
            </span>
            <span className="font-pixel text-[length:var(--fs-pixel)] uppercase tracking-[0.06em] text-text-faint group-hover:text-accent">
              tab
            </span>
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="modal-panel popover-launch">
        {open && <Inner onLaunch={launch} />}
      </PopoverContent>
    </Popover>
  );
}

function Inner({ onLaunch }: { onLaunch: (cli: Cli, mode: Mode) => void }) {
  const { cli, mode, setCli, setMode } = useLaunchChoice();
  return (
    <div className={mode === "yolo" ? "yolo-armed" : undefined}>
      <header className="popover-head">
        <span className="kicker">New tab</span>
      </header>
      <LauncherBody cli={cli} mode={mode} setCli={setCli} setMode={setMode} layout="stack" />
      <footer className="popover-foot">
        <button type="button" className="start" onClick={() => onLaunch(cli, mode)}>
          Open session
        </button>
      </footer>
    </div>
  );
}
