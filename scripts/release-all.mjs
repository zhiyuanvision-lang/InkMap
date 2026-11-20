#!/usr/bin/env node
/**
 * One-command omni-channel release script:
 *   npm run release -- <patch|minor|major|x.y.z> [--skip-stores]
 *
 * Automatically updates & publishes across ALL clients and search entrypoints:
 *   1. Bumps version uniformly across core, web, cli, vscode, antigravity, qoder, and claude-plugin
 *   2. Runs `npm run sync:all` (rebuilds all 3 host architectures, regenerates Claude/Cursor/Codex/MCP manifests,
 *      verifies parity, runs unit + webview + sidebar E2E tests, and hot-updates local clients)
 *   3. Validates Claude plugin directory manifest (`claude plugin validate` if installed)
 *   4. Commits, creates `v{version}` + `inkmap--v{version}` tags, pushes to GitHub `main`, and creates GitHub Release
 *      (automatically updating Claude Directory, Cursor Plugins Directory, Codex GitHub Marketplace, & Antigravity)
 *   5. Publishes to Open VSX (Cursor / Trae / Windsurf / VSCodium Extensions)
 *   6. Publishes to Microsoft VS Code Marketplace
 *   7. Publishes `inkmap-mcp` AND `dsh-inkmap` to npm
 *   8. Publishes to Official MCP Registry (`mcp-publisher publish` -> GitHub Copilot / PulseMCP / Smithery)
 *   9. Updates `dsh-index.json` locally and deploys to `tengxun:/var/www/zhiyuanv/dsh-index.json`
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROOT as root, runNpm, writeJSON } from "./lib/bundle-utils.mjs";

const args = process.argv.slice(2);
const bumpArg = args.find(a => !a.startsWith("--"));
const skipStores = args.includes("--skip-stores");

if (!bumpArg) {
  console.error("Usage: npm run release -- <patch|minor|major|x.y.z> [--skip-stores]");
  process.exit(1);
}

function nextVersion(current, spec) {
  if (/^\d+\.\d+\.\d+$/.test(spec)) return spec;
  const [maj, min, pat] = current.split(".").map(Number);
  if (spec === "patch") return `${maj}.${min}.${pat + 1}`;
  if (spec === "minor") return `${maj}.${min + 1}.0`;
  if (spec === "major") return `${maj + 1}.0.0`;
  throw new Error(`Invalid version bump "${spec}" (expected patch, minor, major, or x.y.z)`);
}

const cliPkgPath = join(root, "packages", "cli", "package.json");
const currentVersion = JSON.parse(await readFile(cliPkgPath, "utf8")).version;
const version = nextVersion(currentVersion, bumpArg);
console.log(`\n🚀 Releasing Inkmap v${version} (was v${currentVersion})...\n`);

// 1. Bump version across all source packages & plugin wrappers
const versionedJsonFiles = [
  "packages/core/package.json",
  "packages/web/package.json",
  "packages/cli/package.json",
  "packages/vscode/package.json",
  "packages/antigravity/plugin.json",
  "packages/qoder/.qoder-plugin/plugin.json",
  "packages/claude-plugin/.claude-plugin/plugin.json",
];
for (const rel of versionedJsonFiles) {
  const full = join(root, rel);
  if (!existsSync(full)) continue;
  const data = JSON.parse(await readFile(full, "utf8"));
  data.version = version;
  await writeJSON(full, data);
}

// 2. Full build, manifest generation, parity check, tests, and local hot-sync
runNpm(["run", "sync:all"], { cwd: root, stdio: "inherit" });

// 3. Validate Claude plugin manifest if local Claude Code CLI exists
try {
  const ccdDir = join(homedir(), ".claude", "remote", "ccd-cli");
  const claudeBin = existsSync("/usr/local/bin/claude") ? "/usr/local/bin/claude" : null;
  if (claudeBin) {
    execFileSync(claudeBin, ["plugin", "validate", root], { stdio: "inherit" });
  } else if (existsSync(ccdDir)) {
    const bins = execFileSync("ls", ["-1t", ccdDir], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    if (bins[0]) execFileSync(join(ccdDir, bins[0]), ["plugin", "validate", root], { stdio: "inherit" });
  }
} catch (err) {
  console.warn("[release] Warning: claude plugin validate check returned non-zero:", err.message);
}

if (skipStores) {
  console.log(`\n✅ Local release prep complete for v${version} (--skip-stores set).`);
  process.exit(0);
}

// 4. Publish npm (`inkmap-mcp` + `dsh-inkmap`) FIRST so npm starts scanning before GitHub tag triggers CI
console.log("\n📦 Publishing inkmap-mcp & dsh-inkmap to npm...");
runNpm(["publish", "--access", "public"], { cwd: join(root, "dist", "npm", "inkmap-mcp"), stdio: "inherit" });
runNpm(["publish", "--access", "public"], { cwd: join(root, "dist", "sidebars", "dsh-inkmap"), stdio: "inherit" });

// 5. Commit, tag (`vX.Y.Z` + Claude directory `inkmap--vX.Y.Z`), push & create GitHub Release
//    (Pushing `vX.Y.Z` triggers `.github/workflows/publish-mcp-registry.yml`, which waits in cloud for npm scan & publishes via GitHub OIDC)
execFileSync("git", ["add", "-A"], { cwd: root, stdio: "inherit" });
try {
  execFileSync("git", ["commit", "-m", `chore(release): v${version}`], { cwd: root, stdio: "inherit" });
} catch {
  console.log("[release] Working tree already committed.");
}
for (const tag of [`v${version}`, `inkmap--v${version}`]) {
  execFileSync("git", ["tag", "-f", tag, "-m", `Inkmap v${version}`], { cwd: root, stdio: "inherit" });
}
execFileSync("git", ["push", "origin", "main", "--force-with-lease"], { cwd: root, stdio: "inherit" });
execFileSync("git", ["push", "origin", `v${version}`, `inkmap--v${version}`, "--force"], { cwd: root, stdio: "inherit" });

const releaseAssets = [
  join(root, "packages", "vscode", "dist", "inkmap.vsix"),
  join(root, "dist", "npm", `inkmap-mcp-${version}.tgz`),
  join(root, "dist", "sidebars", `dsh-inkmap-${version}.tgz`),
  join(root, "dist", "sidebars", "inkmap-codex-desktop.zip"),
  join(root, "dist", "sidebars", "inkmap-local-editor.zip"),
  join(root, "dist", "sidebars", `inkmap-antigravity-${version}.zip`),
  join(root, "dist", "sidebars", `inkmap-qoder-${version}.zip`),
  join(root, "dist", "sidebars", "inkmap-workbuddy.zip"),
].filter(p => existsSync(p));

try {
  execFileSync("gh", ["release", "view", `v${version}`], { cwd: root, stdio: "ignore" });
  execFileSync("gh", ["release", "upload", `v${version}`, ...releaseAssets, "--clobber"], { cwd: root, stdio: "inherit" });
} catch {
  execFileSync(
    "gh",
    ["release", "create", `v${version}`, ...releaseAssets, "--title", `Inkmap v${version}`, "--generate-notes"],
    { cwd: root, stdio: "inherit" },
  );
}

// 6. Open VSX (Cursor / Trae / Windsurf / VSCodium)
console.log("\n📦 Publishing to Open VSX...");
execFileSync(process.execPath, [join(root, "packages", "vscode", "scripts", "publish-openvsx.mjs")], { cwd: root, stdio: "inherit" });

// 7. Microsoft VS Code Marketplace
console.log("\n📦 Publishing to VS Code Marketplace...");
execFileSync(process.execPath, [join(root, "packages", "vscode", "scripts", "publish-vscode.mjs")], { cwd: root, stdio: "inherit" });

// 9. Update website dsh-index.json & deploy to tengxun server
const localDshIndex = "/Users/lhy/Workspace/ZhiyuanV/website/dsh-index.json";
if (existsSync(localDshIndex)) {
  try {
    const idx = JSON.parse(await readFile(localDshIndex, "utf8"));
    const svgIcon = await readFile(join(root, "packages", "vscode", "images", "icon.svg"), "utf8");
    const svgDataUri = `data:image/svg+xml;base64,${Buffer.from(svgIcon).toString("base64")}`;
    const list = Array.isArray(idx) ? idx : idx.plugins || idx.packages || [];
    const nowSec = Math.floor(Date.now() / 1000);
    if (idx.metadata) idx.metadata.updateTimestamp = nowSec;
    for (const item of list) {
      if (item.name === "dsh-inkmap" || item.package === "dsh-inkmap") {
        item.version = version;
        if (item.icon) item.icon = svgDataUri;
        if (Array.isArray(item.versions) && !item.versions.some(v => v.version === version)) {
          item.versions.unshift({
            version,
            publishTimestamp: nowSec,
            source: { type: "npm" },
            engines: { dsh: ">=0.2.0-0 <1.0.0" },
          });
        }
      }
    }
    if (idx.objects && Array.isArray(idx.objects)) {
      for (const obj of idx.objects) {
        if (obj.package?.name === "dsh-inkmap") {
          obj.package.version = version;
          if (obj.package.icon) obj.package.icon = svgDataUri;
        }
      }
    }
    await writeFile(localDshIndex, JSON.stringify(idx, null, 2) + "\n", "utf8");
    execFileSync("scp", [localDshIndex, "tengxun:/var/www/zhiyuanv/dsh-index.json"], { stdio: "inherit" });
    console.log("📦 Synced dsh-index.json to https://zhiyuanv.com/dsh-index.json");
  } catch (err) {
    console.warn("[release] Could not auto-sync dsh-index.json to tengxun:", err.message);
  }
}

console.log(`\n🎉 Inkmap v${version} is LIVE across GitHub, VS Code, Open VSX, npm, MCP Registry, Claude, Cursor & Codex!`);
