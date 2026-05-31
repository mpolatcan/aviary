import { AgentGlyph } from "@/app/components/primitives/AgentGlyph";
import { IconBtn } from "@/app/components/primitives/IconBtn";
import { StatusDot, type StatusKey } from "@/app/components/primitives/StatusDot";
import { Ico } from "@/app/components/primitives/icons";
import {
  type ContainerSizing,
  type ContainerState,
  type RepoInfo,
  type SavedWorkspace,
  type WorkspaceContainer,
  ipc,
} from "@/app/lib/ipc";
import { useOverlay } from "@/app/lib/overlay";
import { containerKeyFor, useStore } from "@/app/lib/store";
import { workspaceLeaves } from "@/app/lib/tree";
import { Button } from "@/app/ui/button";
import { useEffect, useMemo, useState } from "react";

// One launcher row = one workspace you can open. Keyed by CONTAINER key (a saved
// workspace maps to its container via `containerKeyFor`); merges three sources so
// the list shows EVERY reopenable workspace, not just named/saved ones:
//   - a real container (running or stopped), enriched with its saved name/dir,
//   - an unsaved container (ad-hoc / restored), derived-named,
//   - a saved workspace with no container yet (create-on-open).
interface LauncherEntry {
  key: string;
  name: string;
  dir?: string;
  pinned: boolean;
  lastOpened: number | null;
  // Epoch-ms the saved workspace was created (null for container-only entries or
  // pre-field saves). Surfaced on the card to disambiguate same-named workspaces.
  createdAt?: number | null;
  savedId?: string;
  container?: WorkspaceContainer;
  // Per-workspace container resource limits (saved override); falls back to the
  // app default sizing in the card when absent.
  sizing?: ContainerSizing | null;
  // Extra repos this workspace mounts beside its primary dir (each at
  // /workspace/<basename>); shown as repo chips on a stopped/unopened card.
  additionalDirs?: string[];
}

// Friendly name for an unsaved container key: "<lead>-sw-<id>" → "<lead>";
// "ws-<n>-<rand>" → "Workspace <n>"; else the raw key.
function deriveName(key: string): string {
  const sw = /^(.+?)-sw-[a-z0-9-]+$/i.exec(key);
  if (sw?.[1]) return sw[1];
  const wsN = /^ws-(\d+)-/.exec(key);
  if (wsN) return `Workspace ${wsN[1]}`;
  return key;
}

// Container sizing → "2 vCPU · 4 GiB". The s/m/l label is dropped — resources are
// set directly as vCPU/GiB, so the preset letter carries no extra meaning. Drops
// parts the preset omits; integer vCPU/GiB render bare, fractional to one decimal.
function specLabel(sz: ContainerSizing | null | undefined): string | null {
  if (!sz) return null;
  const num = (n: number) => (Number.isInteger(n) ? `${n}` : n.toFixed(1));
  const cpu = sz.cpuCount != null ? `${num(sz.cpuCount)} vCPU` : null;
  const mem = sz.memoryMb != null ? `${num(sz.memoryMb / 1024)} GiB` : null;
  const out = [cpu, mem].filter(Boolean).join(" · ");
  return out || null;
}

// Compact size for the card's lifecycle IconBtns (smaller than the default 26 so
// they sit proportionally in the footer; matches the sidebar row controls).
const LIFE_BTN = { width: 22, height: 22 } as const;

const STATE_DOT: Record<ContainerState, StatusKey> = {
  running: "live",
  starting: "wait",
  stopped: "off",
  missing: "off",
  unreachable: "err",
};

