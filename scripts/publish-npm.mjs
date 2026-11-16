import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkgDir = join(root, "dist", "npm", "inkmap-mcp");

if (!existsSync(join(pkgDir, "package.json"))) {
  console.log("Building npm package first...");
  execFileSync("npm", ["run", "package:npm"], { cwd: root, stdio: "inherit" });
}

const whoami = spawnSync("npm", ["whoami"], { encoding: "utf8" });
if (whoami.status !== 0) {
  console.log("当前尚未登录 npm，正在启动浏览器授权登录 (npm login --auth-type=web)...");
  const login = spawnSync("npm", ["login", "--auth-type=web"], { stdio: "inherit" });
  if (login.status !== 0) {
    console.error("npm 登录未完成，已取消发布。");
    process.exit(1);
  }
} else {
  console.log(`Publishing as npm user: ${whoami.stdout.trim()}`);
}

const extraArgs = process.argv.slice(2);
execFileSync("npm", ["publish", "--access", "public", ...extraArgs], {
  cwd: pkgDir,
  stdio: "inherit",
});
