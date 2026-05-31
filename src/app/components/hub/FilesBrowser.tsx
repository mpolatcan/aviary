import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileGlyph, FolderGlyph } from "../../components/primitives/FileGlyph";
import { IconBtn } from "../../components/primitives/IconBtn";
import { Tip } from "../../components/primitives/Tip";
import { Ico } from "../../components/primitives/icons";
import { useResizableDock } from "../../hooks/useResizableDock";
import { EASE } from "../../hooks/useSlideIn";
import { fmtBytes, joinPath as join, orderEntries as order } from "../../lib/fs";
import { type FileEntry, type GitStatus, type MountInfo, ipc } from "../../lib/ipc";
import { useOverlay } from "../../lib/overlay";
import { activeWorkspace, useStore } from "../../lib/store";
import { Input } from "../../ui/input";
import { ResizeHandle } from "./ResizeHandle";

// IDE-style file tree over the runtime container's /workspace. Folders expand
// inline (lazy — each dir is one `container_list_dir` call, cached + read only on
// first expand, so big trees like node_modules cost nothing until opened). Files
// open a read-only highlighted preview (setFilePreview → FilePreview panel).
// Reads are confined to /workspace server-side; nothing is fabricated.
//
// Docked left panel (⌘E), resizable (useResizableDock). Root /workspace is
// pre-expanded; the tree resets when the active container changes.

const ROOT = "/workspace";
const WIDTH = 256;
const INDENT = 14;
// Silent re-poll of the currently-expanded dirs so externally-created files (an
// agent writing, a background clone landing) appear without a manual app reload.
const FILES_POLL_MS = 4000;

type DirState = FileEntry[] | "loading" | "error";

// A single-letter source-control badge + tint for a changed file (VS Code style).
type GitDecor = { letter: string; color: string };

// Map a git porcelain XY status code to its badge. Conflicts (any U / AA / DD) →
// "!"; untracked (`??`) → "U"; otherwise the dominant status char.
function gitDecor(xy: string): GitDecor | null {
  const code = xy.trim();
  if (!code) return null;
  if (code.includes("U") || code === "AA" || code === "DD")
    return { letter: "!", color: "var(--err)" };
  const c = code.replace(/[^A-Z?]/g, "")[0] ?? "";
  switch (c) {
    case "A":
      return { letter: "A", color: "var(--live)" };
    case "M":
      return { letter: "M", color: "var(--wait)" };
    case "D":
      return { letter: "D", color: "var(--err)" };
    case "R":
      return { letter: "R", color: "var(--a-codex)" };
    case "?":
      return { letter: "U", color: "var(--live)" };
    default:
      return { letter: c, color: "var(--wait)" };
  }
}

