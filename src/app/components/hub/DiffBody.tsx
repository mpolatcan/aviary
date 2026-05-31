// Shared unified-diff renderer. Parses git's raw `diff` text into typed rows
// (file header / hunk / add / del / context) and renders them with line-number
// gutters, +/- coloring, AND per-line syntax highlighting (language derived from
// the file-header path). Used by both the DiffViewer modal and the
// session-detail inspector's Diff tab so there is one diff renderer, not two.

import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { EASE } from "../../hooks/useSlideIn";
import { type Lang, highlight, langFromExt } from "../../lib/highlight";
import { Tip } from "../primitives/Tip";
import { Ico } from "../primitives/icons";

// Runs of more than this many consecutive unchanged (context) lines fold into a
// clickable "⋯ N unchanged lines" stub, keeping FOLD_EDGE lines of lead/trail —
// so a large diff opens as a navigable outline, not a wall.
const FOLD_THRESHOLD = 8;
const FOLD_EDGE = 3;

// Language for the file at this row, derived from each `file` header's path.
// Threaded down each row so a combined diff highlights every file in its own
// language. null (unknown extension) → falls back to plain tone-colored text.
function langsForRows(rows: { kind: string; text?: string }[]): (Lang | null)[] {
  let cur: Lang | null = null;
  return rows.map((r) => {
    if (r.kind === "file" && r.text)
      cur = langFromExt(r.text.split(".").pop()?.toLowerCase() ?? "");
    return cur;
  });
}

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
// One code line + its language (file/hunk/add/del/ctx minus the file header).
type LineRow = { row: Exclude<Row, { kind: "file" }>; lang: Lang | null };
// A per-file run of the diff: its path (null for a header-less single-file diff),
// the code lines under it, and +/− counts.
interface Section {
  file: string | null;
  lines: LineRow[];
  added: number;
  removed: number;
}

function groupSections(rows: Row[], langs: (Lang | null)[]): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  rows.forEach((r, i) => {
    if (r.kind === "file") {
      cur = { file: r.text, lines: [], added: 0, removed: 0 };
      out.push(cur);
      return;
    }
    if (!cur) {
      cur = { file: null, lines: [], added: 0, removed: 0 };
      out.push(cur);
    }
    cur.lines.push({ row: r, lang: langs[i] });
    if (r.kind === "add") cur.added++;
    else if (r.kind === "del") cur.removed++;
  });
  return out;
}

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
  const langs = langsForRows(rows);
  const sections = groupSections(rows, langs);
  const files = sections.filter((s) => s.file != null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // Default a fresh multi-file diff to all-collapsed so it reads as a table of
  // contents; a single-file view stays open since the user opened that file.
  // Adjusting state during render (keyed on the file set) re-inits without an
  // expanded→collapsed flash when the async diff resolves.
  const fileKey = files.map((s) => s.file).join("\n");
  const [seenKey, setSeenKey] = useState<string | null>(null);
  if (fileKey !== seenKey) {
    setSeenKey(fileKey);
    setCollapsed(files.length > 1 ? new Set(files.map((s) => s.file as string)) : new Set());
  }
  const allCollapsed = files.length > 0 && files.every((s) => s.file && collapsed.has(s.file));

  const toggleFile = (f: string) =>
    setCollapsed((p) => {
      const n = new Set(p);
      n.has(f) ? n.delete(f) : n.add(f);
      return n;
    });
  const setAll = (c: boolean) =>
    setCollapsed(c ? new Set(files.map((s) => s.file as string)) : new Set());

  return (
    <div
      className="scroll"
      style={{
        overflow: "auto",
        background: "var(--bg-0)",
        fontFamily: "var(--mono)",
        fontSize: "var(--fs-12)",
        lineHeight: 1.55,
        ...style,
      }}
    >
      {diff === null ? (
        <Msg>Loading diff…</Msg>
      ) : sections.length === 0 ? (
        <Msg>{emptyLabel}</Msg>
      ) : (
        <>
          {files.length > 1 && (
            <DiffToolbar count={files.length} allCollapsed={allCollapsed} onToggleAll={setAll} />
          )}
          {sections.map((s, i) =>
            s.file != null ? (
              <FileSection
                key={s.file}
                file={s.file}
                added={s.added}
                removed={s.removed}
                lines={s.lines}
                collapsed={collapsed.has(s.file)}
                onToggle={() => s.file && toggleFile(s.file)}
              />
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: header-less section, stable in an immutable parse.
              <SectionBody key={`s${i}`} lines={s.lines} />
            ),
          )}
        </>
      )}
    </div>
  );
}

