/**
 * States — reusable loading / error / empty primitives, plus a dev-only gallery.
 * Ported from design/screens/states.jsx.
 *
 * The exported building blocks (`SkeletonPane`, `CrashPane`, `ApiKeyError`,
 * `RateLimited`, `OfflineBanner`, `EmptyPanel`) are prop-driven so real callers
 * pass real data — they fabricate nothing on their own. The `StatesGallery`
 * default export is a reference artboard reachable at `#/__states` in dev only
 * (see main.tsx); its sample text is clearly a design reference, never presented
 * as live app data.
 *
 * Honesty: every numeric figure shown in a live mount must come from a real
 * source the caller supplies (em-dash when absent). The gallery is the one place
 * placeholder copy is acceptable, because it is explicitly a catalogue of looks.
 */
import { Ico } from "@/app/components/primitives/icons";
import { useTheme } from "@/app/lib/theme";
import { Button } from "@/app/ui/button";
import type { ReactNode } from "react";

// ── LOADING ────────────────────────────────────────────────────────────────

// Inject the shimmer keyframe once (idempotent), so the loading primitives stay
// self-contained and don't depend on edits to the shared CSS files.
const SHIMMER_ID = "codehub-state-shimmer";
if (typeof document !== "undefined" && !document.getElementById(SHIMMER_ID)) {
  const el = document.createElement("style");
  el.id = SHIMMER_ID;
  el.textContent =
    "@keyframes state-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}";
  document.head.appendChild(el);
}

/** A single shimmer bar. Width/height are caller-controlled. */
export function Sk({ w, h }: { w: string | number; h: number }) {
  return (
    <span
      style={{
        display: "block",
        width: typeof w === "number" ? `${w}px` : w,
        height: h,
        borderRadius: 4,
        background: "linear-gradient(90deg, var(--bg-3), var(--bg-hover), var(--bg-3))",
        backgroundSize: "200% 100%",
        animation: "state-shimmer 1.4s ease-in-out infinite",
      }}
    />
  );
}

/**
 * Skeleton terminal — first paint before agent metadata returns. `turns` is
 * shown only when the caller knows it (e.g. resuming a transcript with a known
 * length); omitted otherwise rather than guessed.
 */
