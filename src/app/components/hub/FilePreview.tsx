import { motion } from "motion/react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { IconBtn } from "../../components/primitives/IconBtn";
import { Ico } from "../../components/primitives/icons";
import { slideRight } from "../../hooks/useSlideIn";
import { ipc } from "../../lib/ipc";
import { activeWorkspace, useStore } from "../../lib/store";

const WIDTH = 360;

export function FilePreview({ path, onClose }: { path: string; onClose: () => void }) {
  const [body, setBody] = useState<string | null>(null);
  const containerKey = useStore((s) => activeWorkspace(s)?.containerKey);

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
  const highlighted = useMemo(
    () => (body && lang ? highlight(body, lang) : null),
    [body, lang],
  );

  return (
    <motion.aside
      {...slideRight}
      style={{
        width: WIDTH,
        flexShrink: 0,
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

// ── Lightweight syntax highlighting ─────────────────────────────────────────
// Regex-based tokenizer using CSS custom properties from tokens.css. No
// external deps. Covers JS/TS/JSON/CSS/HTML/Rust/Markdown/TOML/YAML/Shell.

type Lang =
  | "js"
  | "json"
  | "css"
  | "html"
  | "rust"
  | "markdown"
  | "toml"
  | "yaml"
  | "shell";

function langFromExt(ext: string): Lang | null {
  switch (ext) {
    case "js":
    case "jsx":
    case "ts":
    case "tsx":
    case "mjs":
    case "mts":
    case "cjs":
      return "js";
    case "json":
    case "jsonc":
      return "json";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
    case "svg":
    case "xml":
      return "html";
    case "rs":
      return "rust";
    case "md":
    case "mdx":
      return "markdown";
    case "toml":
      return "toml";
    case "yaml":
    case "yml":
      return "yaml";
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
      return "shell";
    default:
      return null;
  }
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const C = {
  kw: "oklch(0.75 0.12 280)",    // purple — keywords
  str: "oklch(0.75 0.14 150)",   // green — strings
  num: "oklch(0.78 0.12 60)",    // amber — numbers
  cmt: "oklch(0.5 0.02 240)",    // dim — comments
  fn: "oklch(0.82 0.12 220)",    // blue — function names
  tag: "oklch(0.72 0.14 20)",    // red/coral — HTML tags
  attr: "oklch(0.78 0.1 80)",    // yellow — attributes
  op: "oklch(0.65 0.08 260)",    // muted purple — operators
  type: "oklch(0.78 0.12 200)",  // cyan — types
  prop: "oklch(0.7 0.1 250)",    // lavender — property keys
} as const;

const span = (color: string, text: string) =>
  `<span style="color:${color}">${esc(text)}</span>`;

function highlight(src: string, lang: Lang): string {
  switch (lang) {
    case "json":
      return highlightJson(src);
    case "js":
      return highlightJs(src);
    case "css":
      return highlightCss(src);
    case "html":
      return highlightHtml(src);
    case "rust":
      return highlightRust(src);
    case "markdown":
      return highlightMarkdown(src);
    case "toml":
      return highlightToml(src);
    case "yaml":
      return highlightYaml(src);
    case "shell":
      return highlightShell(src);
    default:
      return esc(src);
  }
}

function highlightJson(src: string): string {
  return src.replace(
    /("(?:[^"\\]|\\.)*")\s*(:)|("(?:[^"\\]|\\.)*")|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(\b(?:true|false|null)\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m, key, colon, str, cmt, lit, num) => {
      if (key) return `${span(C.prop, key)}${esc(colon)}`;
      if (str) return span(C.str, str);
      if (cmt) return span(C.cmt, cmt);
      if (lit) return span(C.kw, lit);
      if (num) return span(C.num, num);
      return esc(m);
    },
  );
}

function highlightJs(src: string): string {
  let out = "";
  let i = 0;
  const re =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\b(?:true|false|null|undefined|NaN|Infinity)\b)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m.index > i) out += kwReplace(esc(src.slice(i, m.index)));
    if (m[1]) out += span(C.cmt, m[1]);
    else if (m[2]) out += span(C.str, m[2]);
    else if (m[3]) out += span(C.num, m[3]);
    else if (m[4]) out += span(C.kw, m[4]);
    i = m.index + m[0].length;
  }
  if (i < src.length) out += kwReplace(esc(src.slice(i)));
  return out;
}

function kwReplace(escaped: string): string {
  return escaped.replace(
    /\b(import|export|from|default|const|let|var|function|async|await|return|if|else|switch|case|break|continue|for|while|do|try|catch|finally|throw|new|typeof|instanceof|void|delete|in|of|class|extends|super|this|static|get|set|yield|as|type|interface|enum|implements|declare|readonly|abstract)\b/g,
    (kw) => span(C.kw, kw),
  );
}

function highlightCss(src: string): string {
  return src.replace(
    /(\/\*[\s\S]*?\*\/)|(--[\w-]+)|(@[\w-]+)|([.#][\w-]+)|(:\s*)((?:[^;{}])*)(;)|(-?\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?)/g,
    (full, cmt, varName, atRule, sel, colonSp, val, semi, num) => {
      if (cmt) return span(C.cmt, cmt);
      if (varName) return span(C.prop, varName);
      if (atRule) return span(C.kw, atRule);
      if (sel) return span(C.fn, sel);
      if (colonSp) return `${esc(colonSp)}${span(C.str, val)}${esc(semi)}`;
      if (num) return span(C.num, num);
      return esc(full);
    },
  );
}

function highlightHtml(src: string): string {
  return src.replace(
    /(<!--[\s\S]*?-->)|(<\/?)([\w-]+)((?:\s+[\w-]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]*))?)*)\s*(\/?>)/g,
    (_full, cmt, open, tag, attrs, close) => {
      if (cmt) return span(C.cmt, cmt);
      const coloredAttrs = attrs.replace(
        /([\w-]+)(=)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,
        (_: string, attr: string, eq: string, val: string) =>
          `${span(C.attr, attr)}${esc(eq)}${span(C.str, val)}`,
      );
      return `${esc(open)}${span(C.tag, tag)}${coloredAttrs}${esc(close)}`;
    },
  );
}

const RUST_KW =
  /\b(fn|let|mut|const|pub|use|mod|struct|enum|impl|trait|for|while|loop|if|else|match|return|async|await|move|self|Self|super|crate|where|type|static|unsafe|extern|ref|as|in|dyn|Box|Vec|Option|Result|Some|None|Ok|Err|true|false)\b/g;

function highlightRust(src: string): string {
  let out = "";
  let i = 0;
  const re =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*")|(\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?(?:_?[iu](?:8|16|32|64|128|size)|_?f(?:32|64))?\b)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m.index > i) out += esc(src.slice(i, m.index)).replace(RUST_KW, (kw) => span(C.kw, kw));
    if (m[1]) out += span(C.cmt, m[1]);
    else if (m[2]) out += span(C.str, m[2]);
    else if (m[3]) out += span(C.num, m[3]);
    i = m.index + m[0].length;
  }
  if (i < src.length) out += esc(src.slice(i)).replace(RUST_KW, (kw) => span(C.kw, kw));
  return out;
}

