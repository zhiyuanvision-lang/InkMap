import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function latestSourceMtime(dir) {
  let max = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      max = Math.max(max, latestSourceMtime(full));
    } else if (entry.isFile()) {
      max = Math.max(max, statSync(full).mtimeMs);
    }
  }
  return max;
}

const cliPkg = JSON.parse(readFileSync(join(root, "packages", "cli", "package.json"), "utf8"));
const vscodePkg = JSON.parse(readFileSync(join(root, "packages", "vscode", "package.json"), "utf8"));
const expectedVersion = cliPkg.version;

// 1. Version parity across all entrypoints and packaged manifests
assert.equal(vscodePkg.version, expectedVersion, "packages/vscode/package.json version mismatch");
for (const [relPath, pattern] of [
  ["packages/cli/src/index.ts", new RegExp(`INKMAP_VERSION\\s*=\\s*"${expectedVersion}"`)],
  ["packages/cli/src/codex.ts", new RegExp(`version:\\s*"${expectedVersion}"`)],
  ["packages/cli/src/license.ts", new RegExp(`version:\\s*"${expectedVersion}"`)],
  ["packages/web/src/codex-entry.ts", new RegExp(`version:\\s*"${expectedVersion}"`)],
]) {
  const content = readFileSync(join(root, relPath), "utf8");
  assert.match(content, pattern, `Version ${expectedVersion} missing in ${relPath}`);
}

const dshPkgPath = join(root, "dist", "sidebars", "dsh-inkmap", "package.json");
const npmPkgPath = join(root, "dist", "npm", "inkmap-mcp", "package.json");
const serverJsonPath = join(root, "server.json");
const rootPluginPath = join(root, "plugin.json");
const claudePluginPath = join(root, ".claude-plugin", "plugin.json");
const cursorPluginPath = join(root, ".cursor-plugin", "plugin.json");
assert.ok(existsSync(dshPkgPath), "Missing dist/sidebars/dsh-inkmap/package.json; run npm run package:platforms");
assert.ok(existsSync(npmPkgPath), "Missing dist/npm/inkmap-mcp/package.json; run npm run package:platforms");
assert.ok(existsSync(serverJsonPath), "Missing root server.json; run npm run package:platforms");
assert.equal(JSON.parse(readFileSync(dshPkgPath, "utf8")).version, expectedVersion, "dsh-inkmap version mismatch");
assert.equal(JSON.parse(readFileSync(npmPkgPath, "utf8")).version, expectedVersion, "inkmap-mcp version mismatch");
assert.equal(JSON.parse(readFileSync(serverJsonPath, "utf8")).version, expectedVersion, "server.json version mismatch");
assert.equal(JSON.parse(readFileSync(rootPluginPath, "utf8")).version, expectedVersion, "root plugin.json version mismatch");
assert.equal(JSON.parse(readFileSync(claudePluginPath, "utf8")).version, expectedVersion, ".claude-plugin/plugin.json version mismatch");
assert.equal(JSON.parse(readFileSync(cursorPluginPath, "utf8")).version, expectedVersion, ".cursor-plugin/plugin.json version mismatch");

// 2. Asset hash parity: Web source -> VS Code Extension + DeepSeek Harness + Standalone CLI
const webIndex = readFileSync(join(root, "packages", "web", "dist", "index.html"), "utf8");
const jsHash = /assets\/(index-[^"]+\.js)/.exec(webIndex)?.[1];
const cssHash = /assets\/(index-[^"]+\.css)/.exec(webIndex)?.[1];
assert.ok(jsHash && cssHash, "Could not locate built Vite asset hashes in packages/web/dist/index.html");

for (const targetHtml of [
  "packages/vscode/dist/web/index.html",
  "dist/sidebars/dsh-inkmap/web/index.html",
]) {
  const full = join(root, targetHtml);
  assert.ok(existsSync(full), `Missing ${targetHtml}`);
  const text = readFileSync(full, "utf8");
  assert.ok(text.includes(jsHash), `${targetHtml} has stale JS bundle (expected ${jsHash})`);
  assert.ok(text.includes(cssHash), `${targetHtml} has stale CSS bundle (expected ${cssHash})`);
}

// 3. Freshness check across all 3 host architectures (Webview, HTTP/Sidebar, Single-file MCP App)
const newestSrc = Math.max(
  latestSourceMtime(join(root, "packages", "core", "src")),
  latestSourceMtime(join(root, "packages", "web", "src")),
  statSync(join(root, "packages", "web", "index.html")).mtimeMs,
);

for (const artifact of [
  "packages/vscode/dist/inkmap.vsix",
  "dist/sidebars/dsh-inkmap/web/index.html",
  "dist/sidebars/inkmap-codex-desktop.zip",
  "dist/sidebars/inkmap-qoder-0.1.0.zip",
  "dist/sidebars/inkmap-antigravity-0.2.0.zip",
  "dist/sidebars/inkmap-workbuddy.zip",
  "dist/npm/inkmap-mcp/dist/codex.html",
  "dist/npm/inkmap-mcp/dist/web/app.js",
  `dist/npm/inkmap-mcp-${expectedVersion}.tgz`,
  `dist/sidebars/dsh-inkmap-${expectedVersion}.tgz`,
]) {
  const full = join(root, artifact);
  assert.ok(existsSync(full), `Missing packaged artifact: ${artifact}`);
  assert.ok(
    statSync(full).mtimeMs + 1000 >= newestSrc,
    `Stale artifact ${artifact}: older than latest source edit in packages/core or packages/web. Run npm run package:platforms!`,
  );
}

console.log(`[verify-parity] OK — All 3 host runtimes & all packaged targets are in sync at v${expectedVersion} (${jsHash}).`);
