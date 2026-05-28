import { create } from "zustand";
import type { CharacterKind } from "../components/primitives/Character";

// Global overlays that float above or dock into every view: the command palette
// (⌘K), keyboard-shortcuts cheat sheet (⌘/), and hub utility panels. Kept in
// their own tiny store, like the launcher, so opening one from a keyboard
// handler or the Hub toolbar doesn't touch app state.
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
  // Workspace-level Shell panel open/closed. This is the design's docked bottom
  // utility panel, separate from agent split panes and restored by the Hub when
  // toggled from the ActionBar / shortcut.
  shell: boolean;
  // Resume drawer open/closed (⌘R, the ActionBar "Resume" button, Welcome's
  // "Browse sessions" card). A docked right-side drawer over the live hub — past
  // Claude/Codex transcripts, grouped by agent. Lives here (not a top-level view)
  // so resuming pulls a session INTO the current workspace without leaving it.
  resume: boolean;
  // Which side the Resume drawer docks on (design resume.jsx header toggle). The
  // drawer replaces the activity-rail slot on the right by default; the user can
  // flip it to the left of the hub. Session-local (a UI preference, not data).
  resumeSide: "left" | "right";
  // About dialog open/closed — app + environment identity (real data), opened
  // from the sidebar wordmark. A modal "About this app", separate from the
  // Settings › About pane which embeds the same facts in the config surface.
  about: boolean;
  // New-workspace wizard open/closed (⌘⇧N, the Welcome launcher's CTA + "Blank"
  // template). A modal over the Welcome list; creates a saved workspace + opens
  // its first agent. Lives here so a keyboard handler can open it directly.
  newWorkspace: boolean;
  // File preview panel — path of the file being previewed on the right side,
  // or null when closed. Set from the FilesBrowser listing; the panel renders
  // in HubView as a right-side sibling (independent of DiffViewer).
  filePreview: string | null;
  // Focus mode (design hub-states HubStateFocus): the active group's focused pane
  // is maximized; its siblings collapse to a "Minimized · N" side strip. Esc (or
  // the strip's "Show all") exits. Only meaningful when the group has 2+ panes;
  // session-local UI state. The store clears it on every group/workspace switch
  // (resetGridOverlays in switchWorkspace/setActiveGroup) so it can't bleed into
  // another group's grid.
  focusMode: boolean;
  // Session being dragged across the pane grid (design hub-states HubStateDragging),
  // or null when no drag is in flight. Set on a pane header dragstart so every
  // OTHER leaf renders its drop-zone overlay; cleared on dragend/drop, and
  // defensively on any group/workspace switch (resetGridOverlays) so a drag cut
  // short by a switch can't leave every pane stuck showing its overlay. Lives here
  // (not React state) so the source leaf and all target leaves coordinate without
  // prop-drilling through the split tree.
  dragSession: string | null;
  setPalette: (open: boolean) => void;
  setShortcuts: (open: boolean) => void;
  setDiff: (path: string | null) => void;
  setFiles: (open: boolean) => void;
  setShell: (open: boolean) => void;
  setResume: (open: boolean) => void;
  setResumeSide: (side: "left" | "right") => void;
  setAbout: (open: boolean) => void;
  setNewWorkspace: (open: boolean) => void;
  setFilePreview: (path: string | null) => void;
  setFocusMode: (on: boolean) => void;
  setDragSession: (session: string | null) => void;
  togglePalette: () => void;
  toggleShortcuts: () => void;
}

