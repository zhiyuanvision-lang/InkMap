import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vsixPath = process.argv[2] || join(root, "dist", "inkmap.vsix");

const { InteractiveBrowserCredential } = require("@azure/identity");
const { publish } = require("@vscode/vsce/out/publish");

let pat = process.env.VSCE_PAT?.trim();
if (!pat) {
  console.log("Opening browser for Microsoft Entra ID authorization (zhiyuanvision@outlook.com)...");
  const cred = new InteractiveBrowserCredential({
    loginHint: process.env.VSCE_LOGIN_HINT || "zhiyuanvision@outlook.com",
  });
  const token = await cred.getToken("499b84ac-1321-427f-aa17-267ca6975798/.default");
  pat = token.token;
}

await publish({
  packagePath: [vsixPath],
  pat,
});
