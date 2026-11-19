import { copyFile, cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildMcpServer, CODEX_HTML, productVersion, ROOT, syncCliCodexHtml, thirdPartyNotices, VSCODE_DIR,
  writeCodexPluginManifests, zipDirectory,
} from "./lib/bundle-utils.mjs";

const out = join(ROOT, "dist", "sidebars");
const source = join(ROOT, "packages", "codex");
const bundleName = "inkmap-codex-desktop";
const name = "inkmap-codex";
const version = await productVersion();

await mkdir(out, { recursive: true });
const staging = await mkdtemp(join(out, ".codex-"));
try {
  const bundle = join(staging, bundleName);
  const plugin = join(bundle, name);
  const marketplace = join(bundle, ".agents", "plugins");
  await Promise.all([
    mkdir(marketplace, { recursive: true }),
    mkdir(join(plugin, ".codex-plugin"), { recursive: true }),
    mkdir(join(plugin, "assets"), { recursive: true }),
  ]);
  await Promise.all([
    // `npm run package:codex` compiles the CLI with plain tsc, which does not copy codex.html.
    syncCliCodexHtml(),
    copyFile(CODEX_HTML, join(plugin, "codex.html")),
    copyFile(join(VSCODE_DIR, "images", "icon.png"), join(plugin, "assets", "icon.png")),
    copyFile(join(VSCODE_DIR, "LICENSE.md"), join(plugin, "LICENSE.md")),
    copyFile(join(source, "README.md"), join(bundle, "README.md")),
    copyFile(join(source, "install.mjs"), join(bundle, "install.mjs")),
  ]);

  const { metafile } = await buildMcpServer(join(plugin, "server.cjs"), "node22");
  await writeFile(join(plugin, "THIRD_PARTY_NOTICES.md"), await thirdPartyNotices(metafile));
  await writeCodexPluginManifests(plugin, marketplace, version);

  const filename = `${bundleName}.zip`;
  const archive = join(staging, filename);
  zipDirectory(staging, archive, bundleName);

  // Keep the unpacked marketplace used by local development and the sidebar tests.
  await rm(join(out, name), { recursive: true, force: true });
  await rm(join(out, ".agents"), { recursive: true, force: true });
  await rename(plugin, join(out, name));
  await cp(join(bundle, ".agents"), join(out, ".agents"), { recursive: true });
  await rename(archive, join(out, filename));
  console.log(join(out, filename));
} finally {
  await rm(staging, { recursive: true, force: true });
}
