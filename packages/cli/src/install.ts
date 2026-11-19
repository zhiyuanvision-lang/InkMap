import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { detectOsLocale } from "./license.js";

export type InstallTarget = "claude" | "claude-code" | "cursor" | "vscode" | "antigravity" | "codex" | "deepseek";

export interface InstallOptions {
  targets?: InstallTarget[];
  workspaces?: string[];
  uninstall?: boolean;
  log?: (msg: string) => void;
}

export interface InstallResult {
  installed: Array<{ target: InstallTarget; location: string; note?: string }>;
  removed: Array<{ target: InstallTarget; location: string }>;
}

const DIST_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(DIST_DIR, "..");

const SERVER_WRAPPER = `#!/usr/bin/env node
"use strict";
require("./cli.cjs").main(["mcp", ...process.argv.slice(2)]).catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
`;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildZipBuffer(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const raw = entry.data;
    const compressed = deflateRawSync(raw, { level: 6 });
    const useDeflate = compressed.length < raw.length;
    const payload = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x5970, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x5970, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    localParts.push(local, payload);
    centralParts.push(central);
    offset += local.length + payload.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

function normalizeTarget(raw: string): InstallTarget | "all" | null {
  const key = raw.trim().toLowerCase();
  if (key === "all") return "all";
  if (key === "claude" || key === "claude-desktop" || key === "claudedesktop") return "claude";
  if (key === "claude-code" || key === "claudecode") return "claude-code";
  if (key === "cursor") return "cursor";
  if (key === "vscode" || key === "code" || key === "vs-code") return "vscode";
  if (key === "antigravity" || key === "agy") return "antigravity";
  if (key === "codex" || key === "chatgpt") return "codex";
  if (key === "deepseek" || key === "deepseek-harness" || key === "dsh" || key === "harness") return "deepseek";
  return null;
}

function isChineseTerminalLocale(): boolean {
  return detectOsLocale() === "zh";
}

function getInkmapHome(): string {
  return process.env.INKMAP_HOME || join(homedir(), ".inkmap");
}

function getClaudeDesktopDir(): string {
  if (process.env.INKMAP_CLAUDE_CONFIG_DIR) return process.env.INKMAP_CLAUDE_CONFIG_DIR;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Claude");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "Claude");
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "Claude");
}

function getCursorDir(): string {
  return process.env.INKMAP_CURSOR_CONFIG_DIR || join(homedir(), ".cursor");
}

function getVscodeDir(): string {
  return process.env.INKMAP_VSCODE_CONFIG_DIR || join(homedir(), ".vscode");
}

function getClaudeCodeConfigPath(): string {
  return process.env.INKMAP_CLAUDE_CODE_CONFIG || join(homedir(), ".claude.json");
}

function getAntigravityConfigDir(): string {
  return process.env.ANTIGRAVITY_CONFIG_DIR || join(homedir(), ".gemini", "config");
}

function findCursorCommand(): string | null {
  if (process.env.INKMAP_ISOLATED_DETECT) return null;
  if (spawnSync("cursor", ["--version"], { stdio: "ignore" }).status === 0) return "cursor";
  if (process.platform === "darwin") {
    for (const dir of ["/Applications", join(homedir(), "Applications")]) {
      const cmd = join(dir, "Cursor.app/Contents/Resources/app/bin/cursor");
      if (existsSync(cmd)) return cmd;
    }
  } else if (process.platform === "win32") {
    const localApp = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    const cmd = join(localApp, "Programs", "cursor", "resources", "app", "bin", "cursor.cmd");
    if (existsSync(cmd)) return cmd;
  }
  return null;
}

function findVscodeCommand(): string | null {
  if (process.env.INKMAP_ISOLATED_DETECT) return null;
  if (spawnSync("code", ["--version"], { stdio: "ignore" }).status === 0) return "code";
  if (process.platform === "darwin") {
    for (const dir of ["/Applications", join(homedir(), "Applications")]) {
      const cmd = join(dir, "Visual Studio Code.app/Contents/Resources/app/bin/code");
      if (existsSync(cmd)) return cmd;
    }
  } else if (process.platform === "win32") {
    const localApp = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    const cmd = join(localApp, "Programs", "Microsoft VS Code", "bin", "code.cmd");
    if (existsSync(cmd)) return cmd;
  }
  return null;
}

