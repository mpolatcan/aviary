"use client";

import { type VariantProps, cva } from "class-variance-authority";
import { Toggle as TogglePrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/app/lib/cn";

const toggleVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-[color,background] outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--fg-0)] focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-[var(--pri-dim)] disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-[var(--bg-3)] data-[state=on]:text-[var(--fg-0)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent text-[var(--fg-2)]",
        outline:
          "border border-[var(--bd)] bg-transparent text-[var(--fg-2)] shadow-xs hover:bg-[var(--bg-hover)]",
      },
      size: {
        default: "h-9 px-3 min-w-9",
        sm: "h-8 px-2 min-w-8",
        lg: "h-10 px-3 min-w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Toggle({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
