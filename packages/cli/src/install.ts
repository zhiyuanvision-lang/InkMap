import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type InstallTarget = "claude" | "claude-code" | "cursor" | "antigravity" | "codex";

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

function normalizeTarget(raw: string): InstallTarget | "all" | null {
  const key = raw.trim().toLowerCase();
  if (key === "all") return "all";
  if (key === "claude" || key === "claude-desktop" || key === "claudedesktop") return "claude";
  if (key === "claude-code" || key === "claudecode") return "claude-code";
  if (key === "cursor") return "cursor";
  if (key === "antigravity" || key === "agy") return "antigravity";
  if (key === "codex" || key === "chatgpt") return "codex";
  return null;
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

function getClaudeCodeConfigPath(): string {
  return process.env.INKMAP_CLAUDE_CODE_CONFIG || join(homedir(), ".claude.json");
}

function getAntigravityConfigDir(): string {
  return process.env.ANTIGRAVITY_CONFIG_DIR || join(homedir(), ".gemini", "config");
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
  if (existsSync(getCursorDir())) {
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

export async function runInstall(options: InstallOptions = {}): Promise<InstallResult> {
  const log = options.log ?? (msg => console.log(msg));
  const workspaces = options.workspaces ?? [];
  const explicitTargets = options.targets && options.targets.length > 0 ? options.targets : null;
  const targets: InstallTarget[] = explicitTargets ?? detectInstalledTargets();

  const result: InstallResult = { installed: [], removed: [] };

  if (options.uninstall) {
    const toRemove: InstallTarget[] = explicitTargets ?? ["claude", "claude-code", "cursor", "antigravity", "codex"];
    for (const target of toRemove) {
      if (target === "claude") {
        const cfg = join(getClaudeDesktopDir(), "claude_desktop_config.json");
        if (removeMcpJsonConfig(cfg)) result.removed.push({ target, location: cfg });
      } else if (target === "claude-code") {
        const cfg = getClaudeCodeConfigPath();
        if (removeMcpJsonConfig(cfg)) result.removed.push({ target, location: cfg });
      } else if (target === "cursor") {
        const cfg = join(getCursorDir(), "mcp.json");
        if (removeMcpJsonConfig(cfg)) result.removed.push({ target, location: cfg });
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
    log("  npx -y inkmap-mcp@latest install cursor        # Cursor");
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
      result.installed.push({
        target,
        location: cfg,
        note: "在 Cursor Settings -> MCP 中可查看 inkmap 状态",
      });
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
    }
  }

  log(`[inkmap] 安装完成（Node: ${process.execPath}）：`);
  for (const item of result.installed) {
    log(`  ✓ ${item.target.padEnd(12)} -> ${item.location}`);
    if (item.note) log(`    ${item.note}`);
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
  cursor         Cursor (~/.cursor/mcp.json)
  antigravity    Google Antigravity (~/.gemini/config/plugins/inkmap)
  codex          OpenAI Codex Desktop

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
      throw new Error(`未知客户端目标: ${arg}（支持: claude, claude-code, cursor, antigravity, codex, all）`);
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