function findCodexCommand(): string | null {
  if (process.env.INKMAP_CODEX_BIN) {
    return existsSync(process.env.INKMAP_CODEX_BIN) ? process.env.INKMAP_CODEX_BIN : null;
  }
  if (spawnSync("codex", ["--version"], { stdio: "ignore" }).status === 0) return "codex";
  if (process.platform === "darwin") {
    for (const dir of ["/Applications", join(homedir(), "Applications")]) {
      const cmd = join(dir, "ChatGPT.app/Contents/Resources/codex-cli/bin/codex");
      if (existsSync(cmd)) return cmd;
    }
  }
  return null;
}

function getDshHome(): string {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function findDshCommand(): string | null {
  if (process.env.INKMAP_DSH_BIN) {
    return existsSync(process.env.INKMAP_DSH_BIN) ? process.env.INKMAP_DSH_BIN : null;
  }
  if (process.env.INKMAP_ISOLATED_DETECT) return null;
  if (spawnSync("dsh", ["--version"], { stdio: "ignore" }).status === 0) return "dsh";
  if (process.platform === "darwin") {
    for (const dir of ["/Applications", join(homedir(), "Applications")]) {
      const cmd = join(dir, "DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh");
      if (existsSync(cmd)) return cmd;
    }
  } else if (process.platform === "win32") {
    const localApp = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    const cmd = join(localApp, "Programs", "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd");
    if (existsSync(cmd)) return cmd;
  }
  return null;
}

function detectInstalledTargets(): InstallTarget[] {
  const found: InstallTarget[] = [];
  const claudeDir = getClaudeDesktopDir();
  if (
    existsSync(claudeDir) ||
    (process.platform === "darwin" && (existsSync("/Applications/Claude.app") || existsSync(join(homedir(), "Applications", "Claude.app"))))
  ) {
    found.push("claude");
  }
  const claudeCodeCfg = getClaudeCodeConfigPath();
  if (existsSync(claudeCodeCfg) || (!process.env.INKMAP_ISOLATED_DETECT && spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0)) {
    found.push("claude-code");
  }
  if (existsSync(getCursorDir()) || Boolean(findCursorCommand())) {
    found.push("cursor");
  }
  const agyDir = getAntigravityConfigDir();
  if (existsSync(agyDir) || (!process.env.ANTIGRAVITY_CONFIG_DIR && existsSync(join(homedir(), ".gemini", "antigravity")))) {
    found.push("antigravity");
  }
  if (!process.env.INKMAP_ISOLATED_DETECT && findCodexCommand()) {
    found.push("codex");
  } else if (process.env.INKMAP_CODEX_BIN && existsSync(process.env.INKMAP_CODEX_BIN)) {
    found.push("codex");
  }
  if (
    (!process.env.INKMAP_ISOLATED_DETECT && (findDshCommand() || existsSync(join(getDshHome(), "profiles", "desktop")))) ||
    (process.env.INKMAP_DSH_BIN && existsSync(process.env.INKMAP_DSH_BIN))
  ) {
    found.push("deepseek");
  }
  return found;
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, "utf8").trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`配置文件 JSON 格式错误，为安全起见未修改 / Invalid JSON in ${filePath}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`配置文件顶层不是 JSON 对象 / Top-level JSON in ${filePath} must be an object.`);
  }
  return parsed as Record<string, unknown>;
}

function writeJsonAtomic(filePath: string, data: Record<string, unknown>) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, filePath);
}

function stageStandaloneMcpApp(): { serverScript: string; appDir: string } {
  const appDir = join(getInkmapHome(), "mcp-app");
  mkdirSync(appDir, { recursive: true });

  const bundledCli = join(DIST_DIR, "cli.cjs");
  const bundledHtml = join(DIST_DIR, "codex.html");
  const bundledWeb = join(DIST_DIR, "web");
  const monorepoAntigravity = resolve(PKG_ROOT, "..", "..", "dist", "sidebars", "inkmap-antigravity", "inkmap");

  if (existsSync(bundledCli) && existsSync(bundledHtml)) {
    cpSync(bundledCli, join(appDir, "cli.cjs"));
    cpSync(bundledHtml, join(appDir, "codex.html"));
    if (existsSync(bundledWeb)) {
      rmSync(join(appDir, "web"), { recursive: true, force: true });
      cpSync(bundledWeb, join(appDir, "web"), { recursive: true });
    }
    writeFileSync(join(appDir, "server.cjs"), SERVER_WRAPPER, { mode: 0o755 });
    for (const notice of ["LICENSE.md", "THIRD_PARTY_NOTICES.md"]) {
      const src = join(PKG_ROOT, notice);
      if (existsSync(src)) cpSync(src, join(appDir, notice));
    }
    return { serverScript: join(appDir, "server.cjs"), appDir };
  }

  if (existsSync(join(monorepoAntigravity, "server.cjs")) && existsSync(join(monorepoAntigravity, "codex.html"))) {
    cpSync(join(monorepoAntigravity, "server.cjs"), join(appDir, "server.cjs"));
    cpSync(join(monorepoAntigravity, "codex.html"), join(appDir, "codex.html"));
    const sidecarWeb = join(monorepoAntigravity, "sidecars", "inkmap", "web");
    if (existsSync(sidecarWeb)) {
      rmSync(join(appDir, "web"), { recursive: true, force: true });
      cpSync(sidecarWeb, join(appDir, "web"), { recursive: true });
    }
    for (const notice of ["LICENSE.md", "THIRD_PARTY_NOTICES.md"]) {
      const src = join(monorepoAntigravity, notice);
      if (existsSync(src)) cpSync(src, join(appDir, notice));
    }
    return { serverScript: join(appDir, "server.cjs"), appDir };
  }

  const devBin = join(PKG_ROOT, "bin", "inkmap.js");
  if (existsSync(devBin) && existsSync(bundledHtml)) {
    return { serverScript: devBin, appDir };
  }

  throw new Error("未找到已构建的 MCP App 资源（codex.html）。/ Built MCP App assets are missing.");
}

function installIdeExtension(editorDir: string, cliCmd: string | null): string | null {
  const vscodeBundle = join(DIST_DIR, "bundles", "vscode");
  const bundledWeb = join(DIST_DIR, "web");
  if (!existsSync(join(vscodeBundle, "package.json")) || !existsSync(join(vscodeBundle, "dist", "extension.js"))) {
    return null;
  }

  const extPkg = JSON.parse(readFileSync(join(vscodeBundle, "package.json"), "utf8")) as { version: string };
  const version = extPkg.version || "0.3.6";
  const staging = mkdtempSync(join(tmpdir(), "inkmap-vsix-"));

  try {
    const extStaging = join(staging, "extension");
    cpSync(vscodeBundle, extStaging, { recursive: true });
    if (existsSync(bundledWeb)) {
      cpSync(bundledWeb, join(extStaging, "dist", "web"), { recursive: true });
    }
    for (const doc of ["LICENSE.md", "THIRD_PARTY_NOTICES.md", "README.md"]) {
      const src = join(PKG_ROOT, doc);
      if (existsSync(src)) cpSync(src, join(extStaging, doc));
    }

    if (cliCmd) {
      const contentTypesXml = `<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".css" ContentType="text/css"/><Default Extension=".html" ContentType="text/html"/><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".json" ContentType="application/json"/><Default Extension=".md" ContentType="text/markdown"/><Default Extension=".png" ContentType="image/png"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>`;
      const vsixManifest = `<?xml version="1.0" encoding="utf-8"?>\n<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="inkmap-vscode" Version="${version}" Publisher="inkmap" /><DisplayName>Inkmap — Markdown Mind Map</DisplayName><Description xml:space="preserve">Edit Markdown mind maps with two-way sync.</Description><Categories>Visualization,Education,Other</Categories><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.90.0" /><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui,workspace" /><Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" /></Properties><License>extension/LICENSE.md</License><Icon>extension/images/icon.png</Icon></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" /><Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.md" Addressable="true" /><Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/images/icon.png" Addressable="true" /></Assets></PackageManifest>`;

      const entries: Array<{ name: string; data: Buffer }> = [
        { name: "[Content_Types].xml", data: Buffer.from(contentTypesXml, "utf8") },
        { name: "extension.vsixmanifest", data: Buffer.from(vsixManifest, "utf8") },
      ];
      const walk = (dir: string, prefix: string) => {
        for (const item of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, item.name);
          const rel = `${prefix}/${item.name}`;
          if (item.isDirectory()) walk(full, rel);
          else if (item.isFile()) entries.push({ name: rel, data: readFileSync(full) });
        }
      };
      walk(extStaging, "extension");

      const vsixPath = join(staging, `inkmap-${version}.vsix`);
      writeFileSync(vsixPath, buildZipBuffer(entries));
      try {
        execFileSync(cliCmd, ["--install-extension", vsixPath, "--force"], { stdio: "pipe" });
        return join(editorDir, "extensions", `inkmap.inkmap-vscode-${version}`);
      } catch {
        // Fall through to direct directory unpack if CLI IPC fails
      }
    }

    const extRoot = join(editorDir, "extensions");
    mkdirSync(extRoot, { recursive: true });
    for (const old of readdirSync(extRoot)) {
      if (old.toLowerCase().startsWith("inkmap.inkmap-vscode")) {
        rmSync(join(extRoot, old), { recursive: true, force: true });
      }
    }
    const dest = join(extRoot, `inkmap.inkmap-vscode-${version}`);
    cpSync(extStaging, dest, { recursive: true });
    return dest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function uninstallIdeExtension(editorDir: string, cliCmd: string | null): boolean {
  let removed = false;
  if (cliCmd) {
    try {
      execFileSync(cliCmd, ["--uninstall-extension", "inkmap.inkmap-vscode"], { stdio: "pipe" });
      removed = true;
    } catch {}
  }
  const extRoot = join(editorDir, "extensions");
  if (existsSync(extRoot)) {
    for (const entry of readdirSync(extRoot)) {
      if (entry.toLowerCase().startsWith("inkmap.inkmap-vscode")) {
        rmSync(join(extRoot, entry), { recursive: true, force: true });
        removed = true;
      }
    }
  }
  return removed;
}

function buildMcpEntry(
  serverScript: string,
  workspaces: string[],
  existingEntry: unknown,
  withTypeStdio = false,
): Record<string, unknown> {
  const isDirectServer = serverScript.endsWith("server.cjs");
  const args = isDirectServer ? [serverScript] : [serverScript, "mcp"];
  const prevEnv =
    existingEntry && typeof existingEntry === "object" && !Array.isArray(existingEntry) && typeof (existingEntry as Record<string, unknown>).env === "object"
      ? { ...((existingEntry as Record<string, unknown>).env as Record<string, string>) }
      : {};

  if (workspaces.length > 0) {
    prevEnv.INKMAP_WORKSPACES = workspaces.map(w => resolve(w)).join(delimiter);
  }

  const entry: Record<string, unknown> = {};
  if (withTypeStdio) entry.type = "stdio";
  entry.command = process.execPath;
  entry.args = args;
  if (Object.keys(prevEnv).length > 0) {
    entry.env = prevEnv;
  }
  return entry;
}

function upsertMcpJsonConfig(filePath: string, serverScript: string, workspaces: string[], withTypeStdio = false) {
  const root = readJsonObject(filePath);
  const servers =
    root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)
      ? { ...(root.mcpServers as Record<string, unknown>) }
      : {};
  servers.inkmap = buildMcpEntry(serverScript, workspaces, servers.inkmap, withTypeStdio);
  root.mcpServers = servers;
  writeJsonAtomic(filePath, root);
}

function removeMcpJsonConfig(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const root = readJsonObject(filePath);
  if (!root.mcpServers || typeof root.mcpServers !== "object" || Array.isArray(root.mcpServers)) return false;
  const servers = { ...(root.mcpServers as Record<string, unknown>) };
  if (!("inkmap" in servers)) return false;
  delete servers.inkmap;
  root.mcpServers = servers;
  writeJsonAtomic(filePath, root);
  return true;
}

async function refreshAntigravityMcp() {
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!lsAddr || !csrf) return;
  try {
    await fetch(`http://${lsAddr}/exa.language_server_pb.LanguageServerService/RefreshMcpServers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-codeium-csrf-token": csrf,
      },
      body: JSON.stringify({ serverName: "inkmap_inkmap" }),
    });
  } catch {}
}