// Top strip for a multi-file diff — file count + a collapse-all / expand-all
// toggle so a big changeset reads as a table of contents.
function DiffToolbar({
  count,
  allCollapsed,
  onToggleAll,
}: {
  count: number;
  allCollapsed: boolean;
  onToggleAll: (c: boolean) => void;
}) {
  return (
    <div
      style={{
        position: "sticky",
        top: 0,
        zIndex: 2,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 12px",
        background: "var(--bg-1)",
        borderBottom: "1px solid var(--bd-soft)",
        color: "var(--fg-3)",
        fontSize: "var(--fs-11)",
      }}
    >
      <span className="tnum">
        {count} file{count === 1 ? "" : "s"}
      </span>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        className="rail-file"
        onClick={() => onToggleAll(!allCollapsed)}
        style={{
          border: "none",
          background: "transparent",
          color: "var(--fg-2)",
          cursor: "pointer",
          fontFamily: "var(--mono)",
          fontSize: "var(--fs-11)",
          padding: "1px 6px",
          borderRadius: 4,
        }}
      >
        {allCollapsed ? "Expand all" : "Collapse all"}
      </button>
    </div>
  );
}

// One file's collapsible section: a sticky header (chevron + path + +N −M) and,
// unless collapsed, its lines (with long context runs folded).
function FileSection({
  file,
  added,
  removed,
  lines,
  collapsed,
  onToggle,
}: {
  file: string;
  added: number;
  removed: number;
  lines: LineRow[];
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <Tip text={file}>
        <button
          type="button"
          data-file={file}
          onClick={onToggle}
          className="mono"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            width: "100%",
            textAlign: "left",
            padding: "7px 12px",
            fontWeight: 500,
            color: "var(--fg-1)",
            background: "var(--bg-1)",
            border: "none",
            borderTop: "1px solid var(--bd)",
            borderBottom: "1px solid var(--bd-soft)",
            position: "sticky",
            top: 0,
            zIndex: 1,
            cursor: "pointer",
          }}
        >
          <span
            style={{
              flexShrink: 0,
              display: "inline-flex",
              color: "var(--fg-3)",
              transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
              transition: "transform .15s ease",
            }}
          >
            {Ico.chevR}
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {file}
          </span>
          {(added > 0 || removed > 0) && (
            <span className="tnum" style={{ flexShrink: 0, fontSize: "var(--fs-11)" }}>
              <span style={{ color: "var(--live)" }}>+{added}</span>{" "}
              <span style={{ color: "var(--err)" }}>−{removed}</span>
            </span>
          )}
        </button>
      </Tip>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE }}
            style={{ overflow: "hidden" }}
          >
            <SectionBody lines={lines} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

// Render a section's lines, folding runs of > FOLD_THRESHOLD context lines into
// an expandable stub. Each fold tracks its own expanded state locally.
function SectionBody({ lines }: { lines: LineRow[] }) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const blocks = foldBlocks(lines);
  return (
    <>
      {blocks.map((b, i) =>
        b.kind === "rows" || expanded.has(b.id) ? (
          b.lines.map((l, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: immutable parse, never reordered.
            <DiffRow key={`${i}-${j}`} row={l.row} lang={l.lang} />
          ))
        ) : (
          <FoldStub
            key={`f${b.id}`}
            count={b.lines.length}
            onClick={() => setExpanded((p) => new Set(p).add(b.id))}
          />
        ),
      )}
    </>
  );
}

