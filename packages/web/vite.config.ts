import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const productVersion: string = JSON.parse(readFileSync(new URL("../cli/package.json", import.meta.url), "utf8")).version;

export default defineConfig(({ mode }) => {
  const codex = mode === "codex";
  const buddy = mode === "workbuddy";
  return {
    // Relative asset paths also work in the CLI and editor webview.
    base: "./",
    define: { __INKMAP_VERSION__: JSON.stringify(productVersion) },
    resolve: {
      alias: { "@inkmap/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)) },
    },
    plugins: [
      ...(codex || buddy ? [{
        name: "inkmap-sidebar-entry",
        transformIndexHtml: {
          order: "pre" as const,
          handler: (html: string) => html.replace("./src/entry.ts", codex ? "./src/codex-entry.ts" : "./src/buddy-entry.ts"),
        },
      }] : []),
      ...(codex ? [viteSingleFile()] : []),
    ],
    build: { outDir: codex ? "dist-codex" : buddy ? "dist-workbuddy" : "dist", emptyOutDir: true, chunkSizeWarningLimit: 6000, modulePreload: false },
    server: { proxy: { "/api": "http://127.0.0.1:4377", "/doc-assets": "http://127.0.0.1:4377" } },
  };
});
