import { build } from "esbuild";
import { cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const web = new URL("../web/dist/", root);
if (!existsSync(web)) throw new Error("packages/web/dist is missing; run `npm run build -w @inkmap/web` first");

rmSync(new URL("dist/", root), { recursive: true, force: true });
await build({
  // fileURLToPath, not URL#pathname: pathname keeps %20 escapes and yields /C:/... on Windows.
  entryPoints: [fileURLToPath(new URL("src/extension.ts", root))],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  define: { "process.env.INKMAP_DEFAULT_BILLING_ORIGIN": JSON.stringify(process.env.INKMAP_BILLING_ORIGIN ?? "") },
  outfile: fileURLToPath(new URL("dist/extension.js", root)),
  sourcemap: true,
});
cpSync(web, new URL("dist/web/", root), { recursive: true });
