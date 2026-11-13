import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cp, copyFile, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
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
    cp(join(source, ".qoder-plugin"), join(plugin, ".qoder-plugin"), { recursive: true }),
    cp(join(source, "skills"), join(plugin, "skills"), { recursive: true }),
    copyFile(join(root, "packages", "vscode", "LICENSE.md"), join(plugin, "LICENSE.md")),
    copyFile(join(root, "packages", "vscode", "THIRD_PARTY_NOTICES.md"), join(plugin, "THIRD_PARTY_NOTICES.md")),
  ]);
  await Promise.all([
    cp(join(root, "packages", "web", "dist"), join(runtime, "web"), { recursive: true }),
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
  execFileSync("zip", ["-q", "-r", archive, ".", "-x", "*/.DS_Store"], { cwd: plugin });
  await rename(archive, join(out, filename));
  console.log(join(out, filename));
} finally {
  await rm(staging, { recursive: true, force: true });
}
