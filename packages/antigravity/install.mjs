import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const source = existsSync(join(root, "inkmap", "plugin.json")) ? join(root, "inkmap") : root;

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

try {
  if (Number(process.versions.node.split(".")[0]) < 22) {
    throw new Error("需要 Node.js 22 或更新版本 / Node.js 22 or later is required.");
  }
  if (!existsSync(join(source, "plugin.json"))) {
    throw new Error("未找到 Inkmap 插件文件 / Inkmap plugin manifest not found.");
  }

  const configRoot = process.env.ANTIGRAVITY_CONFIG_DIR || join(homedir(), ".gemini", "config");
  const pluginsDir = join(configRoot, "plugins");
  const destination = join(pluginsDir, "inkmap");

  mkdirSync(pluginsDir, { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
  await refreshAntigravityMcp();

  console.log(`已安装 Inkmap MCP App 插件到 ${destination}`);
  console.log("在对话中让 AI 用 Inkmap 打开 Markdown 文件即可自动弹出右侧导图，或点击右侧面板 + 选择 Inkmap。");
  console.log(`Installed Inkmap MCP App plugin to ${destination}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
