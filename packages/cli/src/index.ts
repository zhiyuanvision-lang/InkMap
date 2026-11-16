import { spawn } from "node:child_process";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT, YUNFAN_BILLING_ORIGIN } from "@inkmap/core";
import { adFeed, fileSessionStorage, licenseService } from "./license.js";
import { fileSource, serve } from "./server.js";

export const INKMAP_VERSION = "0.2.6";
const WEB_ROOT = fileURLToPath(new URL("./web/", import.meta.url));

const USAGE = `Inkmap v${INKMAP_VERSION} — Markdown 交互思维导图编辑器 & MCP App

用法 / Usage：
  npx -y inkmap-mcp@latest install [claude|claude-code|cursor|antigravity|codex] [--workspace <目录>]
      一键自动检测并配置本机 AI 客户端（支持 Ubuntu / macOS / Windows）
  npx -y inkmap-mcp@latest uninstall [客户端...]
      从指定或全部客户端移除 Inkmap 配置
  npx -y inkmap-mcp@latest mcp [--workspace <目录>]
      以标准 MCP App (stdio) 模式启动服务
  npx -y inkmap-mcp@latest <文件.md> [--port 端口] [--no-open] [--sidebar [--sidebar-purchase]]
      在本地浏览器中以思维导图打开并实时双向编辑 Markdown 文件`;

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

function appendEnvWorkspaces(dirs: string[]) {
  if (dirs.length === 0) return;
  const resolved = dirs.map(d => resolve(d));
  const current = (process.env.INKMAP_WORKSPACES || "").split(delimiter).filter(Boolean);
  process.env.INKMAP_WORKSPACES = [...new Set([...current, ...resolved])].join(delimiter);
}

export async function main(argv: string[]) {
  if (argv.length === 0 && !process.stdin.isTTY) {
    const { serveCodex } = await import("./codex.js");
    return serveCodex();
  }
  if (argv[0] === "-v" || argv[0] === "--version") {
    console.log(INKMAP_VERSION);
    return;
  }
  if (argv[0] === "install") {
    const { runInstallCli } = await import("./install.js");
    return runInstallCli(argv.slice(1), false);
  }
  if (argv[0] === "uninstall") {
    const { runInstallCli } = await import("./install.js");
    return runInstallCli(argv.slice(1), true);
  }
  if (argv[0] === "mcp") {
    const extraWorkspaces: string[] = [];
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === "-w" || arg === "--workspace") {
        const val = argv[++i];
        if (!val) throw new Error("--workspace 需要目录路径");
        extraWorkspaces.push(...val.split(delimiter).filter(Boolean));
      } else if (arg.startsWith("--workspace=")) {
        extraWorkspaces.push(...arg.slice("--workspace=".length).split(delimiter).filter(Boolean));
      } else if (arg === "-h" || arg === "--help") {
        console.log(USAGE);
        return;
      } else {
        throw new Error(`未知 mcp 参数：${arg}\n\n${USAGE}`);
      }
    }
    appendEnvWorkspaces(extraWorkspaces);
    const { serveCodex } = await import("./codex.js");
    return serveCodex();
  }

  let file: string | undefined;
  let port: number | undefined;
  let open = true;
  let sidebar = false;
  let sidebarPurchase = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return console.log(USAGE);
    if (arg === "--no-open") open = false;
    else if (arg === "--sidebar") sidebar = true;
    else if (arg === "--sidebar-purchase") sidebarPurchase = true;
    else if (arg === "--port") port = Number(argv[++i]);
    else if (!file) file = arg;
    else throw new Error(`多余的参数：${arg}\n\n${USAGE}`);
  }
  if (!file) throw new Error(USAGE);
  if (port !== undefined && !Number.isInteger(port)) throw new Error("--port 需要一个整数");
  if (sidebar && !/\.md$/i.test(file)) throw new Error("--sidebar 需要 Markdown 文件");
  if (sidebarPurchase && !sidebar) throw new Error("--sidebar-purchase 需要 --sidebar");

  const log = (msg: string) => console.log(`[inkmap] ${msg}`);
  const license = licenseService(fileSessionStorage(), () => process.env.INKMAP_BILLING_ORIGIN || YUNFAN_BILLING_ORIGIN);
  const served = await serve({
    source: await fileSource(file, log),
    webRoot: WEB_ROOT,
    port: port ?? (sidebar ? 0 : undefined),
    log,
    license,
    ads: adFeed(PRODUCT.adFeedUrl),
    sidebar,
    sidebarPurchase,
  });
  console.log(`[inkmap] 正在编辑 ${file}`);
  console.log(`[inkmap] ${served.url}  （Ctrl+C 退出）`);
  if (open && !sidebar) openBrowser(served.url);

  const stop = () => {
    license.dispose();
    return served.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
