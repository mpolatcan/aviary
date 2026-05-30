import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { type IDisposable, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { installBlockGlyphOverlay } from "./app/lib/block-glyph-overlay";
import { type UnlistenFn, invoke, listen } from "./app/lib/bridge";
import { createPtyOutputNormalizer } from "./app/lib/pty-output";

export interface Pane {
  sessionName: string;
  paneId: string;
  el: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  writeQueue: Promise<void>;
  fitFrame: number | null;
  lastSentCols: number;
  lastSentRows: number;
  disposed: boolean;
  blockOverlay?: IDisposable;
  unlistenData?: UnlistenFn;
  unlistenExit?: UnlistenFn;
}

const BG = "#08090b"; // pane surface (--bg-0); also TERM_THEME.background

// Terminal theme — mirrors the design tokens (tokens.css). xterm needs literal
// hex (no CSS vars / oklch). Surface = --bg-0, text = --fg-1.
const TERM_THEME = {
  background: BG,
  foreground: "#aeb2bb",
  cursor: "#6fda75",
  cursorAccent: "#08090b",
  selectionBackground: "#2b323d",
  selectionForeground: "#ecedf0",

  black: "#1f242d",
  red: "#ff6f69",
  green: "#6fda75",
  yellow: "#f7bc50",
  blue: "#98b7f8",
  magenta: "#b48ad6",
  cyan: "#17d0d8",
  white: "#aeb2bb",

  brightBlack: "#3f444d",
  brightRed: "#ff8981",
  brightGreen: "#89f58f",
  brightYellow: "#ffd66c",
  brightBlue: "#b1d0ff",
  brightMagenta: "#cba6e6",
  brightCyan: "#49eaf2",
  brightWhite: "#ecedf0",
};

// Terminal typeface = self-hosted JetBrains Mono SemiBold (fonts.css), NOT the
// app chrome's Geist Mono. Gate pane creation on the font — if xterm measures the
// cell at term.open() before it loads, it sizes to fallback metrics and never
// re-measures, mis-aligning every glyph. Resolves once at module load, then awaits
// are instant.
const MONO_READY: Promise<unknown> =
  typeof document !== "undefined" && "fonts" in document
    ? Promise.all([
        document.fonts.load('600 13px "JetBrainsMono Terminal"'),
        document.fonts.load('italic 600 13px "JetBrainsMono Terminal"'),
      ]).catch(() => {})
    : Promise.resolve();

function enqueueWrite(pane: Pane, data: string) {
  pane.writeQueue = pane.writeQueue
    .catch(() => {})
    .then(
      () =>
        new Promise<void>((resolve) => {
          if (pane.disposed) {
            resolve();
            return;
          }
          try {
            pane.term.write(data, resolve);
          } catch {
            resolve();
          }
        }),
    );
}

function sendResizeIfChanged(pane: Pane, cols = pane.term.cols, rows = pane.term.rows) {
  if (pane.disposed || cols < 1 || rows < 1) return;
  if (cols === pane.lastSentCols && rows === pane.lastSentRows) return;
  pane.lastSentCols = cols;
  pane.lastSentRows = rows;
  invoke("pty_resize", { paneId: pane.paneId, cols, rows }).catch(console.error);
}

// The pane's xterm surface is created once, parked in `stash`, and then moved
// between split-tree leaf bodies on every layout render. xterm keeps its
// buffer across reparenting as long as the Terminal is not disposed.
export async function createPane(
  stash: HTMLElement,
  sessionName: string,
  fontSize = 13,
  // Per-workspace-container key. Must match the workspace the session was
  // created in so the attach exec opens against the right container (undefined /
  // flag off → the shared runtime). See lib.rs `docker_for`.
  workspace?: string,
): Promise<Pane> {
  // Don't measure the cell until the mono font is loaded (see MONO_READY).
  await MONO_READY;

  const el = document.createElement("div");
  el.className = "term-surface";
  stash.appendChild(el);

  const term = new Terminal({
    fontFamily: '"JetBrainsMono Terminal", Menlo, monospace',
    fontSize,
    fontWeight: 600,
    fontWeightBold: 600,
    lineHeight: 1.25,
    letterSpacing: 0,
    // Let the canvas renderer draw box/block glyphs geometrically instead of
    // relying on WebKit font fallback for U+2580-U+259F.
    customGlyphs: true,
    cursorBlink: true,
    cursorStyle: "block",
    allowProposedApi: true,
    scrollback: 10000,
    theme: TERM_THEME,
  });

  const fit = new FitAddon();
  const canvas = new CanvasAddon();
  term.loadAddon(fit);
  term.loadAddon(canvas);
  term.open(el);
  // Kill browser autocomplete on xterm's internal textarea. Some browsers
  // ignore autocomplete="off" on well-known field names, so we randomize the
  // name attribute to prevent any heuristic matching.
  const ta = el.querySelector("textarea");
  if (ta) {
    ta.setAttribute("autocomplete", "off");
    ta.setAttribute("autocorrect", "off");
    ta.setAttribute("autocapitalize", "off");
    ta.setAttribute("spellcheck", "false");
    ta.setAttribute("name", `term-${Math.random().toString(36).slice(2)}`);
  }

  // Use xterm's canvas renderer in WKWebView. The DOM renderer delegates block
  // elements to WebKit fonts and can paint Claude's logo as thin strokes; the
  // canvas renderer honors `customGlyphs` and draws those cells itself. Avoid the
  // WebGL addon: its glyph atlas has clipped U+2580-U+259F in this webview.

  const paneId: string = await invoke("attach_session", {
    name: sessionName,
    cols: term.cols,
    rows: term.rows,
    workspace,
  });

  const pane: Pane = {
    sessionName,
    paneId,
    el,
    term,
    fit,
    writeQueue: Promise.resolve(),
    fitFrame: null,
    lastSentCols: term.cols,
    lastSentRows: term.rows,
    disposed: false,
  };
  pane.blockOverlay = installBlockGlyphOverlay(term, el);
  const normalizeOutput = createPtyOutputNormalizer();

  pane.unlistenData = await listen<string>(`pty://data/${paneId}`, (e) => {
    enqueueWrite(pane, normalizeOutput(e.payload));
  });

  pane.unlistenExit = await listen<number>(`pty://exit/${paneId}`, () => {
    enqueueWrite(pane, "\r\n\x1b[38;2;106;111;121m\x1b[3m  · session ended ·\x1b[0m\r\n");
  });

  term.onData((data) => {
    invoke("pty_write", { paneId, data }).catch(console.error);
  });

  term.onResize(({ cols, rows }) => {
    sendResizeIfChanged(pane, cols, rows);
  });

  fitPane(pane);

  return pane;
}

export async function destroyPane(pane: Pane) {
  pane.disposed = true;
  if (pane.fitFrame !== null) {
    cancelAnimationFrame(pane.fitFrame);
    pane.fitFrame = null;
  }
  pane.unlistenData?.();
  pane.unlistenExit?.();
  pane.blockOverlay?.dispose();
  await invoke("detach_session", { paneId: pane.paneId }).catch(console.error);
  pane.term.dispose();
  pane.el.remove();
}

// Re-measure and reflow a pane to its current container. Cheap to call after
// any layout change (split, resize, tab switch).
export function fitPane(pane: Pane) {
  if (pane.disposed || !pane.el.isConnected || pane.fitFrame !== null) return;
  pane.fitFrame = requestAnimationFrame(() => {
    pane.fitFrame = null;
    if (pane.disposed || !pane.el.isConnected) return;
    const rect = pane.el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    try {
      pane.fit.fit();
      sendResizeIfChanged(pane);
    } catch {
      // Container momentarily zero-sized during reflow — next tick will retry.
    }
  });
}

export function focusPane(pane: Pane) {
  requestAnimationFrame(() => {
    fitPane(pane);
    pane.term.focus();
  });
}

// Live font-size change: update the xterm option then reflow so the grid
// re-measures to the new cell size (and the backend pty is resized via the
// caller's fit path).
export function setPaneFontSize(pane: Pane, fontSize: number) {
  if (pane.term.options.fontSize === fontSize) return;
  pane.term.options.fontSize = fontSize;
  fitPane(pane);
}
