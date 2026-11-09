import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths let the same build run from the CLI server and from an editor webview.
  base: "./",
  resolve: {
    alias: { "@inkmap/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)) },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  server: { proxy: { "/api": "http://127.0.0.1:4377", "/doc-assets": "http://127.0.0.1:4377" } },
});