type Block = { kind: "rows"; lines: LineRow[] } | { kind: "fold"; id: number; lines: LineRow[] };

function foldBlocks(lines: LineRow[]): Block[] {
  const blocks: Block[] = [];
  let run: LineRow[] = [];
  let foldId = 0;
  const flush = () => {
    if (run.length === 0) return;
    if (run.length > FOLD_THRESHOLD) {
      const lead = run.slice(0, FOLD_EDGE);
      const mid = run.slice(FOLD_EDGE, run.length - FOLD_EDGE);
      const trail = run.slice(run.length - FOLD_EDGE);
      if (lead.length) blocks.push({ kind: "rows", lines: lead });
      blocks.push({ kind: "fold", id: foldId++, lines: mid });
      if (trail.length) blocks.push({ kind: "rows", lines: trail });
    } else {
      blocks.push({ kind: "rows", lines: run });
    }
    run = [];
  };
  for (const l of lines) {
    if (l.row.kind === "ctx") {
      run.push(l);
    } else {
      flush();
      blocks.push({ kind: "rows", lines: [l] });
    }
  }
  flush();
  return blocks;
}

// The "⋯ N unchanged lines" fold strip — quiet, expandable.
function FoldStub({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rail-file"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        textAlign: "left",
        border: "none",
        borderTop: "1px solid var(--bd-soft)",
        borderBottom: "1px solid var(--bd-soft)",
        background: "var(--bg-2)",
        color: "var(--fg-3)",
        cursor: "pointer",
        fontFamily: "var(--mono)",
        fontSize: "var(--fs-11)",
        padding: "3px 12px 3px 60px",
      }}
    >
      <span style={{ color: "var(--fg-2)" }}>⋯</span>
      {count} unchanged line{count === 1 ? "" : "s"}
    </button>
  );
}

