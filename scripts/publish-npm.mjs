import { join } from "node:path";
import { ROOT as root, runNpm } from "./lib/bundle-utils.mjs";

const pkgDir = join(root, "dist", "npm", "inkmap-mcp");

console.log("Rebuilding and verifying parity before npm publish...");
runNpm(["run", "package:platforms"], { cwd: root, stdio: "inherit" });
runNpm(["run", "verify:parity"], { cwd: root, stdio: "inherit" });

let npmUser = "";
try {
  npmUser = String(runNpm(["whoami"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).trim();
} catch {}
if (!npmUser) {
  console.log("当前尚未登录 npm，正在启动浏览器授权登录 (npm login --auth-type=web)...");
  try {
    runNpm(["login", "--auth-type=web"], { stdio: "inherit" });
  } catch {
    console.error("npm 登录未完成，已取消发布。");
    process.exit(1);
  }
} else {
  console.log(`Publishing as npm user: ${npmUser}`);
}

const extraArgs = process.argv.slice(2);
runNpm(["publish", "--access", "public", ...extraArgs], {
  cwd: pkgDir,
  stdio: "inherit",
});
