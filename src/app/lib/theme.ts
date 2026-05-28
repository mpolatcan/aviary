/**
 * Theme — dark/light token switch (Tier 0, client-only).
 *
 * Toggles the `.dark`/`.light` class on <html>, which flips the design tokens
 * in tokens.css. Persisted to localStorage for now; this
 * migrates to the Tier-2 config store (`get_config`/`set_config`) when that
 * lands, at which point localStorage becomes the offline fallback. No backend.
 */
import { useEffect, useState } from "react";

export type Theme = "dark" | "gray" | "light";

const KEY = "codehub.theme";

export function getStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "gray") return v;
    return "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme): void {
  const el = document.documentElement;
  el.classList.remove("dark", "gray", "light");
  el.classList.add(theme);
}

export function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // localStorage unavailable (private mode / locked-down webview) — apply
    // for this session only, silently.
  }
}

/** React hook: current theme + setter/toggle. Applies + persists on change. */
export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void; toggle: () => void } {
  const [theme, set] = useState<Theme>(getStoredTheme);

  useEffect(() => {
    applyTheme(theme);
    persistTheme(theme);
  }, [theme]);

  return {
    theme,
    setTheme: set,
    toggle: () => set((t) => (t === "dark" ? "gray" : t === "gray" ? "light" : "dark")),
  };
}