// Index the polled git status into per-file decorations + the set of ancestor
// dirs that contain a change (so a folder can show a roll-up dot). Porcelain
// paths are repo-relative, matching a tree node's path minus the /workspace root.
function indexGit(g: GitStatus | null): { files: Map<string, GitDecor>; dirs: Set<string> } {
  const files = new Map<string, GitDecor>();
  const dirs = new Set<string>();
  if (g?.isRepo) {
    for (const f of g.files) {
      const d = gitDecor(f.status);
      if (!d) continue;
      const rel = f.path.replace(/^\.?\//, "");
      files.set(rel, d);
      const parts = rel.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
  }
  return { files, dirs };
}

interface Tree {
  expanded: Set<string>;
  children: Record<string, DirState>;
  selected: string | null;
  query: string;
  // Container dest path (no trailing slash) → its real bind/volume mount.
  mounts: Map<string, MountInfo>;
  // Repo-relative path → its git badge; dirs that contain any change.
  gitFiles: Map<string, GitDecor>;
  changedDirs: Set<string>;
  toggle: (path: string) => void;
  open: (path: string) => void;
}

export function FilesBrowser({ onClose }: { onClose: () => void }) {
  const setFilePreview = useOverlay((s) => s.setFilePreview);
  const selected = useOverlay((s) => s.filePreview);
  const containerKey = useStore((s) => activeWorkspace(s)?.containerKey);
  const { size, dragging, ref, beginResize, reset } = useResizableDock("ch.files.w", WIDTH, {
    min: 200,
    max: 520,
    edge: "right",
  });

  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([ROOT]));
  const [children, setChildren] = useState<Record<string, DirState>>({});

  // Git decorations come from the app-wide git-status poll (store); mounts are
  // fetched once per container (docker inspect, rarely changes).
  const gitStatus = useStore((s) => s.gitStatus);
  const git = useMemo(() => indexGit(gitStatus), [gitStatus]);
  const [mounts, setMounts] = useState<MountInfo[]>([]);
  useEffect(() => {
    if (!containerKey) {
      setMounts([]);
      return;
    }
    let alive = true;
    ipc
      .containerMounts(containerKey)
      .then((m) => alive && setMounts(m))
      .catch(() => alive && setMounts([]));
    return () => {
      alive = false;
    };
  }, [containerKey]);
  const mountMap = useMemo(
    () => new Map(mounts.map((m) => [m.destination.replace(/\/+$/, ""), m])),
    [mounts],
  );

  const load = useCallback(
    (path: string) => {
      setChildren((c) => ({ ...c, [path]: "loading" }));
      ipc
        .containerListDir(path, containerKey)
        .then((e) => setChildren((c) => ({ ...c, [path]: e })))
        .catch(() => setChildren((c) => ({ ...c, [path]: "error" })));
    },
    [containerKey],
  );

  // (Re)load the root whenever the active container changes — and reset the tree
  // so one container's listing never bleeds into another's.
  useEffect(() => {
    setChildren({});
    setExpanded(new Set([ROOT]));
    load(ROOT);
  }, [load]);

  // Auto-reload: silently re-list every expanded dir on an interval so new files
  // surface live (no "loading" flicker — only the data is swapped). A ref holds
  // the live `expanded` set so the interval isn't torn down on every toggle.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  useEffect(() => {
    if (!containerKey) return;
    const tick = () => {
      for (const path of expandedRef.current) {
        ipc
          .containerListDir(path, containerKey)
          .then((e) => setChildren((c) => ({ ...c, [path]: e })))
          .catch(() => {});
      }
    };
    const h = setInterval(tick, FILES_POLL_MS);
    return () => clearInterval(h);
  }, [containerKey]);

  const toggle = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          setChildren((c) => {
            if (!c[path]) load(path);
            return c;
          });
        }
        return next;
      });
    },
    [load],
  );

  const open = useCallback((path: string) => setFilePreview(path), [setFilePreview]);

  const tree: Tree = {
    expanded,
    children,
    selected,
    query: query.trim().toLowerCase(),
    mounts: mountMap,
    gitFiles: git.files,
    changedDirs: git.dirs,
    toggle,
    open,
  };

  const root = children[ROOT];
  const rootRows = Array.isArray(root) ? filterDir(root, tree.query) : [];

  return (
    <motion.aside
      ref={ref}
      initial={{ width: 0 }}
      animate={{ width: size }}
      exit={{ width: 0 }}
      transition={{ duration: dragging ? 0 : 0.28, ease: EASE }}
      style={{ flexShrink: 0, overflow: "hidden", position: "relative" }}
    >
      {/* fixed-width inner so content doesn't reflow while the outer width animates */}
      <div
        style={{
          width: size,
          height: "100%",
          background: "var(--bg-1)",
          borderRight: "1px solid var(--bd-soft)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          color: "var(--fg-1)",
        }}
      >
        <div
          style={{
            padding: "8px 10px",
            borderBottom: "1px solid var(--bd-soft)",
            display: "flex",
            alignItems: "center",
            gap: 7,
          }}
        >
          <span style={{ color: "var(--idle)", display: "inline-flex" }}>{Ico.files}</span>
          <span style={{ fontSize: "var(--fs-13)", fontWeight: 500, color: "var(--fg-0)" }}>
            Files
          </span>
          <span className="mono" style={{ fontSize: "var(--fs-10)", color: "var(--fg-3)" }}>
            {Array.isArray(root) ? rootRows.length : "…"}
          </span>
          <span style={{ flex: 1 }} />
          <IconBtn title="Hide files panel (⌘E)" onClick={onClose}>
            {Ico.close}
          </IconBtn>
        </div>

        <div style={{ padding: "8px 10px 6px" }}>
          <Input
            className="mono h-auto rounded-[5px] px-2 py-1 text-[12px]"
            placeholder="filter by name…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          />
        </div>

        <div className="scroll" style={{ flex: 1, overflow: "auto", padding: "2px 6px 8px" }}>
          {root === undefined || root === "loading" ? (
            <Note>Reading /workspace…</Note>
          ) : root === "error" ? (
            <Note>Could not read /workspace.</Note>
          ) : rootRows.length === 0 ? (
            <Note>{tree.query ? "No files match the filter." : "Empty workspace."}</Note>
          ) : (
            rootRows.map((e) => (
              <TreeNode key={e.name} entry={e} path={join(ROOT, e.name)} depth={0} tree={tree} />
            ))
          )}
        </div>

        <div
          style={{
            padding: "7px 10px",
            borderTop: "1px solid var(--bd-soft)",
            display: "flex",
            alignItems: "center",
            gap: 7,
            fontFamily: "var(--mono)",
            fontSize: "var(--fs-10)",
            color: "var(--fg-3)",
            minHeight: 28,
          }}
        >
          {tree.query && <span style={{ color: "var(--wait)" }}>filtered</span>}
          <span style={{ flex: 1 }} />
          {/* Mounts — the link icon's tooltip lists every host↔container bind so
              "all mounted folders" is visible even when (as usual) the only mount
              is /workspace itself (a root, not a tree node) plus the out-of-tree
              /config. Nested mounts under /workspace also get a badge in-tree. */}
          <Tip
            text={
              mounts.length
                ? mounts
                    .map((m) => `${m.source} → ${m.destination}${m.rw ? "" : " (ro)"}`)
                    .join("\n")
                : ROOT
            }
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              {mounts.length > 0 && (
                <span
                  style={{
                    display: "inline-flex",
                    color: "var(--a-codex)",
                    opacity: 0.85,
                    transform: "scale(0.78)",
                  }}
                >
                  {Ico.link}
                </span>
              )}
              {ROOT}
            </span>
          </Tip>
        </div>
      </div>
      <ResizeHandle edge="right" onMouseDown={beginResize} onDoubleClick={reset} />
    </motion.aside>
  );
}

