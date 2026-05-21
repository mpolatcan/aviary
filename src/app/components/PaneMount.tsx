import { useLayoutEffect, useRef } from "react";
import * as registry from "../lib/panes";

// Moves a pre-created pane's xterm DOM node into this slot, and parks it back in
// the offscreen stash on unmount. The Terminal is never disposed here — only
// closeSession (store) tears a pane down. This is what lets buffers survive
// splits and tab switches.
export function PaneMount({ session }: { session: string }) {
  const slotRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    registry.mountPane(session, slot);
    // Re-fit whenever the slot resizes — covers the initial 0→real transition on
    // mount and every window/divider resize after. (The vanilla app used a single
    // window-resize handler; a per-pane observer is more robust.) The observer
    // fires once on observe() with the live size, so no separate initial fit.
    const ro = new ResizeObserver(() => registry.fit(session));
    ro.observe(slot);
    return () => {
      ro.disconnect();
      registry.parkPane(session);
    };
  }, [session]);

  // Fill the relatively-positioned .pane-body. The slot MUST NOT rely on flexbox
  // here: .pane-body is `position:relative; flex:1` but not `display:flex`, so a
  // `flex-1` slot would collapse to 0 height and the absolutely-positioned
  // term-surface inside it would render blank.
  return <div ref={slotRef} className="absolute inset-0" />;
}
