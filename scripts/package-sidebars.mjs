import { build } from "esbuild";
import { cp, copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = join(root, "dist", "sidebars");
const cli = join(root, "packages", "cli");
const workbuddy = join(out, "workbuddy");
const local = join(out, "inkmap-local-editor");
const codexHtml = join(root, "packages", "web", "dist-codex", "index.html");
const writeJSON = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + "\n");

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
await cp(join(cli, "dist", "web"), join(local, "web"), { recursive: true });
await copyFile(codexHtml, join(local, "codex.html"));
const localArchive = join(out, "inkmap-local-editor.zip");
await rm(localArchive, { force: true });
execFileSync("zip", ["-q", "-r", localArchive, "inkmap-local-editor"], { cwd: out });

const buddyDist = join(root, "packages", "web", "dist-workbuddy");
const files = (await readdir(buddyDist, { recursive: true, withFileTypes: true }))
  .filter(file => file.isFile())
  .map(file => join(file.parentPath.slice(buddyDist.length + 1), file.name))
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
execFileSync("zip", ["-q", "-r", archive, "."], { cwd: workbuddy });
if ((await stat(archive)).size > 20_000_000) throw new Error("WorkBuddy ZIP exceeds 20 MB.");
