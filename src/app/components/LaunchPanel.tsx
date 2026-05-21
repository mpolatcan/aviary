import type { Cli, Mode } from "../lib/ipc";
import { useLaunchChoice } from "../lib/launcher";
import { LauncherBody } from "./LauncherBody";

interface Props {
  // Pixel-cap label above the body (e.g. "New tab", "Split", "Add to tab").
  kicker: string;
  onLaunch: (cli: Cli, mode: Mode) => void;
}

// The single launch UI shared by every surface (tab "+", ⌘T, pane split, rail).
// Always the compact stacked popover body — see lib/launcher.ts for how each
// trigger drives it open. Keeps copy + layout identical everywhere; the primary
// button copy is standardised to "Open session".
export function LaunchPanel({ kicker, onLaunch }: Props) {
  const { cli, mode, setCli, setMode } = useLaunchChoice();
  return (
    <div
      className={mode === "yolo" ? "yolo-armed" : undefined}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onLaunch(cli, mode);
        }
      }}
    >
      <header className="popover-head">
        <span className="kicker">{kicker}</span>
      </header>
      <LauncherBody cli={cli} mode={mode} setCli={setCli} setMode={setMode} />
      <footer className="popover-foot">
        <button type="button" className="start" onClick={() => onLaunch(cli, mode)}>
          Open session
        </button>
      </footer>
    </div>
  );
}
