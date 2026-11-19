// Helpers shared by the scripts/package-*.mjs bundlers, so every platform package is built the same way.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFile, cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const WEB_DIST = join(ROOT, "packages", "web", "dist");
export const CODEX_HTML = join(ROOT, "packages", "web", "dist-codex", "index.html");
export const CLI_DIST = join(ROOT, "packages", "cli", "dist");
/** LICENSE.md, THIRD_PARTY_NOTICES.md and the icons live in the VS Code package. */
export const VSCODE_DIR = join(ROOT, "packages", "vscode");

export const writeJSON = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");

/** The product version every package ships with. */
export async function productVersion() {
  return JSON.parse(await readFile(join(ROOT, "packages", "cli", "package.json"), "utf8")).version;
}

const notFinderMetadata = path => basename(path) !== ".DS_Store";

/** Recursive copy that leaves out macOS Finder metadata. */
export function copyTree(from, to) {
  return cp(from, to, { recursive: true, filter: notFinderMetadata });
}

/** Zips `entry` (relative to `cwd`) into `archive`, leaving out Finder metadata at any depth. */
export function zipDirectory(cwd, archive, entry) {
  try {
    execFileSync("zip", ["-q", "-r", archive, entry, "-x", ".DS_Store", "*/.DS_Store"], { cwd });
  } catch (err) {
    if (err?.code === "ENOENT") throw new Error("Packaging needs the `zip` command on PATH (preinstalled on macOS; `apt install zip` on Linux).");
    throw err;
  }
}

/**
 * Runs npm through the same npm CLI that started this script when possible, which avoids the Windows
 * restriction on spawning `npm.cmd` without a shell.
 */
export function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (npmCli && /\.c?js$/.test(npmCli)) return execFileSync(process.execPath, [npmCli, ...args], options);
  return execFileSync("npm", args, { ...options, shell: process.platform === "win32" });
}

/** Deletes older builds of a versioned artifact (e.g. `dsh-inkmap-0.3.9.tgz`) so tests never pick up a stale one. */
export async function removeStaleArtifacts(dir, pattern, keep) {
  for (const name of await readdir(dir)) {
    if (pattern.test(name) && name !== keep) await rm(join(dir, name), { force: true });
  }
}

/** Refreshes `packages/cli/dist/codex.html`, which `codex.js` serves when it runs straight from the repository. */
export function syncCliCodexHtml() {
  return copyFile(CODEX_HTML, join(CLI_DIST, "codex.html"));
}

/** Inlines the KaTeX woff2 fonts the stylesheet references, so the CSS works without its asset folder. */
export async function inlineCssFonts(cssText, assetsDir) {
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

/**
 * The built web editor as one HTML page whose stylesheet (fonts included) is inline and whose script is loaded
 * from `appSrc`. Returns that HTML and the Vite entry chunk to bundle into `appSrc` with {@link buildWebApp}.
 */
export async function singleFileWebEditor(appSrc) {
  const assetsDir = join(WEB_DIST, "assets");
  const assetFiles = await readdir(assetsDir);
  const jsEntry = assetFiles.find(f => /^index-.*\.js$/.test(f));
  const cssEntry = assetFiles.find(f => /^index-.*\.css$/.test(f));
  if (!jsEntry || !cssEntry) {
    throw new Error("Missing built web assets in packages/web/dist/assets");
  }
  const inlinedCss = await inlineCssFonts(await readFile(join(assetsDir, cssEntry), "utf8"), assetsDir);
  const rawHtml = await readFile(join(WEB_DIST, "index.html"), "utf8");
  const html = rawHtml
    .replace(/<script\b[^>]*src="\.\/assets\/index-[^"]+\.js"[^>]*><\/script>\s*/g, "")
    .replace(/<link\b[^>]*href="\.\/assets\/index-[^"]+\.css"[^>]*>\s*/g, "")
    .replace("</head>", () => `  <style>${inlinedCss}</style>\n  <script defer src="${appSrc}"></script>\n</head>`);
  return { html, jsEntry: join(assetsDir, jsEntry) };
}

/** Bundles the web editor's entry chunk and its lazy chunks into one classic script. */
export function buildWebApp(entry, outfile) {
  return build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    define: { "import.meta.url": "window.location.href" },
    logLevel: "error",
    outfile,
  });
}