function buildEntries(saved: SavedWorkspace[], containers: WorkspaceContainer[]): LauncherEntry[] {
  const savedByKey = new Map<string, SavedWorkspace>();
  for (const sw of saved) {
    savedByKey.set(containerKeyFor({ title: sw.name, savedWorkspaceId: sw.id }), sw);
  }
  const seen = new Set<string>();
  const out: LauncherEntry[] = [];
  for (const c of containers) {
    const sw = savedByKey.get(c.key);
    out.push({
      key: c.key,
      name: sw?.name ?? deriveName(c.key),
      dir: sw?.dir,
      pinned: sw?.pinned ?? false,
      lastOpened: sw?.lastOpened ?? null,
      createdAt: sw?.createdAt ?? null,
      savedId: sw?.id,
      container: c,
      sizing: sw?.sizing ?? null,
      additionalDirs: sw?.additionalDirs ?? [],
    });
    seen.add(c.key);
  }
  for (const sw of saved) {
    const key = containerKeyFor({ title: sw.name, savedWorkspaceId: sw.id });
    if (seen.has(key)) continue;
    out.push({
      key,
      name: sw.name,
      dir: sw.dir,
      pinned: sw.pinned,
      lastOpened: sw.lastOpened,
      createdAt: sw.createdAt ?? null,
      savedId: sw.id,
      sizing: sw.sizing ?? null,
      additionalDirs: sw.additionalDirs ?? [],
    });
  }
  // Running containers first, then pinned, then most-recently-opened.
  return out.sort((a, b) => {
    const ar = a.container?.status.state === "running" ? 1 : 0;
    const br = b.container?.status.state === "running" ? 1 : 0;
    if (ar !== br) return br - ar;
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.lastOpened ?? 0) - (a.lastOpened ?? 0);
  });
}

function relTime(ms: number | null): string {
  if (!ms) return "not opened yet";
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 172800) return "yesterday";
  return `${Math.floor(secs / 86400)}d ago`;
}

function dirName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

