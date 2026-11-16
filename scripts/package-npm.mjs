import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const outRoot = join(root, "dist", "npm");
const pkgDir = join(outRoot, "inkmap-mcp");
const cliDist = join(root, "packages", "cli", "dist");
const codexHtml = join(root, "packages", "web", "dist-codex", "index.html");
const webDist = join(root, "packages", "web", "dist");
const agySource = join(root, "packages", "antigravity");
const vscodeDir = join(root, "packages", "vscode");

const cliPkg = JSON.parse(await readFile(join(root, "packages", "cli", "package.json"), "utf8"));
const version = cliPkg.version;

const writeJSON = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");

async function inlineCssFonts(cssText, assetsDir) {
  const woff2Re = /url\(\.\/(KaTeX_[^)]+\.woff2)\)\s*format\("woff2"\)(?:,url\(\.\/KaTeX_[^)]+\.woff\)\s*format\("woff"\))?(?:,url\(\.\/KaTeX_[^)]+\.ttf\)\s*format\("truetype"\))?/g;
  const matches = [...cssText.matchAll(woff2Re)];
  let outCss = cssText;
  for (const m of matches) {
    try {
      const buf = await readFile(join(assetsDir, m[1]));
      const dataUrl = `data:font/woff2;base64,${buf.toString("base64")}`;
      outCss = outCss.replace(m[0], `url("${dataUrl}") format("woff2")`);
    } catch {}
  }
  return outCss;
}

await rm(outRoot, { recursive: true, force: true });
await Promise.all([
  mkdir(join(pkgDir, "bin"), { recursive: true }),
  mkdir(join(pkgDir, "dist", "web"), { recursive: true }),
  mkdir(join(pkgDir, "dist", "bundles", "antigravity", "assets"), { recursive: true }),
  mkdir(join(pkgDir, "dist", "bundles", "antigravity", "sidecars", "inkmap"), { recursive: true }),
  mkdir(join(pkgDir, "dist", "bundles", "codex", ".agents", "plugins"), { recursive: true }),
  mkdir(join(pkgDir, "dist", "bundles", "codex", "inkmap-codex", ".codex-plugin"), { recursive: true }),
  mkdir(join(pkgDir, "dist", "bundles", "codex", "inkmap-codex", "assets"), { recursive: true }),
  mkdir(join(pkgDir, "dist", "bundles", "vscode", "dist"), { recursive: true }),
  mkdir(join(pkgDir, "dist", "bundles", "vscode", "images"), { recursive: true }),
]);

const assetFiles = await readdir(join(webDist, "assets"));
const jsEntry = assetFiles.find(f => /^index-.*\.js$/.test(f));
const cssEntry = assetFiles.find(f => /^index-.*\.css$/.test(f));
if (!jsEntry || !cssEntry) {
  throw new Error("Missing built web assets in packages/web/dist/assets");
}

const rawCss = await readFile(join(webDist, "assets", cssEntry), "utf8");
const inlinedCss = await inlineCssFonts(rawCss, join(webDist, "assets"));
const rawHtml = await readFile(join(webDist, "index.html"), "utf8");
const cleanHtml = rawHtml
  .replace(/<script\b[^>]*src="\.\/assets\/index-[^"]+\.js"[^>]*><\/script>\s*/g, "")
  .replace(/<link\b[^>]*href="\.\/assets\/index-[^"]+\.css"[^>]*>\s*/g, "")
  .replace("</head>", () => `  <style>${inlinedCss}</style>\n  <script defer src="./app.js"></script>\n</head>`);

const agyBundle = join(pkgDir, "dist", "bundles", "antigravity");
const agySidecar = join(agyBundle, "sidecars", "inkmap");
const codexBundle = join(pkgDir, "dist", "bundles", "codex");
const codexPlugin = join(codexBundle, "inkmap-codex");
const vscodeBundle = join(pkgDir, "dist", "bundles", "vscode");
const vscodeRawPkg = JSON.parse(await readFile(join(vscodeDir, "package.json"), "utf8"));
const { private: _omitPrivate, scripts: _omitScripts, dependencies: _omitDeps, devDependencies: _omitDevDeps, ...vscodeCleanPkg } = vscodeRawPkg;

