import { build } from "esbuild";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { CODEX_HTML as codexHtml, copyTree, ROOT as root, writeJSON, zipDirectory } from "./lib/bundle-utils.mjs";

const out = join(root, "dist", "sidebars");
const cli = join(root, "packages", "cli");
const workbuddy = join(out, "workbuddy");
const local = join(out, "inkmap-local-editor");

for (const path of [workbuddy, local]) {
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}

// The same standalone CLI serves the built-in browser in Harness, ZCode, or any desktop host.
await build({
  entryPoints: [join(cli, "bin", "inkmap.js")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: join(local, "inkmap.mjs"),
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
await copyTree(join(cli, "dist", "web"), join(local, "web"));
await copyFile(codexHtml, join(local, "codex.html"));
const localArchive = join(out, "inkmap-local-editor.zip");
await rm(localArchive, { force: true });
zipDirectory(out, localArchive, "inkmap-local-editor");

const buddyDist = join(root, "packages", "web", "dist-workbuddy");
const files = (await readdir(buddyDist, { recursive: true, withFileTypes: true }))
  // The manifest must list exactly what goes into the ZIP, which never contains Finder metadata.
  .filter(file => file.isFile() && file.name !== ".DS_Store")
  .map(file => join(file.parentPath.slice(buddyDist.length + 1), file.name).replaceAll("\\", "/"))
  .sort();
for (const file of files) {
  const target = join(workbuddy, file);
  await mkdir(join(target, ".."), { recursive: true });
  await copyFile(join(buddyDist, file), target);
}
await writeJSON(join(workbuddy, "manifest.json"), {
  pages: [{ id: "inkmap", entry: "index.html", assets: files.filter(file => file !== "index.html") }],
});

const archive = join(out, "inkmap-workbuddy.zip");
await rm(archive, { force: true });
zipDirectory(workbuddy, archive, ".");
if ((await stat(archive)).size > 20_000_000) throw new Error("WorkBuddy ZIP exceeds 20 MB.");
