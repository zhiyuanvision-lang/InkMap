import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = join(root, "dist", "sidebars");
const source = join(root, "packages", "codex");
const cli = join(root, "packages", "cli", "dist");
const codexHtml = join(root, "packages", "web", "dist-codex", "index.html");
const notices = join(root, "packages", "vscode");
const bundleName = "inkmap-codex-desktop";
const name = "inkmap-codex";
const version = "0.1.0";
const writeJSON = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n");

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
    copyFile(codexHtml, join(cli, "codex.html")),
    copyFile(codexHtml, join(plugin, "codex.html")),
    copyFile(join(notices, "images", "icon.png"), join(plugin, "assets", "icon.png")),
    copyFile(join(notices, "LICENSE.md"), join(plugin, "LICENSE.md")),
    copyFile(join(source, "README.md"), join(bundle, "README.md")),
    copyFile(join(source, "install.mjs"), join(bundle, "install.mjs")),
  ]);

  const { metafile } = await build({
    absWorkingDir: root,
    entryPoints: [join(cli, "codex.js")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: join(plugin, "server.cjs"),
    define: { "import.meta.url": "inkmapModuleUrl" },
    banner: { js: 'const inkmapModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
    footer: { js: 'module.exports.serveCodex().catch(error => { console.error(error); process.exitCode = 1; });' },
    metafile: true,
  });
  const licenses = new Set(["node_modules/@openai/mcp-extensions"]);
  for (const input of Object.keys(metafile.inputs)) {
    const path = input.replaceAll("\\", "/");
    const packageDir = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)/.exec(path)?.[1];
    if (packageDir) licenses.add(packageDir);
  }
  const bundledLicenses = await Promise.all([...licenses].sort().map(async dir => {
    const path = join(root, dir);
    const pkg = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
    const licenseFile = (await readdir(path)).find(file => /^(licen[cs]e|copying)(\.|$)/i.test(file));
    if (!licenseFile) throw new Error(`Missing bundled license for ${pkg.name}`);
    const license = (await readFile(join(path, licenseFile), "utf8")).trim();
    return `## ${pkg.name} ${pkg.version}\n\n\`\`\`text\n${license}\n\`\`\`\n`;
  }));
  const webNotices = await readFile(join(notices, "THIRD_PARTY_NOTICES.md"), "utf8");
  await writeFile(join(plugin, "THIRD_PARTY_NOTICES.md"), webNotices + "\n" + bundledLicenses.join("\n"));

  const description = "Open Markdown as an editable mind map with Inkmap.";
  const interfaceMetadata = { displayName: "Inkmap", logo: "./assets/icon.png", composerIcon: "./assets/icon.png" };
  const manifest = { name, version, description };
  const server = { command: "node", args: ["${PLUGIN_ROOT}/server.cjs"], cwd: "${PLUGIN_ROOT}" };
  await Promise.all([
    writeJSON(join(plugin, "plugin.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      ...manifest,
      extensions: { "com.openai": { requires_local_executor: true, interface: interfaceMetadata } },
    }),
    writeJSON(join(plugin, ".codex-plugin", "plugin.json"), {
      ...manifest, requires_local_executor: true, interface: interfaceMetadata, mcpServers: "./.mcp.json",
    }),
    writeJSON(join(plugin, "mcp.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { inkmap: { type: "stdio", ...server } },
    }),
    writeJSON(join(plugin, ".mcp.json"), { mcpServers: { inkmap: server } }),
    writeJSON(join(marketplace, "marketplace.json"), {
      name: "inkmap-local",
      interface: { displayName: "Inkmap Local" },
      plugins: [{
        name,
        source: { source: "local", path: "./inkmap-codex" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      }],
    }),
  ]);

  const filename = `${bundleName}.zip`;
  const archive = join(staging, filename);
  execFileSync("zip", ["-q", "-r", archive, bundleName], { cwd: staging });

  // Keep the unpacked marketplace used by local development and the sidebar tests.
  await rm(join(out, name), { recursive: true, force: true });
  await rename(plugin, join(out, name));
  await cp(join(bundle, ".agents"), join(out, ".agents"), { recursive: true });
  await rename(archive, join(out, filename));
  console.log(join(out, filename));
} finally {
  await rm(staging, { recursive: true, force: true });
}
