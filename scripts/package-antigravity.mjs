import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cp, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = join(root, "dist", "sidebars");
const source = join(root, "packages", "antigravity");
const cli = join(root, "packages", "cli", "dist");
const codexHtml = join(root, "packages", "web", "dist-codex", "index.html");
const webDist = join(root, "packages", "web", "dist");
const notices = join(root, "packages", "vscode");
const manifest = JSON.parse(await readFile(join(source, "plugin.json"), "utf8"));
const bundleName = `inkmap-antigravity-${manifest.version}`;
const filename = `${bundleName}.zip`;

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
    .replace("</head>", () => `  <style>${inlinedCss}</style>\n  <script defer src="/app.js"></script>\n</head>`);

  const [, , , , , , , , , , , , , mcpBuild] = await Promise.all([
    copyFile(codexHtml, join(cli, "codex.html")),
    copyFile(codexHtml, join(plugin, "codex.html")),
    copyFile(join(source, "plugin.json"), join(plugin, "plugin.json")),
    copyFile(join(source, "mcp_config.json"), join(plugin, "mcp_config.json")),
    copyFile(join(source, "README.md"), join(plugin, "README.md")),
    copyFile(join(source, "README.md"), join(bundle, "README.md")),
    copyFile(join(source, "install.mjs"), join(bundle, "install.mjs")),
    copyFile(join(source, "sidecar.json"), join(sidecar, "sidecar.json")),
    copyFile(join(source, "src", "bridge.js"), join(sidecar, "bridge.js")),
    cp(join(source, "skills"), join(plugin, "skills"), { recursive: true }),
    copyFile(join(notices, "images", "icon.svg"), join(plugin, "assets", "logo.svg")),
    copyFile(join(notices, "LICENSE.md"), join(plugin, "LICENSE.md")),
    writeFile(join(sidecarWeb, "index.html"), cleanHtml, "utf8"),
    build({
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
    }),
    writeFile(join(sidecarWeb, "app.css"), inlinedCss, "utf8"),
    build({
      entryPoints: [join(webDist, "assets", jsEntry)],
      bundle: true,
      format: "iife",
      platform: "browser",
      target: ["es2022"],
      define: { "import.meta.url": "window.location.href" },
      logLevel: "error",
      outfile: join(sidecarWeb, "app.js"),
    }),
    build({
      entryPoints: [join(source, "src", "main.mjs")],
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      external: ["sidecar_sdk"],
      outfile: join(sidecar, "main.mjs"),
    }),
    build({
      entryPoints: [join(source, "src", "select.mjs")],
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      outfile: join(sidecar, "select.mjs"),
    }),
  ]);

  const licenses = new Set(["node_modules/@openai/mcp-extensions"]);
  for (const input of Object.keys(mcpBuild.metafile.inputs)) {
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
  const webNotices = await readFile(join(notices, "THIRD_PARTY_NOTICES.md"), "utf8");
  await writeFile(join(plugin, "THIRD_PARTY_NOTICES.md"), webNotices + "\n" + bundledLicenses.join("\n"));

  const archive = join(staging, filename);
  execFileSync("zip", ["-q", "-r", archive, bundleName, "-x", "*/.DS_Store"], { cwd: staging });

  const unpacked = join(out, "inkmap-antigravity");
  await rm(unpacked, { recursive: true, force: true });
  await rename(bundle, unpacked);
  await rename(archive, join(out, filename));
  console.log(join(out, filename));
} finally {
  await rm(staging, { recursive: true, force: true });
}
