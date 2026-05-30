import { motion } from "motion/react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { IconBtn } from "../../components/primitives/IconBtn";
import { Ico } from "../../components/primitives/icons";
import { useResizableDock } from "../../hooks/useResizableDock";
import { EASE } from "../../hooks/useSlideIn";
import { highlight, langFromExt } from "../../lib/highlight";
import { ipc } from "../../lib/ipc";
import { activeWorkspace, useStore } from "../../lib/store";
import { ResizeHandle } from "./ResizeHandle";

const WIDTH = 360;

export function FilePreview({ path, onClose }: { path: string; onClose: () => void }) {
  const [body, setBody] = useState<string | null>(null);
  const containerKey = useStore((s) => activeWorkspace(s)?.containerKey);
  const { size, dragging, ref, beginResize, reset } = useResizableDock("ch.filePreview.w", WIDTH, {
    min: 300,
    max: 700,
    edge: "left",
  });

  useEffect(() => {
    let alive = true;
    setBody(null);
    ipc
      .containerReadFile(path, containerKey)
      .then((b) => alive && setBody(b))
      .catch((e) => alive && setBody(`(could not read file: ${e})`));
    return () => {
      alive = false;
    };
  }, [path, containerKey]);

  const filename = path.split("/").pop() ?? path;
  const dir = path.slice(0, -(filename.length + 1));
  const ext = filename.includes(".") ? filename.split(".").pop()?.toLowerCase() : null;
  const lineCount = body ? body.split("\n").length : 0;
  const lang = ext ? langFromExt(ext) : null;
  const highlighted = useMemo(() => (body && lang ? highlight(body, lang) : null), [body, lang]);

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
          borderLeft: "1px solid var(--bd-soft)",
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
          <span style={{ color: "var(--idle)", display: "inline-flex" }}>{Ico.diff}</span>
          <span
            className="mono"
            title={path}
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: "var(--fg-0)",
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              direction: "rtl",
              textAlign: "left",
            }}
          >
            {filename}
          </span>
          {ext && (
            <span
              className="mono"
              style={{
                fontSize: 10,
                color: "var(--fg-3)",
                padding: "1px 5px",
                borderRadius: 3,
                background: "var(--bg-2)",
                flexShrink: 0,
              }}
            >
              {ext}
            </span>
          )}
          <IconBtn title="Close file preview" onClick={onClose}>
            {Ico.close}
          </IconBtn>
        </div>

        <div
          className="scroll"
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            fontFamily: "var(--mono)",
            fontSize: 11.5,
            lineHeight: 1.55,
            background: "var(--bg-0)",
          }}
        >
          {body === null ? (
            <Note>Reading file…</Note>
          ) : body.startsWith("(could not read") ? (
            <Note>{body}</Note>
          ) : body === "" ? (
            <Note>(empty file)</Note>
          ) : (
            <div style={{ display: "flex", margin: 0 }}>
              <LineNumbers count={lineCount} />
              <pre
                style={{
                  margin: 0,
                  padding: "10px 12px 10px 0",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  color: "var(--fg-1)",
                  flex: 1,
                  minWidth: 0,
                }}
                // biome-ignore lint: safe — tokenized source, not user-controlled
                dangerouslySetInnerHTML={highlighted ? { __html: highlighted } : undefined}
              >
                {highlighted ? undefined : body}
              </pre>
            </div>
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
            fontSize: 10,
            color: "var(--fg-3)",
            minHeight: 28,
          }}
        >
          {body !== null && lineCount > 0 && <span>{lineCount} lines</span>}
          {lang && (
            <span
              style={{
                padding: "1px 5px",
                borderRadius: 3,
                background: "var(--bg-2)",
              }}
            >
              {lang}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <span
            title={dir}
            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {dir}
          </span>
        </div>
      </div>
      <ResizeHandle edge="left" onMouseDown={beginResize} onDoubleClick={reset} />
    </motion.aside>
  );
}

function LineNumbers({ count }: { count: number }) {
  const width = String(count).length * 7.5 + 16;
  return (
    <div
      aria-hidden
      className="tnum"
      style={{
        width,
        flexShrink: 0,
        padding: "10px 8px 10px 10px",
        textAlign: "right",
        color: "var(--fg-4, var(--fg-3))",
        opacity: 0.4,
        fontSize: 10.5,
        lineHeight: 1.55,
        userSelect: "none",
        borderRight: "1px solid var(--bd-soft)",
      }}
    >
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static line-number gutter (1..count), never reordered
        <div key={i}>{i + 1}</div>
      ))}
    </div>
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
