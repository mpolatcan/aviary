import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../ui/tooltip";

/**
 * One-prop styled tooltip. Replaces native `title=` attributes with
 * Radix Tooltip for consistent rendering across Chrome and WKWebView.
 *
 * Usage: `<Tip text="Settings"><IconBtn>…</IconBtn></Tip>`
 */
export function Tip({
  text,
  children,
  side = "bottom",
  delay = 400,
  className,
}: {
  text: string;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  delay?: number;
  className?: string;
}) {
  if (!text) return <>{children}</>;
  return (
    <TooltipProvider delayDuration={delay}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} sideOffset={6} className={className}>
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
