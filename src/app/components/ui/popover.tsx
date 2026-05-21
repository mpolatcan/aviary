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
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn("z-[1001] focus:outline-none", className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
