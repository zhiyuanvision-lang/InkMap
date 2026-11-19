import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const npmOut = join(root, "dist", "npm");
const cliPkg = JSON.parse(await readFile(join(root, "packages", "cli", "package.json"), "utf8"));
const tgzPath = join(npmOut, `inkmap-mcp-${cliPkg.version}.tgz`);

test("inkmap-mcp npm tarball works standalone with zero dependencies across install, mcp, and browser modes", async t => {
  assert.ok(existsSync(tgzPath), `Expected ${tgzPath} to exist; run npm run package:npm first.`);

  // Unpack into os.tmpdir() so Node cannot accidentally resolve monorepo node_modules
  const sandbox = await mkdtemp(join(tmpdir(), "inkmap-npm-isolated-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const unpackDir = join(sandbox, "unpacked");
  await mkdir(unpackDir, { recursive: true });
  execFileSync("tar", ["-xzf", tgzPath, "-C", unpackDir]);
  const pkgRoot = join(unpackDir, "package");
  const binPath = join(pkgRoot, "bin", "inkmap.cjs");

  // 1. Metadata & zero-dependency verification
  const pkg = JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf8"));
  const serverManifest = JSON.parse(await readFile(join(pkgRoot, "server.json"), "utf8"));
  assert.equal(pkg.name, "inkmap-mcp");
  assert.equal(pkg.version, cliPkg.version);
  assert.equal(pkg.dependencies, undefined, "npm package must have zero external dependencies");
  assert.equal(pkg.mcpName, serverManifest.name);
  for (const required of ["LICENSE.md", "THIRD_PARTY_NOTICES.md", "README.md", "dist/cli.cjs", "dist/codex.html", "dist/web/index.html", "dist/web/app.js"]) {
    assert.ok(existsSync(join(pkgRoot, required)), `Missing ${required} in npm tarball`);
  }

  // 2. --version check in isolated directory
  const verOut = execFileSync(process.execPath, [binPath, "--version"], { cwd: sandbox, encoding: "utf8" }).trim();
  assert.equal(verOut, cliPkg.version);

  // 3. Auto-detect `inkmap install` across simulated Ubuntu/macOS client directories
  const fakeHome = join(sandbox, "home");
  const inkmapHome = join(fakeHome, ".inkmap");
  const claudeDir = join(fakeHome, ".config", "Claude");
  const cursorDir = join(fakeHome, ".cursor");
  const claudeCodeCfg = join(fakeHome, ".claude.json");
  const agyConfigDir = join(fakeHome, ".gemini", "config");
  const workspaceDir = join(sandbox, "workspace");

  await Promise.all([
    mkdir(claudeDir, { recursive: true }),
    mkdir(cursorDir, { recursive: true }),
    mkdir(agyConfigDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
  ]);

  // Seed existing MCP servers to verify safe non-destructive merge
  await writeFile(
    join(claudeDir, "claude_desktop_config.json"),
    JSON.stringify({ mcpServers: { otherServer: { command: "echo", args: ["keep-me"] } }, theme: "dark" }, null, 2),
  );
  await writeFile(claudeCodeCfg, JSON.stringify({ mcpServers: { existingCli: { type: "stdio", command: "true" } } }, null, 2));
  const sampleMd = join(workspaceDir, "architecture.markmap.md");
  await writeFile(sampleMd, "# Inkmap NPM Test\n\n- Zero Dependencies\n- Cross Platform\n", "utf8");

  const env = {
    ...process.env,
    HOME: fakeHome,
    INKMAP_HOME: inkmapHome,
    INKMAP_CLAUDE_CONFIG_DIR: claudeDir,
    INKMAP_CURSOR_CONFIG_DIR: cursorDir,
    INKMAP_CLAUDE_CODE_CONFIG: claudeCodeCfg,
    ANTIGRAVITY_CONFIG_DIR: agyConfigDir,
    INKMAP_ISOLATED_DETECT: "1",
    INKMAP_NO_OPEN: "1",
  };

  execFileSync(process.execPath, [binPath, "install", "--workspace", workspaceDir], {
    cwd: sandbox,
    env,
    encoding: "utf8",
  });

  const claudeJson = JSON.parse(await readFile(join(claudeDir, "claude_desktop_config.json"), "utf8"));
  assert.equal(claudeJson.theme, "dark");
  assert.deepEqual(claudeJson.mcpServers.otherServer, { command: "echo", args: ["keep-me"] });
  assert.equal(claudeJson.mcpServers.inkmap.command, process.execPath);
  const stagedServer = claudeJson.mcpServers.inkmap.args[0];
  assert.ok(existsSync(stagedServer), "staged ~/.inkmap/mcp-app/server.cjs must exist");
  assert.ok(claudeJson.mcpServers.inkmap.env.INKMAP_WORKSPACES.includes("workspace"));

  const cursorJson = JSON.parse(await readFile(join(cursorDir, "mcp.json"), "utf8"));
  assert.equal(cursorJson.mcpServers.inkmap.command, process.execPath);
  const cursorExtDir = join(cursorDir, "extensions", `inkmap.inkmap-vscode-${cliPkg.version}`);
  assert.ok(existsSync(join(cursorExtDir, "dist", "extension.js")), "Cursor native right-pane extension must be installed");
  assert.ok(existsSync(join(cursorExtDir, "dist", "web", "app.js")), "Cursor extension web assets must be installed");

  const claudeCodeJson = JSON.parse(await readFile(claudeCodeCfg, "utf8"));
  assert.equal(claudeCodeJson.mcpServers.inkmap.type, "stdio");
  assert.ok(claudeCodeJson.mcpServers.existingCli);

  // Verify Antigravity dual-engine plugin installation
  const agyInstalled = join(agyConfigDir, "plugins", "inkmap");
  for (const rel of ["plugin.json", "mcp_config.json", "rules/AGENTS.md", "server.cjs", "codex.html", "sidecars/inkmap/main.mjs", "sidecars/inkmap/web/app.js"]) {
    assert.ok(existsSync(join(agyInstalled, rel)), `Antigravity plugin missing ${rel}`);
  }

  // 4. Live stdio MCP protocol test on installed ~/.inkmap/mcp-app/server.cjs AND zero-arg `npx inkmap`
  for (const [label, cmdArgs] of [
    ["staged server.cjs", [stagedServer]],
    ["zero-arg npx pipe", [binPath]],
  ]) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: cmdArgs,
      cwd: workspaceDir,
      env,
    });
    const client = new Client({ name: `test-${label}`, version: "1.0.0" });
    await client.connect(transport);
    try {
      const res = await client.readResource({ uri: "ui://inkmap/markdown.html" });
      assert.ok(res.contents[0].text.includes("<!doctype html>") || res.contents[0].text.includes("<!DOCTYPE html>"));

      const opened = await client.callTool({
        name: "inkmap_open",
        arguments: { path: sampleMd },
      });
      assert.equal(opened.structuredContent.mode, "mcp-workspace");
      assert.ok(opened.structuredContent.doc.md.includes("# Inkmap NPM Test"));
      assert.match(opened.structuredContent.editorUrl, /^http:\/\/127\.0\.0\.1:\d+\//);
      const fallbackDoc = await (await fetch(opened.structuredContent.editorUrl + "api/doc")).json();
      assert.ok(fallbackDoc.md.includes("# Inkmap NPM Test"));
    } finally {
      await client.close();
    }
  }

  // 5. Local browser / sidebar HTTP server check from unpacked tarball
  const child = spawn(process.execPath, [binPath, sampleMd, "--sidebar"], {
    cwd: sandbox,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));

  const url = await new Promise((resolveUrl, rejectUrl) => {
    let out = "";
    const timer = setTimeout(() => rejectUrl(new Error(`Timed out waiting for sidebar URL: ${out}`)), 5000);
    child.stdout.on("data", chunk => {
      out += chunk.toString("utf8");
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/s\/[a-f0-9]+\//);
      if (m) {
        clearTimeout(timer);
        resolveUrl(m[0]);
      }
    });
    child.on("exit", code => {
      clearTimeout(timer);
      rejectUrl(new Error(`Sidebar exited early with ${code}: ${out}`));
    });
  });

  const htmlResp = await fetch(url);
  assert.equal(htmlResp.status, 200);
  const htmlText = await htmlResp.text();
  assert.ok(htmlText.includes("./app.js"));
  const jsResp = await fetch(url + "app.js");
  assert.equal(jsResp.status, 200);
  const docResp = await fetch(url + "api/doc");
  assert.equal(docResp.status, 200);
  const docJson = await docResp.json();
  assert.ok(docJson.md.includes("Zero Dependencies"));
  child.kill("SIGTERM");

  // 6. Uninstall removes inkmap cleanly while keeping existing user servers
  execFileSync(process.execPath, [binPath, "uninstall"], { cwd: sandbox, env, encoding: "utf8" });
  const afterClaude = JSON.parse(await readFile(join(claudeDir, "claude_desktop_config.json"), "utf8"));
  assert.equal(afterClaude.mcpServers.inkmap, undefined);
  assert.deepEqual(afterClaude.mcpServers.otherServer, { command: "echo", args: ["keep-me"] });
  assert.equal(existsSync(agyInstalled), false);
});