// Dirs first, alphabetical, then name-filtered (substring). Applied at each level.
function filterDir(entries: FileEntry[], q: string): FileEntry[] {
  const ordered = order(entries);
  return q ? ordered.filter((e) => e.name.toLowerCase().includes(q)) : ordered;
}

function TreeNode({
  entry,
  path,
  depth,
  tree,
}: {
  entry: FileEntry;
  path: string;
  depth: number;
  tree: Tree;
}) {
  const isDir = entry.kind === "dir";
  const open = tree.expanded.has(path);
  const active = tree.selected === path;
  const kids = tree.children[path];

  // Decorations keyed off the node's repo-relative path (container path minus
  // the /workspace root): a per-file git badge, a folder roll-up dot, and a
  // mount marker on folders that are real host bind-mounts.
  const rel = path.slice(ROOT.length + 1);
  const decor = isDir ? undefined : tree.gitFiles.get(rel);
  const dirChanged = isDir && tree.changedDirs.has(rel);
  const mount = isDir ? tree.mounts.get(path) : undefined;

  return (
    <>
      <Tip text={entry.name}>
        <button
          type="button"
          className="rail-file"
          onClick={() => (isDir ? tree.toggle(path) : tree.open(path))}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            width: "100%",
            padding: "3px 6px",
            paddingLeft: depth * INDENT + 6,
            borderRadius: 4,
            border: "none",
            background: active ? "var(--bg-2)" : "transparent",
            cursor: "pointer",
            textAlign: "left",
            fontFamily: "var(--mono)",
            fontSize: "var(--fs-12)",
          }}
        >
          {/* chevron gutter — only for dirs (files get an equal spacer to align) */}
          <span
            style={{
              flexShrink: 0,
              width: 12,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--fg-3)",
              transform: isDir && open ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform .15s ease",
            }}
          >
            {isDir ? Ico.chevR : null}
          </span>
          {isDir ? <FolderGlyph open={open} /> : <FileGlyph name={entry.name} />}
          <span
            style={{
              color: decor
                ? decor.color
                : entry.kind === "link"
                  ? "var(--wait)"
                  : active
                    ? "var(--fg-0)"
                    : "var(--fg-1)",
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {entry.name}
          </span>
          {mount && (
            <Tip text={`mounted from ${mount.source}${mount.rw ? "" : " (read-only)"}`}>
              <span
                style={{
                  flexShrink: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  color: "var(--a-codex)",
                  opacity: 0.9,
                }}
              >
                {Ico.link}
              </span>
            </Tip>
          )}
          {!isDir && entry.size > 0 && (
            <span
              className="tnum"
              style={{ flexShrink: 0, fontSize: "var(--fs-10)", color: "var(--fg-3)" }}
            >
              {fmtBytes(entry.size)}
            </span>
          )}
          {decor && (
            <Tip text={`git: ${entry.name} (${decor.letter})`}>
              <span
                className="tnum"
                style={{
                  flexShrink: 0,
                  width: 12,
                  textAlign: "center",
                  fontSize: "var(--fs-11)",
                  fontWeight: 600,
                  color: decor.color,
                }}
              >
                {decor.letter}
              </span>
            </Tip>
          )}
          {dirChanged && (
            <Tip text="contains uncommitted changes">
              <span
                aria-hidden="true"
                style={{
                  flexShrink: 0,
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--wait)",
                  opacity: 0.9,
                }}
              />
            </Tip>
          )}
        </button>
      </Tip>

      <AnimatePresence initial={false}>
        {isDir && open && (
          <motion.div
            key="children"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: EASE }}
            style={{ overflow: "hidden" }}
          >
            <TreeChildren path={path} depth={depth} tree={tree} kids={kids} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function TreeChildren({
  path,
  depth,
  tree,
  kids,
}: {
  path: string;
  depth: number;
  tree: Tree;
  kids: DirState | undefined;
}) {
  if (kids === undefined || kids === "loading") {
    return <Leaf depth={depth + 1}>reading…</Leaf>;
  }
  if (kids === "error") {
    return <Leaf depth={depth + 1}>unreadable</Leaf>;
  }
  const rows = filterDir(kids, tree.query);
  if (rows.length === 0) {
    return <Leaf depth={depth + 1}>{tree.query ? "no matches" : "empty"}</Leaf>;
  }
  return (
    <>
      {rows.map((e) => (
        <TreeNode key={e.name} entry={e} path={join(path, e.name)} depth={depth + 1} tree={tree} />
      ))}
    </>
  );
}

// Indented inline status line for a dir's loading/empty/error state.
function Leaf({ depth, children }: { depth: number; children: ReactNode }) {
  return (
    <div
      className="mono"
      style={{
        padding: `2px 6px 2px ${depth * INDENT + 24}px`,
        fontSize: "var(--fs-11)",
        color: "var(--fg-3)",
      }}
    >
      {children}
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div
      className="mono"
      style={{
        padding: "20px 14px",
        fontSize: "var(--fs-11)",
        color: "var(--fg-3)",
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}
