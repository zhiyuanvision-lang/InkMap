import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PRODUCT, YUNFAN_BILLING_ORIGIN } from "@inkmap/core";
import { adFeed, fileSessionStorage, licenseService } from "./license.js";
import { fileSource, serve } from "./server.js";

const WEB_ROOT = fileURLToPath(new URL("./web/", import.meta.url));

const USAGE = `用法：inkmap <文件.md> [--port 端口] [--no-open] [--sidebar [--sidebar-purchase]]

在浏览器中以思维导图编辑 Markdown 大纲，修改会写回该文件；
文件在别处被修改时，页面会自动刷新。
--sidebar 输出可粘贴到侧栏浏览器的本机地址。
--sidebar-purchase 在支持外部结账的侧栏启用购买入口。`;

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

export async function main(argv: string[]) {
  if (argv.length === 1 && argv[0] === "mcp") {
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
