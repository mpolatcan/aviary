import { useLaunchChoice, useLauncher } from "../lib/launcher";
import { LauncherBody } from "./LauncherBody";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";

const FLEURONS = ["tl", "tr", "bl", "br"] as const;

// App-root launcher. Opened imperatively via useLauncher.openLauncher(kicker),
// used by splits, the rail "+", and ⌘T. The new-tab button uses the popover
// (NewTabPopover) instead.
export function LauncherDialog() {
  const open = useLauncher((s) => s.open);
  const resolve = useLauncher((s) => s.resolve);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && resolve(null)}>
      {open && <Inner />}
    </Dialog>
  );
}

function Inner() {
  const kicker = useLauncher((s) => s.kicker);
  const resolve = useLauncher((s) => s.resolve);
  const { cli, mode, setCli, setMode } = useLaunchChoice();

  return (
    <DialogContent
      aria-describedby={undefined}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          resolve({ cli, mode });
        }
      }}
    >
      <div className={`modal-panel launcher${mode === "yolo" ? " yolo-armed" : ""}`}>
        {FLEURONS.map((c) => (
          <span key={c} className={`frame-fleuron ${c}`}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <use href="#fleuron" />
            </svg>
          </span>
        ))}

        <header className="modal-header">
          <span className="kicker">{kicker}</span>
          <DialogTitle asChild>
            <h2>New session</h2>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Choose an agent and a permission mode, then start the session.
          </DialogDescription>
        </header>

        <LauncherBody cli={cli} mode={mode} setCli={setCli} setMode={setMode} layout="cols" />

        <footer className="modal-footer">
          <span className="esc">
            <kbd>Esc</kbd> dismiss · <kbd>↵</kbd> start
          </span>
          <span className="footer-actions">
            <button type="button" className="cancel" onClick={() => resolve(null)}>
              Cancel
            </button>
            <button type="button" className="start" onClick={() => resolve({ cli, mode })}>
              Start session
            </button>
          </span>
        </footer>
      </div>
    </DialogContent>
  );
}
