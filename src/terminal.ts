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

// Terminal theme — mirrors the design tokens (tokens.css). xterm needs literal
// hex (no CSS vars / oklch), so the ANSI palette is the sRGB conversion of the
// design accents: green=--live, amber=--wait, red=--err, blue=--a-codex,
// cyan=--a-antigravity. Surface = --bg-0, text = --fg-1.
const TERM_THEME = {
  background: "#08090b",
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
  const el = document.createElement("div");
  el.className = "term-surface";
  stash.appendChild(el);

  const term = new Terminal({
    fontFamily: '"Geist Mono", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
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
    workspace,
  });

  const pane: Pane = { sessionName, paneId, el, term, fit };

  pane.unlistenData = await listen<string>(`pty://data/${paneId}`, (e) => {
    term.write(e.payload);
  });

  pane.unlistenExit = await listen<number>(`pty://exit/${paneId}`, () => {
    term.write("\r\n\x1b[38;2;106;111;121m\x1b[3m  · session ended ·\x1b[0m\r\n");
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
