import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// Swaps the web app's real Better Auth client (src/lib/auth.ts) for the stub in auth.ts.
const authFixture = {
  name: "ui-review-auth-fixture",
  enforce: "pre" as const,
  resolveId(source: string, importer?: string) {
    if (/\/lib\/auth$|^\.\.\/lib\/auth$/.test(source) && importer?.includes("apps/web/src"))
      return path.resolve(import.meta.dirname, "auth.ts");
  },
};
export default defineConfig({
  root: path.resolve(import.meta.dirname, "../../.."),
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "../../../apps/desktop/src"),
    },
  },
  plugins: [authFixture, react(), tailwindcss()],
  optimizeDeps: { exclude: ["@tldraw/assets"] },
  server: {
    port: 1431,
    strictPort: true,
    watch: { usePolling: true, interval: 500 },
  },
});
