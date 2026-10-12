import path from "node:path";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "../desktop/src") },
  },
  ssr: {
    noExternal: ["@workos/authkit-tanstack-react-start"],
  },
  optimizeDeps: { exclude: ["@tldraw/assets"] },
  plugins: [
    tanstackStart(),
    nitro({
      preset: "vercel",
      traceDeps: ["jsdom", "dompurify", "mermaid"],
    }),
    react(),
    tailwindcss(),
  ],
  server: { port: 1430, strictPort: true },
});
