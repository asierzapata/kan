import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";
export default defineConfig(({ mode }) => {
  // Server-only local configuration. Vite exposes only VITE_* to the browser.
  const local = loadEnv(mode, import.meta.dirname, "");
  for (const name of [
    "WORKOS_API_KEY",
    "WORKOS_CLIENT_ID",
    "WORKOS_REDIRECT_URI",
    "WORKOS_COOKIE_PASSWORD",
  ]) {
    if (!process.env[name] && local[name]) process.env[name] = local[name];
  }
  return {
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
  };
});
