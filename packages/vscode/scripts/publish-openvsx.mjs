import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vsixPath = process.argv[2] || join(root, "dist", "inkmap.vsix");
const tokenPath = process.env.OVSX_TOKEN_FILE || join(homedir(), ".inkmap", "openvsx.token");

const token = (process.env.OVSX_PAT || (await readFile(tokenPath, "utf8").catch(() => ""))).trim();
if (!token) {
  console.error(`Missing Open VSX token. Set OVSX_PAT or save token to ${tokenPath}`);
  process.exit(1);
}

const body = await readFile(vsixPath);
const res = await fetch(`https://open-vsx.org/api/-/publish?token=${encodeURIComponent(token)}`, {
  method: "POST",
  headers: { "Content-Type": "application/octet-stream" },
  body,
});

const text = await res.text();
if (!res.ok) {
  console.error(`Open VSX publish failed (HTTP ${res.status}): ${text}`);
  process.exit(1);
}
console.log(text);
