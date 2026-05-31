/**
 * CompanionAvatar — the floating always-on-top agent puck. A status-ring puck
 * around a {@link Character} face, with an optional speech bubble. Faithful port
 * of `design/project/screens/companion.jsx`'s CompanionAvatar, driven by the real
 * agent status (`live`/`wait`/`done`/`err`/`idle`) plus presentation flags
 * (thinking/dragging/docked).
 *
 * Honesty: the puck only reflects state the caller actually has. `bubble`/metric
 * text is passed in by the screen from real sources (working/idle always; the
 * "wait" approve affordance comes from `pending_prompts`); this component never
 * fabricates a status.
 */
import type { CSSProperties, ReactNode } from "react";
import { AGENT_META, AgentGlyph } from "./AgentGlyph";
import { Character, type CharacterExpression, type CharacterKind } from "./Character";

/** Live status of the companion's agent. */
export type CompanionStatus = "idle" | "live" | "wait" | "done" | "err";

export interface CompanionAvatarProps {
  /** Agent identity — drives glyph + accent. */
  agent?: string;
  /** Live status; selects the ring color + corner badge. */
  status?: CompanionStatus;
  /** Character art style for the face inside the puck. */
  character?: CharacterKind;
  /** Speech-bubble body text. Shown only when `expanded` is also set. */
  bubble?: ReactNode;
  /** Secondary line inside the bubble header (e.g. session alias). */
  bubbleMeta?: string;
  /** Reveal the speech bubble (hover / pinned). */
  expanded?: boolean;
  /** Orbiting "thinking" dots around the rim. */
  thinking?: boolean;
  /** Scale up + cast a ghost trail (drag affordance). */
  dragging?: boolean;
  /** Half-hidden against a screen edge, with a peek chevron. */
  docked?: boolean;
  /** Approve/Deny callbacks — rendered in the bubble when status is "wait". */
  onApprove?: () => void;
  onDeny?: () => void;
  /** Puck diameter at rest (design default 56). Dragging adds 8px regardless. */
  size?: number;
  style?: CSSProperties;
}

// Map a live status to the four Character expressions.
function expressionFor(status: CompanionStatus, thinking: boolean): CharacterExpression {
  if (status === "wait") return "awaiting";
  if (status === "done") return "done";
  if (status === "live") return thinking ? "thinking" : "idle";
  return "idle";
}

function ringFor(status: CompanionStatus): string {
  switch (status) {
    case "live":
      return "var(--live)";
    case "wait":
      return "var(--wait)";
    case "done":
      return "var(--done)";
    case "err":
      return "var(--err)";
    default:
      return "var(--bd-strong)";
  }
}