async function installAntigravityPlugin(): Promise<string> {
  const pluginsDir = join(getAntigravityConfigDir(), "plugins");
  const destination = join(pluginsDir, "inkmap");
  const bundledAgy = join(DIST_DIR, "bundles", "antigravity");
  const bundledCli = join(DIST_DIR, "cli.cjs");
  const bundledHtml = join(DIST_DIR, "codex.html");
  const bundledWeb = join(DIST_DIR, "web");
  const monorepoAgy = resolve(PKG_ROOT, "..", "..", "dist", "sidebars", "inkmap-antigravity", "inkmap");

  mkdirSync(pluginsDir, { recursive: true });
  rmSync(destination, { recursive: true, force: true });

  if (existsSync(join(bundledAgy, "plugin.json")) && existsSync(bundledCli) && existsSync(bundledHtml)) {
    cpSync(bundledAgy, destination, { recursive: true });
    cpSync(bundledCli, join(destination, "cli.cjs"));
    cpSync(bundledHtml, join(destination, "codex.html"));
    writeFileSync(join(destination, "server.cjs"), SERVER_WRAPPER, { mode: 0o755 });
    if (existsSync(bundledWeb)) {
      cpSync(bundledWeb, join(destination, "sidecars", "inkmap", "web"), { recursive: true });
    }
    for (const doc of ["LICENSE.md", "THIRD_PARTY_NOTICES.md", "README.md"]) {
      const src = join(PKG_ROOT, doc);
      if (existsSync(src)) cpSync(src, join(destination, doc));
    }
  } else if (existsSync(join(monorepoAgy, "plugin.json"))) {
    cpSync(monorepoAgy, destination, { recursive: true });
  } else {
    throw new Error("未找到 Antigravity 插件资源 / Antigravity plugin bundle not found.");
  }

  await refreshAntigravityMcp();
  return destination;
}

