import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  // React 19 app (index.html → src/app/main.tsx). Tailwind v4 via the Vite
  // plugin; tokens are bridged from theme.css into the @theme layer.
  plugins: [react(), tailwindcss()],
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    hmr: { port: 1421 },
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
