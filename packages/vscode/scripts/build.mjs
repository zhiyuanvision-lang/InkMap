import { build } from "esbuild";
import { cpSync, existsSync, rmSync } from "node:fs";

const root = new URL("../", import.meta.url);
const web = new URL("../web/dist/", root);
if (!existsSync(web)) throw new Error("packages/web/dist is missing; run `npm run build -w @inkmap/web` first");

rmSync(new URL("dist/", root), { recursive: true, force: true });
await build({
  entryPoints: [new URL("src/extension.ts", root).pathname],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  outfile: new URL("dist/extension.js", root).pathname,
  sourcemap: true,
});
cpSync(web, new URL("dist/web/", root), { recursive: true });
