import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webRoot, "..");

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(repoRoot, "shared"),
    },
  },
  server: {
    host: true,
    port: 5183,
    strictPort: true,
    fs: {
      allow: [repoRoot],
    },
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: path.resolve(repoRoot, "dist", "web"),
    emptyOutDir: true,
  },
});
