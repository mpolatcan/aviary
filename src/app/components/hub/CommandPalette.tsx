import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import { CLIS, SPEC_BY_CLI } from "../../lib/catalog";
import { type Cli, ipc } from "../../lib/ipc";
import { useLauncher } from "../../lib/launcher";
import { useOverlay } from "../../lib/overlay";
import { type HubView, activeWorkspace, useStore } from "../../lib/store";
import { workspaceTitle } from "../../lib/tree";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../ui/command";
/**
 * Command palette (⌘K). Ported from design/screens/command-palette.jsx onto the
 * shadcn CommandDialog (cmdk). Every row is a REAL action wired to the live store
 * — go to a view, focus a running session (with its live metadata), spawn an
 * agent, open the diff / files viewer, restart the runtime, or open a recent /
 * connected repo.
 *
 * Honesty (binding): rows whose action doesn't exist are omitted, NOT shown as
 * dead entries. The design's "mute notifications" and "search transcripts" rows
 * are dropped — CodeHub has no per-session mute and no transcript search yet, so
 * listing them would be a lie. They return when those features ship.
 */
import { AgentGlyph } from "../primitives/AgentGlyph";
import { Ico } from "../primitives/icons";
import { shortPath } from "../spawn-form";

const VIEWS: { id: HubView; label: string; icon: keyof typeof Ico; section?: string }[] = [
  { id: "hub", label: "Hub", icon: "hub" },
  { id: "dashboard", label: "Dashboard", icon: "grid" },
  { id: "usage", label: "Usage", icon: "cpu" },
  { id: "containers", label: "Workspaces", icon: "container" },
  { id: "settings", label: "Integrations", icon: "branch", section: "integrations" },
  { id: "settings", label: "Settings", icon: "settings" },
];

