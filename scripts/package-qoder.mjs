import { build } from "esbuild";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { copyTree, removeStaleArtifacts, ROOT as root, zipDirectory } from "./lib/bundle-utils.mjs";

const out = join(root, "dist", "sidebars");
const source = join(root, "packages", "qoder");
const manifest = JSON.parse(await readFile(join(source, ".qoder-plugin", "plugin.json"), "utf8"));
const filename = `inkmap-qoder-${manifest.version}.zip`;

await mkdir(out, { recursive: true });
const staging = await mkdtemp(join(out, ".qoder-"));
try {
  const plugin = join(staging, "plugin");
  const runtime = join(plugin, "skills", "inkmap", "editor");
  await mkdir(plugin);
  await Promise.all([
    copyTree(join(source, ".qoder-plugin"), join(plugin, ".qoder-plugin")),
    copyFile(join(source, ".qoder-plugin", "plugin.json"), join(plugin, "plugin.json")),
    copyTree(join(source, "skills"), join(plugin, "skills")),
    copyFile(join(root, "packages", "vscode", "LICENSE.md"), join(plugin, "LICENSE.md")),
    copyFile(join(root, "packages", "vscode", "THIRD_PARTY_NOTICES.md"), join(plugin, "THIRD_PARTY_NOTICES.md")),
  ]);
  await Promise.all([
    copyTree(join(root, "packages", "web", "dist"), join(runtime, "web")),
    build({
      entryPoints: [join(source, "editor.mjs")],
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      outfile: join(runtime, "inkmap.mjs"),
    }),
  ]);
  const archive = join(staging, filename);
  zipDirectory(plugin, archive, ".");
  await rename(archive, join(out, filename));
  await removeStaleArtifacts(out, /^inkmap-qoder-.+\.zip$/, filename);
  console.log(join(out, filename));
} finally {
  await rm(staging, { recursive: true, force: true });
}