function installCodexPlugin(): { location: string; note?: string } {
  const codex = findCodexCommand();
  if (!codex) {
    throw new Error("未检测到 codex 命令，请先安装 ChatGPT Desktop 或 Codex CLI / Codex CLI not found.");
  }
  const bundledCodex = join(DIST_DIR, "bundles", "codex");
  const bundledCli = join(DIST_DIR, "cli.cjs");
  const bundledHtml = join(DIST_DIR, "codex.html");
  const monorepoCodexRoot = resolve(PKG_ROOT, "..", "..", "dist", "sidebars");

  const destination = join(getInkmapHome(), "codex-marketplace");
  mkdirSync(destination, { recursive: true });
  const marketplaceRoot = realpathSync(destination);

  if (existsSync(join(bundledCodex, ".agents")) && existsSync(bundledCli) && existsSync(bundledHtml)) {
    cpSync(bundledCodex, marketplaceRoot, { recursive: true });
    const pluginDir = join(marketplaceRoot, "inkmap-codex");
    cpSync(bundledCli, join(pluginDir, "cli.cjs"));
    cpSync(bundledHtml, join(pluginDir, "codex.html"));
    writeFileSync(join(pluginDir, "server.cjs"), SERVER_WRAPPER, { mode: 0o755 });
    for (const doc of ["LICENSE.md", "THIRD_PARTY_NOTICES.md"]) {
      const src = join(PKG_ROOT, doc);
      if (existsSync(src)) cpSync(src, join(pluginDir, doc));
    }
  } else if (existsSync(join(monorepoCodexRoot, "inkmap-codex")) && existsSync(join(monorepoCodexRoot, ".agents"))) {
    cpSync(join(monorepoCodexRoot, ".agents"), join(marketplaceRoot, ".agents"), { recursive: true });
    cpSync(join(monorepoCodexRoot, "inkmap-codex"), join(marketplaceRoot, "inkmap-codex"), { recursive: true });
  } else {
    throw new Error("未找到 Codex 插件资源 / Codex plugin bundle not found.");
  }

  const marketplaceName = "inkmap-local";
  const rawList = execFileSync(codex, ["plugin", "marketplace", "list", "--json"], { encoding: "utf8" });
  const { marketplaces = [] } = JSON.parse(rawList) as { marketplaces?: Array<{ name: string; root: string }> };
  const existing = marketplaces.find(entry => entry.name === marketplaceName);
  if (!existing) {
    execFileSync(codex, ["plugin", "marketplace", "add", marketplaceRoot], { stdio: "pipe" });
  }
  execFileSync(codex, ["plugin", "add", `inkmap-codex@${marketplaceName}`], { stdio: "pipe" });
  return {
    location: marketplaceRoot,
    note: "重启 ChatGPT Desktop 后，在 Codex 模式点击 .md 文件打开菜单选择 Inkmap Mind Map",
  };
}

