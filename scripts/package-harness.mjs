import { build } from "esbuild";
import { cp, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageName } from "../packages/harness/src/shared.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = join(root, "dist", "sidebars");
const target = join(out, packageName);
const version = "0.1.1";
const manifest = {
  name: packageName,
  version,
  description: "Open local Markdown files as editable Inkmap mind maps in DeepSeek Harness.",
  type: "module",
  license: "SEE LICENSE IN LICENSE.md",
  engines: { dsh: "0.2.2-rc.2" },
  exports: { ".": "./host.js", "./client": "./client.js" },
  files: ["host.js", "client.js", "web", "cordis.patch.yml", "LICENSE.md", "THIRD_PARTY_NOTICES.md"],
  dsh: {
    bundle: { patch: "./cordis.patch.yml" },
    client: {
      platform: "web",
      inject: [
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-sidebar-documentpreview",
        "@deepseek-ai/dsh-client-ui-sidebar-right",
      ],
    },
  },
};

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await writeFile(join(target, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
await writeFile(join(target, "cordis.patch.yml"), `- insert:\n    - id: inkmap\n      name: ${packageName}\n`);
await Promise.all([
  cp(join(root, "packages", "web", "dist"), join(target, "web"), { recursive: true }),
  copyFile(join(root, "packages", "vscode", "LICENSE.md"), join(target, "LICENSE.md")),
  copyFile(join(root, "packages", "vscode", "THIRD_PARTY_NOTICES.md"), join(target, "THIRD_PARTY_NOTICES.md")),
  build({
    entryPoints: [join(root, "packages", "harness", "src", "host.mjs")],
    bundle: true, platform: "node", target: "node22", format: "esm",
    outfile: join(target, "host.js"),
  }),
  build({
    entryPoints: [join(root, "packages", "harness", "src", "client.mjs")],
    bundle: true, platform: "browser", format: "cjs", external: ["react"],
    banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}, factory: require => { const module = { exports: {} }; const exports = module.exports;` },
    footer: { js: "return module.exports; } });" },
    outfile: join(target, "client.js"),
  }),
]);

const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", out], {
  cwd: target, encoding: "utf8",
}));
console.log(join(out, packed[0].filename));
