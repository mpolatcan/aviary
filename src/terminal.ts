import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { type UnlistenFn, invoke, listen } from "./app/lib/bridge";

export interface Pane {
  sessionName: string;
  paneId: string;
  el: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  unlistenData?: UnlistenFn;
  unlistenExit?: UnlistenFn;
}

// Terminal theme — cool grey with an amber cursor
const TERM_THEME = {
  background: "#131417",
  foreground: "#c9cdd4",
  cursor: "#e8a33d",
  cursorAccent: "#131417",
  selectionBackground: "#2e333b",
  selectionForeground: "#e6e9ee",

  black: "#1b1e23",
  red: "#d6604d",
  green: "#6ee787",
  yellow: "#e8a33d",
  blue: "#5a8fd6",
  magenta: "#b07acb",
  cyan: "#5ad4e6",
  white: "#c9cdd4",

  brightBlack: "#3e444c",
  brightRed: "#e8786a",
  brightGreen: "#8af0a0",
  brightYellow: "#f6b65a",
  brightBlue: "#7aa6e6",
  brightMagenta: "#c79ada",
  brightCyan: "#7ce0ef",
  brightWhite: "#e6e9ee",
};

// The pane's xterm surface is created once, parked in `stash`, and then moved
// between split-tree leaf bodies on every layout render. xterm keeps its
// buffer across reparenting as long as the Terminal is not disposed.
export async function createPane(
  stash: HTMLElement,
  sessionName: string,
  fontSize = 13,
): Promise<Pane> {
  const el = document.createElement("div");
  el.className = "term-surface";
  stash.appendChild(el);

  const term = new Terminal({
    fontFamily: '"JetBrains Mono", "DM Mono", ui-monospace, "SF Mono", Menlo, monospace',
    fontSize,
    fontWeight: 400,
    lineHeight: 1.25,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: "block",
    allowProposedApi: true,
    scrollback: 10000,
    theme: TERM_THEME,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);

  try {
    const webgl = new WebglAddon();
    // WKWebView (Tauri's WebKit) drops the WebGL context when the canvas is
    // reparented between split-tree leaves — which <PaneMount> does on every
    // split and tab switch — and the addon does not auto-recover, so the pane
    // renders blank ("terminal disappears"). Dispose it on context loss so
    // xterm falls back to the DOM renderer, which survives reparenting.
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // WebGL unavailable — canvas renderer fallback is automatic.
  }

  requestAnimationFrame(() => fit.fit());

  const paneId: string = await invoke("attach_session", {
    name: sessionName,
    cols: term.cols,
    rows: term.rows,
  });

  const pane: Pane = { sessionName, paneId, el, term, fit };

  pane.unlistenData = await listen<string>(`pty://data/${paneId}`, (e) => {
    term.write(e.payload);
  });

  pane.unlistenExit = await listen<number>(`pty://exit/${paneId}`, () => {
    term.write("\r\n\x1b[38;2;201;163;107m\x1b[3m  · session ended ·\x1b[0m\r\n");
  });

  term.onData((data) => {
    invoke("pty_write", { paneId, data }).catch(console.error);
  });

  term.onResize(({ cols, rows }) => {
    invoke("pty_resize", { paneId, cols, rows }).catch(console.error);
  });

  return pane;
}

export async function destroyPane(pane: Pane) {
  pane.unlistenData?.();
  pane.unlistenExit?.();
  await invoke("detach_session", { paneId: pane.paneId }).catch(console.error);
  pane.term.dispose();
  pane.el.remove();
}

// Re-measure and reflow a pane to its current container. Cheap to call after
// any layout change (split, resize, tab switch).
export function fitPane(pane: Pane) {
  if (!pane.el.isConnected) return;
  try {
    pane.fit.fit();
  } catch {
    // Container momentarily zero-sized during reflow — next tick will retry.
  }
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
