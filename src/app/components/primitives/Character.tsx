/**
 * Character — the companion "mascot" inside the avatar puck. Six built-in styles
 * (glyph / sprite / face / orb / ascii / robot), each rendering four expressions
 * (idle · thinking · awaiting · done) that map to the live agent state. Faithful
 * port of `design/project/screens/companion.jsx`'s character system; the colors
 * come straight from the design tokens (`--live`/`--wait`/`--a-*`) so the puck
 * reskins with the theme.
 *
 * This is presentation only — the *which* expression to show is decided upstream
 * from the real working/idle/awaiting signal; Character never invents state.
 */
import type { CSSProperties } from "react";
import { AgentGlyph } from "./AgentGlyph";

/** The six built-in character art styles. */
export type CharacterKind = "glyph" | "sprite" | "face" | "orb" | "ascii" | "robot";

/** The four expressions every style can render, one per live agent state. */
export type CharacterExpression = "idle" | "thinking" | "awaiting" | "done";

export interface CharacterProps {
  /** Art style. Defaults to the geometric agent mark ("glyph"). */
  kind?: CharacterKind;
  /** Expression to render — driven by the live agent state. */
  expression?: CharacterExpression;
  /** Agent identity (only used by the "glyph" style, for its mark + accent). */
  agent?: string;
  size?: number;
  style?: CSSProperties;
}

// Map an agent id to its accent token; unknown agents fall back to neutral.
function accentFor(agent: string): string {
  switch (agent) {
    case "claude":
      return "var(--a-claude)";
    case "codex":
      return "var(--a-codex)";
    case "antigravity":
      return "var(--a-antigravity)";
    case "shell":
      return "var(--a-shell)";
    default:
      return "var(--fg-2)";
  }
}

