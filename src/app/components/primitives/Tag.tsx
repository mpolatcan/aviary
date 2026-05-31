import type { CSSProperties, ReactNode } from "react";
import { Badge } from "../../ui/badge";

export interface TagProps {
  children: ReactNode;
  color?: string;
  style?: CSSProperties;
}

// Small colored chip. Renders the shadcn <Badge> (outline) so it shares the
// badge base, then overrides to the Tag look: mono, 10.5px, 4px radius, and a
// dynamic accent (color-mixed bg/border/text) that fixed Badge variants can't
// express — pass `color` for live/err/agent accents, omit for neutral.
export function Tag({ children, color, style }: TagProps) {
  return (
    <Badge
      variant="outline"
      className="gap-1 rounded-[4px] px-1.5 py-[2px] font-mono text-[11px] tracking-[0.03em]"
      style={{
        color: color ?? "var(--fg-1)",
        background: color ? `color-mix(in oklab, ${color} 14%, transparent)` : "var(--bg-3)",
        borderColor: color ? `color-mix(in oklab, ${color} 35%, transparent)` : "var(--bd)",
        ...style,
      }}
    >
      {children}
    </Badge>
  );
}
