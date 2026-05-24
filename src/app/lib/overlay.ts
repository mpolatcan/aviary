import { create } from "zustand";
import type { CharacterKind } from "../components/primitives/Character";

// Global overlays that float above every view: the command palette (⌘K), the
// keyboard-shortcuts cheat sheet (⌘/), and the diff viewer. Kept in their own
// tiny store, like the launcher, so opening one from a keyboard handler or the
// Hub toolbar doesn't touch app state.
interface OverlayState {
  palette: boolean;
  shortcuts: boolean;
  // Path whose diff is open in the DiffViewer: a /workspace path, the empty
  // string "" for the combined "all changes" view, or null when closed. Lives
  // here (not in ActivityRail's local state) so both the Hub toolbar's Diff
  // button and the rail's file rows drive the same viewer.
  diff: string | null;
  // Files browser open/closed. Like `diff`, lives here so the Hub toolbar's
  // Files button (and later a shortcut) drive the one viewer.
  files: boolean;
  // Broadcast composer open/closed — send one prompt to many running sessions.
  broadcast: boolean;
  // About dialog open/closed — app + environment identity (real data), opened
  // from the sidebar wordmark. A modal "About this app", separate from the
  // Settings › About pane which embeds the same facts in the config surface.
  about: boolean;
  setPalette: (open: boolean) => void;
  setShortcuts: (open: boolean) => void;
  setDiff: (path: string | null) => void;
  setFiles: (open: boolean) => void;
  setBroadcast: (open: boolean) => void;
  setAbout: (open: boolean) => void;
  togglePalette: () => void;
  toggleShortcuts: () => void;
}

export const useOverlay = create<OverlayState>((set) => ({
  palette: false,
  shortcuts: false,
  diff: null,
  files: false,
  broadcast: false,
  about: false,
  setPalette: (palette) => set({ palette }),
  setShortcuts: (shortcuts) => set({ shortcuts }),
  setDiff: (diff) => set({ diff }),
  setFiles: (files) => set({ files }),
  setBroadcast: (broadcast) => set({ broadcast }),
  setAbout: (about) => set({ about }),
  // Opening one overlay closes the other so they never stack.
  togglePalette: () => set((s) => ({ palette: !s.palette, shortcuts: false })),
  toggleShortcuts: () => set((s) => ({ shortcuts: !s.shortcuts, palette: false })),
}));

// ── Companion preferences (desktop-only, F-COMPANION) ───────────────────────
// Live preferences for the always-on-top companion avatar(s): which character
// style to use, the puck size, and behavioral toggles. These shape *only the
// companion presentation* — no fabricated data flows through them.
//
// NOTE: these are session-local (not persisted). There is no backend command to
// store companion prefs, and the honesty contract forbids inventing one; a
// future BE track can add a `companion_prefs` config slice and wire it here. The
// preferences panel is honestly labelled "desktop only" per the design.
export type CompanionSize = "S" | "M" | "L";

interface CompanionPrefsState {
  /** Master show/hide for the companion window. */
  show: boolean;
  /** Auto-hide the companion while the main CodeHub window is focused. */
  hideWhenFocused: boolean;
  /** Let the mouse pass through to apps underneath when there are no events. */
  clickThrough: boolean;
  /** Snap the dragged companion to screen edges. */
  snapToEdges: boolean;
  /** Reveal the context bubble on hover. */
  bubbleOnHover: boolean;
  /** Default character art style (per-agent override is a future addition). */
  character: CharacterKind;
  /** Puck size preset. */
  size: CompanionSize;
  setShow: (v: boolean) => void;
  setHideWhenFocused: (v: boolean) => void;
  setClickThrough: (v: boolean) => void;
  setSnapToEdges: (v: boolean) => void;
  setBubbleOnHover: (v: boolean) => void;
  setCharacter: (v: CharacterKind) => void;
  setSize: (v: CompanionSize) => void;
}

export const useCompanionPrefs = create<CompanionPrefsState>((set) => ({
  show: true,
  hideWhenFocused: false,
  clickThrough: true,
  snapToEdges: true,
  bubbleOnHover: true,
  character: "glyph",
  size: "M",
  setShow: (show) => set({ show }),
  setHideWhenFocused: (hideWhenFocused) => set({ hideWhenFocused }),
  setClickThrough: (clickThrough) => set({ clickThrough }),
  setSnapToEdges: (snapToEdges) => set({ snapToEdges }),
  setBubbleOnHover: (bubbleOnHover) => set({ bubbleOnHover }),
  setCharacter: (character) => set({ character }),
  setSize: (size) => set({ size }),
}));