function highlightMarkdown(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      if (/^#{1,6}\s/.test(line)) return span(C.fn, line);
      if (/^(\s*[-*+]|\s*\d+\.)\s/.test(line)) {
        const m2 = line.match(/^(\s*(?:[-*+]|\d+\.))\s/);
        return m2 ? span(C.kw, m2[1]) + esc(line.slice(m2[1].length)) : esc(line);
      }
      if (/^```/.test(line)) return span(C.cmt, line);
      if (/^>\s/.test(line)) return span(C.str, line);
      return esc(line)
        .replace(/(`[^`]+`)/g, (c) => span(C.str, c))
        .replace(/(\*\*[^*]+\*\*|__[^_]+__)/g, (b) => `<b>${b}</b>`)
        .replace(/(\*[^*]+\*|_[^_]+_)/g, (i2) => `<i>${i2}</i>`)
        .replace(/(\[.*?\]\(.*?\))/g, (l) => span(C.fn, l));
    })
    .join("\n");
}

function highlightToml(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      if (/^\s*#/.test(line)) return span(C.cmt, line);
      if (/^\s*\[/.test(line)) return span(C.fn, line);
      const kv = line.match(/^(\s*[\w.-]+)(\s*=\s*)(.*)/);
      if (kv) {
        let val = esc(kv[3]);
        if (/^"/.test(kv[3])) val = span(C.str, kv[3]);
        else if (/^(true|false)$/.test(kv[3])) val = span(C.kw, kv[3]);
        else if (/^-?\d/.test(kv[3])) val = span(C.num, kv[3]);
        return `${span(C.prop, kv[1])}${esc(kv[2])}${val}`;
      }
      return esc(line);
    })
    .join("\n");
}

function highlightYaml(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      if (/^\s*#/.test(line)) return span(C.cmt, line);
      const kv = line.match(/^(\s*[\w.-]+)(\s*:\s*)(.*)/);
      if (kv) {
        let val = esc(kv[3]);
        if (/^['"]/.test(kv[3])) val = span(C.str, kv[3]);
        else if (/^(true|false|null|~)$/i.test(kv[3].trim())) val = span(C.kw, kv[3]);
        else if (/^-?\d/.test(kv[3])) val = span(C.num, kv[3]);
        else if (kv[3].trim()) val = span(C.str, kv[3]);
        return `${span(C.prop, kv[1])}${esc(kv[2])}${val}`;
      }
      if (/^\s*-\s/.test(line)) {
        const m2 = line.match(/^(\s*-\s)(.*)/);
        return m2 ? `${span(C.op, m2[1])}${esc(m2[2])}` : esc(line);
      }
      return esc(line);
    })
    .join("\n");
}

function highlightShell(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      if (/^\s*#/.test(line)) return span(C.cmt, line);
      return esc(line)
        .replace(
          /\b(if|then|else|elif|fi|for|while|do|done|case|esac|in|function|return|exit|export|local|readonly|set|unset|source|alias|cd|echo|printf|cat|grep|sed|awk|find|xargs|curl|wget|chmod|chown|mkdir|rm|cp|mv|ls|test)\b/g,
          (kw) => span(C.kw, kw),
        )
        .replace(/("(?:[^"\\]|\\.)*"|'[^']*')/g, (s) => span(C.str, s))
        .replace(/(\$\{?\w+\}?)/g, (v) => span(C.fn, v));
    })
    .join("\n");
}