function configureDshMarketIndex(profileDir: string): void {
  const pkgPath = join(profileDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        dsh?: { profile?: { bundles?: string[] } };
      };
      const bundles = pkg.dsh?.profile?.bundles;
      if (Array.isArray(bundles)) {
        let changed = false;
        for (const name of ["@deepseek-ai/dsh-experimental-plugin-market-bundle", "dsh-inkmap"]) {
          if (!bundles.includes(name)) {
            bundles.push(name);
            changed = true;
          }
        }
        if (changed) {
          writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
        }
      }
    } catch {}
  }

  const patchPath = join(profileDir, "cordis.patch.yml");
  const indexUrl = "https://zhiyuanv.com/dsh-index.json";
  try {
    const existing = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
    if (!existing.includes(indexUrl)) {
      const snippet = `\n- id: plugin-market\n  name: "@deepseek-ai/dsh-plugin-market"\n  config:\n    indexes:\n      - ${indexUrl}\n`;
      writeFileSync(patchPath, existing.replace(/\n*$/, "") + snippet, "utf8");
    }
  } catch {}
}

function installDeepSeekHarnessPlugin(): { location: string; note?: string } {
  const bundledHarness = join(DIST_DIR, "bundles", "harness");
  const bundledWeb = join(DIST_DIR, "web");
  const monorepoHarness = resolve(PKG_ROOT, "..", "..", "dist", "sidebars", "dsh-inkmap");

  const stagedDir = join(getInkmapHome(), "dsh-inkmap");
  rmSync(stagedDir, { recursive: true, force: true });
  mkdirSync(stagedDir, { recursive: true });

  if (existsSync(join(bundledHarness, "package.json")) && existsSync(bundledWeb)) {
    cpSync(bundledHarness, stagedDir, { recursive: true });
    cpSync(bundledWeb, join(stagedDir, "web"), { recursive: true });
    for (const doc of ["LICENSE.md", "THIRD_PARTY_NOTICES.md"]) {
      const src = join(PKG_ROOT, doc);
      if (existsSync(src)) cpSync(src, join(stagedDir, doc));
    }
  } else if (existsSync(join(monorepoHarness, "package.json"))) {
    cpSync(monorepoHarness, stagedDir, { recursive: true });
  } else {
    throw new Error("未找到 DeepSeek Harness 插件资源 / DeepSeek Harness plugin bundle not found.");
  }

  const realStaged = realpathSync(stagedDir);
  const dshCmd = findDshCommand();
  const profileDir = join(getDshHome(), "profiles", "desktop");

  if (dshCmd) {
    execFileSync(dshCmd, ["plugin", "--profile", "desktop", "add", realStaged], { stdio: "pipe" });
  } else if (existsSync(profileDir)) {
    const nodeModulesTarget = join(profileDir, "node_modules", "dsh-inkmap");
    rmSync(nodeModulesTarget, { recursive: true, force: true });
    mkdirSync(join(profileDir, "node_modules"), { recursive: true });
    cpSync(realStaged, nodeModulesTarget, { recursive: true });
  } else {
    throw new Error("未检测到 DeepSeek Harness 客户端 / DeepSeek Harness not found.");
  }

  if (existsSync(profileDir)) {
    configureDshMarketIndex(profileDir);
  }

  return {
    location: existsSync(profileDir) ? profileDir : realStaged,
    note: "已在 DeepSeek Harness「插件」页启用 Inkmap 思维导图与插件索引（预览 .md 文件点击右上角 Inkmap 即可打开）",
  };
}

