import { Tag } from "@/app/components/primitives/Tag";
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
      <div
        className="mono"
        style={{ marginTop: "auto", fontSize: "var(--fs-11)", color: "var(--fg-3)" }}
      >
        {caption}
        {turns != null && <span className="tnum"> · {turns} turns</span>}
      </div>
    </div>
  );
}

/** One row of the container-boot progress list. */
export type BootStepState = "done" | "active" | "pending";
export interface BootStepSpec {
  state: BootStepState;
  text: string;
  detail?: string;
}

function BootStep({ state, text, detail }: BootStepSpec) {
  const done = state === "done";
  const active = state === "active";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: "var(--fs-12)",
        fontFamily: "var(--mono)",
      }}
    >
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: "50%",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: done ? "var(--live)" : active ? "transparent" : "var(--bg-3)",
          border: active ? "1.5px solid var(--live)" : "none",
          color: "var(--bg-0)",
          flexShrink: 0,
        }}
      >
        {done && (
          <svg
            width="8"
            height="8"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 8l3.5 3.5L13 5" />
          </svg>
        )}
        {active && (
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--live)" }} />
        )}
      </span>
      <span style={{ color: done ? "var(--fg-2)" : active ? "var(--fg-0)" : "var(--fg-3)" }}>
        {text}
      </span>
      {detail && <span style={{ color: "var(--fg-3)", fontSize: "var(--fs-11)" }}>· {detail}</span>}
    </div>
  );
}

/**
 * Container-booting pane — real lifecycle progress, not a generic spinner. The
 * caller supplies the observed boot `steps` (pull → create → mount → tmux →
 * restore), the container `name`, an optional `elapsed` string, and a 0–1
 * progress fraction. Nothing is invented; absent fields are simply omitted.
 */