export function Character({
  kind = "glyph",
  expression = "idle",
  agent = "claude",
  size = 44,
  style,
}: CharacterProps) {
  // Ring color per expression (matches the design's Character()).
  const ring =
    expression === "awaiting"
      ? "var(--wait)"
      : expression === "done"
        ? "var(--live)"
        : expression === "thinking"
          ? "var(--live)"
          : "var(--bd-strong)";

  const glow =
    expression === "awaiting"
      ? "0 0 18px var(--wait)"
      : expression === "done"
        ? "0 0 14px var(--live)"
        : "none";

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "var(--bg-0)",
        border: `2px solid ${ring}`,
        boxShadow: `0 6px 16px rgba(0,0,0,.5), ${glow}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        overflow: "hidden",
        flexShrink: 0,
        ...style,
      }}
    >
      {kind === "glyph" && <GlyphFace agent={agent} />}
      {kind === "sprite" && <SpriteFace expression={expression} />}
      {kind === "face" && <SimpleFace expression={expression} />}
      {kind === "orb" && <OrbFace expression={expression} />}
      {kind === "ascii" && <AsciiFace expression={expression} />}
      {kind === "robot" && <RobotFace expression={expression} />}

      {/* thinking orbital dot */}
      {expression === "thinking" && (
        <span
          style={{
            position: "absolute",
            top: -1,
            left: "50%",
            width: 4,
            height: 4,
            borderRadius: "50%",
            background: "var(--live)",
            transform: "translateX(-50%)",
          }}
        />
      )}
      {/* awaiting attention badge */}
      {expression === "awaiting" && (
        <span
          style={{
            position: "absolute",
            bottom: -3,
            right: -3,
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: "var(--wait)",
            color: "#0a0a0a",
            border: "2px solid var(--bg-0)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "var(--fs-9)",
            fontWeight: 700,
          }}
        >
          !
        </span>
      )}
    </div>
  );
}

// 1. Glyph — the agent's geometric mark, scaled up inside the puck.
function GlyphFace({ agent }: { agent: string }) {
  return (
    <div style={{ transform: "scale(1.7)" }}>
      <AgentGlyph agent={agent} size={12} color={accentFor(agent)} />
    </div>
  );
}

// 2. Sprite — 8x8 pixel-art face. 1 = on, 2 = mouth-accent. Per-expression grid.
function SpriteFace({ expression }: { expression: CharacterExpression }) {
  const patterns: Record<CharacterExpression, number[]> = {
    // biome-ignore format: 8x8 pixel grids read best as fixed rows.
    idle:     [0,0,1,1,1,1,0,0, 0,1,1,1,1,1,1,0, 1,0,1,1,1,1,0,1, 1,1,1,1,1,1,1,1, 1,0,1,1,1,1,0,1, 1,1,0,2,2,0,1,1, 0,1,1,1,1,1,1,0, 0,0,1,1,1,1,0,0],
    // biome-ignore format: 8x8 pixel grids read best as fixed rows.
    thinking: [0,0,1,1,1,1,0,0, 0,1,1,1,1,1,1,0, 1,0,1,0,0,1,0,1, 1,1,1,1,1,1,1,1, 1,0,1,0,0,1,0,1, 1,1,2,2,2,2,1,1, 0,1,1,1,1,1,1,0, 0,0,1,1,1,1,0,0],
    // biome-ignore format: 8x8 pixel grids read best as fixed rows.
    awaiting: [0,0,1,1,1,1,0,0, 0,1,1,1,1,1,1,0, 1,2,1,1,1,1,2,1, 1,1,2,2,2,2,1,1, 1,0,1,1,1,1,0,1, 1,1,0,2,2,0,1,1, 0,1,2,2,2,2,1,0, 0,0,1,1,1,1,0,0],
    // biome-ignore format: 8x8 pixel grids read best as fixed rows.
    done:     [0,0,1,1,1,1,0,0, 0,1,1,1,1,1,1,0, 1,1,1,2,2,1,1,1, 1,2,1,1,1,1,2,1, 1,0,1,1,1,1,0,1, 1,1,0,1,1,0,1,1, 0,1,1,2,2,1,1,0, 0,0,1,1,1,1,0,0],
  };
  const grid = patterns[expression];
  const px = 2.8;
  const color =
    expression === "awaiting"
      ? "var(--wait)"
      : expression === "done"
        ? "var(--live)"
        : "var(--fg-0)";
  const accent =
    expression === "awaiting" ? "var(--err)" : expression === "done" ? "#fff" : "var(--a-claude)";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(8, ${px}px)`,
        gap: 0.5,
        imageRendering: "pixelated",
      }}
    >
      {grid.map((v, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static grid, index is stable.
          key={i}
          style={{
            width: px,
            height: px,
            background: v === 1 ? color : v === 2 ? accent : "transparent",
          }}
        />
      ))}
    </div>
  );
}

