import type { CSSProperties, ReactNode } from "react";
import { Fragment, useEffect, useRef, useState } from "react";
import { CLIS, SPEC_BY_CLI } from "../../lib/catalog";
import { type Cli, ipc } from "../../lib/ipc";
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
import { AgentGlyph } from "../primitives/AgentGlyph";
import { Ico } from "../primitives/icons";
import { shortPath } from "../spawn-form";

type Scope = "agent" | "spawn" | "cmd" | "repo" | null;
const SCOPES: { id: Exclude<Scope, null>; label: string }[] = [
  { id: "agent", label: "agent" },
  { id: "spawn", label: "spawn" },
  { id: "cmd", label: "cmd" },
  { id: "repo", label: "repo" },
];

const VIEWS: { id: HubView; label: string; icon: keyof typeof Ico; section?: string }[] = [
  { id: "hub", label: "Hub", icon: "hub" },
  { id: "dashboard", label: "Dashboard", icon: "grid" },
  { id: "settings", label: "Source control", icon: "branch", section: "integrations" },
  { id: "settings", label: "Settings", icon: "settings" },
];

function relativeTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function statusDotColor(sessionStatus: string | undefined): string {
  switch (sessionStatus) {
    case "running":
      return "var(--live)";
    case "awaiting":
      return "var(--wait)";
    case "idle":
      return "var(--idle)";
    case "done":
      return "var(--done)";
    case "failed":
      return "var(--err)";
    default:
      return "var(--idle)";
  }
}

function statusText(sessionStatus: string | undefined, idleMs: number): string {
  switch (sessionStatus) {
    case "running":
      return "";
    case "awaiting":
      return "awaiting approval";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "idle":
      return idleMs > 0 ? relativeTime(idleMs) : "idle";
    default:
      return "";
  }
}

function dotShadow(sessionStatus: string | undefined): string | undefined {
  switch (sessionStatus) {
    case "running":
      return "0 0 0 3px var(--live-dim)";
    case "awaiting":
      return "0 0 0 3px var(--wait-dim)";
    default:
      return undefined;
  }
}

