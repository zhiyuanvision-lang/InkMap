import { copyFileSync, cpSync, existsSync, rmSync } from "node:fs";

const from = new URL("../../web/dist/", import.meta.url);
const to = new URL("../dist/web/", import.meta.url);
if (!existsSync(from)) throw new Error("packages/web/dist is missing; run `npm run build -w @inkmap/web` first");
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });

const codexHtml = new URL("../../web/dist-codex/index.html", import.meta.url);
const toCodexHtml = new URL("../dist/codex.html", import.meta.url);
if (existsSync(codexHtml)) {
  copyFileSync(codexHtml, toCodexHtml);
}
