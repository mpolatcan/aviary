import type { Cli, Mode } from "../lib/ipc";
import { useLauncher } from "../lib/launcher";
import { useStore } from "../lib/store";
import { LaunchPanel } from "./LaunchPanel";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";

const KEY = "newtab";

// New-tab launcher: the same anchored popover every other surface uses, opened
// either by clicking "+" or by ⌘T (both set the launcher store's openKey). The
// "+" button is the popover's anchor, not its trigger, so the keyboard path and
// the click path open the identical UI.
export function NewTabPopover() {
  const newPlate = useStore((s) => s.newPlate);
  const openKey = useLauncher((s) => s.openKey);
  const open = useLauncher((s) => s.open);
  const close = useLauncher((s) => s.close);
  const isOpen = openKey === KEY;

  const launch = (cli: Cli, mode: Mode) => {
    close();
    void newPlate(cli, mode);
  };

  return (
    <Popover open={isOpen} onOpenChange={(o) => (o ? open(KEY) : close())}>
      <PopoverAnchor asChild>
        <button
          type="button"
          title="Open a new tab (⌘T)"
          aria-keyshortcuts="Meta+T"
          onClick={() => open(KEY)}
          className="group flex items-center gap-[7px] px-[14px] border-l border-rule-soft text-text-dim hover:text-accent transition-colors data-[state=open]:text-accent"
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
      </PopoverAnchor>
      <PopoverContent align="end" className="modal-panel popover-launch">
        {isOpen && <LaunchPanel kicker="New tab" onLaunch={launch} />}
      </PopoverContent>
    </Popover>
  );
}
