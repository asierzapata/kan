import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

export default defineConfig({
  envDir: path.resolve(import.meta.dirname, "../.."),
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "../desktop/src") },
  },
  optimizeDeps: { exclude: ["@tldraw/assets"] },
  server: {
    port: 1430,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:8787",
      "/sync": { target: "ws://localhost:8787", ws: true },
    },
  },
  build: { outDir: "dist" },
});
