import { useState } from "react";
import { create } from "zustand";
import { MODE_SUPPORT } from "./catalog";
import type { Cli, Mode } from "./ipc";
import type { SplitDir } from "./tree";

export interface LaunchChoice {
  cli: Cli;
  mode: Mode;
}

// Context carried while a launch popover is open. `session` present → the launch
// splits that pane; absent → it opens a new tab.
export interface LaunchCtx {
  dir: SplitDir;
  session?: string;
}

// Every launch surface (new-tab "+", ⌘T, pane split controls, rail "+") opens
// the SAME anchored popover. The store just tracks which one is open by key and
// the split context, so a keyboard shortcut can open the popover its trigger
// owns without a synthetic click. Keys:
//   "newtab"          — the tab-bar "+" popover
//   "split:<session>" — a pane head's popover
//   "rail"            — the session rail's "+" popover
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

// Controlled agent×mode selection, one instance per open popover. Clamps the
// mode to what the chosen agent supports (e.g. antigravity → standard only).
export function useLaunchChoice(initialCli: Cli = "claude") {
  const [cli, setCliRaw] = useState<Cli>(initialCli);
  const [mode, setMode] = useState<Mode>("standard");

  const setCli = (next: Cli) => {
    setCliRaw(next);
    if (!MODE_SUPPORT[next].includes(mode)) setMode("standard");
  };

  return { cli, mode, setCli, setMode };
}