export function SkeletonPane({
  caption = "loading…",
  turns,
}: { caption?: string; turns?: number }) {
  return (
    <div style={{ flex: 1, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
      <Sk w="65%" h={11} />
      <Sk w="40%" h={10} />
      <div style={{ height: 8 }} />
      <Sk w="80%" h={9} />
      <Sk w="92%" h={9} />
      <Sk w="55%" h={9} />
      <div style={{ height: 4 }} />
      <Sk w="74%" h={9} />
      <Sk w="60%" h={9} />
      <div className="mono" style={{ marginTop: "auto", fontSize: 10.5, color: "var(--fg-3)" }}>
        {caption}
        {turns != null && <span className="tnum"> · {turns} turns</span>}
      </div>
    </div>
  );
}

// ── ERRORS ───────────────────────────────────────────────────────────────--

/**
 * Container-crashed pane (e.g. an OOMKill). `detail` is the real exit reason
 * the caller observed (em-dash when unknown); the buttons are caller-wired.
 */
export function CrashPane({
  title = "Container crashed",
  detail,
  body,
  onRestart,
  onLogs,
  onShell,
  restartLabel = "Restart",
}: {
  title?: string;
  detail?: string;
  body?: ReactNode;
  onRestart?: () => void;
  onLogs?: () => void;
  onShell?: () => void;
  restartLabel?: string;
}) {
  return (
    <div style={{ flex: 1, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "var(--err)",
            boxShadow: "0 0 12px var(--err)",
          }}
        />
        <span className="mono" style={{ fontSize: 12, color: "var(--err)" }}>
          {title}
        </span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>
          {detail ?? "—"}
        </span>
      </div>
      {body && (
        <div
          style={{
            padding: "10px 12px",
            background: "color-mix(in oklab, var(--err) 8%, var(--bg-0))",
            border: "1px solid color-mix(in oklab, var(--err) 30%, var(--bd))",
            borderRadius: 6,
            fontFamily: "var(--mono)",
            fontSize: 11.5,
            color: "var(--fg-1)",
            lineHeight: 1.55,
          }}
        >
          {body}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginTop: "auto" }}>
        <Button
          variant="success"
          size="sm"
          style={{ flex: 1, justifyContent: "center" }}
          onClick={onRestart}
        >
          {restartLabel}
        </Button>
        <Button variant="outline" size="sm" onClick={onLogs}>
          View logs
        </Button>
        <Button variant="ghost" size="sm" onClick={onShell}>
          Open shell
        </Button>
      </div>
    </div>
  );
}

/**
 * Authentication-failed pane. `code`/`body` describe the real provider rejection
 * the caller saw; actions are wired by the caller (reauthorize / switch account).
 */
export function ApiKeyError({
  code = "Authentication failed",
  body,
  onReauthorize,
  onSwitch,
}: {
  code?: string;
  body?: ReactNode;
  onReauthorize?: () => void;
  onSwitch?: () => void;
}) {
  return (
    <div style={{ flex: 1, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "var(--wait)",
            boxShadow: "0 0 12px var(--wait)",
          }}
        />
        <span className="mono" style={{ fontSize: 12, color: "var(--wait)" }}>
          {code}
        </span>
      </div>
      {body && (
        <div
          style={{
            padding: "10px 12px",
            background: "color-mix(in oklab, var(--wait) 8%, var(--bg-0))",
            border: "1px solid color-mix(in oklab, var(--wait) 30%, var(--bd))",
            borderRadius: 6,
            fontSize: 11.5,
            color: "var(--fg-1)",
            lineHeight: 1.55,
          }}
        >
          {body}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginTop: "auto" }}>
        <Button size="sm" style={{ flex: 1, justifyContent: "center" }} onClick={onReauthorize}>
          Reauthorize
        </Button>
        <Button variant="outline" size="sm" onClick={onSwitch}>
          Switch account
        </Button>
      </div>
    </div>
  );
}

/**
 * Rate-limited pane. `resetsIn` is a caller-formatted countdown string (em-dash
 * when unknown); `usedLabel` is the real used/limit string (e.g. from Codex's
 * on-disk rate_limits). No values are invented here.
 */
export function RateLimited({
  title = "Rate limit reached",
  account,
  resetsIn,
  pct,
  usedLabel,
  onSwitch,
  onNotify,
}: {
  title?: string;
  account?: string;
  resetsIn?: string;
  pct?: number;
  usedLabel?: string;
  onSwitch?: () => void;
  onNotify?: () => void;
}) {
  const width = pct == null ? "100%" : `${Math.min(100, Math.max(0, pct))}%`;
  return (
    <div style={{ flex: 1, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--wait)" }} />
        <span className="mono" style={{ fontSize: 12, color: "var(--wait)" }}>
          {title}
        </span>
        <span style={{ flex: 1 }} />
        {account && (
          <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-2)" }}>
            {account}
          </span>
        )}
      </div>
      <div
        style={{
          padding: "10px 12px",
          background: "var(--bg-1)",
          border: "1px solid var(--bd)",
          borderRadius: 6,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: 6,
          }}
        >
          <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>
            resets in
          </span>
          <span
            className="mono tnum"
            style={{ fontSize: 16, fontWeight: 500, color: "var(--fg-0)" }}
          >
            {resetsIn ?? "—"}
          </span>
        </div>
        <div
          style={{ height: 4, background: "var(--bg-3)", borderRadius: 999, overflow: "hidden" }}
        >
          <div style={{ width, height: "100%", background: "var(--wait)" }} />
        </div>
        {usedLabel && (
          <div className="mono tnum" style={{ marginTop: 6, fontSize: 10.5, color: "var(--fg-3)" }}>
            {usedLabel}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: "auto" }}>
        <Button
          variant="outline"
          size="sm"
          style={{ flex: 1, justifyContent: "center" }}
          onClick={onSwitch}
        >
          Switch account
        </Button>
        <Button variant="ghost" size="sm" onClick={onNotify}>
          Notify me
        </Button>
      </div>
    </div>
  );
}

/** App-wide offline banner with a degraded-mode hint and a caller-wired retry. */
export function OfflineBanner({
  hint = "Running agents are paused. Local containers and shells still work.",
  sub,
  onRetry,
}: {
  hint?: string;
  sub?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      style={{
        padding: "10px 14px",
        background: "color-mix(in oklab, var(--err) 10%, var(--bg-1))",
        border: "1px solid color-mix(in oklab, var(--err) 35%, var(--bd))",
        borderRadius: 8,
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: "50%",
          background: "var(--err)",
          color: "var(--bg-0)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        !
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-0)" }}>You're offline</div>
        <div style={{ fontSize: 11, color: "var(--fg-2)" }}>{hint}</div>
        {sub && (
          <div className="mono" style={{ marginTop: 4, fontSize: 10.5, color: "var(--fg-3)" }}>
            {sub}
          </div>
        )}
      </div>
      <Button variant="outline" size="xs" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/**
 * Centered empty panel — a quiet state with a clear next step (never a blank
 * page). `cta`/`onCta` are optional; without them it's a pure informational rest
 * state. This is the canonical "nothing here yet" template across the app.
 */
export function EmptyPanel({
  icon,
  title,
  hint,
  cta,
  onCta,
  small,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  cta?: string;
  onCta?: () => void;
  small?: boolean;
}) {
  return (
    <div
      style={{
        flex: 1,
        padding: small ? 14 : 22,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        gap: 10,
        textAlign: "center",
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 8,
          background: "var(--bg-3)",
          color: "var(--fg-2)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span style={{ transform: "scale(1.4)" }}>{icon}</span>
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--fg-0)" }}>{title}</div>
      <div style={{ fontSize: 11.5, color: "var(--fg-2)", maxWidth: 280, lineHeight: 1.5 }}>
        {hint}
      </div>
      {cta && (
        <Button variant="outline" size="sm" style={{ marginTop: 4 }} onClick={onCta}>
          {Ico.plus}
          {cta}
        </Button>
      )}
    </div>
  );
}

// ── DEV-ONLY GALLERY ─────────────────────────────────────────────────────--
// Reachable at #/__states in dev (main.tsx). A reference artboard of every
// state's look; the sample copy here is explicitly illustrative, not live data.

function SectionTitle({ label, caption }: { label: string; caption: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 12,
        marginBottom: 12,
        marginTop: 4,
      }}
    >
      <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--fg-0)" }}>{label}</h2>
      <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>
        {caption}
      </span>
      <span style={{ flex: 1, height: 1, background: "var(--bd-soft)" }} />
    </div>
  );
}

function StateCard({
  caption,
  desc,
  children,
}: {
  caption: string;
  desc: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        background: "var(--bg-2)",
        border: "1px solid var(--bd)",
        borderRadius: 10,
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div
        style={{
          background: "var(--bg-0)",
          borderRadius: 7,
          border: "1px solid var(--bd-soft)",
          minHeight: 160,
          overflow: "hidden",
          display: "flex",
          alignItems: "stretch",
        }}
      >
        {children}
      </div>
      <div>
        <div style={{ fontSize: 12.5, color: "var(--fg-0)", fontWeight: 500, marginBottom: 2 }}>
          {caption}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.4 }}>{desc}</div>
      </div>
    </div>
  );
}

export default function StatesGallery() {
  const { theme, toggle } = useTheme();
  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-1)",
        color: "var(--fg-1)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "16px 28px 14px",
          borderBottom: "1px solid var(--bd-soft)",
          flexShrink: 0,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 19, fontWeight: 600, letterSpacing: "-0.01em" }}>
          States
        </h1>
        <span className="mono" style={{ fontSize: 12, color: "var(--fg-2)" }}>
          loading · error · empty states across the app · dev reference
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={toggle}
          style={{
            padding: "4px 12px",
            borderRadius: 6,
            border: "1px solid var(--bd)",
            background: "var(--bg-3)",
            color: "var(--fg-0)",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Theme: {theme}
        </button>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "20px 28px" }}>
        <SectionTitle label="Loading" caption="skeletons before metadata returns" />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 14,
            marginBottom: 22,
          }}
        >
          <StateCard
            caption="Skeleton terminal"
            desc="First paint before agent metadata returns. Shimmer block, then content."
          >
            <SkeletonPane caption="loading transcript…" turns={218} />
          </StateCard>
          <StateCard
            caption="Skeleton (no turn count)"
            desc="When the transcript length isn't known yet, the count is omitted — never guessed."
          >
            <SkeletonPane caption="attaching…" />
          </StateCard>
        </div>

        <SectionTitle label="Errors" caption="recoverable — each has a clear next action" />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 14,
            marginBottom: 22,
          }}
        >
          <StateCard
            caption="Container crashed (OOM)"
            desc="Mem cap hit during a build. Restart with more memory, or inspect logs."
          >
            <CrashPane
              detail="exit 137 · OOMKilled"
              restartLabel="Restart with 8 GiB"
              body={
                <>
                  <div style={{ color: "var(--err)" }}>
                    Memory cap exceeded during the container's last command
                  </div>
                  <div style={{ color: "var(--fg-2)", marginTop: 4 }}>
                    Scrollback persisted · agent context intact
                  </div>
                </>
              }
            />
          </StateCard>
          <StateCard
            caption="API key invalid"
            desc="Provider rejected the token. Pause sessions, reauthorize, resume — no scrollback loss."
          >
            <ApiKeyError
              code="401 · Invalid API key"
              body={
                <div style={{ color: "var(--fg-2)" }}>
                  The provider rejected the configured key. Sessions on this key are paused; their
                  state is preserved.
                </div>
              }
            />
          </StateCard>
          <StateCard
            caption="Rate limited"
            desc="Real countdown + used/limit when the source provides it (e.g. Codex rate_limits)."
          >
            <RateLimited
              title="Window full"
              resetsIn="01:42:08"
              pct={100}
              usedLabel="240 / 240 messages"
            />
          </StateCard>
          <StateCard caption="Network · offline" desc="App-wide banner with a degraded-mode hint.">
            <div style={{ flex: 1, padding: 16, display: "flex" }}>
              <OfflineBanner sub="Reconnecting…" />
            </div>
          </StateCard>
        </div>

        <SectionTitle
          label="Empty"
          caption="quiet states with a clear next step — not blank pages"
        />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
          <StateCard caption="No containers" desc="Container Inspector before any spawn.">
            <EmptyPanel
              icon={Ico.container}
              title="No containers yet"
              hint="A container is created when you spawn your first agent."
              cta="New agent"
            />
          </StateCard>
          <StateCard caption="No resumable sessions" desc="Resume library on day one.">
            <EmptyPanel
              icon={Ico.hub}
              title="Nothing to resume"
              hint="Closed sessions and past conversations appear here."
              cta="Start a session"
            />
          </StateCard>
          <StateCard caption="No integrations" desc="Before connecting GitHub.">
            <EmptyPanel
              icon={Ico.files}
              title="No integrations connected"
              hint="Connect GitHub to let agents clone, branch, and open PRs."
              cta="Connect GitHub"
            />
          </StateCard>
          <StateCard caption="No usage data yet" desc="Brand-new account, before the first turn.">
            <EmptyPanel
              icon={Ico.cpu}
              title="No usage yet"
              hint="Charts populate after your first agent turn."
            />
          </StateCard>
          <StateCard caption="Search · no results" desc="A palette filter that matched nothing.">
            <EmptyPanel
              small
              icon={Ico.search}
              title="No matches"
              hint="Try a shorter query, or ⌘N to spawn a new agent."
            />
          </StateCard>
          <StateCard caption="No processes" desc="Container inspector with an idle runtime.">
            <EmptyPanel
              small
              icon={Ico.cpu}
              title="No processes"
              hint="The runtime is up but no agent is running yet."
            />
          </StateCard>
        </div>
      </div>
    </div>
  );
}
