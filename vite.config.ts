import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  // React migration is in progress. plugin-react + tailwind power the React app
  // (app.html / src/app); both are no-ops for the legacy vanilla entry.
  plugins: [react(), tailwindcss()],
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    hmr: { port: 1421 },
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
