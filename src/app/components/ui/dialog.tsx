import * as DialogPrimitive from "@radix-ui/react-dialog";
import type * as React from "react";
import { cn } from "../../lib/cn";

// shadcn-style Dialog over Radix, themed for Aviary's field-journal skin.
// Enter/exit animation is handled by the ported .modal-overlay / .modal CSS
// (panes.css) rather than the tailwindcss-animate plugin.
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return <DialogPrimitive.Overlay className={cn("modal-overlay", className)} {...props} />;
}

export function DialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn("modal-fixed focus:outline-none", className)}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}