// Absolute creation date for the card meta ("created May 30, 2026"). Null when
// unknown (container-only or pre-field saves) so the card omits it.
function fmtDate(ms: number | null | undefined): string | null {
  if (!ms) return null;
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// Short, stable id for the card (drops the `sw-` prefix, caps length) so two
// workspaces that share a name are still distinguishable at a glance.
function shortId(id: string | undefined): string | null {
  if (!id) return null;
  return id.replace(/^sw-/, "").slice(0, 10);
}

// Rendered two ways: inline as the Hub's empty state (no `onClose`), and as the
// launcher OVERLAY above open tabs (`onClose` set, opened by ⌘T / the tab "+").
// In overlay mode every action closes the launcher after acting, and Esc / a
// close button dismiss it — so a workspace can be reopened or resumed without
// first closing every tab.
export function Welcome({ onClose }: { onClose?: () => void } = {}) {
  const saved = useStore((s) => s.config?.savedWorkspaces) ?? [];
  const containers = useStore((s) => s.workspaceContainers) ?? [];
  const openWizard = useOverlay((s) => s.setNewWorkspace);
  const refreshContainers = useStore((s) => s.refreshWorkspaceContainers);
  const removeSavedWorkspace = useStore((s) => s.removeSavedWorkspace);
  const openContainerWorkspace = useStore((s) => s.openContainerWorkspace);
  const openSavedWorkspace = useStore((s) => s.openSavedWorkspace);
  const beginNewWorkspaceSpawn = useStore((s) => s.beginNewWorkspaceSpawn);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "running" | "stopped">("all");
  // Explicit multi-select mode — OFF by default so the per-card checkbox reserves
  // no space; toggled by the "Select" button. `selected` = set of container keys.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Re-read the container fleet every 3s so cards/counts stay current as the user
  // opens/stops/removes workspaces (bulk delete + per-card lifecycle live here).
  useEffect(() => {
    const tick = () => void refreshContainers();
    tick();
    const h = setInterval(tick, 3000);
    return () => clearInterval(h);
  }, [refreshContainers]);

  // Overlay mode: Esc dismisses (stopPropagation so it doesn't also fire a pane's
  // own Esc handler behind the scrim).
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const entries = useMemo(() => buildEntries(saved, containers), [saved, containers]);
  const q = query.toLowerCase();
  const filtered = useMemo(
    () =>
      entries.filter((e) => {
        const matchesText =
          !q || e.name.toLowerCase().includes(q) || (e.dir ?? "").toLowerCase().includes(q);
        if (!matchesText) return false;
        if (statusFilter === "all") return true;
        const running = e.container?.status.state === "running";
        return statusFilter === "running" ? running : !running;
      }),
    [entries, q, statusFilter],
  );

  // ── Bulk selection actions ────────────────────────────────────────────────
  // Keyed by container key. "Open" opens each selected workspace into a tab;
  // "Remove" drops the saved record AND prunes any container behind one confirm.
  const selectedEntries = entries.filter((e) => selected.has(e.key));
  const toggleSelect = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const clearSelection = () => setSelected(new Set());
  const exitSelect = () => {
    setSelectMode(false);
    clearSelection();
  };
  // Mirror a card's own open(): adopt a live container, else create the tab from a
  // saved identity (inline configuring pane), else open the bare container.
  const openEntry = async (e: LauncherEntry) => {
    if (e.container) {
      await openContainerWorkspace(e.key);
    } else if (e.savedId) {
      await openSavedWorkspace(e.savedId);
      beginNewWorkspaceSpawn(undefined, { title: e.name, dir: e.dir, savedWorkspaceId: e.savedId });
    } else {
      await openContainerWorkspace(e.key);
    }
  };
  const bulkOpen = async () => {
    for (const e of selectedEntries) await openEntry(e);
    exitSelect();
    onClose?.();
  };
  const bulkDelete = async () => {
    const n = selectedEntries.length;
    if (n === 0) return;
    if (
      !window.confirm(
        `Delete ${n} workspace${n === 1 ? "" : "s"}? Bind-mounted /workspace files are preserved; their containers and saved records are removed.`,
      )
    )
      return;
    for (const e of selectedEntries) {
      if (e.container) await ipc.removeWorkspaceContainer(e.key).catch(() => {});
      if (e.savedId) await removeSavedWorkspace(e.savedId);
    }
    exitSelect();
    await refreshContainers();
  };

  return (
    <main
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        background: "var(--bg-1)",
        overflow: "hidden",
        color: "var(--fg-1)",
      }}
    >
      {/* hero band — matches design welcome.jsx */}
      <div
        style={{
          padding: "40px 48px 28px",
          borderBottom: "1px solid var(--bd-soft)",
          display: "flex",
          alignItems: "flex-end",
          gap: 24,
        }}
      >
        <div style={{ flex: 1 }}>
          <div className="lbl" style={{ marginBottom: 10 }}>
            Workspaces
          </div>
          <h1
            style={{
              margin: 0,
              fontSize: 28,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              color: "var(--fg-0)",
            }}
          >
            Pick up where you left off,
            <span style={{ color: "var(--fg-2)" }}> or start fresh.</span>
          </h1>
          <p
            style={{
              margin: "8px 0 0",
              color: "var(--fg-2)",
              fontSize: 13,
              maxWidth: 512,
              lineHeight: 1.55,
            }}
          >
            A workspace bundles repos and a container together. Open one to spawn agents inside it.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <Button
            onClick={() => {
              openWizard(true);
              onClose?.();
            }}
            title="Create a new workspace"
          >
            {Ico.plus}New workspace
          </Button>
        </div>
      </div>

      <div className="scroll" style={{ flex: 1, overflow: "auto", padding: "24px 48px 40px" }}>
        {/* toolbar: search + status filter (always present) */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 20,
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 12px",
              background: "var(--bg-2)",
              border: "1px solid var(--bd-soft)",
              borderRadius: 8,
              flex: 1,
              minWidth: 200,
              maxWidth: 360,
            }}
          >
            <span style={{ color: "var(--fg-3)", display: "inline-flex" }}>{Ico.search}</span>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter workspaces…"
              className="mono"
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                outline: "none",
                color: "var(--fg-0)",
                fontSize: 12,
              }}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--fg-3)",
                  cursor: "pointer",
                  display: "inline-flex",
                  padding: 0,
                }}
              >
                {Ico.close}
              </button>
            )}
          </div>
          <div
            style={{
              display: "inline-flex",
              border: "1px solid var(--bd-soft)",
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            {(["all", "running", "stopped"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setStatusFilter(f)}
                className="mono"
                style={{
                  fontSize: 11.5,
                  textTransform: "capitalize",
                  padding: "6px 12px",
                  border: "none",
                  cursor: "pointer",
                  background: statusFilter === f ? "var(--bg-active)" : "transparent",
                  color: statusFilter === f ? "var(--fg-0)" : "var(--fg-2)",
                }}
              >
                {f}
              </button>
            ))}
          </div>

          {/* select controls — live at the filter level, right-aligned. Entering
              select mode swaps the trigger for the bulk Open/Remove/Done actions. */}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            {selectMode ? (
              <>
                <span className="mono" style={{ fontSize: 12, color: "var(--fg-2)" }}>
                  {selected.size} selected
                </span>
                <Button
                  variant="outline"
                  onClick={() => void bulkOpen()}
                  disabled={selected.size === 0}
                  title="Open the selected workspaces"
                >
                  {Ico.arrowR}Open · {selected.size}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void bulkDelete()}
                  disabled={selected.size === 0}
                  title="Delete the selected workspaces (prunes containers + saved records)"
                  style={{ color: selected.size > 0 ? "var(--err)" : undefined }}
                >
                  {Ico.trash}Remove · {selected.size}
                </Button>
                <Button variant="ghost" onClick={exitSelect} title="Exit selection">
                  Done
                </Button>
              </>
            ) : (
              entries.length > 0 && (
                <Button
                  variant="outline"
                  onClick={() => setSelectMode(true)}
                  title="Select multiple workspaces"
                >
                  {Ico.check}Select
                </Button>
              )
            )}
          </div>
        </div>

        {filtered.length > 0 && (
          <CardSection title="Workspaces" count={filtered.length}>
            {filtered.map((e) => (
              <WorkspaceCard
                key={e.key}
                entry={e}
                onClose={onClose}
                selectMode={selectMode}
                selected={selected.has(e.key)}
                onToggleSelect={() => toggleSelect(e.key)}
              />
            ))}
          </CardSection>
        )}

        {entries.length > 0 && filtered.length === 0 && (
          <div
            className="mono"
            style={{
              padding: "32px 0",
              textAlign: "center",
              fontSize: 12,
              color: "var(--fg-3)",
            }}
          >
            No workspaces match your filters.
          </div>
        )}
      </div>
    </main>
  );
}

