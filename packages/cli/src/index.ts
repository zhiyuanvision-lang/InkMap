import { spawn } from "node:child_process";
import { serve } from "./server.js";

const USAGE = `用法：inkmap <文件.md> [--port 端口] [--no-open]

在浏览器中以思维导图编辑 Markdown 大纲，修改会写回该文件；
文件在别处被修改时，页面会自动刷新。`;

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

export async function main(argv: string[]) {
  let file: string | undefined;
  let port: number | undefined;
  let open = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return console.log(USAGE);
    if (arg === "--no-open") open = false;
    else if (arg === "--port") port = Number(argv[++i]);
    else if (!file) file = arg;
    else throw new Error(`多余的参数：${arg}\n\n${USAGE}`);
  }
  if (!file) throw new Error(USAGE);
  if (port !== undefined && !Number.isInteger(port)) throw new Error("--port 需要一个整数");

  const served = await serve({ file, port, log: msg => console.log(`[inkmap] ${msg}`) });
  console.log(`[inkmap] 正在编辑 ${file}`);
  console.log(`[inkmap] ${served.url}  （Ctrl+C 退出）`);
  if (open) openBrowser(served.url);

  const stop = () => served.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
