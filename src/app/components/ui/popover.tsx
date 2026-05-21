import * as PopoverPrimitive from "@radix-ui/react-popover";
import type * as React from "react";
import { cn } from "../../lib/cn";

// shadcn-style Popover over Radix.
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export function PopoverContent({
  className,
  align = "start",
  sideOffset = 6,
  onFocusOutside,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn("z-[1001] focus:outline-none", className)}
        // A launch popover can float over a focused xterm pane. xterm reclaims
        // DOM focus into its helper textarea right after a click inside the
        // popover (e.g. picking an agent), which would trip Radix's non-modal
        // focus-outside dismiss and close the popover mid-selection. Suppress
        // the focus-driven dismiss; pointer-down-outside and Escape still close.
        onFocusOutside={(e) => {
          e.preventDefault();
          onFocusOutside?.(e);
        }}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
