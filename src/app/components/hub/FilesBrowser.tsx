import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { IconBtn } from "../../components/primitives/IconBtn";
import { Ico } from "../../components/primitives/icons";
import { fmtBytes, joinPath as join, orderEntries as order } from "../../lib/fs";
import { type FileEntry, ipc } from "../../lib/ipc";

// Browses the runtime container's /workspace, one directory at a time
// (container_list_dir → `find -maxdepth 1`), with a read-only preview of a
// selected file's first 256 KiB (container_read_file → `head -c`). Both reads
// are confined to /workspace server-side. Nothing here is fabricated — an empty
// directory, a down runtime, or a binary file each render an honest line.
//
// Docked left panel (design/screens/hub-states.jsx FilesPanel), toggled from the
// hub ActionBar (⌘E). The parent (HubView) mounts it only while open, so a fresh
// mount starts at the workspace root. Unlike the design's fabricated multi-repo
// tree, this is the ONE real /workspace mount — narrow enough for a dock, so the
// listing and the file preview share the column (master ↔ detail) rather than
// sitting side by side as the old modal did.

const ROOT = "/workspace";
// 16rem — matches the design's FilesPanel width.
const WIDTH = 256;

export function FilesBrowser({ onClose }: { onClose: () => void }) {
  // Current directory, its listing (null = loading, [] = empty/error), and the
  // selected file's path + contents (null content = loading).
  const [cwd, setCwd] = useState(ROOT);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Load the listing whenever the directory changes.
  useEffect(() => {
    let alive = true;
    setEntries(null);
    setErr(null);
    ipc
      .containerListDir(cwd)
      .then((e) => alive && setEntries(e))
      .catch((e) => {
        if (alive) {
          setEntries([]);
          setErr(String(e));
        }
      });
    return () => {
      alive = false;
    };
  }, [cwd]);

  // Load a file's preview when one is selected.
  useEffect(() => {
    if (file === null) return;
    let alive = true;
    setBody(null);
    ipc
      .containerReadFile(file)
      .then((b) => alive && setBody(b))
      .catch((e) => alive && setBody(`(could not read file: ${e})`));
    return () => {
      alive = false;
    };
  }, [file]);

  const enter = (e: FileEntry) => {
    if (e.kind === "dir") {
      setFile(null);
      setBody(null);
      setQuery("");
      setCwd(join(cwd, e.name));
    } else if (e.kind === "file") {
      setFile(join(cwd, e.name));
    }
  };

  // Client-side name filter over the loaded listing (honest — narrows what the
  // single directory read returned, never reaches beyond it).
  const q = query.trim().toLowerCase();
  const rows = entries ? order(entries).filter((e) => !q || e.name.toLowerCase().includes(q)) : [];

  return (
    <aside
      style={{
        width: WIDTH,
        flexShrink: 0,
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
        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-0)" }}>Files</span>
        <span style={{ flex: 1 }} />
        <IconBtn title="Hide files panel (⌘E)" onClick={onClose}>
          {Ico.close}
        </IconBtn>
      </div>

      {/* When previewing a file the listing is hidden, so the filter only makes
          sense in listing mode. */}
      {file === null && (
        <>
          <div style={{ padding: "8px 10px 0" }}>
            <input
              className="mono"
              placeholder="filter by name…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              style={{
                width: "100%",
                padding: "4px 8px",
                borderRadius: 5,
                border: "1px solid var(--bd-soft)",
                background: "var(--bg-0)",
                color: "var(--fg-0)",
                fontSize: 11.5,
                outline: "none",
              }}
            />
          </div>
          <div style={{ padding: "8px 10px 6px" }}>
            <Crumbs
              cwd={cwd}
              onNav={(p) => {
                setFile(null);
                setBody(null);
                setQuery("");
                setCwd(p);
              }}
            />
          </div>
          <div className="scroll" style={{ flex: 1, overflow: "auto", padding: "0 8px 8px" }}>
            {entries === null ? (
              <Note>Reading {cwd}…</Note>
            ) : err ? (
              <Note>{err}</Note>
            ) : rows.length === 0 ? (
              <Note>{q ? "No files match the filter." : "Empty directory."}</Note>
            ) : (
              rows.map((e) => (
                <EntryRow
                  key={e.name}
                  entry={e}
                  active={file === join(cwd, e.name)}
                  onClick={() => enter(e)}
                />
              ))
            )}
          </div>
        </>
      )}

      {/* File preview — replaces the listing in the same column; a back row
          returns to the directory. */}
      {file !== null && (
        <>
          <button
            type="button"
            onClick={() => {
              setFile(null);
              setBody(null);
            }}
            className="rail-file mono"
            title="Back to listing"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              width: "100%",
              padding: "7px 10px",
              border: "none",
              borderBottom: "1px solid var(--bd-soft)",
              background: "var(--bg-1)",
              color: "var(--fg-1)",
              cursor: "pointer",
              fontSize: 11.5,
              textAlign: "left",
            }}
          >
            <span style={{ transform: "rotate(180deg)", display: "inline-flex" }}>
              {Ico.arrowR}
            </span>
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
              }}
            >
              {file.slice(cwd.length + 1)}
            </span>
          </button>
          <div
            className="scroll"
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "auto",
              fontFamily: "var(--mono)",
              fontSize: 11.5,
              lineHeight: 1.55,
              background: "var(--bg-0)",
            }}
          >
            {body === null ? (
              <Note>Reading file…</Note>
            ) : (
              <pre
                style={{
                  margin: 0,
                  padding: "10px 12px",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  color: "var(--fg-1)",
                }}
              >
                {body || "(empty file)"}
              </pre>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

// Clickable path segments. The leading "/workspace" is one crumb; deeper
// segments each navigate to that ancestor. The last crumb is the current dir.
function Crumbs({ cwd, onNav }: { cwd: string; onNav: (path: string) => void }) {
  const segs = cwd.split("/").filter(Boolean); // ["workspace", "a", "b"]
  return (
    <div
      className="mono"
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 2, fontSize: 11.5 }}
    >
      {segs.map((seg, i) => {
        const path = `/${segs.slice(0, i + 1).join("/")}`;
        const last = i === segs.length - 1;
        return (
          <span key={path} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
            <button
              type="button"
              disabled={last}
              onClick={() => onNav(path)}
              style={{
                border: "none",
                background: "transparent",
                cursor: last ? "default" : "pointer",
                color: last ? "var(--fg-1)" : "var(--fg-2)",
                padding: "1px 3px",
                borderRadius: 3,
                fontFamily: "var(--mono)",
                fontSize: 11.5,
              }}
              className={last ? undefined : "rail-file"}
            >
              {seg}
            </button>
            {!last && <span style={{ color: "var(--fg-3)" }}>/</span>}
          </span>
        );
      })}
    </div>
  );
}