const [cliBuild] = await Promise.all([
  build({
    absWorkingDir: root,
    entryPoints: [join(cliDist, "index.js")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: join(pkgDir, "dist", "cli.cjs"),
    define: { "import.meta.url": "inkmapModuleUrl" },
    banner: { js: 'const inkmapModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
    metafile: true,
  }),
  build({
    entryPoints: [join(webDist, "assets", jsEntry)],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    define: { "import.meta.url": "window.location.href" },
    logLevel: "error",
    outfile: join(pkgDir, "dist", "web", "app.js"),
  }),
  build({
    entryPoints: [join(agySource, "src", "main.mjs")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    external: ["sidecar_sdk"],
    outfile: join(agySidecar, "main.mjs"),
  }),
  build({
    entryPoints: [join(agySource, "src", "select.mjs")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outfile: join(agySidecar, "select.mjs"),
  }),
  build({
    absWorkingDir: root,
    entryPoints: [join(vscodeDir, "src", "extension.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    external: ["vscode"],
    define: { "process.env.INKMAP_DEFAULT_BILLING_ORIGIN": JSON.stringify(process.env.INKMAP_BILLING_ORIGIN ?? "") },
    outfile: join(vscodeBundle, "dist", "extension.js"),
  }),
  writeJSON(join(vscodeBundle, "package.json"), { ...vscodeCleanPkg, version }),
  copyFile(join(vscodeDir, "package.nls.json"), join(vscodeBundle, "package.nls.json")),
  copyFile(join(vscodeDir, "package.nls.zh-cn.json"), join(vscodeBundle, "package.nls.zh-cn.json")),
  copyFile(join(vscodeDir, "images", "icon.png"), join(vscodeBundle, "images", "icon.png")),
  writeFile(join(pkgDir, "dist", "web", "index.html"), cleanHtml, "utf8"),
  writeFile(join(pkgDir, "dist", "web", "app.css"), inlinedCss, "utf8"),
  copyFile(codexHtml, join(cliDist, "codex.html")),
  copyFile(codexHtml, join(pkgDir, "dist", "codex.html")),
  copyFile(join(agySource, "plugin.json"), join(agyBundle, "plugin.json")),
  copyFile(join(agySource, "mcp_config.json"), join(agyBundle, "mcp_config.json")),
  copyFile(join(agySource, "sidecar.json"), join(agySidecar, "sidecar.json")),
  copyFile(join(agySource, "src", "bridge.js"), join(agySidecar, "bridge.js")),
  cp(join(agySource, "skills"), join(agyBundle, "skills"), { recursive: true }),
  copyFile(join(vscodeDir, "images", "icon.svg"), join(agyBundle, "assets", "logo.svg")),
  copyFile(join(vscodeDir, "images", "icon.png"), join(codexPlugin, "assets", "icon.png")),
  copyFile(join(vscodeDir, "LICENSE.md"), join(pkgDir, "LICENSE.md")),
  copyFile(join(root, "packages", "cli", "NPM_README.md"), join(pkgDir, "README.md")),
]);

const binScript = `#!/usr/bin/env node
"use strict";
require("../dist/cli.cjs").main(process.argv.slice(2)).catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
`;
const binPath = join(pkgDir, "bin", "inkmap.cjs");
await writeFile(binPath, binScript, "utf8");
await chmod(binPath, 0o755);

// Codex bundle manifests
const codexDescription = "Open Markdown as an editable mind map with Inkmap.";
const codexInterface = { displayName: "Inkmap", logo: "./assets/icon.png", composerIcon: "./assets/icon.png" };
const codexManifest = { name: "inkmap-codex", version, description: codexDescription };
const codexServer = { command: "node", args: ["${PLUGIN_ROOT}/server.cjs"], cwd: "${PLUGIN_ROOT}" };
await Promise.all([
  writeJSON(join(codexPlugin, "plugin.json"), {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    ...codexManifest,
    extensions: { "com.openai": { requires_local_executor: true, interface: codexInterface } },
  }),
  writeJSON(join(codexPlugin, ".codex-plugin", "plugin.json"), {
    ...codexManifest,
    requires_local_executor: true,
    interface: codexInterface,
    mcpServers: "./.mcp.json",
  }),
  writeJSON(join(codexPlugin, "mcp.json"), {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { inkmap: { type: "stdio", ...codexServer } },
  }),
  writeJSON(join(codexPlugin, ".mcp.json"), { mcpServers: { inkmap: codexServer } }),
  writeJSON(join(codexBundle, ".agents", "plugins", "marketplace.json"), {
    name: "inkmap-local",
    interface: { displayName: "Inkmap Local" },
    plugins: [{
      name: "inkmap-codex",
      source: { source: "local", path: "./inkmap-codex" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    }],
  }),
]);

// Third-party license notices
const licenses = new Set(["node_modules/@openai/mcp-extensions"]);
for (const input of Object.keys(cliBuild.metafile.inputs)) {
  const p = input.replaceAll("\\", "/");
  const packageDir = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)/.exec(p)?.[1];
  if (packageDir) licenses.add(packageDir);
}
const bundledLicenses = await Promise.all([...licenses].sort().map(async dir => {
  const p = join(root, dir);
  const pkg = JSON.parse(await readFile(join(p, "package.json"), "utf8"));
  const licenseFile = (await readdir(p)).find(file => /^(licen[cs]e|copying)(\.|$)/i.test(file));
  if (!licenseFile) throw new Error(`Missing bundled license for ${pkg.name}`);
  const license = (await readFile(join(p, licenseFile), "utf8")).trim();
  return `## ${pkg.name} ${pkg.version}\n\n\`\`\`text\n${license}\n\`\`\`\n`;
}));
const webNotices = await readFile(join(vscodeDir, "THIRD_PARTY_NOTICES.md"), "utf8");
await writeFile(join(pkgDir, "THIRD_PARTY_NOTICES.md"), webNotices + "\n" + bundledLicenses.join("\n"), "utf8");

// Official MCP Registry manifest + zero-dependency package.json
const mcpName = "io.github.zhiyuanvision-lang/inkmap-markdown-mindmap-markmap";
await Promise.all([
  writeJSON(join(pkgDir, "server.json"), {
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: mcpName,
    title: "Inkmap Mind Map",
    description: "Interactive two-way Markdown mind map editor & MCP App for local .md and .markmap.md files.",
    version,
    websiteUrl: "https://www.zhiyuanv.com/software.html",
    repository: {
      url: "https://github.com/zhiyuanvision-lang/InkMap",
      source: "github",
    },
    packages: [
      {
        registryType: "npm",
        identifier: "inkmap-mcp",
        version,
        transport: { type: "stdio" },
        packageArguments: [{ type: "positional", value: "mcp" }],
      },
    ],
  }),
  writeJSON(join(pkgDir, "package.json"), {
    name: "inkmap-mcp",
    version,
    description: "Interactive Markdown mind map editor & MCP App for Claude, Codex, Antigravity, Cursor, VS Code, and local browsers.",
    mcpName,
    license: "SEE LICENSE IN LICENSE.md",
    homepage: "https://www.zhiyuanv.com/software.html",
    repository: {
      type: "git",
      url: "git+https://github.com/zhiyuanvision-lang/InkMap.git",
    },
    author: "Zhiyuan Vision <contact@zhiyuanv.com>",
    bin: {
      "inkmap-mcp": "bin/inkmap.cjs",
      inkmap: "bin/inkmap.cjs",
    },
    main: "./dist/cli.cjs",
    files: [
      "bin",
      "dist",
      "LICENSE.md",
      "THIRD_PARTY_NOTICES.md",
      "README.md",
      "server.json",
    ],
    engines: {
      node: ">=20",
    },
    keywords: [
      "mcp",
      "mcp-server",
      "mcp-app",
      "markdown",
      "mindmap",
      "mind-map",
      "mind map",
      "markmap",
      "mermaid",
      "flowchart",
      "diagram",
      "outline",
      "xmind",
      "claude",
      "codex",
      "cursor",
      "vscode",
      "antigravity",
      "思维导图",
      "脑图",
      "大纲",
      "流程图",
    ],
  }),
]);

const packedName = execFileSync("npm", ["pack", "--pack-destination", outRoot], {
  cwd: pkgDir,
  encoding: "utf8",
}).trim().split("\n").pop();
console.log(join(outRoot, packedName));
