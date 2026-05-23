import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme, getStoredTheme } from "./lib/theme";
import "./theme.css";
import "./tokens.css";
import "./panes.css";

const PrimitivesGallery = lazy(() => import("./dev/PrimitivesGallery"));
const DevPreview = lazy(() => import("./dev/DevPreview"));
// Content of the always-on-top companion window (P5). NOT dev-gated — the Tauri
// `open_companion` command loads index.html#/companion as a real second window.
const Companion = lazy(() => import("./screens/Companion").then((m) => ({ default: m.Companion })));

// Apply the persisted dark/light theme before first paint (no flash).
applyTheme(getStoredTheme());

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

const hash = window.location.hash;
const isCompanion = hash === "#/companion";
const isPrimitivesGallery = import.meta.env.DEV && hash === "#/__primitives";
const isScreenPreview = import.meta.env.DEV && hash.startsWith("#/__screens");

let view = <App />;
if (isCompanion) {
  view = (
    <Suspense fallback={null}>
      <Companion />
    </Suspense>
  );
} else if (isPrimitivesGallery) {
  view = (
    <Suspense fallback={null}>
      <PrimitivesGallery />
    </Suspense>
  );
} else if (isScreenPreview) {
  view = (
    <Suspense fallback={null}>
      <DevPreview />
    </Suspense>
  );
}

createRoot(root).render(<StrictMode>{view}</StrictMode>);
