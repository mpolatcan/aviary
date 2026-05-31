import type { CSSProperties, MouseEventHandler, ReactNode } from "react";
import { Button } from "../../ui/button";
import { Tip } from "./Tip";

export interface IconBtnProps {
  children: ReactNode;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  title?: string;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  // Square edge length in px (default 26). Use this instead of style width/height
  // — e.g. <IconBtn size={22}> for the compact 22px controls in tabs/footers.
  size?: number;
  style?: CSSProperties;
  // Foreground/hover overrides for use on a colored surface (e.g. a tinted pane
  // header). Default to the standard fg tokens so existing callers are unchanged.
  idleColor?: string;
  hoverColor?: string;
  hoverBg?: string;
}

// Token-driven icon button. Renders the shadcn <Button> (variant `ghostIcon`)
// so every icon control shares the one button implementation; idle/hover/active
// colors flow through CSS custom properties (no JS hover handlers), which also
// lets a tinted pane header recolor the whole control via the *Color props.
export function IconBtn({
  children,
  onClick,
  title,
  active = false,
  danger = false,
  disabled = false,
  size = 26,
  style,
  idleColor,
  hoverColor,
  hoverBg,
}: IconBtnProps) {
  // Map state → the CSS vars consumed by the `ghostIcon` variant. active pins
  // hover to the active colors so it reads "stuck on"; an explicit idleColor
  // (tinted header) wins over the danger default; unset vars fall back to the
  // neutral icon-button look defined in the variant.
  const vars: Record<string, string> = {};
  if (active) {
    vars["--ib-bg"] = "var(--bg-active)";
    vars["--ib-fg"] = "var(--fg-0)";
    vars["--ib-hover-bg"] = "var(--bg-active)";
    vars["--ib-hover-fg"] = "var(--fg-0)";
  } else {
    if (idleColor) vars["--ib-fg"] = idleColor;
    else if (danger) vars["--ib-fg"] = "var(--err)";
    if (hoverColor) vars["--ib-hover-fg"] = hoverColor;
    if (hoverBg) vars["--ib-hover-bg"] = hoverBg;
  }

  const btn = (
    <Button
      type="button"
      variant="ghostIcon"
      onClick={onClick}
      disabled={disabled}
      // Layout (size/radius) stays inline so callers can override width/height;
      // !w-auto/!h-auto restores the icon's intrinsic 14px (the base variant
      // forces svg → size-4). disabled opacity matches the old 0.4.
      className="rounded-md p-0 disabled:opacity-40 [&_svg]:!h-auto [&_svg]:!w-auto"
      style={{ width: size, height: size, ...vars, ...style } as CSSProperties}
    >
      {children}
    </Button>
  );

  return title ? <Tip text={title}>{btn}</Tip> : btn;
}
