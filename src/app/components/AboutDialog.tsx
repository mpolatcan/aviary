import { useEffect, useState } from "react";
import { CLIS } from "../lib/catalog";
import { type AppInfo, type ImageInfo, type UpdateStatus, ipc } from "../lib/ipc";
import { useOverlay } from "../lib/overlay";
import { useStore } from "../lib/store";
import { Button } from "../ui/button";
import { Logo } from "./primitives/Logo";
import { Tip } from "./primitives/Tip";

// About CodeHub — a modal "about this app", ported from design/screens/about.jsx.
// Opened from the sidebar wordmark. Every value shown is REAL: version/os/arch
// from app_info, the daemon line from docker_info, the runtime image from
// container_image, agent versions from the bootstrap probe.
//
// Updater (Phase-0 contract `check_update`): the badge + install button appear
// ONLY when the backend reports a newer version (`available` non-null). Until the
// BE updater lands the command returns honest-empty (available: null), so the UI
// shows "up to date" — never a fabricated "v0.43.0 available". The install action
// is gated on a real available version; with none, there's nothing to install.
//
// Changelog: a curated, hand-verified list of what actually shipped per release
// (matches the real git tags v0.1.0–v0.1.2). Not a feed — a maintained constant
// describing real changes, kept short. The footer links to the repo releases
// page (selectable text — no in-app browser is opened).
const REPO_RELEASES = "https://github.com/mpolatcan/codehub/releases";

// Curated changelog — real shipped changes, newest first. Maintained by hand
// alongside releases; each line describes a change that actually landed (see the
// git history / release tags). Tone keys: "add" (new), "fix", "chore".
const CHANGELOG: { version: string; entries: { tone: "add" | "fix" | "chore"; text: string }[] }[] =
  [
    {
      version: "0.1.2",
      entries: [
        { tone: "add", text: "Runtime container start / stop / restart controls" },
        { tone: "add", text: "macOS native Dynamic Island companion" },
        {
          tone: "add",
          text: "Tier-2 workspace picker and Tier-3 account profiles in the spawn dialog",
        },
        { tone: "fix", text: "Reskinned chrome to the CodeHub design tokens (dark + light)" },
      ],
    },
    {
      version: "0.1.1",
      entries: [
        {
          tone: "add",
          text: "Real all-time Claude token total + usage analytics from transcripts",
        },
        { tone: "add", text: "Resume past Claude conversations from on-disk transcripts" },
        { tone: "add", text: "Integrations screen reads the real Claude account + MCP servers" },
        {
          tone: "fix",
          text: "Dev-bridge bin moved to its own crate so tauri build bundles cleanly",
        },
      ],
    },
    {
      version: "0.1.0",
      entries: [
        {
          tone: "add",
          text: "Multiple AI coding CLIs in one Docker runtime, multiplexed via tmux",
        },
        { tone: "add", text: "React + Zustand UI with split panes and a compare grid" },
      ],
    },
  ];

