import { create } from "zustand";
import type { Cli } from "./ipc";
import type { SplitDir } from "./tree";

// Context carried while the spawn modal is open. `session` present → the launch
// splits that pane; `groupId` present → it spawns the first pane into that
// (empty) group; absent → it opens a new tab.
export interface LaunchCtx {
  dir: SplitDir;
  // Optional preferred agent for launcher surfaces that already name one
  // (first-run cards, usage empty cards, etc.). Placement still follows the
  // normal context rules.
  preferredCli?: Cli;
  session?: string;
  // When opening a saved workspace from the Welcome launcher, carry its real
  // name/path into the first live workspace tab.
  workspaceTitle?: string;
  workspaceDir?: string;
  savedWorkspaceId?: string;
  // Target an empty pane group (design GroupGrid empty-state CTA). Carries the
  // owning workspace so the launch can resolve the group without active-tab
  // assumptions.
  groupId?: string;
  workspaceId?: string;
  // Optional Claude transcript id. Used by the Resume drawer so resumed sessions
  // still pass through the same spawn dialog/account selector as fresh sessions.
  resume?: string;
}

// Every launch surface (new-tab "+", ⌘T, pane split controls, sidebar "New
// agent") opens the SAME spawn modal (see components/SpawnModal). The store
// tracks which surface opened it by key plus the split context, so a keyboard
// shortcut can open it without a synthetic click. Keys:
//   "newtab" / "tabbar" — a new-tab spawn (no split context)
//   "split:<session>"   — a pane head's split (carries dir + session in ctx)
interface LauncherState {
  openKey: string | null;
  ctx: LaunchCtx | null;
  open: (key: string, ctx?: LaunchCtx) => void;
  close: () => void;
}

export const useLauncher = create<LauncherState>((set) => ({
  openKey: null,
  ctx: null,
  open: (openKey, ctx) => set({ openKey, ctx: ctx ?? null }),
  close: () => set({ openKey: null, ctx: null }),
}));

export const splitKey = (session: string) => `split:${session}`;
export const groupKey = (groupId: string) => `group:${groupId}`;
