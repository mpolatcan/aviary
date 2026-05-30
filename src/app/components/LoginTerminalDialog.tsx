// Login terminal dialog — embeds an xterm terminal connected to a temporary
// container running the agent's login command. When the session exits (login
// complete) or the user closes the dialog, the credential is captured and the
// container is cleaned up. This dialog is self-contained: it manages its own
// xterm instance independent of the hub pane registry.
import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ipc } from "@/app/lib/ipc";
import { useEffect, useRef, useState } from "react";
import { installBlockGlyphOverlay } from "../../app/lib/block-glyph-overlay";
import { type UnlistenFn, listen } from "../../app/lib/bridge";
import { createPtyOutputNormalizer } from "../../app/lib/pty-output";
import { Button } from "../ui/button";

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

export interface LoginTerminalDialogProps {
  provider: string;
  profileId: string;
  sessionName: string;
  workspace: string;
  onDone: (result: "captured" | "cancelled") => void;
}

const PROVIDER_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
};

export function LoginTerminalDialog({
  provider,
  profileId,
  sessionName,
  workspace,
  onDone,
}: LoginTerminalDialogProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"connecting" | "running" | "done" | "error">("connecting");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  // Refs hold live objects that don't need to trigger re-renders.
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const paneIdRef = useRef<string | null>(null);
  const unlistenDataRef = useRef<UnlistenFn | null>(null);
  const unlistenExitRef = useRef<UnlistenFn | null>(null);
  const doneRef = useRef(false);
  const capturedRef = useRef(false);

  const capture = async () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setCapturing(true);
    try {
      await ipc.vaultCompleteLogin(provider, profileId, workspace, sessionName);
      capturedRef.current = true;
      setStatus("done");
      setStatusMsg(
        `${PROVIDER_LABEL[provider] ?? provider} credential captured and stored in keychain.`,
      );
      setTimeout(() => onDone("captured"), 1500);
    } catch (e) {
      setStatus("error");
      setStatusMsg(String(e).replace(/^Error:\s*/, ""));
      setCapturing(false);
      doneRef.current = false;
    }
  };

  const dismiss = async () => {
    if (capturedRef.current) {
      onDone("captured");
      return;
    }
    if (capturing) return;
    if (!doneRef.current) {
      doneRef.current = true;
      // Best-effort cleanup: kill the session and remove the container.
      try {
        await ipc.killSession(sessionName, workspace);
      } catch {
        /* ignore */
      }
      try {
        await ipc.removeWorkspaceContainer(workspace);
      } catch {
        /* ignore */
      }
    }
    onDone("cancelled");
  };

  // Mount xterm and attach to the backend session. Runs once on mount:
  // sessionName/workspace/capture are stable for the dialog's lifetime.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only effect
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      fontFamily: '"JetBrainsMono Terminal", Menlo, monospace',
      fontSize: 13,
      fontWeight: 600,
      fontWeightBold: 600,
      lineHeight: 1.25,
      letterSpacing: 0,
      customGlyphs: true,
      cursorBlink: true,
      cursorStyle: "block",
      allowProposedApi: true,
      scrollback: 5000,
      theme: TERM_THEME,
    });
    const fit = new FitAddon();
    const canvas = new CanvasAddon();
    term.loadAddon(fit);
    term.loadAddon(canvas);
    term.open(el);
    const ta = el.querySelector("textarea");
    if (ta) {
      ta.setAttribute("autocomplete", "off");
      ta.setAttribute("autocorrect", "off");
      ta.setAttribute("autocapitalize", "off");
      ta.setAttribute("spellcheck", "false");
      ta.setAttribute("name", `term-${Math.random().toString(36).slice(2)}`);
    }
    termRef.current = term;
    fitRef.current = fit;
    const blockOverlay = installBlockGlyphOverlay(term, el);
    const normalizeOutput = createPtyOutputNormalizer();

    let alive = true;
    let fitFrame: number | null = null;
    let writeQueue = Promise.resolve();
    let lastSentCols = term.cols;
    let lastSentRows = term.rows;

    const enqueueWrite = (data: string) => {
      writeQueue = writeQueue
        .catch(() => {})
        .then(
          () =>
            new Promise<void>((resolve) => {
              if (!alive) {
                resolve();
                return;
              }
              try {
                term.write(data, resolve);
              } catch {
                resolve();
              }
            }),
        );
    };

    const sendResizeIfChanged = (cols = term.cols, rows = term.rows) => {
      const paneId = paneIdRef.current;
      if (!alive || !paneId || cols < 1 || rows < 1) return;
      if (cols === lastSentCols && rows === lastSentRows) return;
      lastSentCols = cols;
      lastSentRows = rows;
      void ipc.ptyResize(paneId, cols, rows);
    };

    const scheduleFit = () => {
      if (fitFrame !== null) return;
      fitFrame = requestAnimationFrame(() => {
        fitFrame = null;
        if (!alive) return;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return;
        try {
          fit.fit();
          sendResizeIfChanged();
        } catch {
          // Dialog mount/close can briefly leave the surface without a size.
        }
      });
    };

    const ro = new ResizeObserver(scheduleFit);
    ro.observe(el);
    scheduleFit();

    (async () => {
      try {
        const paneId = await ipc.attachSession(sessionName, term.cols, term.rows, workspace);
        if (!alive) return;
        paneIdRef.current = paneId;
        lastSentCols = term.cols;
        lastSentRows = term.rows;
        setStatus("running");

        term.onData((data) => {
          void ipc.ptyWrite(paneId, data);
        });
        term.onResize(({ cols, rows }) => {
          sendResizeIfChanged(cols, rows);
        });

        unlistenDataRef.current = await listen<string>(`pty://data/${paneId}`, (e) => {
          enqueueWrite(normalizeOutput(e.payload));
        });

        unlistenExitRef.current = await listen<number>(`pty://exit/${paneId}`, () => {
          enqueueWrite("\r\n\x1b[38;2;106;111;121m\x1b[3m  · session ended ·\x1b[0m\r\n");
          // Auto-capture when the login session exits.
          void capture();
        });
      } catch (e) {
        if (!alive) return;
        setStatus("error");
        setStatusMsg(String(e).replace(/^Error:\s*/, ""));
      }
    })();

    return () => {
      alive = false;
      if (fitFrame !== null) {
        cancelAnimationFrame(fitFrame);
        fitFrame = null;
      }
      ro.disconnect();
      unlistenDataRef.current?.();
      unlistenExitRef.current?.();
      blockOverlay.dispose();
      term.dispose();
    };
  }, []);

  const label = PROVIDER_LABEL[provider] ?? provider;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.65)",
      }}
    >
      <div
        style={{
          width: 860,
          maxWidth: "calc(100vw - 48px)",
          background: "var(--bg-1)",
          border: "1px solid var(--bd)",
          borderRadius: 10,
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 16px",
            borderBottom: "1px solid var(--bd-soft)",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-0)" }}>
            Sign in with {label}
          </span>
          <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)", marginLeft: 4 }}>
            {status === "connecting"
              ? "connecting..."
              : status === "running"
                ? "follow the instructions in the terminal"
                : status === "done"
                  ? "done"
                  : "error"}
          </span>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" size="icon-xs" onClick={() => void dismiss()} aria-label="Close">
            ×
          </Button>
        </div>

        {/* terminal */}
        <div
          style={{
            height: 420,
            background: "#08090b",
            flexShrink: 0,
            position: "relative",
          }}
        >
          <div
            className="login-term-surface"
            ref={containerRef}
            style={{
              position: "absolute",
              inset: 0,
              padding: "8px 4px",
            }}
          />
        </div>

        {/* footer */}
        <div
          style={{
            padding: "10px 16px",
            borderTop: "1px solid var(--bd-soft)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexShrink: 0,
            minHeight: 52,
          }}
        >
          {status === "error" && (
            <span className="mono" style={{ fontSize: 11.5, color: "var(--err)", flex: 1 }}>
              {statusMsg}
            </span>
          )}
          {status === "done" && statusMsg && (
            <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)", flex: 1 }}>
              {statusMsg}
            </span>
          )}
          {(status === "running" || status === "connecting") && (
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)", flex: 1 }}>
              {provider === "claude"
                ? "Complete the Claude setup above. The credential is captured automatically when the session exits."
                : `Complete the ${label} login above. The credential is captured automatically when the session exits.`}
            </span>
          )}

          {status === "done" && (
            <Button variant="outline" size="sm" onClick={() => onDone("captured")}>
              Close
            </Button>
          )}

          {(status === "error" || status === "running" || status === "connecting") && (
            <Button variant="ghost" size="sm" onClick={() => void dismiss()}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
