import { CLIS, SPEC_BY_CLI } from "../../lib/catalog";
import type { Cli } from "../../lib/ipc";
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
 * shadcn CommandDialog (cmdk), per MIGRATION.md. Every row is a REAL action wired
 * to the live store — go to a view, focus a running session, or spawn an agent.
 * The design's fabricated rows (cross-session diff, spawn-time estimates, restart
 * container, transcript search) are omitted: nothing here that doesn't work.
 */
import { AgentGlyph } from "../primitives/AgentGlyph";
import { Ico } from "../primitives/icons";

const VIEWS: { id: HubView; label: string; icon: keyof typeof Ico }[] = [
  { id: "hub", label: "Hub", icon: "hub" },
  { id: "dashboard", label: "Dashboard", icon: "grid" },
  { id: "containers", label: "Containers", icon: "container" },
  { id: "settings", label: "Settings", icon: "settings" },
];

export function CommandPalette() {
  const open = useOverlay((s) => s.palette);
  const setPalette = useOverlay((s) => s.setPalette);
  const setBroadcast = useOverlay((s) => s.setBroadcast);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const workspaces = useStore((s) => s.workspaces);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const focusSession = useStore((s) => s.focusSession);
  const newPlate = useStore((s) => s.newPlate);
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

        {sessions.length > 0 && (
          <CommandGroup heading={`Sessions · ${sessions.length}`}>
            {sessions.map(([session, meta]) => {
              const ws = workspaces.find((w) => w.id === meta.workspaceId);
              return (
                <CommandItem
                  key={session}
                  value={`session ${meta.alias} ${SPEC_BY_CLI[meta.cli].label}`}
                  onSelect={() => goSession(session)}
                >
                  {/* No per-session run-state feed yet (honest-data): show the
                      agent glyph only, not a hard-coded status dot. */}
                  <AgentGlyph agent={meta.cli} size={12} color={`var(--a-${meta.cli})`} />
                  <span style={{ flex: 1 }}>{meta.alias}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
                    {SPEC_BY_CLI[meta.cli].label}
                    {ws && ` · tab ${ws.plate}`}
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        {sessions.length > 0 && (
          <CommandGroup heading="Broadcast">
            <CommandItem
              value="broadcast prompt to agents"
              onSelect={() => {
                setPalette(false);
                setBroadcast(true);
              }}
            >
              <span style={{ display: "inline-flex", color: "var(--fg-2)" }}>{Ico.arrowR}</span>
              <span style={{ flex: 1 }}>Broadcast a prompt to agents…</span>
            </CommandItem>
          </CommandGroup>
        )}

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
      </CommandList>
    </CommandDialog>
  );
}