function CardSection({
  title,
  count,
  children,
}: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span className="lbl">{title}</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>
          {count}
        </span>
      </div>
      <div
        style={{
          display: "grid",
          // auto-fill + minmax so cards keep a sane width and wide screens get MORE
          // columns instead of a few ultra-wide cards with dead space on the right.
          // The 0-floor inside min() lets a long repo chip ellipsize, not widen its track.
          gridTemplateColumns: "repeat(auto-fill, minmax(min(320px, 100%), 1fr))",
          gap: 12,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function WorkspaceCard({
  entry,
  onClose,
  selectMode,
  selected,
  onToggleSelect,
}: {
  entry: LauncherEntry;
  onClose?: () => void;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const workspaces = useStore((s) => s.workspaces);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const openSavedWorkspace = useStore((s) => s.openSavedWorkspace);
  const openContainerWorkspace = useStore((s) => s.openContainerWorkspace);
  const removeSavedWorkspace = useStore((s) => s.removeSavedWorkspace);
  const togglePin = useStore((s) => s.toggleWorkspacePin);
  const beginNewWorkspaceSpawn = useStore((s) => s.beginNewWorkspaceSpawn);
  const refreshContainers = useStore((s) => s.refreshWorkspaceContainers);
  const startContainer = useStore((s) => s.startContainer);
  const stopContainer = useStore((s) => s.stopContainer);
  const restartContainer = useStore((s) => s.restartContainer);
  // Lifecycle op in flight for THIS container (set by the store actions). Drives
  // the inline spinner + disables the lifecycle controls so a double-click can't
  // fire two ops, and the state badge reads the transition honestly.
  const busy = useStore((s) => s.containerBusy[entry.key]);
  const defaultSizing = useStore((s) => s.config?.defaultSizing ?? null);
  const [repos, setRepos] = useState<RepoInfo[]>([]);

  // Match the live tab by CONTAINER key (accurate — saved workspaces can share a
  // /workspace dir, so a dir match would mark them all "open").
  const liveWs = workspaces.find((w) => w.containerKey === entry.key);
  const isOpen = !!liveWs;
  const agents = (liveWs ? workspaceLeaves(liveWs) : [])
    .map((s) => sessionMeta[s])
    .filter((m) => m && m.cli !== "shell");

  const state = entry.container?.status.state;
  // A lifecycle op in flight overrides the badge with its verb + a wait tint, so
  // the card reads "stopping…/restarting…/starting…" while the docker call runs.
  const dot: StatusKey = busy ? "wait" : state ? STATE_DOT[state] : "off";
  const stateLabel = busy
    ? busy
    : isOpen
      ? "open"
      : !entry.container
        ? "no container"
        : state === "running"
          ? "running"
          : state === "starting"
            ? "starting"
            : "stopped";
  // A stopped container can't be opened directly — its click STARTS it instead
  // (see cardClick), so the affordance reads "Start", not "Resume".
  const action = isOpen
    ? "Show"
    : !entry.container
      ? "Open"
      : state === "running"
        ? "Resume"
        : "Start";

  // Live repos + their branches, discovered under /workspace. Only readable while
  // the container runs (it's a docker exec) — fetched once per (key, state), so
  // the 3s fleet poll doesn't restart it. Stopped/unopened cards fall back to the
  // workspace folder name (see repoChips below).
  useEffect(() => {
    let alive = true;
    if (state === "running") {
      ipc
        .containerRepos(entry.key)
        .then((r) => alive && setRepos(r))
        .catch(() => alive && setRepos([]));
    } else {
      setRepos([]);
    }
    return () => {
      alive = false;
    };
  }, [entry.key, state]);

  // Click = open/resume into the Hub. An existing container is adopted (its live
  // agents re-attach) or opened empty; a saved workspace with no container yet is
  // created through the spawn dialog (mount set first).
  const open = async () => {
    if (entry.container) {
      await openContainerWorkspace(entry.key);
    } else if (entry.savedId) {
      await openSavedWorkspace(entry.savedId);
      // No container yet → create the workspace tab bound to the saved identity
      // with an inline configuring first pane (replaces the legacy spawn modal).
      beginNewWorkspaceSpawn(undefined, {
        title: entry.name,
        dir: entry.dir,
        savedWorkspaceId: entry.savedId,
      });
    } else {
      await openContainerWorkspace(entry.key);
    }
    onClose?.();
  };

  // Remove from the launcher. For a container-backed entry this PRUNES the
  // container (reclaims it) behind a confirm; for a saved-only entry it just drops
  // the config record. Hidden while the workspace is open in a tab (close it with
  // ⌘⇧W first — can't prune the container you're attached to).
  const canRemove = !isOpen && (entry.container != null || entry.savedId != null);
  const remove = async () => {
    if (entry.container) {
      if (
        !window.confirm(
          `Remove the "${entry.name}" workspace container? Bind-mounted /workspace files are preserved; container-local state is lost.`,
        )
      )
        return;
      await ipc.removeWorkspaceContainer(entry.key).catch(() => {});
    }
    if (entry.savedId) await removeSavedWorkspace(entry.savedId);
    await refreshContainers();
  };

  // Container lifecycle, rehomed from the Hub status bar onto the card. Restart /
  // stop kill every attached tmux session (the bollard execs die with the
  // container), so both confirm + name how many go with it when the workspace is
  // open. Refresh the fleet after so the state badge updates.
  const sessionCount = liveWs ? workspaceLeaves(liveWs).length : 0;
  const killClause =
    sessionCount > 0
      ? ` This kills ${sessionCount} attached session${sessionCount === 1 ? "" : "s"}.`
      : "";
  const restart = async () => {
    if (busy) return;
    if (!window.confirm(`Restart the "${entry.name}" workspace container?${killClause}`)) return;
    await restartContainer(entry.key);
  };
  const stop = async () => {
    if (busy) return;
    if (!window.confirm(`Stop the "${entry.name}" workspace container?${killClause}`)) return;
    await stopContainer(entry.key);
  };
  const start = async () => {
    if (busy) return;
    await startContainer(entry.key);
  };

  // Card-body click opens the workspace — but ONLY when there's something live to
  // open: a running container, an already-open tab, or a never-created saved entry
  // (create-on-open). A STOPPED container is deliberately NOT openable by clicking
  // the card: booting it on a body click felt broken (nothing visibly happens, the
  // container just starts in the background). The explicit "Start" CTA in the footer
  // is the only way to boot a stopped container. Select mode + in-flight ops swallow.
  const canOpen = isOpen || !entry.container || state === "running";
  // Whole-card affordance is live only when the click does something (open) — or in
  // select mode for bulk-pick. A stopped/booting card is inert except for its controls.
  const clickable = selectMode || canOpen;
  const cardClick = () => {
    if (selectMode) {
      onToggleSelect();
      return;
    }
    if (busy || state === "starting") return;
    if (canOpen) void open();
  };
  // State-colored accent spine down the card's left edge — at-a-glance status that
  // reads before the badge text: active workspaces glow (open/live), dormant stay quiet.
  const spine = busy
    ? "var(--wait)"
    : isOpen
      ? "var(--pri)"
      : state === "running"
        ? "var(--live)"
        : state === "unreachable"
          ? "var(--err)"
          : state === "stopped"
            ? "var(--idle)"
            : "var(--bd-strong)";

  // Mount chips: one chip per thing this workspace MOUNTS — the primary dir
  // (at /workspace) plus any additional repos (at /workspace/<basename>) — NOT the
  // git repos discovered inside them. A directly-mounted parent folder (e.g.
  // my-projects) is a single directory chip; we don't expand the nested repos it
  // happens to contain. A chip shows a branch + repo glyph only when that mount is
  // ITSELF a git repo (matched against the live discovery while running); a plain
  // directory gets a folder glyph and no branch.
  const fallbackRepo = entry.dir ? dirName(entry.dir) : entry.name;
  const repoAt = (path: string) => repos.find((r) => r.path === path);
  const primaryRepo = repoAt("/workspace");
  const repoChips = [
    { name: fallbackRepo, branch: primaryRepo?.branch ?? null, isRepo: !!primaryRepo },
    ...(entry.additionalDirs ?? []).map((d) => {
      const r = repoAt(`/workspace/${dirName(d)}`);
      return { name: dirName(d), branch: r?.branch ?? null, isRepo: !!r };
    }),
  ];
  // Cap the visible repo chips so a many-repo workspace doesn't wrap into a tall
  // card; the rest collapse into a "+N" chip that lists them on hover.
  const MAX_REPO_CHIPS = 2;
  const shownChips = repoChips.slice(0, MAX_REPO_CHIPS);
  const hiddenChips = repoChips.slice(MAX_REPO_CHIPS);
  const specs = specLabel(entry.sizing ?? defaultSizing);
  const created = fmtDate(entry.createdAt);
  const sid = shortId(entry.savedId);

  return (
    <div
      className={`ch-card ws-card${clickable ? " is-clickable" : ""}${selected ? " ws-selected" : ""}`}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? cardClick : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                cardClick();
              }
            }
          : undefined
      }
      title={
        selectMode
          ? `${entry.name} — ${selected ? "deselect" : "select"}`
          : clickable
            ? `${entry.name} — ${action.toLowerCase()} (${stateLabel})`
            : `${entry.name} — ${stateLabel}; press Start to launch`
      }
      style={{
        padding: "14px 16px 14px 18px",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        borderColor: isOpen ? "var(--pri)" : undefined,
      }}
    >
      {/* state accent spine — left edge, color-coded by container state */}
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          left: 0,
          top: 8,
          bottom: 8,
          width: 3,
          borderRadius: 999,
          background: spine,
        }}
      />
      {/* name row: select + pin + workspace mark + name + state badge + remove */}
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        {/* Bulk-select checkbox — rendered ONLY in select mode, so it reserves no
            space by default (and never shifts the name). Stops propagation so
            ticking it doesn't also open the card. */}
        {selectMode && (
          <button
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: a styled <button> carries the check glyph; a bare checkbox input can't render it
            role="checkbox"
            aria-checked={selected}
            title={selected ? "Deselect" : "Select"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect();
            }}
            style={{
              width: 16,
              height: 16,
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 4,
              border: `1.5px solid ${selected ? "var(--pri)" : "var(--bd-strong)"}`,
              background: selected ? "var(--pri)" : "transparent",
              color: "var(--bg-0)",
              cursor: "pointer",
              padding: 0,
            }}
          >
            {selected && Ico.check}
          </button>
        )}
        {entry.savedId && (
          <button
            type="button"
            title={entry.pinned ? "Unpin" : "Pin to top"}
            aria-pressed={entry.pinned}
            onClick={(e) => {
              e.stopPropagation();
              if (entry.savedId) void togglePin(entry.savedId);
            }}
            style={{
              background: "none",
              border: "none",
              padding: 2,
              cursor: "pointer",
              color: entry.pinned ? "var(--wait)" : "var(--fg-3)",
              display: "inline-flex",
              lineHeight: 0,
            }}
          >
            <PinGlyph filled={entry.pinned} />
          </button>
        )}
        {/* Workspace mark — only when there's no pin toggle, so each card carries
            exactly one leading glyph (the pin already marks saved workspaces). */}
        {!entry.savedId && (
          <span style={{ color: "var(--fg-3)", display: "inline-flex", flexShrink: 0 }}>
            {Ico.hub}
          </span>
        )}
        <span
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--fg-0)",
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {entry.name}
        </span>
        {/* Live agents (only when the workspace is open in a tab) sit beside the
            identity so activity reads inline with the name. */}
        {agents.length > 0 && (
          <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
            {agents.slice(0, 4).map((m, i) => (
              <AgentGlyph
                // biome-ignore lint/suspicious/noArrayIndexKey: positional agent indicators
                key={i}
                agent={m.cli}
                size={12}
                color={`var(--a-${m.cli})`}
              />
            ))}
          </div>
        )}
        <span
          title={`Container is ${stateLabel}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: busy
              ? "var(--wait)"
              : isOpen
                ? "var(--pri)"
                : dot === "live"
                  ? "var(--live)"
                  : "var(--fg-3)",
            padding: "2px 6px",
            borderRadius: 999,
            background: busy
              ? "color-mix(in oklab, var(--wait) 12%, transparent)"
              : isOpen
                ? "color-mix(in oklab, var(--pri) 12%, transparent)"
                : dot === "live"
                  ? "color-mix(in oklab, var(--live) 12%, transparent)"
                  : "var(--bg-3)",
          }}
        >
          {busy ? (
            <span style={{ display: "inline-flex", lineHeight: 0 }}>{Ico.spinner}</span>
          ) : (
            <StatusDot status={isOpen ? "live" : dot} pulse={isOpen} />
          )}
          {stateLabel}
        </span>
      </div>

      {/* repo pills — one row of repo NAMES (the identifier you scan for); the
          branch is detail-on-hover (title), not inline, so two long branches can't
          chop the names or bloat the card. Extras collapse into a "+N" chip. */}
      <div style={{ display: "flex", gap: 5, overflow: "hidden" }}>
        {shownChips.map((r, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: positional repo chips
            key={i}
            title={r.branch && r.branch !== r.name ? `${r.name} · ${r.branch}` : r.name}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "2px 9px",
              borderRadius: 6,
              background: "var(--bg-3)",
              border: "1px solid var(--bd-soft)",
              fontFamily: "var(--mono)",
              fontSize: 11,
              flex: "0 1 auto",
              minWidth: 0,
            }}
          >
            <span style={{ color: "var(--fg-3)", display: "inline-flex", flexShrink: 0 }}>
              {r.isRepo ? Ico.branch : Ico.files}
            </span>
            <span
              style={{
                color: "var(--fg-1)",
                fontWeight: 500,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
              }}
            >
              {r.name}
            </span>
          </span>
        ))}
        {hiddenChips.length > 0 && (
          <span
            title={hiddenChips
              .map((c) => (c.branch ? `${c.name} · ${c.branch}` : c.name))
              .join("\n")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "2px 9px",
              borderRadius: 6,
              background: "var(--bg-3)",
              border: "1px solid var(--bd-soft)",
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--fg-3)",
              flex: "0 0 auto",
            }}
          >
            +{hiddenChips.length}
          </span>
        )}
      </div>

      {/* specs row: container sizing + last-opened age */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--fg-2)",
        }}
      >
        {specs && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "var(--fg-3)", display: "inline-flex" }}>{Ico.container}</span>
            {specs}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--fg-3)" }}>{relTime(entry.lastOpened)}</span>
      </div>

      {/* identity row: created date + short id — disambiguates same-named
          workspaces (saved entries only). */}
      {(created || sid) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: "var(--fg-3)",
          }}
        >
          {created && <span>created {created}</span>}
          <span style={{ flex: 1 }} />
          {sid && <span title="Workspace id">#{sid}</span>}
        </div>
      )}

      {/* footer action bar: manage controls (left) · primary CTA (right). Filling
          both edges is what stops the card reading as a left-stacked column — the
          big tinted CTA is the obvious click target; lifecycle + delete sit opposite.
          Start is the CTA itself, so there's no separate play control for it. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          borderTop: "1px solid var(--bd-soft)",
          paddingTop: 10,
        }}
      >
        {busy ? (
          // Mid-transition: hide controls + CTA so the op can't be re-fired; the
          // spinner lives ONLY in the top state pill.
          <span style={{ display: "inline-flex", height: 28 }} />
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
              {state === "running" && (
                <>
                  <IconBtn
                    title="Restart container"
                    style={LIFE_BTN}
                    onClick={(e) => {
                      e.stopPropagation();
                      void restart();
                    }}
                  >
                    {Ico.restart}
                  </IconBtn>
                  <IconBtn
                    title="Stop container"
                    style={LIFE_BTN}
                    hoverColor="var(--err)"
                    hoverBg="color-mix(in oklab, var(--err) 16%, transparent)"
                    onClick={(e) => {
                      e.stopPropagation();
                      void stop();
                    }}
                  >
                    {Ico.stop}
                  </IconBtn>
                </>
              )}
              {canRemove && (
                <IconBtn
                  title={
                    entry.container
                      ? "Remove workspace + prune container"
                      : "Remove from workspaces"
                  }
                  idleColor="var(--fg-3)"
                  hoverColor="var(--err)"
                  hoverBg="color-mix(in oklab, var(--err) 16%, transparent)"
                  style={LIFE_BTN}
                  onClick={(e) => {
                    e.stopPropagation();
                    void remove();
                  }}
                >
                  {Ico.trash}
                </IconBtn>
              )}
            </div>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="ws-cta"
              title={`${action} ${entry.name}`}
              onClick={(e) => {
                e.stopPropagation();
                // Start is the ONLY way to boot a stopped container (the card body is
                // inert for those); everything else opens via the shared cardClick.
                if (action === "Start") void start();
                else cardClick();
              }}
            >
              {action === "Start" ? (
                <>
                  <span style={{ display: "inline-flex", lineHeight: 0 }}>{Ico.play}</span>
                  Start
                </>
              ) : (
                <>
                  {action}
                  <span style={{ display: "inline-flex", lineHeight: 0 }}>{Ico.arrowR}</span>
                </>
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function PinGlyph({ filled }: { filled?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.4}
    >
      <path d="M9 1l1.2 1.2L8 4.5l3.5 3.5 2.3-2.3L15 6.9l-3 3 2 5-2-1-3-3-3.5 3.5L4 13l3.5-3.5-3-3-1 1-1.2-1.2 2.4-2.3L1 1.7 2.2 0.5 6 4.3 9 1z" />
    </svg>
  );
}