/** Bundles the MCP server (`packages/cli/dist/codex.js`) into one CommonJS file that starts serving on load. */
export function buildMcpServer(outfile, target) {
  return build({
    absWorkingDir: ROOT,
    entryPoints: [join(CLI_DIST, "codex.js")],
    bundle: true,
    platform: "node",
    target,
    format: "cjs",
    outfile,
    define: { "import.meta.url": "inkmapModuleUrl" },
    banner: { js: 'const inkmapModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
    footer: { js: 'module.exports.serveCodex().catch(error => { console.error(error); process.exitCode = 1; });' },
    metafile: true,
  });
}

/** The web editor's notices followed by the license of every npm package bundled into a Node build. */
export async function thirdPartyNotices(metafile) {
  const licenses = new Set(["node_modules/@openai/mcp-extensions"]);
  for (const input of Object.keys(metafile.inputs)) {
    const p = input.replaceAll("\\", "/");
    const packageDir = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)/.exec(p)?.[1];
    if (packageDir) licenses.add(packageDir);
  }
  const bundledLicenses = await Promise.all([...licenses].sort().map(async dir => {
    const p = join(ROOT, dir);
    const pkg = JSON.parse(await readFile(join(p, "package.json"), "utf8"));
    const licenseFile = (await readdir(p)).find(file => /^(licen[cs]e|copying)(\.|$)/i.test(file));
    if (!licenseFile) throw new Error(`Missing bundled license for ${pkg.name}`);
    const license = (await readFile(join(p, licenseFile), "utf8")).trim();
    return `## ${pkg.name} ${pkg.version}\n\n\`\`\`text\n${license}\n\`\`\`\n`;
  }));
  const webNotices = await readFile(join(VSCODE_DIR, "THIRD_PARTY_NOTICES.md"), "utf8");
  return webNotices + "\n" + bundledLicenses.join("\n");
}

const CODEX_PLUGIN = "inkmap-codex";

/**
 * Writes the Codex plugin manifests into `pluginDir` and a local marketplace listing it into `marketplaceDir`
 * (`<bundle>/.agents/plugins`). The plugin folder must sit at `<bundle>/inkmap-codex`.
 */
export async function writeCodexPluginManifests(pluginDir, marketplaceDir, version) {
  const interfaceMetadata = { displayName: "Inkmap — Mind Map & Mermaid 思维导图", logo: "./assets/icon.png", composerIcon: "./assets/icon.png" };
  const manifest = {
    name: CODEX_PLUGIN,
    version,
    description: "Interactive two-way Markdown mind map (markmap), Mermaid flowchart & XMind outline editor | 双向编辑 Markdown 思维导图、脑图、流程图与大纲",
    homepage: "https://zhiyuanv.com/software.html",
    repository: "https://github.com/zhiyuanvision-lang/InkMap",
    author: { name: "Zhiyuan Vision", email: "contact@zhiyuanv.com" },
    keywords: [
      "inkmap", "markdown", "mindmap", "mind-map", "mind map", "markmap", "mermaid",
      "flowchart", "diagram", "outline", "xmind", "katex", "思维导图", "脑图", "流程图", "大纲", "架构图",
    ],
  };
  const server = { command: "node", args: ["${PLUGIN_ROOT}/server.cjs"], cwd: "${PLUGIN_ROOT}" };
  await Promise.all([
    writeJSON(join(pluginDir, "plugin.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      ...manifest,
      extensions: { "com.openai": { requires_local_executor: true, interface: interfaceMetadata } },
    }),
    writeJSON(join(pluginDir, ".codex-plugin", "plugin.json"), {
      ...manifest,
      requires_local_executor: true,
      interface: interfaceMetadata,
      mcpServers: "./.mcp.json",
    }),
    writeJSON(join(pluginDir, "mcp.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { inkmap: { type: "stdio", ...server } },
    }),
    writeJSON(join(pluginDir, ".mcp.json"), { mcpServers: { inkmap: server } }),
    writeJSON(join(marketplaceDir, "marketplace.json"), {
      name: "inkmap-local",
      interface: { displayName: "Inkmap Local" },
      plugins: [{
        name: CODEX_PLUGIN,
        source: { source: "local", path: `./${CODEX_PLUGIN}` },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      }],
    }),
  ]);
}
