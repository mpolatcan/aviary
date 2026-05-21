import { useState } from "react";
import { MODE_BY_ID, SPEC_BY_CLI } from "../lib/catalog";
import type { Cli, Mode } from "../lib/ipc";
import { splitKey, useLauncher } from "../lib/launcher";
import { useStore } from "../lib/store";
import type { SplitDir } from "../lib/tree";
import { LaunchPanel } from "./LaunchPanel";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";

const IconSplitRow = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <rect
      x="1.5"
      y="2.5"
      width="5.5"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    />
    <rect
      x="9"
      y="2.5"
      width="5.5"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    />
  </svg>
);
const IconSplitCol = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <rect
      x="2.5"
      y="1.5"
      width="11"
      height="5.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    />
    <rect
      x="2.5"
      y="9"
      width="11"
      height="5.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    />
  </svg>
);
const IconClose = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

export function PaneHead({ session }: { session: string }) {
  const meta = useStore((s) => s.sessionMeta[session]);
  const splitSession = useStore((s) => s.splitSession);
  const closeSession = useStore((s) => s.closeSession);
  const renameSession = useStore((s) => s.renameSession);
  const openKey = useLauncher((s) => s.openKey);
  const ctx = useLauncher((s) => s.ctx);
  const openLaunch = useLauncher((s) => s.open);
  const closeLaunch = useLauncher((s) => s.close);
  const [editing, setEditing] = useState(false);

  if (!meta) return null;
  const spec = SPEC_BY_CLI[meta.cli];
  const badge = MODE_BY_ID[meta.mode].badge;
  const key = splitKey(session);
  const isOpen = openKey === key;

  // Both split buttons open the same anchored popover, differing only in the
  // direction they stash in the launcher store (⌘\ does the same via geometry).
  const armSplit = (dir: SplitDir) => openLaunch(key, { dir, session });
  const launch = (cli: Cli, mode: Mode) => {
    const dir = ctx?.dir ?? "row";
    closeLaunch();
    void splitSession(session, dir, cli, mode);
  };

  return (
    <div className="pane-head">
      <svg className="bird" aria-hidden="true">
        <use href={spec.bird} />
      </svg>

      {editing ? (
        <input
          className="pane-name-input"
          defaultValue={meta.alias}
          maxLength={32}
          // biome-ignore lint/a11y/noAutofocus: rename input is opened by an explicit user action
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            renameSession(session, e.currentTarget.value);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              renameSession(session, e.currentTarget.value);
              setEditing(false);
            } else if (e.key === "Escape") {
              setEditing(false);
            }
          }}
        />
      ) : (
        <span
          className="pane-name"
          title="Double-click to rename"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          {meta.alias}
        </span>
      )}

      <span className="pane-agent">{spec.label}</span>
      {badge && <span className={`mode-badge badge-${meta.mode}`}>{badge}</span>}
      <span className="pane-spacer" />

      <Popover open={isOpen} onOpenChange={(o) => !o && closeLaunch()}>
        <PopoverAnchor asChild>
          {/* Stop mousedown bubbling to the pane-leaf focus handler: its
              registry.focus() steals DOM focus as the popover opens, which trips
              Radix's focus-outside dismiss and closes the popover instantly. */}
          <span className="pane-ctl-group" onMouseDown={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="pane-ctl split-col"
              title="Split below"
              onClick={(e) => {
                e.stopPropagation();
                armSplit("col");
              }}
            >
              <IconSplitCol />
            </button>
            <button
              type="button"
              className="pane-ctl split-row"
              title="Split right (⌘\)"
              aria-keyshortcuts="Meta+Backslash"
              onClick={(e) => {
                e.stopPropagation();
                armSplit("row");
              }}
            >
              <IconSplitRow />
            </button>
          </span>
        </PopoverAnchor>
        <PopoverContent align="end" className="modal-panel popover-launch">
          {isOpen && <LaunchPanel kicker="Split — adds to this tab" onLaunch={launch} />}
        </PopoverContent>
      </Popover>

      <button
        type="button"
        className="pane-ctl close"
        title="Close session (⌘W)"
        aria-keyshortcuts="Meta+W"
        onClick={(e) => {
          e.stopPropagation();
          void closeSession(session);
        }}
      >
        <IconClose />
      </button>
    </div>
  );
}
