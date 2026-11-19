import { build } from "esbuild";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildMcpServer, buildWebApp, CODEX_HTML, copyTree, removeStaleArtifacts, ROOT, singleFileWebEditor,
  syncCliCodexHtml, thirdPartyNotices, VSCODE_DIR, zipDirectory,
} from "./lib/bundle-utils.mjs";

const out = join(ROOT, "dist", "sidebars");
const source = join(ROOT, "packages", "antigravity");
const manifest = JSON.parse(await readFile(join(source, "plugin.json"), "utf8"));
const bundleName = `inkmap-antigravity-${manifest.version}`;
const filename = `${bundleName}.zip`;

await mkdir(out, { recursive: true });
const staging = await mkdtemp(join(out, ".antigravity-"));
try {
  const bundle = join(staging, bundleName);
  const plugin = join(bundle, "inkmap");
  const sidecar = join(plugin, "sidecars", "inkmap");
  const sidecarWeb = join(sidecar, "web");
  await Promise.all([
    mkdir(join(plugin, "assets"), { recursive: true }),
    mkdir(sidecarWeb, { recursive: true }),
  ]);

  const web = await singleFileWebEditor("/app.js");
  const [mcpBuild] = await Promise.all([
    buildMcpServer(join(plugin, "server.cjs"), "node22"),
    syncCliCodexHtml(),
    copyFile(CODEX_HTML, join(plugin, "codex.html")),
    copyFile(join(source, "plugin.json"), join(plugin, "plugin.json")),
    copyFile(join(source, "mcp_config.json"), join(plugin, "mcp_config.json")),
    copyFile(join(source, "README.md"), join(plugin, "README.md")),
    copyFile(join(source, "README.md"), join(bundle, "README.md")),
    copyFile(join(source, "install.mjs"), join(bundle, "install.mjs")),
    copyFile(join(source, "sidecar.json"), join(sidecar, "sidecar.json")),
    copyFile(join(source, "src", "bridge.js"), join(sidecar, "bridge.js")),
    copyTree(join(source, "skills"), join(plugin, "skills")),
    copyTree(join(source, "rules"), join(plugin, "rules")),
    copyFile(join(VSCODE_DIR, "images", "icon.svg"), join(plugin, "assets", "logo.svg")),
    copyFile(join(VSCODE_DIR, "LICENSE.md"), join(plugin, "LICENSE.md")),
    writeFile(join(sidecarWeb, "index.html"), web.html, "utf8"),
    buildWebApp(web.jsEntry, join(sidecarWeb, "app.js")),
    build({
      entryPoints: [join(source, "src", "main.mjs")],
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      external: ["sidecar_sdk"],
      outfile: join(sidecar, "main.mjs"),
    }),
  ]);
  await writeFile(join(plugin, "THIRD_PARTY_NOTICES.md"), await thirdPartyNotices(mcpBuild.metafile));

  const archive = join(staging, filename);
  zipDirectory(staging, archive, bundleName);

  const unpacked = join(out, "inkmap-antigravity");
  await rm(unpacked, { recursive: true, force: true });
  await rename(bundle, unpacked);
  await rename(archive, join(out, filename));
  await removeStaleArtifacts(out, /^inkmap-antigravity-.+\.zip$/, filename);
  console.log(join(out, filename));
} finally {
  await rm(staging, { recursive: true, force: true });
}
