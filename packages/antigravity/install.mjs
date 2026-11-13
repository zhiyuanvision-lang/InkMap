import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const source = existsSync(join(root, "inkmap", "plugin.json")) ? join(root, "inkmap") : root;

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

  console.log(`已安装 Inkmap 插件到 ${destination}`);
  console.log("在 Antigravity 右侧面板点击 + 选择 Inkmap，或在对话中让 AI 用 Inkmap 打开 Markdown 文件。");
  console.log(`Installed Inkmap plugin to ${destination}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
