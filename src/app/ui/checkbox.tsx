"use client";

import { CheckIcon } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/app/lib/cn";

function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer size-4 shrink-0 rounded-[4px] border border-[var(--bd-strong)] shadow-xs transition-shadow outline-none focus-visible:border-[var(--pri)] focus-visible:ring-[2px] focus-visible:ring-[var(--pri-dim)] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-[var(--pri)] data-[state=checked]:bg-[var(--pri)] data-[state=checked]:text-[var(--bg-0)] aria-invalid:border-destructive",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current transition-none"
      >
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