function DiffRow({ row, lang }: { row: Row; lang: Lang | null }) {
  if (row.kind === "file") {
    return (
      <div
        className="mono"
        data-file={row.text}
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
  // Syntax-highlight the code (when the language is known) so the diff reads as
  // code, not plain text. The +/− background tint + the colored marker still
  // signal add/del, so the text color yields to the syntax palette.
  const code = lang && row.text ? highlight(row.text, lang) : null;
  return (
    <div style={{ display: "flex", background: bg, minHeight: 18 }}>
      <Gutter n={row.kind === "add" ? null : row.oldNo} />
      <Gutter n={row.kind === "del" ? null : row.newNo} />
      <span style={{ width: 16, color: tone, flexShrink: 0, textAlign: "center" }}>{marker}</span>
      {code ? (
        <span
          style={{ color: "var(--fg-1)", whiteSpace: "pre-wrap", wordBreak: "break-word", flex: 1 }}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: tokenized source, escaped in highlight()
          dangerouslySetInnerHTML={{ __html: code }}
        />
      ) : (
        <span style={{ color: tone, whiteSpace: "pre-wrap", wordBreak: "break-word", flex: 1 }}>
          {row.text || " "}
        </span>
      )}
    </div>
  );
}

// Side-by-side (split) diff renderer — the session-detail control bar's "Split"
// layout. Pairs each run of removed lines with the following run of added lines
// so a changed line sits old-left / new-right; context spans both columns. Reuses
// the same `parseDiff` rows as the unified `DiffBody`, only the layout differs.
type SplitSide = { no: number | null; text: string; tone: "add" | "del" | "ctx" | "blank" };
type SplitRow =
  | { kind: "file"; text: string }
  | { kind: "hunk"; text: string }
  | { kind: "pair"; left: SplitSide; right: SplitSide };

function splitRows(rows: Row[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: Array<Extract<Row, { kind: "del" }>> = [];
  let adds: Array<Extract<Row, { kind: "add" }>> = [];
  const blank: SplitSide = { no: null, text: "", tone: "blank" };
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      const d = dels[i];
      const a = adds[i];
      out.push({
        kind: "pair",
        left: d ? { no: d.oldNo, text: d.text, tone: "del" } : blank,
        right: a ? { no: a.newNo, text: a.text, tone: "add" } : blank,
      });
    }
    dels = [];
    adds = [];
  };
  for (const r of rows) {
    if (r.kind === "file") {
      flush();
      out.push({ kind: "file", text: r.text });
    } else if (r.kind === "hunk") {
      flush();
      out.push({ kind: "hunk", text: r.text });
    } else if (r.kind === "del") {
      dels.push(r);
    } else if (r.kind === "add") {
      adds.push(r);
    } else {
      flush();
      out.push({
        kind: "pair",
        left: { no: r.oldNo, text: r.text, tone: "ctx" },
        right: { no: r.newNo, text: r.text, tone: "ctx" },
      });
    }
  }
  flush();
  return out;
}

export function SplitDiffBody({
  diff,
  emptyLabel,
  style,
}: {
  diff: string | null;
  emptyLabel: string;
  style?: React.CSSProperties;
}) {
  const rows = diff ? splitRows(parseDiff(diff)) : [];
  const langs = langsForRows(rows);
  return (
    <div
      className="scroll"
      style={{
        overflow: "auto",
        background: "var(--bg-0)",
        fontFamily: "var(--mono)",
        fontSize: "var(--fs-12)",
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
          // biome-ignore lint/suspicious/noArrayIndexKey: split rows are a fixed render of an immutable parse, never reordered.
          <SplitDiffRow key={i} row={r} lang={langs[i]} />
        ))
      )}
    </div>
  );
}

function SplitDiffRow({ row, lang }: { row: SplitRow; lang: Lang | null }) {
  if (row.kind === "file") {
    return (
      <div
        className="mono"
        data-file={row.text}
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
  return (
    <div style={{ display: "flex", minHeight: 18 }}>
      <SplitCell side={row.left} lang={lang} />
      <span style={{ width: 1, flexShrink: 0, background: "var(--bd-soft)" }} />
      <SplitCell side={row.right} lang={lang} />
    </div>
  );
}

function SplitCell({ side, lang }: { side: SplitSide; lang: Lang | null }) {
  const tone =
    side.tone === "add" ? "var(--live)" : side.tone === "del" ? "var(--err)" : "var(--fg-1)";
  const bg =
    side.tone === "add"
      ? "color-mix(in oklab, var(--live) 9%, transparent)"
      : side.tone === "del"
        ? "color-mix(in oklab, var(--err) 9%, transparent)"
        : side.tone === "blank"
          ? "color-mix(in oklab, var(--bg-2) 40%, transparent)"
          : "transparent";
  const marker = side.tone === "add" ? "+" : side.tone === "del" ? "−" : "";
  const code = lang && side.tone !== "blank" && side.text ? highlight(side.text, lang) : null;
  return (
    <div style={{ display: "flex", flex: 1, minWidth: 0, background: bg }}>
      <Gutter n={side.no} />
      <span style={{ width: 14, color: tone, flexShrink: 0, textAlign: "center" }}>{marker}</span>
      {code ? (
        <span
          style={{
            color: "var(--fg-1)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            flex: 1,
            minWidth: 0,
          }}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: tokenized source, escaped in highlight()
          dangerouslySetInnerHTML={{ __html: code }}
        />
      ) : (
        <span
          style={{
            color: side.tone === "ctx" ? "var(--fg-1)" : tone,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            flex: 1,
            minWidth: 0,
          }}
        >
          {side.text || " "}
        </span>
      )}
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
