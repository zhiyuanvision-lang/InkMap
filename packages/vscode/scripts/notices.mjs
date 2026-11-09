// Writes THIRD_PARTY_NOTICES.md for every npm package bundled into the extension or the web editor.
// The package list comes from the source maps, so it matches what actually ships.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const here = fileURLToPath(new URL("..", import.meta.url));
const webRoot = resolve(here, "../web");

function bundledPackages(mapFile) {
  const map = JSON.parse(readFileSync(mapFile, "utf8"));
  const names = new Set();
  for (const source of map.sources) {
    const path = source.replaceAll("\\", "/");
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path.slice(path.lastIndexOf("node_modules/")));
    if (m) names.add(m[1]);
  }
  return names;
}

const outDir = join(tmpdir(), `inkmap-notices-${process.pid}`);
await build({ root: webRoot, logLevel: "warn", build: { outDir, emptyOutDir: true, sourcemap: true } });
const names = new Set();
for (const file of readdirSync(join(outDir, "assets"))) if (file.endsWith(".js.map")) bundledPackages(join(outDir, "assets", file)).forEach(n => names.add(n));
rmSync(outDir, { recursive: true, force: true });
const extensionMap = join(here, "dist/extension.js.map");
if (!existsSync(extensionMap)) throw new Error("dist/extension.js.map is missing; run `npm run build` first");
bundledPackages(extensionMap).forEach(n => names.add(n));

function packageDir(name) {
  for (let dir = webRoot; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) throw new Error(`cannot find ${name}`);
  }
}

const sections = [...names].sort().map(name => {
  const dir = packageDir(name);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const licenseFile = readdirSync(dir).find(f => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  // Packages published without a license file use a copy taken from their source repository.
  const fallback = join(here, "scripts/licenses", `${name.replace("/", "__")}.txt`);
  if (!licenseFile && !existsSync(fallback)) throw new Error(`${name} ships no license file; add ${fallback}`);
  const text = readFileSync(licenseFile ? join(dir, licenseFile) : fallback, "utf8").trim();
  const home = pkg.homepage ?? (typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url) ?? "";
  return `## ${name} ${pkg.version}\n\nLicense: ${pkg.license ?? "see below"}${home ? `  \nSource: ${home}` : ""}\n\n\`\`\`\n${text}\n\`\`\`\n`;
});

writeFileSync(
  join(here, "THIRD_PARTY_NOTICES.md"),
  `# Third-party notices\n\nInkmap includes the following open-source packages. Each is used under its own license, reproduced below.\n\n${sections.join("\n")}`,
);
console.log([...names].sort().join("\n"));