export const useOverlay = create<OverlayState>((set) => ({
  palette: false,
  shortcuts: false,
  diff: null,
  files: false,
  shell: false,
  resume: false,
  resumeSide: "right",
  about: false,
  newWorkspace: false,
  filePreview: null,
  focusMode: false,
  dragSession: null,
  setPalette: (palette) => set({ palette }),
  setShortcuts: (shortcuts) => set({ shortcuts }),
  // Diff + FilePreview share the right dock — opening one closes the other so
  // they can't stack alongside Files and crush the terminal grid to slivers.
  setDiff: (diff) => set(diff !== null ? { diff, filePreview: null } : { diff }),
  setFiles: (files) => set({ files }),
  setShell: (shell) => set({ shell }),
  setResume: (resume) => set({ resume }),
  setResumeSide: (resumeSide) => set({ resumeSide }),
  setAbout: (about) => set({ about }),
  setNewWorkspace: (newWorkspace) => set({ newWorkspace }),
  setFilePreview: (filePreview) =>
    set(filePreview !== null ? { filePreview, diff: null } : { filePreview }),
  setFocusMode: (focusMode) => set({ focusMode }),
  setDragSession: (dragSession) => set({ dragSession }),
  // Opening one overlay closes the other so they never stack.
  togglePalette: () => set((s) => ({ palette: !s.palette, shortcuts: false })),
  toggleShortcuts: () => set((s) => ({ shortcuts: !s.shortcuts, palette: false })),
}));

// ── Companion preferences (desktop-only, F-COMPANION) ───────────────────────
// Preferences for the always-on-top companion avatar(s): character style, puck
// size, and behavioral toggles. Persisted to disk via AppSettings.companion —
// the setters optimistically update the local store, then write through to the
// backend config so preferences survive across sessions.
export type CompanionSize = "S" | "M" | "L";

interface CompanionPrefsState {
  show: boolean;
  hideWhenFocused: boolean;
  clickThrough: boolean;
  snapToEdges: boolean;
  bubbleOnHover: boolean;
  character: CharacterKind;
  size: CompanionSize;
  setShow: (v: boolean) => void;
  setHideWhenFocused: (v: boolean) => void;
  setClickThrough: (v: boolean) => void;
  setSnapToEdges: (v: boolean) => void;
  setBubbleOnHover: (v: boolean) => void;
  setCharacter: (v: CharacterKind) => void;
  setSize: (v: CompanionSize) => void;
  /** Hydrate from persisted config (called once after loadConfig resolves). */
  hydrate: (c: {
    show: boolean;
    hideWhenFocused: boolean;
    clickThrough: boolean;
    snapToEdges: boolean;
    bubbleOnHover: boolean;
    character: string;
    size: string;
  }) => void;
}

/** Persist a companion pref change to the backend settings store. */
function persistCompanion(patch: Partial<CompanionPrefsState>) {
  // Lazy import to avoid circular dep (store imports overlay for resetGridOverlays).
  import("./store").then(({ useStore }) => {
    const config = useStore.getState().config;
    if (!config) return;
    const current = config.companion ?? {};
    useStore.getState().updateConfig({
      companion: { ...current, ...patch } as typeof config.companion,
    });
  });
}

export const useCompanionPrefs = create<CompanionPrefsState>((set) => ({
  show: true,
  hideWhenFocused: false,
  clickThrough: false,
  snapToEdges: false,
  bubbleOnHover: true,
  character: "glyph",
  size: "M",
  setShow: (show) => {
    set({ show });
    persistCompanion({ show });
  },
  setHideWhenFocused: (hideWhenFocused) => {
    set({ hideWhenFocused });
    persistCompanion({ hideWhenFocused });
  },
  setClickThrough: (clickThrough) => {
    set({ clickThrough });
    persistCompanion({ clickThrough });
  },
  setSnapToEdges: (snapToEdges) => {
    set({ snapToEdges });
    persistCompanion({ snapToEdges });
  },
  setBubbleOnHover: (bubbleOnHover) => {
    set({ bubbleOnHover });
    persistCompanion({ bubbleOnHover });
  },
  setCharacter: (character) => {
    set({ character });
    persistCompanion({ character });
  },
  setSize: (size) => {
    set({ size });
    persistCompanion({ size });
  },
  hydrate: (c) =>
    set({
      show: c.show,
      hideWhenFocused: c.hideWhenFocused,
      clickThrough: c.clickThrough,
      snapToEdges: c.snapToEdges,
      bubbleOnHover: c.bubbleOnHover,
      character: (c.character || "glyph") as CharacterKind,
      size: (c.size || "M") as CompanionSize,
    }),
}));
