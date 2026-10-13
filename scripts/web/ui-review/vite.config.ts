import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  root: path.resolve(import.meta.dirname, "../../.."),
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "../../../apps/desktop/src"),
      "@workos/authkit-tanstack-react-start/client": path.resolve(
        import.meta.dirname,
        "auth.ts",
      ),
    },
  },
  plugins: [react(), tailwindcss()],
  optimizeDeps: { exclude: ["@tldraw/assets"] },
  server: {
    port: 1431,
    strictPort: true,
    watch: { usePolling: true, interval: 500 },
  },
});
