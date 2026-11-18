import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { YUNFAN_BILLING_ORIGIN } from "@inkmap/core";
import { fileSessionStorage, licenseService } from "../cli/dist/license.js";
import { fileSource, serve } from "../cli/dist/server.js";

async function main(args) {
  if (Number(process.versions.node.split(".")[0]) < 22) {
    throw new Error("Inkmap 需要 Node.js 22 或更新版本。");
  }
  if (args.length !== 1 || !/\.md$/i.test(args[0])) {
    throw new Error("请在 Qoder 的本地工作区终端运行 node inkmap.mjs <文件.md>。");
  }

  const [workspace, file] = await Promise.all([realpath(process.cwd()), realpath(args[0])]);
  const pathInWorkspace = relative(workspace, file);
  if (!pathInWorkspace || isAbsolute(pathInWorkspace) || pathInWorkspace === ".." ||
      pathInWorkspace.startsWith(".." + sep) || !/\.md$/i.test(file) || !(await stat(file)).isFile()) {
    throw new Error("请选择当前工作区内的 Markdown 文件。");
  }

  const source = await fileSource(file);
  const license = licenseService(fileSessionStorage(), () => YUNFAN_BILLING_ORIGIN);
  const editor = await serve({
    source,
    license,
    webRoot: fileURLToPath(new URL("./web/", import.meta.url)),
    port: 0,
    sidebar: true,
    sidebarPurchase: true,
    workspaceRoots: [workspace],
  });
  console.log(editor.url);
  console.log("将上面的地址粘贴到 Qoder 内置浏览器。按 Ctrl+C 退出。");

  async function stop() {
    license.dispose();
    await editor.close();
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
