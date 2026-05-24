import { CLIS, SPEC_BY_CLI } from "../../lib/catalog";
import { type Cli, ipc } from "../../lib/ipc";
import { useOverlay } from "../../lib/overlay";
import { type HubView, useStore } from "../../lib/store";
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
 * agent, broadcast a prompt, open the diff / files viewer, restart the runtime,
 * or open a recent / connected repo.
 *
 * Honesty (binding): rows whose action doesn't exist are omitted, NOT shown as
 * dead entries. The design's "mute notifications" and "search transcripts" rows
 * are dropped — CodeHub has no per-session mute and no transcript search yet, so
 * listing them would be a lie. They return when those features ship.
 */
import { AgentGlyph } from "../primitives/AgentGlyph";
import { Ico } from "../primitives/icons";

const VIEWS: { id: HubView; label: string; icon: keyof typeof Ico }[] = [
  { id: "hub", label: "Hub", icon: "hub" },
  { id: "dashboard", label: "Dashboard", icon: "grid" },
  { id: "usage", label: "Usage", icon: "cpu" },
  { id: "resume", label: "Resume", icon: "expand" },
  { id: "containers", label: "Containers", icon: "container" },
  { id: "settings", label: "Settings", icon: "settings" },
];

export function CommandPalette() {
  const open = useOverlay((s) => s.palette);
  const setPalette = useOverlay((s) => s.setPalette);
  const setBroadcast = useOverlay((s) => s.setBroadcast);
  const setDiff = useOverlay((s) => s.setDiff);
  const setFiles = useOverlay((s) => s.setFiles);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const sessionActivity = useStore((s) => s.sessionActivity);
  const workspaces = useStore((s) => s.workspaces);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const focusSession = useStore((s) => s.focusSession);
  const newPlate = useStore((s) => s.newPlate);
  const restartRuntime = useStore((s) => s.restartRuntime);
  const selectWorkspaceDir = useStore((s) => s.selectWorkspaceDir);
  const recents = useStore((s) => s.config?.recentWorkspaces ?? []);
  const githubRepos = useStore((s) => s.githubRepos);
  const runtimeLive = useStore((s) => s.status?.state === "running");

  const sessions = Object.entries(sessionMeta);

  const goView = (id: HubView) => {
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
    // Match the lifecycle layer: surface IPC failures rather than swallow them.
    newPlate(cli, "standard").catch(console.warn);
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
    <CommandDialog open={open} onOpenChange={setPalette} title="Command palette">
      <CommandInput placeholder="Go to a view, focus a session, or spawn an agent…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>

        <CommandGroup heading="Go to">
          {VIEWS.map((v) => (
            <CommandItem
              key={v.id}
              value={`view ${v.label}`}
              onSelect={() => goView(v.id)}
              disabled={v.id === view}
            >
              <span style={{ display: "inline-flex", color: "var(--fg-2)" }}>{Ico[v.icon]}</span>
              <span style={{ flex: 1 }}>{v.label}</span>
              {v.id === view && (
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
            <span style={{ flex: 1 }}>Open companion window</span>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
              always on top
            </span>
          </CommandItem>
        </CommandGroup>

        {sessions.length > 0 && (
          <CommandGroup heading={`Sessions · ${sessions.length}`}>
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
                  <span style={{ flex: 1 }}>{meta.alias}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                    {SPEC_BY_CLI[meta.cli].label} · {meta.mode}
                    {ws && ` · tab ${ws.plate}`}
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        <CommandGroup heading="Commands">
          {sessions.length > 0 && (
            <CommandItem
              value="broadcast prompt to agents compare"
              onSelect={() => {
                setPalette(false);
                setBroadcast(true);
              }}
            >
              <span style={{ display: "inline-flex", color: "var(--fg-2)" }}>{Ico.arrowR}</span>
              <span style={{ flex: 1 }}>Broadcast a prompt to agents…</span>
            </CommandItem>
          )}
          {runtimeLive && (
            <CommandItem value="review all changes diff workspace" onSelect={openDiff}>
              <span style={{ display: "inline-flex", color: "var(--fg-2)" }}>{Ico.diff}</span>
              <span style={{ flex: 1 }}>Review all changes</span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                workspace diff
              </span>
            </CommandItem>
          )}
          {runtimeLive && (
            <CommandItem value="open files browser workspace" onSelect={openFiles}>
              <span style={{ display: "inline-flex", color: "var(--fg-2)" }}>{Ico.files}</span>
              <span style={{ flex: 1 }}>Open files browser</span>
            </CommandItem>
          )}
          {runtimeLive && (
            <CommandItem value="restart runtime container" onSelect={restart}>
              <span style={{ display: "inline-flex", color: "var(--fg-2)" }}>{Ico.container}</span>
              <span style={{ flex: 1 }}>Restart runtime container</span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                ends sessions
              </span>
            </CommandItem>
          )}
        </CommandGroup>

        {runtimeLive && (
          <CommandGroup heading="Spawn new agent">
            {CLIS.map((c) => (
              <CommandItem key={c.id} value={`spawn ${c.label}`} onSelect={() => spawn(c.id)}>
                <AgentGlyph agent={c.id} size={13} color={`var(--a-${c.id})`} />
                <span style={{ flex: 1 }}>New {c.label} session</span>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                  ⌘N
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* Repos — recent local workspaces (real Tier-2 MRU) plus repos visible
            to a connected GitHub account (honest-empty until the BE connector
            lands). Selecting a recent re-points the /workspace mount. */}
        {(recents.length > 0 || githubRepos.length > 0) && (
          <CommandGroup heading="Repos">
            {recents.slice(0, 6).map((path) => (
              <CommandItem
                key={path}
                value={`repo recent ${path}`}
                onSelect={() => openRecent(path)}
              >
                <span style={{ display: "inline-flex", color: "var(--fg-2)" }}>{Ico.files}</span>
                <span style={{ flex: 1 }}>{shortPath(path)}</span>
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
                // is informational (focuses Integrations) rather than a fake action.
                onSelect={() => goView("settings")}
              >
                <span style={{ display: "inline-flex", color: "var(--fg-2)" }}>{Ico.branch}</span>
                <span style={{ flex: 1 }}>{repo.nameWithOwner}</span>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                  {repo.private ? "private" : "public"}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}

// Compact a host path: last two segments, ellipsized.
function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  const tail = parts.slice(-2).join("/");
  return parts.length > 2 ? `…/${tail}` : `/${tail}`;
}