function EntryRow({
  entry,
  active,
  onClick,
}: {
  entry: FileEntry;
  active: boolean;
  onClick: () => void;
}) {
  const isDir = entry.kind === "dir";
  return (
    <button
      type="button"
      onClick={onClick}
      title={entry.name}
      className="rail-file"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "4px 6px",
        borderRadius: 4,
        border: "none",
        background: active ? "var(--bg-2)" : "transparent",
        cursor: "pointer",
        textAlign: "left",
        fontFamily: "var(--mono)",
        fontSize: 11.5,
      }}
    >
      <span style={{ flexShrink: 0, color: isDir ? "var(--fg-1)" : "var(--fg-3)" }}>
        {isDir ? Ico.files : Ico.diff}
      </span>
      <span
        style={{
          color: entry.kind === "link" ? "var(--wait)" : "var(--fg-1)",
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {entry.name}
        {isDir && "/"}
      </span>
      {!isDir && (
        <span className="tnum" style={{ flexShrink: 0, fontSize: 10.5, color: "var(--fg-3)" }}>
          {fmtBytes(entry.size)}
        </span>
      )}
      {isDir && <span style={{ flexShrink: 0, color: "var(--fg-3)" }}>{Ico.arrowR}</span>}
    </button>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div
      className="mono"
      style={{ padding: "20px 14px", fontSize: 11, color: "var(--fg-3)", lineHeight: 1.5 }}
    >
      {children}
    </div>
  );
}
