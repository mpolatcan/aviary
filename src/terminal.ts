import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn, listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

export interface Pane {
  sessionName: string;
  paneId: string;
  el: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  unlistenData?: UnlistenFn;
  unlistenExit?: UnlistenFn;
}

export interface PaneOptions {
  plateLabel?: string;
  binomial?: string;
}

// Terminal theme — parchment ink on warm charcoal
const TERM_THEME = {
  background: "#1a1612",
  foreground: "#e8dcc4",
  cursor: "#c9a36b",
  cursorAccent: "#1a1612",
  selectionBackground: "#3a2f25",
  selectionForeground: "#f0e4cc",

  black: "#1a1612",
  red: "#a04a3a",
  green: "#6a7a52",
  yellow: "#c9a36b",
  blue: "#4a5a78",
  magenta: "#8a5a6a",
  cyan: "#6a8a8a",
  white: "#e8dcc4",

  brightBlack: "#3a2f25",
  brightRed: "#c96a5a",
  brightGreen: "#8a9a72",
  brightYellow: "#e0b87a",
  brightBlue: "#6a7a98",
  brightMagenta: "#aa7a8a",
  brightCyan: "#8aaaaa",
  brightWhite: "#f0e4cc",
};

export async function createPane(
  host: HTMLElement,
  sessionName: string,
  opts: PaneOptions = {},
): Promise<Pane> {
  const el = document.createElement("div");
  el.className = "term-pane";

  if (opts.plateLabel) {
    const label = document.createElement("span");
    label.className = "plate-label";
    label.textContent = opts.plateLabel;
    el.appendChild(label);
  }
  if (opts.binomial) {
    const bn = document.createElement("span");
    bn.className = "plate-binomial";
    bn.textContent = opts.binomial;
    el.appendChild(bn);
  }

  const termHost = document.createElement("div");
  termHost.style.position = "absolute";
  termHost.style.inset = "10px";
  el.appendChild(termHost);

  host.appendChild(el);

  const term = new Terminal({
    fontFamily: '"JetBrains Mono", "DM Mono", ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 13,
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
  term.open(termHost);

  try {
    term.loadAddon(new WebglAddon());
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
    term.write("\r\n\x1b[38;2;201;163;107m\x1b[3m  · specimen has departed ·\x1b[0m\r\n");
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

export function activatePane(pane: Pane) {
  pane.el.classList.add("active");
  requestAnimationFrame(() => {
    pane.fit.fit();
    pane.term.focus();
  });
}

export function deactivatePane(pane: Pane) {
  pane.el.classList.remove("active");
}
