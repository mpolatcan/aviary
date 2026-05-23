import type { CSSProperties } from "react";

export type AgentId = "claude" | "codex" | "antigravity" | "cursor" | string;

export interface AgentGlyphProps {
  agent: AgentId;
  size?: number;
  color?: string;
  style?: CSSProperties;
}

export const AGENT_META: Record<string, { name: string; short: string; accent: string }> = {
  claude: { name: "Claude Code", short: "CC", accent: "var(--a-claude)" },
  codex: { name: "Codex", short: "CX", accent: "var(--a-codex)" },
  antigravity: { name: "Antigravity", short: "AG", accent: "var(--a-antigravity)" },
  shell: { name: "Shell", short: "SH", accent: "var(--a-shell)" },
};

export function AgentGlyph({ agent, size = 14, color, style }: AgentGlyphProps) {
  const s = size;
  const stroke = color ?? "currentColor";

  if (agent === "claude") {
    return (
      <svg
        width={s}
        height={s}
        viewBox="0 0 16 16"
        style={style}
        role="img"
        aria-label="Claude Code"
      >
        <rect
          x="2.5"
          y="2.5"
          width="11"
          height="11"
          rx="1.5"
          stroke={stroke}
          strokeWidth="1.3"
          fill="none"
        />
        <path d="M6 5.5 L10 8 L6 10.5 Z" fill={stroke} />
      </svg>
    );
  }

  if (agent === "codex") {
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" style={style} role="img" aria-label="Codex">
        <path d="M8 2 L13 8 L8 14 L3 8 Z" stroke={stroke} strokeWidth="1.3" fill="none" />
        <path d="M8 5.5 L10.5 8 L8 10.5 L5.5 8 Z" fill={stroke} />
      </svg>
    );
  }

  if (agent === "antigravity") {
    return (
      <svg
        width={s}
        height={s}
        viewBox="0 0 16 16"
        style={style}
        role="img"
        aria-label="Antigravity"
      >
        <circle
          cx="8"
          cy="9"
          r="5.5"
          stroke={stroke}
          strokeWidth="1.3"
          fill="none"
          opacity="0.55"
        />
        <path
          d="M4.5 9 L8 5 L11.5 9"
          stroke={stroke}
          strokeWidth="1.6"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="8" cy="9" r="1.1" fill={stroke} />
      </svg>
    );
  }

  if (agent === "shell") {
    // A terminal prompt: chevron + cursor underscore.
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" style={style} role="img" aria-label="Shell">
        <rect
          x="2"
          y="3"
          width="12"
          height="10"
          rx="1.5"
          stroke={stroke}
          strokeWidth="1.3"
          fill="none"
        />
        <path
          d="M4.8 6.5 L6.8 8 L4.8 9.5"
          stroke={stroke}
          strokeWidth="1.3"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <line
          x1="8"
          y1="10"
          x2="11"
          y2="10"
          stroke={stroke}
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (agent === "cursor") {
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" style={style} role="img" aria-label="Cursor">
        <path
          d="M3 3 L13 8 L8 9 L7 13 Z"
          stroke={stroke}
          strokeWidth="1.3"
          fill="none"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  // Fallback: generic circle
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" style={style} aria-hidden="true">
      <circle cx="8" cy="8" r="5" stroke={stroke} strokeWidth="1.3" fill="none" />
    </svg>
  );
}