export async function runInstall(options: InstallOptions = {}): Promise<InstallResult> {
  const log = options.log ?? (msg => console.log(msg));
  const workspaces = options.workspaces ?? [];
  const explicitTargets = options.targets && options.targets.length > 0 ? options.targets : null;
  const targets: InstallTarget[] = explicitTargets ?? detectInstalledTargets();

  const result: InstallResult = { installed: [], removed: [] };

  if (options.uninstall) {
    const toRemove: InstallTarget[] = explicitTargets ?? ["claude", "claude-code", "cursor", "vscode", "antigravity", "codex", "deepseek"];
    for (const target of toRemove) {
      if (target === "claude") {
        const cfg = join(getClaudeDesktopDir(), "claude_desktop_config.json");
        if (removeMcpJsonConfig(cfg)) result.removed.push({ target, location: cfg });
      } else if (target === "claude-code") {
        const cfg = getClaudeCodeConfigPath();
        if (removeMcpJsonConfig(cfg)) result.removed.push({ target, location: cfg });
      } else if (target === "cursor") {
        const cfg = join(getCursorDir(), "mcp.json");
        const removedMcp = removeMcpJsonConfig(cfg);
        const removedExt = uninstallIdeExtension(getCursorDir(), findCursorCommand());
        if (removedMcp || removedExt) result.removed.push({ target, location: cfg });
      } else if (target === "vscode") {
        if (uninstallIdeExtension(getVscodeDir(), findVscodeCommand())) {
          result.removed.push({ target, location: join(getVscodeDir(), "extensions") });
        }
      } else if (target === "antigravity") {
        const dir = join(getAntigravityConfigDir(), "plugins", "inkmap");
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
          await refreshAntigravityMcp();
          result.removed.push({ target, location: dir });
        }
      } else if (target === "codex") {
        const dir = join(getInkmapHome(), "codex-marketplace");
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
          result.removed.push({ target, location: dir });
        }
      } else if (target === "deepseek") {
        const dshCmd = findDshCommand();
        const profileDir = join(getDshHome(), "profiles", "desktop");
        if (dshCmd && existsSync(profileDir)) {
          try {
            execFileSync(dshCmd, ["plugin", "--profile", "desktop", "remove", "dsh-inkmap"], { stdio: "pipe" });
          } catch {}
        }
        const dir = join(getInkmapHome(), "dsh-inkmap");
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
          result.removed.push({ target, location: profileDir });
        }
      }
    }
    if (!explicitTargets) {
      rmSync(join(getInkmapHome(), "mcp-app"), { recursive: true, force: true });
    }
    if (result.removed.length === 0) {
      log("[inkmap] 未发现已安装的 Inkmap 客户端配置 / No installed Inkmap client configs found.");
    } else {
      for (const item of result.removed) {
        log(`[inkmap] 已移除 ${item.target}: ${item.location}`);
      }
    }
    return result;
  }

  // Always stage ~/.inkmap/mcp-app so standalone MCP binary is ready on disk
  const { serverScript, appDir } = stageStandaloneMcpApp();

  if (targets.length === 0) {
    log(`[inkmap] 已将 MCP App 核心文件就绪到: ${appDir}`);
    log("[inkmap] 未在默认目录检测到已安装的 AI 客户端，可指定客户端名称强制生成配置：");
    log("  npx -y inkmap-mcp@latest install claude        # Claude Desktop (macOS / Windows / Ubuntu)");
    log("  npx -y inkmap-mcp@latest install claude-code   # Claude Code CLI");
    log("  npx -y inkmap-mcp@latest install cursor        # Cursor (MCP + 右侧原生编辑器标签)");
    log("  npx -y inkmap-mcp@latest install vscode        # VS Code (原生编辑器扩展)");
    log("  npx -y inkmap-mcp@latest install antigravity   # Google Antigravity");
    log("  npx -y inkmap-mcp@latest install codex         # OpenAI Codex Desktop");
    return result;
  }

  for (const target of targets) {
    if (target === "claude") {
      const cfg = join(getClaudeDesktopDir(), "claude_desktop_config.json");
      upsertMcpJsonConfig(cfg, serverScript, workspaces, false);
      result.installed.push({
        target,
        location: cfg,
        note: "完全退出并重启 Claude Desktop 后，对 Claude 说“用 Inkmap 打开 xxx.md”即可",
      });
    } else if (target === "claude-code") {
      const cfg = getClaudeCodeConfigPath();
      upsertMcpJsonConfig(cfg, serverScript, workspaces, true);
      result.installed.push({
        target,
        location: cfg,
        note: "在 Claude Code 中已注册全局 inkmap MCP 服务",
      });
    } else if (target === "cursor") {
      const cfg = join(getCursorDir(), "mcp.json");
      upsertMcpJsonConfig(cfg, serverScript, workspaces, false);
      const extLoc = installIdeExtension(getCursorDir(), findCursorCommand());
      const cursorServerDir = join(homedir(), ".cursor-server");
      if (existsSync(cursorServerDir)) {
        try {
          installIdeExtension(cursorServerDir, null);
        } catch {}
      }
      result.installed.push({
        target,
        location: extLoc ? `${cfg} + ${extLoc}` : cfg,
        note: "已同时安装 MCP 服务与右侧主编辑区导图扩展（Reload Window 后对话可直接打开右侧导图标签）",
      });
    } else if (target === "vscode") {
      const extLoc = installIdeExtension(getVscodeDir(), findVscodeCommand());
      if (extLoc) {
        result.installed.push({
          target,
          location: extLoc,
          note: "已在 VS Code 安装原生 Inkmap 思维导图编辑器扩展",
        });
      }
    } else if (target === "antigravity") {
      const loc = await installAntigravityPlugin();
      result.installed.push({
        target,
        location: loc,
        note: "在 Antigravity 对话中让 AI 用 Inkmap 打开 .md 文件，或点击右侧面板 + 选择 Inkmap",
      });
    } else if (target === "codex") {
      try {
        const installedCodex = installCodexPlugin();
        result.installed.push({
          target,
          location: installedCodex.location,
          note: installedCodex.note,
        });
      } catch (err) {
        if (explicitTargets) throw err;
        log(`[inkmap] 跳过 codex 自动注册: ${(err as Error).message}`);
      }
    } else if (target === "deepseek") {
      try {
        const installedDsh = installDeepSeekHarnessPlugin();
        result.installed.push({
          target,
          location: installedDsh.location,
          note: installedDsh.note,
        });
      } catch (err) {
        if (explicitTargets) throw err;
        log(`[inkmap] 跳过 deepseek 自动注册: ${(err as Error).message}`);
      }
    }
  }

  const zhLocale = isChineseTerminalLocale();
  if (zhLocale) {
    log(`[inkmap] 安装完成（Node: ${process.execPath}）：`);
    for (const item of result.installed) {
      log(`  ✓ ${item.target.padEnd(12)} -> ${item.location}`);
      if (item.note) log(`    ${item.note}`);
    }
    log("");
    log("──────────────────────────────────────────────────────────────────────");
    log("🎁 7 天免费试用与 Inkmap Pro 终身会员开通：");
    log("  • 首次使用享 7 天全功能免费试用（无需登录）");
    log("  • 开通 Pro 终身版（¥29.9 微信支付一次买断，免费包含后续全部更新）：");
    log("    👉 插件内直接开通: VS Code / Cursor / DeepSeek Harness / Qoder / 浏览器版右上角点击「立即开通 Pro（¥29.9）」");
    log("    👉 或官方网站开通: https://zhiyuanv.com/software.html?lang=zh#inkmap-pricing");
    log("  • 全平台通用：登录同一邮箱即可在 Cursor / VS Code / DeepSeek Harness / Qoder / WorkBuddy /");
    log("    Claude Desktop / Claude Code / OpenAI Codex / Google Antigravity / Trae 全端同步激活！");
    log("──────────────────────────────────────────────────────────────────────");
  } else {
    log(`[inkmap] Installation complete (Node: ${process.execPath}):`);
    for (const item of result.installed) {
      log(`  ✓ ${item.target.padEnd(12)} -> ${item.location}`);
    }
    log("");
    log("──────────────────────────────────────────────────────────────────────");
    log("🎁 7-Day Free Trial & Inkmap Pro Lifetime License:");
    log("  • Enjoy a 7-day full-featured free trial from first use (no sign-in required)");
    log("  • Upgrade to Inkmap Pro Lifetime ($15 one-time purchase, all future updates included):");
    log("    👉 In-Plugin Checkout: Click 'Buy Pro ($15)' inside VS Code / Cursor / DeepSeek Harness / Qoder / Browser");
    log("    👉 Or Official Website: https://zhiyuanv.com/software.html?lang=en#inkmap-pricing");
    log("  • Cross-Platform Sync: Sign in with the same email across Cursor, VS Code, DeepSeek Harness,");
    log("    Qoder, WorkBuddy, Claude Desktop, Claude Code, OpenAI Codex, Google Antigravity & Trae!");
    log("──────────────────────────────────────────────────────────────────────");
  }
  if (!options.uninstall && result.installed.length > 0) {
    try {
      const { fileSessionStorage, licenseService } = await import("./license.js");
      const { YUNFAN_BILLING_ORIGIN } = await import("@inkmap/core");
      const svc = licenseService(fileSessionStorage(), () => process.env.INKMAP_BILLING_ORIGIN || YUNFAN_BILLING_ORIGIN, { host: "cli" });
      svc.track?.("plugin_install", 1, "cli");
      await Promise.race([svc.flushTelemetry?.(), new Promise(r => setTimeout(r, 1500))]);
      svc.dispose();
    } catch {}
  }
  return result;
}