export function AboutDialog() {
  const open = useOverlay((s) => s.about);
  const close = () => useOverlay.getState().setAbout(false);
  const dockerInfo = useStore((s) => s.dockerInfo);
  const agentVersions = useStore((s) => s.agentVersions);

  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [image, setImage] = useState<ImageInfo | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  // "idle" → not checked this open; "checking" → in flight; "done" → resolved.
  const [updateState, setUpdateState] = useState<"idle" | "checking" | "done">("idle");

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      useOverlay.getState().setAbout(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Fetch the static identity (app_info) + the runtime image tag once the dialog
  // is opened. Both are cheap reads; image is best-effort (em-dash if the daemon
  // is down). Guarded by `open` so a closed dialog does no I/O.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    ipc
      .appInfo()
      .then((i) => alive && setAppInfo(i))
      .catch(() => alive && setAppInfo(null));
    ipc
      .containerImage()
      .then((i) => alive && setImage(i))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open]);

  // Check for an update when the dialog opens. The backend command is honest:
  // until the updater lands it returns available: null, so we render "up to date"
  // rather than a fabricated newer version. A failure is treated the same way.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setUpdateState("checking");
    setUpdate(null);
    ipc
      .checkUpdate()
      .then((u) => {
        if (!alive) return;
        setUpdate(u);
        setUpdateState("done");
      })
      .catch(() => {
        if (!alive) return;
        setUpdate(null);
        setUpdateState("done");
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const checkNow = () => {
    setUpdateState("checking");
    ipc
      .checkUpdate()
      .then((u) => {
        setUpdate(u);
        setUpdateState("done");
      })
      .catch(() => {
        setUpdate(null);
        setUpdateState("done");
      });
  };
  const copyAbout = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
  };

  if (!open) return null;

  const dash = "—";
  const platform = appInfo ? `${appInfo.os}-${appInfo.arch}` : dash;
  const dockerLine = dockerInfo?.reachable ? (dockerInfo.version ?? "reachable") : "not reachable";
  // An update is offerable only when the backend reports a concrete newer version.
  const hasUpdate = Boolean(update?.available);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(6,7,9,0.55)",
        backdropFilter: "blur(14px) saturate(120%)",
        WebkitBackdropFilter: "blur(14px) saturate(120%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
      onClick={close}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,0.45) 100%)",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "relative",
          zIndex: 1,
          width: "40rem",
          maxWidth: "calc(100vw - 48px)",
          background: "var(--bg-2)",
          border: "1px solid var(--bd-strong)",
          borderRadius: 14,
          overflow: "hidden",
          boxShadow: "0 30px 80px rgba(0,0,0,.6)",
          color: "var(--fg-1)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* hero */}
        <div
          style={{
            padding: "26px 28px 22px",
            background:
              "linear-gradient(135deg, color-mix(in oklab, var(--pri) 16%, var(--bg-2)), var(--bg-2))",
            display: "flex",
            alignItems: "center",
            gap: 18,
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: "var(--bg-0)",
              border: "1px solid var(--bd)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Logo size={32} withText={false} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: "var(--fs-20)",
                fontWeight: 600,
                letterSpacing: "-0.01em",
                color: "var(--fg-0)",
              }}
            >
              CodeHub
            </div>
            <div
              className="mono"
              style={{
                fontSize: "var(--fs-12)",
                color: "var(--fg-2)",
                marginTop: 3,
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <span>
                v{appInfo?.version ?? dash} · {platform}
              </span>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: "color-mix(in oklab, var(--live) 12%, transparent)",
                  border: "1px solid color-mix(in oklab, var(--live) 30%, transparent)",
                  color: "var(--live)",
                  fontSize: "var(--fs-11)",
                }}
              >
                <span
                  style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--live)" }}
                />
                desktop
              </span>
            </div>
          </div>
          {hasUpdate && (
            <div
              style={{
                alignSelf: "flex-start",
                padding: "6px 10px",
                borderRadius: 6,
                background: "color-mix(in oklab, var(--live) 12%, transparent)",
                border: "1px solid color-mix(in oklab, var(--live) 35%, transparent)",
                color: "var(--live)",
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-end",
              }}
            >
              <div className="mono" style={{ fontSize: "var(--fs-11)" }}>
                update available
              </div>
              <div className="mono tnum" style={{ fontSize: "var(--fs-13)", fontWeight: 600 }}>
                v{update?.available}
              </div>
            </div>
          )}
          <Button variant="outline" size="xs" className="mono self-start" onClick={close}>
            esc
          </Button>
        </div>

        {/* environment — every field is real */}
        <div style={{ padding: "16px 28px", borderBottom: "1px solid var(--bd-soft)" }}>
          <div className="lbl" style={{ fontSize: "var(--fs-11)", marginBottom: 10 }}>
            Environment
          </div>
          <div
            className="mono"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "6px 24px",
              fontSize: "var(--fs-12)",
            }}
          >
            <Kv k="Version" v={appInfo ? `v${appInfo.version}` : dash} />
            <Kv k="Docker" v={dockerLine} />
            <Kv k="OS" v={appInfo?.os ?? dash} />
            <Kv k="Docker API" v={dockerInfo?.apiVersion ?? dash} />
            <Kv k="Architecture" v={appInfo?.arch ?? dash} />
            <Kv k="Image" v={image?.tag ?? dash} />
          </div>
        </div>

        {/* agents — real versions from the runtime probe */}
        <div style={{ padding: "16px 28px", borderBottom: "1px solid var(--bd-soft)" }}>
          <div className="lbl" style={{ fontSize: "var(--fs-11)", marginBottom: 10 }}>
            Agents
          </div>
          <div
            className="mono"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "6px 24px",
              fontSize: "var(--fs-12)",
            }}
          >
            {CLIS.map((c) => (
              <Kv key={c.id} k={c.label} v={agentVersions?.[c.id]?.version ?? dash} />
            ))}
          </div>
        </div>

        {/* changelog — curated, real shipped changes (newest release first) */}
        <div
          style={{
            padding: "16px 28px",
            borderBottom: "1px solid var(--bd-soft)",
            maxHeight: 220,
            overflow: "auto",
          }}
        >
          <div className="lbl" style={{ fontSize: "var(--fs-11)", marginBottom: 10 }}>
            Changelog
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {CHANGELOG.map((rel) => (
              <div key={rel.version}>
                <div
                  className="mono tnum"
                  style={{ fontSize: "var(--fs-12)", color: "var(--fg-1)", marginBottom: 6 }}
                >
                  v{rel.version}
                </div>
                <ul
                  style={{
                    margin: 0,
                    padding: 0,
                    listStyle: "none",
                    display: "flex",
                    flexDirection: "column",
                    gap: 5,
                    fontSize: "var(--fs-12)",
                    color: "var(--fg-1)",
                  }}
                >
                  {rel.entries.map((e) => (
                    <ChangelogLine key={e.text} tone={e.tone}>
                      {e.text}
                    </ChangelogLine>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        {/* credits */}
        <div
          style={{
            padding: "14px 28px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: "var(--fs-12)",
            color: "var(--fg-2)",
            flexWrap: "wrap",
          }}
        >
          <span>MIT licensed</span>
          <span style={{ color: "var(--fg-3)" }}>·</span>
          <span>built on Tauri, tmux, Docker, and JetBrains Mono</span>
          <span style={{ flex: 1 }} />
          <Button
            variant="outline"
            size="xs"
            onClick={() => copyAbout("Tauri, tmux, Docker, JetBrains Mono")}
          >
            Credits
          </Button>
          <Button variant="outline" size="xs" onClick={() => copyAbout("MIT licensed")}>
            License
          </Button>
        </div>

        {/* footer — honest update status. "Check now" re-runs check_update; the
            Install button only appears for a real available version (none until
            the BE updater lands → "up to date"). Releases link is selectable. */}
        <div
          style={{
            padding: "12px 28px",
            borderTop: "1px solid var(--bd-soft)",
            background: "var(--bg-1)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span
            className="mono"
            style={{
              fontSize: "var(--fs-11)",
              color: "var(--fg-3)",
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            {updateState === "checking"
              ? "checking for updates…"
              : hasUpdate
                ? "an update is available"
                : updateState === "done"
                  ? "up to date"
                  : "releases at"}
          </span>
          <Tip text={REPO_RELEASES}>
            <span
              className="mono"
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: "var(--fs-11)",
                color: "var(--fg-1)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                userSelect: "all",
              }}
            >
              {REPO_RELEASES}
            </span>
          </Tip>
          <Button
            variant="outline"
            size="sm"
            onClick={checkNow}
            disabled={updateState === "checking"}
          >
            Check now
          </Button>
          {hasUpdate ? (
            <Button
              variant="success"
              size="sm"
              onClick={() => {
                void ipc.checkUpdate();
              }}
            >
              Install v{update?.available} &amp; restart
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={close}>
              Close
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// One changelog entry — a tone tag (add/fix/chore) and the change text.
function ChangelogLine({
  tone,
  children,
}: {
  tone: "add" | "fix" | "chore";
  children: string;
}) {
  const color = tone === "add" ? "var(--live)" : tone === "fix" ? "var(--wait)" : "var(--idle)";
  return (
    <li style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
      <span
        className="mono"
        style={{
          fontSize: "var(--fs-10)",
          color,
          minWidth: 34,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {tone}
      </span>
      <span style={{ flex: 1 }}>{children}</span>
    </li>
  );
}

// Mono key/value row: dim key left, bright value right, truncated.
function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span style={{ color: "var(--fg-3)" }}>{k}</span>
      <span
        style={{
          color: "var(--fg-0)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {v}
      </span>
    </div>
  );
}
