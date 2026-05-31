import { type VariantProps, cva } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";

import { cn } from "@/app/lib/cn";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-[var(--pri)] focus-visible:ring-[2px] focus-visible:ring-[var(--pri-dim)] disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "border border-[color-mix(in_oklab,var(--pri)_40%,var(--bd))] bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "border border-[color-mix(in_oklab,var(--err)_40%,var(--bd))] bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border border-[var(--bd)] bg-transparent text-[var(--fg-1)] shadow-xs hover:bg-[var(--bg-hover)] hover:text-[var(--fg-0)]",
        secondary:
          "border border-[var(--bd)] bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "border border-[var(--bd-soft)] text-[var(--fg-1)] hover:border-[var(--bd)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg-0)]",
        link: "text-primary underline-offset-4 hover:underline",
        success:
          "border border-[color-mix(in_oklab,var(--live)_40%,var(--bd))] bg-[var(--live)] text-[var(--bg-0)] hover:bg-[oklch(0.85_0.17_145)] focus-visible:ring-[var(--live)]/30",
        // Backs the IconBtn domain primitive. Colors are driven by CSS custom
        // properties so a tinted pane header can recolor every control (idle /
        // hover / active) without JS hover handlers — IconBtn sets the vars
        // inline; the fallbacks reproduce the neutral icon-button look.
        ghostIcon:
          "border-0 bg-[var(--ib-bg,transparent)] text-[var(--ib-fg,var(--fg-2))] shadow-none hover:bg-[var(--ib-hover-bg,var(--bg-3))] hover:text-[var(--ib-hover-fg,var(--fg-0))]",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-auto gap-[5px] rounded px-[7px] py-1 text-[11px] has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
