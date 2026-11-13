import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bundle = fileURLToPath(new URL(".", import.meta.url));
const marketplace = "inkmap-local";

function codexCommand() {
  if (spawnSync("codex", ["--version"], { stdio: "ignore" }).status === 0) return "codex";
  if (process.platform === "darwin") {
    for (const directory of ["/Applications", join(homedir(), "Applications")]) {
      const command = join(directory, "ChatGPT.app/Contents/Resources/codex-cli/bin/codex");
      if (existsSync(command)) return command;
    }
  }
  throw new Error("找不到 codex 命令。请安装或更新 Codex CLI / Install or update Codex CLI: https://learn.chatgpt.com/docs/codex/cli");
}

try {
  if (Number(process.versions.node.split(".")[0]) < 22) {
    throw new Error("需要 Node.js 22 或更新版本 / Node.js 22 or later is required.");
  }

  const codex = codexCommand();
  const destination = join(homedir(), ".inkmap", "codex-marketplace");
  mkdirSync(destination, { recursive: true });
  const marketplaceRoot = realpathSync(destination);
  const { marketplaces } = JSON.parse(execFileSync(codex, ["plugin", "marketplace", "list", "--json"], { encoding: "utf8" }));
  const existing = marketplaces.find(entry => entry.name === marketplace);
  if (existing && existing.root !== marketplaceRoot) {
    throw new Error(`已有其他 Inkmap 插件源 / Inkmap already uses another marketplace: ${existing.root}\n如需改用此安装包，请移除旧插件源后重试 / To switch to this package, remove the old source and retry: codex plugin marketplace remove ${marketplace}`);
  }

  for (const directory of [".agents", "inkmap-codex"]) {
    cpSync(join(bundle, directory), join(marketplaceRoot, directory), { recursive: true });
  }
  if (!existing) {
    execFileSync(codex, ["plugin", "marketplace", "add", marketplaceRoot], { stdio: "inherit" });
  }
  execFileSync(codex, ["plugin", "add", `inkmap-codex@${marketplace}`], { stdio: "inherit" });
  console.log("安装完成。重启 ChatGPT 桌面应用，在 Codex 模式下从 Markdown 文件的打开菜单选择 Inkmap Mind Map。");
  console.log("Installed. Restart ChatGPT desktop, then open a Markdown file in Codex and select Inkmap Mind Map from its open menu.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
