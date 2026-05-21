import { useState } from "react";
import { create } from "zustand";
import { MODE_SUPPORT } from "./catalog";
import type { Cli, Mode } from "./ipc";

export interface LaunchChoice {
  cli: Cli;
  mode: Mode;
}

interface LauncherState {
  open: boolean;
  kicker: string;
  resolver: ((c: LaunchChoice | null) => void) | null;
  // Imperatively open the launcher dialog; resolves with the choice or null
  // (cancelled). Mirrors the vanilla pickSession() promise so call sites read
  // `const c = await openLauncher(...); if (c) ...`.
  openLauncher: (kicker: string) => Promise<LaunchChoice | null>;
  resolve: (c: LaunchChoice | null) => void;
}

export const useLauncher = create<LauncherState>((set, get) => ({
  open: false,
  kicker: "",
  resolver: null,
  openLauncher: (kicker) =>
    new Promise<LaunchChoice | null>((resolve) => {
      // If one is already open, cancel it first.
      get().resolver?.(null);
      set({ open: true, kicker, resolver: resolve });
    }),
  resolve: (c) => {
    get().resolver?.(c);
    set({ open: false, resolver: null });
  },
}));

// Controlled agent×mode selection shared by the dialog and the popover. Clamps
// the mode to what the chosen agent supports (e.g. antigravity → standard only).
export function useLaunchChoice(initialCli: Cli = "claude") {
  const [cli, setCliRaw] = useState<Cli>(initialCli);
  const [mode, setMode] = useState<Mode>("standard");

  const setCli = (next: Cli) => {
    setCliRaw(next);
    if (!MODE_SUPPORT[next].includes(mode)) setMode("standard");
  };

  return { cli, mode, setCli, setMode };
}