export function CommandPalette() {
  const open = useOverlay((s) => s.palette);
  const setPalette = useOverlay((s) => s.setPalette);
  const setDiff = useOverlay((s) => s.setDiff);
  const setFiles = useOverlay((s) => s.setFiles);
  const setResume = useOverlay((s) => s.setResume);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const sessionActivity = useStore((s) => s.sessionActivity);
  const active = useStore(activeWorkspace);
  const view = useStore((s) => s.view);
  const settingsSection = useStore((s) => s.settingsSection);
  const setView = useStore((s) => s.setView);
  const setSettingsSection = useStore((s) => s.setSettingsSection);
  const focusSession = useStore((s) => s.focusSession);
  const openDetail = useStore((s) => s.openDetail);
  const restartRuntime = useStore((s) => s.restartRuntime);
  const selectWorkspaceDir = useStore((s) => s.selectWorkspaceDir);
  const newAgent = useStore((s) => s.newAgent);
  const recents = useStore((s) => s.config?.recentWorkspaces) ?? [];
  const githubRepos = useStore((s) => s.githubRepos);
  const runtimeLive = useStore((s) => s.status?.state === "running");

  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>(null);
  const [selected, setSelected] = useState("");
  const selectedRef = useRef("");
  selectedRef.current = selected;

  // ⌘⏎ action map: lowercased cmdk value → handler. Populated during render,
  // read by the capture-phase keydown listener.
  const modifierActions = useRef<Map<string, () => void>>(new Map());
  modifierActions.current.clear();

  useEffect(() => {
    if (!open) {
      setQuery("");
      setScope(null);
    }
  }, [open]);

  // Capture-phase listener for ⌘⏎ — fires before cmdk's Enter handler.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter" && e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const action = modifierActions.current.get(selectedRef.current);
        if (action) action();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open]);

  const sessions = Object.entries(sessionMeta).filter(([, meta]) => meta.cli !== "shell");
  const workspaceName = active ? workspaceTitle(active) : "current workspace";

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
  const goSessionDetail = (session: string) => {
    focusSession(session);
    setView("hub");
    openDetail(session);
    setPalette(false);
  };
  const spawn = (cli: Cli) => {
    setPalette(false);
    newAgent(cli);
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

  const show = (g: Exclude<Scope, null>) => scope === null || scope === g;

  return (
    <CommandDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setQuery("");
          setScope(null);
        }
        setPalette(v);
      }}
      onValueChange={setSelected}
      className="w-[min(680px,calc(100vw-32px))] max-w-[calc(100vw-32px)] gap-0 rounded-xl border-[var(--bd-strong)] bg-[var(--bg-2)] p-0 shadow-[0_30px_80px_rgba(0,0,0,.6)] sm:max-w-none"
      showCloseButton={false}
      title="Command palette"
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Go to a view, focus a session, or spawn an agent…"
      >
        <ScopeChips scope={scope} setScope={setScope} />
        <Kbd>esc</Kbd>
      </CommandInput>

      <CommandList className="max-h-[520px]">
        <CommandEmpty>No matches.</CommandEmpty>

        {/* ── Agents ────────────────────────────────────────────────────── */}
        {show("agent") && sessions.length > 0 && (
          <CommandGroup heading={`Agents · ${sessions.length}`}>
            {sessions.map(([session, meta]) => {
              const activity = sessionActivity[session];
              const sStatus = activity?.sessionStatus;
              const sText = statusText(sStatus, activity?.idleMs ?? 0);
              const isAwaiting = sStatus === "awaiting";
              const itemValue = `session ${meta.alias} ${SPEC_BY_CLI[meta.cli].label} ${activity?.taskDescription ?? ""}`;

              modifierActions.current.set(itemValue.toLowerCase().trim(), () =>
                goSessionDetail(session),
              );

              return (
                <CommandItem key={session} value={itemValue} onSelect={() => goSession(session)}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: statusDotColor(sStatus),
                        boxShadow: dotShadow(sStatus),
                      }}
                    />
                    <AgentGlyph agent={meta.cli} size={12} color={`var(--a-${meta.cli})`} />
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <Hi text={meta.alias} q={query} />
                    {activity?.taskDescription && (
                      <>
                        <span style={{ color: "var(--fg-3)" }}> · </span>
                        <span style={{ color: "var(--fg-1)" }}>
                          <Hi text={activity.taskDescription} q={query} />
                        </span>
                      </>
                    )}
                  </span>
                  <span
                    className="mono"
                    style={{
                      fontSize: "var(--fs-11)",
                      color: "var(--fg-3)",
                      flexShrink: 0,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    {SPEC_BY_CLI[meta.cli].label}
                    {sText && ` · ${sText}`}
                    {isAwaiting && (
                      <span
                        style={{ color: "var(--fg-2)", fontSize: "var(--fs-14)", lineHeight: 1 }}
                      >
                        ›
                      </span>
                    )}
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        {/* ── Spawn ─────────────────────────────────────────────────────── */}
        {show("spawn") && runtimeLive && (
          <CommandGroup heading={`Spawn new agent · ${CLIS.length}`}>
            {CLIS.map((c) => (
              <CommandItem key={c.id} value={`spawn ${c.label}`} onSelect={() => spawn(c.id)}>
                <AgentGlyph agent={c.id} size={13} color={`var(--a-${c.id})`} />
                <span style={{ flex: 1 }}>
                  <span style={{ color: "var(--fg-2)" }}>{c.label} in </span>
                  <Hi text={workspaceName} q={query} />
                </span>
                <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
                  standard · ⌘N
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* ── Commands ──────────────────────────────────────────────────── */}
        {show("cmd") && runtimeLive && (
          <CommandGroup heading="Commands · 4">
            <CommandItem value="review all changes diff workspace" onSelect={openDiff}>
              <span style={{ display: "inline-flex", color: "var(--fg-2)" }}>{Ico.diff}</span>
              <span style={{ flex: 1 }}>
                <Hi text="Review all changes" q={query} />
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
                  workspace diff
                </span>
                <Kbd>⌘D</Kbd>
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
            </CommandItem>
            <CommandItem value="restart runtime container" onSelect={restart}>
              <span style={{ display: "inline-flex", color: "var(--fg-2)" }}>{Ico.container}</span>
              <span style={{ flex: 1 }}>
                <Hi text="Restart runtime container" q={query} />
              </span>
              <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
                ends sessions
              </span>
            </CommandItem>
          </CommandGroup>
        )}

        {/* ── Go to ─────────────────────────────────────────────────────── */}
        {show("cmd") && (
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
                  <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
                    current
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* ── Window ────────────────────────────────────────────────────── */}
        {show("cmd") && (
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
              <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
                always on top
              </span>
            </CommandItem>
          </CommandGroup>
        )}

        {/* ── Repos ─────────────────────────────────────────────────────── */}
        {show("repo") && (recents.length > 0 || githubRepos.length > 0) && (
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
                <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
                  recent
                </span>
              </CommandItem>
            ))}
            {githubRepos.slice(0, 6).map((repo) => (
              <CommandItem
                key={repo.nameWithOwner}
                value={`repo github ${repo.nameWithOwner}`}
                onSelect={() => {
                  setSettingsSection("integrations");
                  goView("settings", "integrations");
                }}
              >
                <span style={{ display: "inline-flex", color: "var(--fg-2)" }}>{Ico.branch}</span>
                <span style={{ flex: 1 }}>
                  <Hi text={repo.nameWithOwner} q={query} />
                </span>
                <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
                  {repo.private ? "private" : "public"}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>

      {/* ── Footer hint bar ─────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "6px 14px",
          borderTop: "1px solid var(--bd-soft)",
          background: "var(--bg-1)",
          fontSize: "var(--fs-11)",
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
          <Kbd>⌘</Kbd>
          <Kbd style={{ marginLeft: 2 }}>⏎</Kbd> open in new pane
        </span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ color: "var(--fg-3)" }}>
          {commandCount} commands
        </span>
      </div>
    </CommandDialog>
  );
}

// ── Scope filter chips in the search bar ────────────────────────────────────

function ScopeChips({ scope, setScope }: { scope: Scope; setScope: (s: Scope) => void }) {
  return (
    <span style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
      {SCOPES.map((s, i) => (
        <Fragment key={s.id}>
          {i > 0 && (
            <span style={{ color: "var(--fg-3)", fontSize: "var(--fs-10)", margin: "0 4px" }}>
              ·
            </span>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setScope(scope === s.id ? null : s.id);
            }}
            style={{
              background: scope === s.id ? "var(--bg-3)" : "none",
              border: "none",
              padding: "1px 4px",
              cursor: "pointer",
              fontFamily: "var(--mono)",
              fontSize: "var(--fs-11)",
              color: scope === s.id ? "var(--fg-0)" : "var(--fg-3)",
              transition: "color 0.1s, background 0.1s",
              borderRadius: 3,
            }}
          >
            {s.label}
          </button>
        </Fragment>
      ))}
    </span>
  );
}

// ── Match highlight (amber background pill) ─────────────────────────────────

function Hi({ text, q }: { text: string; q: string }) {
  const needle = q.trim();
  if (!needle) return <>{text}</>;
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span
        style={{
          background: "var(--wait-dim)",
          color: "var(--wait)",
          borderRadius: 3,
          padding: "1px 3px",
          margin: "0 -1px",
          fontWeight: 600,
        }}
      >
        {text.slice(i, i + needle.length)}
      </span>
      {text.slice(i + needle.length)}
    </>
  );
}

// ── Keyboard shortcut badge ─────────────────────────────────────────────────

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
        fontSize: "var(--fs-10)",
        ...style,
      }}
    >
      {children}
    </span>
  );
}
