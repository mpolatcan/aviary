// Shared unified-diff renderer. Parses git's raw `diff` text into typed rows
// (file header / hunk / add / del / context) and renders them with line-number
// gutters and +/- coloring. Used by both the DiffViewer modal and the
// session-detail inspector's Diff tab so there is one diff renderer, not two.

export type Row =
  | { kind: "file"; text: string }
  | { kind: "hunk"; text: string }
  | { kind: "add"; text: string; newNo: number }
  | { kind: "del"; text: string; oldNo: number }
  | { kind: "ctx"; text: string; oldNo: number; newNo: number };

// Parse a unified diff into renderable rows. `diff --git a/X b/Y` becomes a
// "file" header row (so combined diffs are legible); index/---/+++ and other
// metadata are dropped; @@ hunks reset the running line numbers.
export function parseDiff(diff: string): Row[] {
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

// Added / removed line counts, for a "+N −M" summary.
export function diffCounts(rows: Row[]): { added: number; removed: number } {
  return {
    added: rows.filter((r) => r.kind === "add").length,
    removed: rows.filter((r) => r.kind === "del").length,
  };
}

// The scrollable diff body: loading / empty / rows. `diff === null` is loading;
// an empty parse renders `emptyLabel`. Layout (max height, borders) is left to
// the caller's wrapper.
export function DiffBody({
  diff,
  emptyLabel,
  style,
}: {
  diff: string | null;
  emptyLabel: string;
  style?: React.CSSProperties;
}) {
  const rows = diff ? parseDiff(diff) : [];
  return (
    <div
      className="scroll"
      style={{
        overflow: "auto",
        background: "var(--bg-0)",
        fontFamily: "var(--mono)",
        fontSize: 11.5,
        lineHeight: 1.55,
        ...style,
      }}
    >
      {diff === null ? (
        <Msg>Loading diff…</Msg>
      ) : rows.length === 0 ? (
        <Msg>{emptyLabel}</Msg>
      ) : (
        rows.map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff rows are a fixed render of an immutable parse, never reordered.
          <DiffRow key={i} row={r} />
        ))
      )}
    </div>
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
