import { useEffect, useState } from "react";
import { ipc } from "../../lib/ipc";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../ui/dialog";

// Renders a unified diff in a modal. With a path it's one /workspace file
// (container_git_diff); with the empty-string sentinel it's the combined diff
// of every tracked change (container_git_diff_all). The diff text is git's raw
// output; we parse it into typed rows for coloring + line numbers rather than
// dumping it as a blob. A combined diff carries multiple `diff --git` markers,
// each emitted as a "file" header row so the viewer reads file-by-file.

type Row =
  | { kind: "file"; text: string }
  | { kind: "hunk"; text: string }
  | { kind: "add"; text: string; newNo: number }
  | { kind: "del"; text: string; oldNo: number }
  | { kind: "ctx"; text: string; oldNo: number; newNo: number };

// Parse a unified diff into renderable rows. `diff --git a/X b/Y` becomes a
// "file" header row (so combined diffs are legible); index/---/+++ and other
// metadata are dropped; @@ hunks reset the running line numbers.
function parseDiff(diff: string): Row[] {
  const rows: Row[] = [];
  let oldNo = 0;
  let newNo = 0;
  const lines = diff.split("\n");
  // Git's output ends in a newline, so split yields a trailing "" — drop it so
  // it isn't rendered as a spurious blank context row past the last real line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      // `diff --git a/path b/path` → show the b-side path as a file header.
      const m = line.match(/ b\/(.+)$/);
      rows.push({ kind: "file", text: m ? m[1] : line.slice("diff --git ".length) });
      continue;
    }
    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("similarity ") ||
      line.startsWith("rename ") ||
      line.startsWith("\\ No newline")
    ) {
      continue;
    }
    if (line.startsWith("@@")) {
      // @@ -oldStart,oldLen +newStart,newLen @@
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
      }
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), newNo });
      newNo++;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1), oldNo });
      oldNo++;
    } else {
      // Context line (leading space) or a trailing empty string from split.
      rows.push({ kind: "ctx", text: line.slice(1), oldNo, newNo });
      oldNo++;
      newNo++;
    }
  }
  return rows;
}

export function DiffViewer({ path, onClose }: { path: string | null; onClose: () => void }) {
  const [diff, setDiff] = useState<string | null>(null);

  useEffect(() => {
    if (path === null) {
      setDiff(null);
      return;
    }
    let alive = true;
    setDiff(null);
    // Empty-string sentinel → combined diff of every change; a path → that file.
    const load = path === "" ? ipc.containerGitDiffAll() : ipc.containerGitDiff(path);
    load.then((d) => alive && setDiff(d)).catch(() => alive && setDiff(""));
    return () => {
      alive = false;
    };
  }, [path]);

  const rows = diff ? parseDiff(diff) : [];
  const added = rows.filter((r) => r.kind === "add").length;
  const removed = rows.filter((r) => r.kind === "del").length;

  return (
    <Dialog open={path !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent style={{ maxWidth: 860, padding: 0 }}>
        <DialogHeader style={{ padding: "16px 18px 10px" }}>
          <DialogTitle
            className="mono"
            style={{
              fontSize: 13,
              fontWeight: 500,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {path === "" ? "All changes" : (path ?? "")}
          </DialogTitle>
          {diff !== null && rows.length > 0 && (
            <span className="mono tnum" style={{ fontSize: 11, color: "var(--fg-2)" }}>
              <span style={{ color: "var(--live)" }}>+{added}</span>{" "}
              <span style={{ color: "var(--err)" }}>−{removed}</span>
            </span>
          )}
        </DialogHeader>
        <div
          className="scroll"
          style={{
            maxHeight: "62vh",
            overflow: "auto",
            borderTop: "1px solid var(--bd-soft)",
            background: "var(--bg-0)",
            fontFamily: "var(--mono)",
            fontSize: 11.5,
            lineHeight: 1.55,
          }}
        >
          {diff === null ? (
            <Msg>Loading diff…</Msg>
          ) : rows.length === 0 ? (
            <Msg>
              {path === ""
                ? "No tracked changes — the working tree is clean."
                : "No diff to show — the file may be unchanged or binary."}
            </Msg>
          ) : (
            rows.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: diff rows are a fixed render of an immutable parse, never reordered.
              <DiffRow key={i} row={r} />
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DiffRow({ row }: { row: Row }) {
  if (row.kind === "file") {
    return (
      <div
        className="mono"
        style={{
          padding: "8px 12px",
          fontWeight: 500,
          color: "var(--fg-1)",
          background: "var(--bg-1)",
          borderTop: "1px solid var(--bd)",
          borderBottom: "1px solid var(--bd-soft)",
          position: "sticky",
          top: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {row.text}
      </div>
    );
  }
  if (row.kind === "hunk") {
    return (
      <div
        style={{
          padding: "3px 12px",
          color: "var(--fg-3)",
          background: "var(--bg-2)",
          borderTop: "1px solid var(--bd-soft)",
          borderBottom: "1px solid var(--bd-soft)",
        }}
      >
        {row.text}
      </div>
    );
  }
  const tone =
    row.kind === "add" ? "var(--live)" : row.kind === "del" ? "var(--err)" : "var(--fg-1)";
  const bg =
    row.kind === "add"
      ? "color-mix(in oklab, var(--live) 9%, transparent)"
      : row.kind === "del"
        ? "color-mix(in oklab, var(--err) 9%, transparent)"
        : "transparent";
  const marker = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";
  return (
    <div style={{ display: "flex", background: bg, minHeight: 18 }}>
      <Gutter n={row.kind === "add" ? null : row.oldNo} />
      <Gutter n={row.kind === "del" ? null : row.newNo} />
      <span style={{ width: 16, color: tone, flexShrink: 0, textAlign: "center" }}>{marker}</span>
      <span style={{ color: tone, whiteSpace: "pre-wrap", wordBreak: "break-word", flex: 1 }}>
        {row.text || " "}
      </span>
    </div>
  );
}

function Gutter({ n }: { n: number | null }) {
  return (
    <span
      className="tnum"
      style={{
        width: 44,
        flexShrink: 0,
        textAlign: "right",
        paddingRight: 8,
        color: "var(--fg-3)",
        userSelect: "none",
      }}
    >
      {n ?? ""}
    </span>
  );
}

function Msg({ children }: { children: string }) {
  return (
    <div style={{ padding: "28px 16px", textAlign: "center", color: "var(--fg-3)" }}>
      {children}
    </div>
  );
}