export function CompanionAvatar({
  agent = "claude",
  status = "idle",
  character = "glyph",
  bubble,
  bubbleMeta,
  expanded = false,
  thinking = false,
  dragging = false,
  docked = false,
  onApprove,
  onDeny,
  size: sizeProp = 56,
  style,
}: CompanionAvatarProps) {
  const meta = AGENT_META[agent];
  const accent = meta?.accent ?? "var(--fg-1)";
  const ring = ringFor(status);
  const size = dragging ? sizeProp + 8 : sizeProp;
  const glowColor = status === "wait" || status === "err" ? ring : "transparent";
  const glowSize = status === "wait" || status === "err" ? 24 : 14;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        transform: docked ? "translateX(20px)" : "none",
        ...style,
      }}
    >
      <div style={{ position: "relative", flexShrink: 0 }}>
        {/* ghost trail when dragging */}
        {dragging && (
          <>
            <div
              style={{
                position: "absolute",
                top: 8,
                left: -16,
                width: size,
                height: size,
                borderRadius: "50%",
                background: accent,
                opacity: 0.15,
              }}
            />
            <div
              style={{
                position: "absolute",
                top: 4,
                left: -8,
                width: size,
                height: size,
                borderRadius: "50%",
                background: accent,
                opacity: 0.3,
              }}
            />
          </>
        )}

        {/* the puck */}
        <div
          style={{
            width: size,
            height: size,
            borderRadius: "50%",
            background: "var(--bg-0)",
            border: `2px solid ${ring}`,
            boxShadow: `0 ${dragging ? 18 : 10}px ${dragging ? 40 : 26}px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06), 0 0 ${glowSize}px ${glowColor}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
          }}
        >
          {character === "glyph" ? (
            <div style={{ transform: "scale(2.2)" }}>
              <AgentGlyph agent={agent} size={14} color={accent} />
            </div>
          ) : (
            <Character
              kind={character}
              agent={agent}
              expression={expressionFor(status, thinking)}
              size={Math.round(size * 0.62)}
              style={{ border: "none", background: "transparent", boxShadow: "none" }}
            />
          )}

          {/* thinking dots — orbital */}
          {thinking && (
            <>
              <span
                style={{
                  position: "absolute",
                  top: -2,
                  left: "50%",
                  transform: "translateX(-50%)",
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  background: "var(--live)",
                }}
              />
              <span
                style={{
                  position: "absolute",
                  top: "50%",
                  right: -2,
                  transform: "translateY(-50%)",
                  width: 4,
                  height: 4,
                  borderRadius: "50%",
                  background: "var(--live)",
                  opacity: 0.6,
                }}
              />
              <span
                style={{
                  position: "absolute",
                  bottom: -2,
                  left: "40%",
                  width: 3,
                  height: 3,
                  borderRadius: "50%",
                  background: "var(--live)",
                  opacity: 0.35,
                }}
              />
            </>
          )}

          {/* status badge bottom-right */}
          {(status === "wait" || status === "err" || status === "done") && (
            <span
              style={{
                position: "absolute",
                bottom: -2,
                right: -2,
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: ring,
                color: "#0a0a0a",
                border: "2px solid var(--bg-0)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "var(--fs-11)",
                fontWeight: 600,
                boxShadow: `0 0 8px ${ring}`,
              }}
            >
              {status === "wait" && "!"}
              {status === "err" && "×"}
              {status === "done" && (
                <svg
                  width="9"
                  height="9"
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
            </span>
          )}

          {/* edge-dock peek chevron */}
          {docked && (
            <span
              style={{
                position: "absolute",
                left: -10,
                top: "50%",
                transform: "translateY(-50%)",
                color: "var(--fg-3)",
                fontSize: "var(--fs-14)",
              }}
            >
              ‹
            </span>
          )}
        </div>
      </div>

      {/* speech bubble */}
      {bubble && expanded && (
        <div
          style={{
            position: "relative",
            background: "var(--bg-0)",
            color: "var(--fg-0)",
            padding: "8px 12px",
            borderRadius: 10,
            fontSize: "var(--fs-12)",
            fontFamily: "var(--sans)",
            maxWidth: 220,
            marginTop: 6,
            boxShadow: "0 8px 24px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.06)",
          }}
        >
          {/* tail */}
          <span
            style={{
              position: "absolute",
              left: -6,
              top: 14,
              width: 0,
              height: 0,
              borderTop: "6px solid transparent",
              borderBottom: "6px solid transparent",
              borderRight: "7px solid var(--bg-0)",
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
            <span style={{ fontSize: "var(--fs-13)", fontWeight: 600 }}>{meta?.name ?? agent}</span>
            {bubbleMeta && (
              <span
                style={{
                  fontSize: "var(--fs-11)",
                  color: "var(--fg-2)",
                  fontFamily: "var(--mono)",
                }}
              >
                {bubbleMeta}
              </span>
            )}
          </div>
          <div style={{ fontSize: "var(--fs-12)", color: "var(--fg-1)", lineHeight: 1.4 }}>
            {bubble}
          </div>
          {status === "wait" && (onApprove || onDeny) && (
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button
                type="button"
                onClick={onDeny}
                style={{
                  background: "var(--bg-3)",
                  color: "var(--fg-0)",
                  border: "1px solid var(--bd)",
                  borderRadius: 999,
                  padding: "5px 10px",
                  fontSize: "var(--fs-11)",
                  cursor: "pointer",
                }}
              >
                Deny
              </button>
              <button
                type="button"
                onClick={onApprove}
                style={{
                  background: "var(--live)",
                  color: "#0a0a0a",
                  border: "none",
                  borderRadius: 999,
                  padding: "5px 12px",
                  fontSize: "var(--fs-11)",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Approve ↵
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