export function CommandPalette() {
  const open = useOverlay((s) => s.palette);
  const setPalette = useOverlay((s) => s.setPalette);
  const setDiff = useOverlay((s) => s.setDiff);
  const setFiles = useOverlay((s) => s.setFiles);
  const setResume = useOverlay((s) => s.setResume);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const sessionActivity = useStore((s) => s.sessionActivity);
  const workspaces = useStore((s) => s.workspaces);
  const active = useStore(activeWorkspace);
  const view = useStore((s) => s.view);
  const settingsSection = useStore((s) => s.settingsSection);
  const setView = useStore((s) => s.setView);
  const setSettingsSection = useStore((s) => s.setSettingsSection);
  const focusSession = useStore((s) => s.focusSession);
  const restartRuntime = useStore((s) => s.restartRuntime);
  const selectWorkspaceDir = useStore((s) => s.selectWorkspaceDir);
  const openLaunch = useLauncher((s) => s.open);
  // Default OUTSIDE the selector: returning `?? []` inside hands
  // useSyncExternalStore a fresh array every render (config starts null) and
  // spins an infinite render loop. Select the stable ref, default in render.
  const recents = useStore((s) => s.config?.recentWorkspaces) ?? [];
  const githubRepos = useStore((s) => s.githubRepos);
  const runtimeLive = useStore((s) => s.status?.state === "running");
  // Controlled search query, used only to highlight the matched substring in row
  // labels (design command-palette.jsx `<Hi>`). cmdk still owns filtering/ordering.
  const [query, setQuery] = useState("");

  // Reset the query whenever the palette closes — the row handlers close it via
  // setPalette(false) directly (bypassing onOpenChange), so without this a
  // filtered command would leave stale filter text on the next open.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const sessions = Object.entries(sessionMeta).filter(([, meta]) => meta.cli !== "shell");
  const workspaceName = active ? workspaceTitle(active) : "current workspace";

  // Total registered actions (honest count — the palette's command surface, not
  // a per-keystroke filtered tally; cmdk's filtered count isn't exposed without
  // reaching into its internals, so we label the stable total rather than fake a
  // live "N results"). Mirrors exactly the rows rendered below.
  const repoCount = Math.min(recents.length, 6) + Math.min(githubRepos.length, 6);
  const commandCount =
    VIEWS.length + 1 + sessions.length + (runtimeLive ? 4 + CLIS.length : 0) + repoCount;

  const goView = (id: HubView, section?: string) => {
    if (section) setSettingsSection(section);
    setView(id);
    setPalette(false);
  };
  const goSession = (session: string) => {
    focusSession(session);
    setView("hub");
    setPalette(false);
  };
  const spawn = (cli: Cli) => {
    setPalette(false);
    openLaunch(`palette:${cli}`, { dir: "row", preferredCli: cli });
  };
  const openDiff = () => {
    setPalette(false);
    setView("hub");
    setDiff("");
  };
  const openFiles = () => {
    setPalette(false);
    setView("hub");
    setFiles(true);
  };
  const openResume = () => {
    setPalette(false);
    setView("hub");
    setResume(true);
  };
  const restart = () => {
    setPalette(false);
    if (
      window.confirm(
        "Restart the runtime container? This ends every running session (tmux scrollback is kept).",
      )
    ) {
      void restartRuntime();
    }
  };
  const openRecent = (path: string) => {
    setPalette(false);
    void selectWorkspaceDir(path);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setQuery("");
        setPalette(v);
      }}
      className="top-[90px] w-[min(680px,calc(100vw-32px))] max-w-[calc(100vw-32px)] translate-y-0 gap-0 rounded-xl border-[var(--bd-strong)] bg-[var(--bg-2)] p-0 shadow-[0_30px_80px_rgba(0,0,0,.6)] sm:max-w-none"
      showCloseButton={false}
      title="Command palette"
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Go to a view, focus a session, or spawn an agent…"
      />
      <CommandList className="max-h-[520px]">
        <CommandEmpty>No matches.</CommandEmpty>

        <CommandGroup heading={`Go to · ${VIEWS.length}`}>
          {VIEWS.map((v) => (
            <CommandItem
              key={`${v.id}:${v.section ?? v.label}`}
              value={`view ${v.label}`}
              onSelect={() => goView(v.id, v.section)}
              disabled={v.id === view && (!v.section || v.section === settingsSection)}
            >
              <span style={{ display: "inline-flex", color: "var(--fg-2)" }}>{Ico[v.icon]}</span>
              <span style={{ flex: 1 }}>
                <Hi text={v.label} q={query} />
              </span>
              {v.id === view && (!v.section || v.section === settingsSection) && (
                <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                  current
                </span>
              )}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandGroup heading="Window">
          <CommandItem
            value="open companion floating window monitor"
            onSelect={() => {
              setPalette(false);
              void ipc.openCompanion();
            }}
          >
            <span style={{ display: "inline-flex", color: "var(--fg-2)" }}>{Ico.bell}</span>
            <span style={{ flex: 1 }}>
              <Hi text="Open companion window" q={query} />
            </span>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
              always on top
            </span>
          </CommandItem>
        </CommandGroup>

        {sessions.length > 0 && (
          <CommandGroup heading={`Agents · ${sessions.length}`}>
            {sessions.map(([session, meta]) => {
              const ws = workspaces.find((w) => w.id === meta.workspaceId);
              // Live working/idle from the real output-flow activity signal —
              // a real state dot, not a hard-coded one. Absent → no dot.
              const working = sessionActivity[session]?.state === "working";
              return (
                <CommandItem
                  key={session}
                  value={`session ${meta.alias} ${SPEC_BY_CLI[meta.cli].label}`}
                  onSelect={() => goSession(session)}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: working ? "var(--live)" : "var(--idle)",
                      }}
                    />
                    <AgentGlyph agent={meta.cli} size={12} color={`var(--a-${meta.cli})`} />
                  </span>
                  <span style={{ flex: 1 }}>
                    <Hi text={meta.alias} q={query} />
                  </span>
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                    {SPEC_BY_CLI[meta.cli].label} · {meta.mode}
                    {ws && ` · tab ${ws.plate}`}
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        {/* Whole group is gated on a live runtime — all three commands need it —
            so the heading count stays honest (no "Commands · 3" with dead rows). */}
        {runtimeLive && (
          <CommandGroup heading="Commands · 4">
            <CommandItem value="review all changes diff workspace" onSelect={openDiff}>
              <span style={{ display: "inline-flex", color: "var(--fg-2)" }}>{Ico.diff}</span>
              <span style={{ flex: 1 }}>
                <Hi text="Review all changes" q={query} />
              </span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                workspace diff
              </span>
            </CommandItem>
            <CommandItem value="open files browser workspace" onSelect={openFiles}>
              <span style={{ display: "inline-flex", color: "var(--fg-2)" }}>{Ico.files}</span>
              <span style={{ flex: 1 }}>
                <Hi text="Open files browser" q={query} />
              </span>
            </CommandItem>
            <CommandItem value="resume past session drawer claude codex" onSelect={openResume}>
              <span style={{ display: "inline-flex", color: "var(--fg-2)" }}>{Ico.clock}</span>
              <span style={{ flex: 1 }}>
                <Hi text="Open Resume drawer" q={query} />
              </span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                ⌘R
              </span>
            </CommandItem>
            <CommandItem value="restart runtime container" onSelect={restart}>
              <span style={{ display: "inline-flex", color: "var(--fg-2)" }}>{Ico.container}</span>
              <span style={{ flex: 1 }}>
                <Hi text="Restart runtime container" q={query} />
              </span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                ends sessions
              </span>
            </CommandItem>
          </CommandGroup>
        )}

        {runtimeLive && (
          <CommandGroup heading={`Spawn new agent · ${CLIS.length}`}>
            {CLIS.map((c) => (
              <CommandItem key={c.id} value={`spawn ${c.label}`} onSelect={() => spawn(c.id)}>
                <AgentGlyph agent={c.id} size={13} color={`var(--a-${c.id})`} />
                <span style={{ flex: 1 }}>
                  <span style={{ color: "var(--fg-2)" }}>{c.label} in </span>
                  <Hi text={workspaceName} q={query} />
                </span>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                  standard · ⌘N
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* Repos — recent local workspaces (real Tier-2 MRU) plus repos visible
            to a connected GitHub account (honest-empty until the BE connector
            lands). Selecting a recent re-points the /workspace mount. */}
        {(recents.length > 0 || githubRepos.length > 0) && (
          <CommandGroup
            heading={`Repos · ${Math.min(recents.length, 6) + Math.min(githubRepos.length, 6)}`}
          >
            {recents.slice(0, 6).map((path) => (
              <CommandItem
                key={path}
                value={`repo recent ${path}`}
                onSelect={() => openRecent(path)}
              >
                <span style={{ display: "inline-flex", color: "var(--fg-2)" }}>{Ico.files}</span>
                <span style={{ flex: 1 }}>
                  <Hi text={shortPath(path)} q={query} />
                </span>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                  recent
                </span>
              </CommandItem>
            ))}
            {githubRepos.slice(0, 6).map((repo) => (
              <CommandItem
                key={repo.nameWithOwner}
                value={`repo github ${repo.nameWithOwner}`}
                // No clone-into-workspace command exists yet, so a GitHub repo row
                // is informational — it opens the Integrations pane (where the
                // connected account + repo list live) rather than a fake action.
                onSelect={() => {
                  setSettingsSection("integrations");
                  goView("settings", "integrations");
                }}
              >
                <span style={{ display: "inline-flex", color: "var(--fg-2)" }}>{Ico.branch}</span>
                <span style={{ flex: 1 }}>
                  <Hi text={repo.nameWithOwner} q={query} />
                </span>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                  {repo.private ? "private" : "public"}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>

      {/* Footer nav-hint bar (design/screens/command-palette.jsx). Only the hints
          that are REAL cmdk behaviors: ↑↓ move, ⏎ run, esc close. The design's
          "⌘⏎ open in new pane" / "⌥⏎ spawn here" rows are dropped — no modifier
          handlers are wired on the items, so listing them would be a lie. Right
          side shows the stable total action count (not a faked "N results · Nms").*/}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "6px 14px",
          borderTop: "1px solid var(--bd-soft)",
          background: "var(--bg-1)",
          fontSize: 11,
          color: "var(--fg-2)",
        }}
      >
        <span>
          <Kbd>↑</Kbd>
          <Kbd style={{ marginLeft: 2 }}>↓</Kbd> navigate
        </span>
        <span>
          <Kbd>⏎</Kbd> open
        </span>
        <span>
          <Kbd>esc</Kbd> close
        </span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ color: "var(--fg-3)" }}>
          {commandCount} commands
        </span>
      </div>
    </CommandDialog>
  );
}

// Highlights the first case-insensitive occurrence of the query inside a label
// (design command-palette.jsx `<Hi>`). cmdk does the matching/ordering; this is
// purely the visual emphasis on the matched substring.
function Hi({ text, q }: { text: string; q: string }) {
  const needle = q.trim();
  if (!needle) return <>{text}</>;
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span style={{ color: "var(--fg-0)", fontWeight: 600 }}>
        {text.slice(i, i + needle.length)}
      </span>
      {text.slice(i + needle.length)}
    </>
  );
}

function Kbd({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 16,
        height: 16,
        padding: "0 4px",
        borderRadius: 4,
        background: "var(--bg-3)",
        border: "1px solid var(--bd-soft)",
        color: "var(--fg-2)",
        fontSize: 10,
        ...style,
      }}
    >
      {children}
    </span>
  );
}