export function ContainerBootingPane({
  name,
  elapsed,
  steps,
  pct,
}: {
  name?: string;
  elapsed?: string;
  steps: BootStepSpec[];
  pct?: number;
}) {
  const width = pct == null ? "0%" : `${Math.min(100, Math.max(0, pct * 100))}%`;
  return (
    <div style={{ flex: 1, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "var(--live)",
            boxShadow: "0 0 12px var(--live)",
          }}
        />
        <span className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--fg-0)" }}>
          {name ? `${name} · booting` : "booting"}
        </span>
        <span style={{ flex: 1 }} />
        {elapsed && (
          <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-2)" }}>
            {elapsed}
          </span>
        )}
      </div>
      {steps.map((s) => (
        <BootStep key={s.text} {...s} />
      ))}
      <div
        style={{
          marginTop: 4,
          height: 2,
          background: "var(--bg-3)",
          borderRadius: 999,
          overflow: "hidden",
        }}
      >
        <div
          style={{ width, height: "100%", background: "var(--live)", transition: "width .3s" }}
        />
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
        <span className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--err)" }}>
          {title}
        </span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-3)" }}>
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
            fontSize: "var(--fs-12)",
            color: "var(--fg-1)",
            lineHeight: 1.55,
          }}
        >
          {body}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginTop: "auto" }}>
        <Button size="sm" style={{ flex: 1, justifyContent: "center" }} onClick={onRestart}>
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
        <span className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--wait)" }}>
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
            fontSize: "var(--fs-12)",
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
        <span className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--wait)" }}>
          {title}
        </span>
        <span style={{ flex: 1 }} />
        {account && (
          <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-2)" }}>
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
          <span className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--fg-2)" }}>
            resets in
          </span>
          <span
            className="mono tnum"
            style={{ fontSize: "var(--fs-16)", fontWeight: 500, color: "var(--fg-0)" }}
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
          <div
            className="mono tnum"
            style={{ marginTop: 6, fontSize: "var(--fs-11)", color: "var(--fg-3)" }}
          >
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
          fontSize: "var(--fs-13)",
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        !
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "var(--fs-13)", fontWeight: 500, color: "var(--fg-0)" }}>
          You're offline
        </div>
        <div style={{ fontSize: "var(--fs-11)", color: "var(--fg-2)" }}>{hint}</div>
        {sub && (
          <div
            className="mono"
            style={{ marginTop: 4, fontSize: "var(--fs-11)", color: "var(--fg-3)" }}
          >
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
 * Account-suspended hard-stop banner (design states.jsx `SuspendedBanner`). Shown
 * inside Usage when a provider revokes/suspends a key. `account` + `body` carry
 * the real provider message the caller observed; actions are caller-wired.
 */
export function SuspendedBanner({
  account = "account",
  body,
  onContact,
  onRemove,
}: {
  account?: string;
  body?: ReactNode;
  onContact?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div style={{ flex: 1, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: "var(--fs-13)", fontWeight: 500, color: "var(--fg-0)" }}>
          {account}
        </span>
        <span style={{ flex: 1 }} />
        <Tag color="var(--err)">suspended</Tag>
      </div>
      {body && (
        <div
          style={{
            padding: "10px 12px",
            background: "color-mix(in oklab, var(--err) 8%, var(--bg-0))",
            border: "1px solid color-mix(in oklab, var(--err) 30%, var(--bd))",
            borderRadius: 6,
            fontSize: "var(--fs-12)",
            color: "var(--fg-1)",
            lineHeight: 1.55,
          }}
        >
          {body}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginTop: "auto" }}>
        <Button
          variant="outline"
          size="sm"
          style={{ flex: 1, justifyContent: "center" }}
          onClick={onContact}
        >
          Contact support
        </Button>
        <Button variant="ghost" size="sm" onClick={onRemove}>
          Remove account
        </Button>
      </div>
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
      <div style={{ fontSize: "var(--fs-14)", fontWeight: 500, color: "var(--fg-0)" }}>{title}</div>
      <div
        style={{ fontSize: "var(--fs-12)", color: "var(--fg-2)", maxWidth: 280, lineHeight: 1.5 }}
      >
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
      <h2 style={{ margin: 0, fontSize: "var(--fs-14)", fontWeight: 600, color: "var(--fg-0)" }}>
        {label}
      </h2>
      <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--fg-2)" }}>
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
        <div
          style={{
            fontSize: "var(--fs-13)",
            color: "var(--fg-0)",
            fontWeight: 500,
            marginBottom: 2,
          }}
        >
          {caption}
        </div>
        <div style={{ fontSize: "var(--fs-12)", color: "var(--fg-2)", lineHeight: 1.4 }}>
          {desc}
        </div>
      </div>
    </div>
  );
}

export default function StatesGallery() {
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
        <h1
          style={{ margin: 0, fontSize: "var(--fs-20)", fontWeight: 600, letterSpacing: "-0.01em" }}
        >
          States
        </h1>
        <span className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--fg-2)" }}>
          loading · error · empty states across the app · reference
        </span>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "20px 28px" }}>
        <SectionTitle label="Loading" caption="skeletons + spawn progress" />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 14,
            marginBottom: 22,
          }}
        >
          <StateCard
            caption="Container booting"
            desc="Pulling image · attaching tmux · mounting workspace. Real lifecycle progress, not a generic spinner."
          >
            <ContainerBootingPane
              name="codehub-runtime"
              elapsed="2.4s elapsed"
              pct={0.58}
              steps={[
                { state: "done", text: "Pull image", detail: "node:20-slim" },
                { state: "done", text: "Create container", detail: "codehub-runtime" },
                { state: "done", text: "Mount /workspace", detail: "rw" },
                { state: "active", text: "Start tmux server", detail: "/tmp/codehub" },
                { state: "pending", text: "Attach session" },
              ]}
            />
          </StateCard>
          <StateCard
            caption="Skeleton terminal"
            desc="First paint before agent metadata returns. Shimmer block, then content."
          >
            <SkeletonPane caption="loading transcript…" turns={218} />
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
          <StateCard caption="No workspaces" desc="Workspaces inspector before any spawn.">
            <EmptyPanel
              icon={Ico.container}
              title="No workspaces yet"
              hint="A workspace is created when you spawn your first agent."
              cta="New workspace"
            />
          </StateCard>
          <StateCard caption="No resumable agents" desc="Resume library on day one.">
            <EmptyPanel
              icon={Ico.hub}
              title="Nothing to resume"
              hint="Closed sessions and past conversations appear here."
              cta="Start a session"
            />
          </StateCard>
          <StateCard caption="Source control" desc="Before connecting GitHub.">
            <EmptyPanel
              icon={Ico.files}
              title="Source control not connected"
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
              title='No matches for "audit-tracking"'
              hint="Try a shorter query, or use ⌘N to spawn a new agent on this topic."
            />
          </StateCard>
          <StateCard
            caption="Account suspended"
            desc="Hard-stop banner inside Usage when a provider revokes a key."
          >
            <SuspendedBanner
              account="provider account"
              body="The provider suspended this API key. Sessions on it are paused — their state is preserved. Contact support to appeal."
            />
          </StateCard>
        </div>
      </div>
    </div>
  );
}