export async function runInstallCli(argv: string[], uninstall = false) {
  const targets: InstallTarget[] = [];
  const workspaces: string[] = [];
  let explicitAll = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log(`用法 / Usage:
  npx -y inkmap-mcp@latest install [客户端...] [--workspace <目录>]
  npx -y inkmap-mcp@latest uninstall [客户端...]

支持的客户端 / Supported targets:
  (默认省略)     自动检测本机已安装的客户端并一键配置 / Auto-detect installed clients
  claude         Claude Desktop (Ubuntu / macOS / Windows)
  claude-code    Claude Code CLI (~/.claude.json)
  cursor         Cursor (MCP + 右侧主编辑区原生导图扩展)
  vscode         VS Code (原生导图编辑器扩展)
  antigravity    Google Antigravity (~/.gemini/config/plugins/inkmap)
  codex          OpenAI Codex Desktop
  deepseek       DeepSeek Harness (~/.dsh/profiles/desktop)

选项 / Options:
  -w, --workspace <dir>   预设允许 Inkmap 访问的工作区目录（可多次传入）`);
      return;
    }
    if (arg === "-w" || arg === "--workspace") {
      const val = argv[++i];
      if (!val) throw new Error("--workspace 需要提供目录路径 / --workspace requires a directory path");
      workspaces.push(...val.split(delimiter).filter(Boolean));
      continue;
    }
    if (arg.startsWith("--workspace=")) {
      const val = arg.slice("--workspace=".length);
      workspaces.push(...val.split(delimiter).filter(Boolean));
      continue;
    }
    const normalized = normalizeTarget(arg);
    if (!normalized) {
      throw new Error(`未知客户端目标: ${arg}（支持: claude, claude-code, cursor, vscode, antigravity, codex, all）`);
    }
    if (normalized === "all") {
      explicitAll = true;
    } else if (!targets.includes(normalized)) {
      targets.push(normalized);
    }
  }

  await runInstall({
    targets: explicitAll ? undefined : targets.length > 0 ? targets : undefined,
    workspaces,
    uninstall,
  });
}