// 3. Simple emoji-like face — circle implied by the puck, 2 eye dots, arc mouth.
function SimpleFace({ expression }: { expression: CharacterExpression }) {
  let mouth: React.ReactNode;
  if (expression === "idle")
    mouth = (
      <path
        d="M11 22 Q16 24 21 22"
        stroke="var(--fg-0)"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
      />
    );
  else if (expression === "thinking")
    mouth = (
      <line
        x1="12"
        y1="22"
        x2="20"
        y2="22"
        stroke="var(--fg-0)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    );
  else if (expression === "awaiting") mouth = <circle cx="16" cy="22" r="1.6" fill="var(--fg-0)" />;
  else
    mouth = (
      <path
        d="M10 21 Q16 26 22 21"
        stroke="var(--live)"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
      />
    );

  return (
    <svg width="32" height="32" viewBox="0 0 32 32" role="img" aria-label={`face ${expression}`}>
      {expression === "awaiting" && (
        <>
          <line
            x1="8"
            y1="10"
            x2="13"
            y2="8"
            stroke="var(--wait)"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <line
            x1="24"
            y1="10"
            x2="19"
            y2="8"
            stroke="var(--wait)"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </>
      )}
      <circle cx="11" cy="13" r="1.8" fill="var(--fg-0)" />
      <circle cx="21" cy="13" r="1.8" fill="var(--fg-0)" />
      {mouth}
    </svg>
  );
}

// 4. Orb — pure-energy radial sphere; pulse color encodes state.
function OrbFace({ expression }: { expression: CharacterExpression }) {
  const colorMap: Record<CharacterExpression, string> = {
    idle: "var(--idle)",
    thinking: "var(--live)",
    awaiting: "var(--wait)",
    done: "var(--live)",
  };
  const c = colorMap[expression];
  return (
    <div
      style={{
        width: 26,
        height: 26,
        borderRadius: "50%",
        background: `radial-gradient(circle at 35% 30%, color-mix(in oklab, ${c} 90%, white), ${c} 50%, color-mix(in oklab, ${c} 50%, black) 100%)`,
        boxShadow: `0 0 ${expression === "idle" ? 8 : 16}px ${c}`,
      }}
    />
  );
}

// 5. ASCII face — terminal-native text vocabulary.
function AsciiFace({ expression }: { expression: CharacterExpression }) {
  const map: Record<CharacterExpression, string> = {
    idle: "(o_o)",
    thinking: "(•_•)",
    awaiting: "(@_@)",
    done: "(^_^)",
  };
  const color =
    expression === "awaiting"
      ? "var(--wait)"
      : expression === "done"
        ? "var(--live)"
        : "var(--fg-0)";
  return (
    <span
      style={{
        fontFamily: "var(--mono)",
        fontSize: "var(--fs-11)",
        fontWeight: 600,
        color,
        letterSpacing: "0.02em",
      }}
    >
      {map[expression]}
    </span>
  );
}

// 6. Robot — angular faceplate with rectangular eyes + antenna.
function RobotFace({ expression }: { expression: CharacterExpression }) {
  const eyeColor =
    expression === "awaiting"
      ? "var(--wait)"
      : expression === "done"
        ? "var(--live)"
        : "var(--fg-0)";
  const eyeH = expression === "thinking" ? 1.5 : expression === "done" ? 2.5 : 4;
  const eyeY = expression === "thinking" ? 14 : expression === "done" ? 13 : 12;
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" role="img" aria-label={`robot ${expression}`}>
      <rect
        x="6"
        y="7"
        width="20"
        height="18"
        rx="3"
        stroke="var(--fg-2)"
        strokeWidth="1.4"
        fill="rgba(255,255,255,0.03)"
      />
      <line
        x1="16"
        y1="7"
        x2="16"
        y2="4"
        stroke="var(--fg-2)"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle
        cx="16"
        cy="3"
        r="1.2"
        fill={expression === "thinking" ? "var(--live)" : "var(--fg-2)"}
      />
      <rect x="10" y={eyeY} width="4" height={eyeH} rx="0.5" fill={eyeColor} />
      <rect x="18" y={eyeY} width="4" height={eyeH} rx="0.5" fill={eyeColor} />
      {expression === "done" ? (
        <path
          d="M11 21 Q16 24 21 21"
          stroke={eyeColor}
          strokeWidth="1.4"
          fill="none"
          strokeLinecap="round"
        />
      ) : expression === "awaiting" ? (
        <line
          x1="13"
          y1="22"
          x2="19"
          y2="22"
          stroke="var(--wait)"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      ) : (
        <line
          x1="12"
          y1="22"
          x2="20"
          y2="22"
          stroke="var(--fg-2)"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

/** The catalog of built-in styles, for pickers. */
export const CHARACTER_KINDS: { kind: CharacterKind; name: string; desc: string }[] = [
  {
    kind: "glyph",
    name: "Glyph",
    desc: "The default. Each agent's geometric mark inside a black puck.",
  },
  {
    kind: "sprite",
    name: "8-bit Sprite",
    desc: "Pixel-art face with idle bobbing, eye blinks, and mouth shapes.",
  },
  {
    kind: "face",
    name: "Face",
    desc: "Minimal emoji vocabulary — eyes + mouth arc. Expressive but neutral.",
  },
  { kind: "orb", name: "Orb", desc: "No face, pure energy. Pulse rate and color encode state." },
  {
    kind: "ascii",
    name: "ASCII",
    desc: "Monospace face e.g. (o_o) (>_<) (^_^). Terminal-native vibe.",
  },
  {
    kind: "robot",
    name: "Robot",
    desc: "Angular faceplate with rectangular eyes. Tilts toward cursor.",
  },
];

/** The four expressions in canonical order, for galleries. */
export const CHARACTER_EXPRESSIONS: CharacterExpression[] = [
  "idle",
  "thinking",
  "awaiting",
  "done",
];
