import { build } from "esbuild";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildWebApp, CLI_DIST as cliDist, CODEX_HTML as codexHtml, copyTree, productVersion, ROOT as root, runNpm,
  singleFileWebEditor, syncCliCodexHtml, thirdPartyNotices, VSCODE_DIR as vscodeDir, writeCodexPluginManifests,
  writeJSON,
} from "./lib/bundle-utils.mjs";

const outRoot = join(root, "dist", "npm");
const pkgDir = join(outRoot, "inkmap-mcp");
const agySource = join(root, "packages", "antigravity");
const version = await productVersion();

await rm(outRoot, { recursive: true, force: true });
await Promise.all([
  mkdir(join(pkgDir, "bin"), { recursive: true }),
  mkdir(join(pkgDir, "dist", "web"), { recursive: true }),
  mkdir(join(pkgDir, "dist", "bundles", "antigravity", "assets"), { recursive: true }),
  mkdir(join(pkgDir, "dist", "bundles", "antigravity", "sidecars", "inkmap"), { recursive: true }),
  mkdir(join(pkgDir, "dist", "bundles", "codex", ".agents", "plugins"), { recursive: true }),
  mkdir(join(pkgDir, "dist", "bundles", "codex", "inkmap-codex", ".codex-plugin"), { recursive: true }),
  mkdir(join(pkgDir, "dist", "bundles", "codex", "inkmap-codex", "assets"), { recursive: true }),
  mkdir(join(pkgDir, "dist", "bundles", "vscode", "dist"), { recursive: true }),
  mkdir(join(pkgDir, "dist", "bundles", "vscode", "images"), { recursive: true }),
  mkdir(join(pkgDir, "dist", "bundles", "harness", "locale"), { recursive: true }),
]);

const web = await singleFileWebEditor("./app.js");

const agyBundle = join(pkgDir, "dist", "bundles", "antigravity");
const agySidecar = join(agyBundle, "sidecars", "inkmap");
const codexBundle = join(pkgDir, "dist", "bundles", "codex");
const codexPlugin = join(codexBundle, "inkmap-codex");
const vscodeBundle = join(pkgDir, "dist", "bundles", "vscode");
const harnessBundle = join(pkgDir, "dist", "bundles", "harness");
const dshBuiltDir = join(root, "dist", "sidebars", "dsh-inkmap");
const vscodeRawPkg = JSON.parse(await readFile(join(vscodeDir, "package.json"), "utf8"));
const { private: _omitPrivate, scripts: _omitScripts, dependencies: _omitDeps, devDependencies: _omitDevDeps, ...vscodeCleanPkg } = vscodeRawPkg;

const [cliBuild] = await Promise.all([
  build({
    absWorkingDir: root,
    entryPoints: [join(cliDist, "index.js")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: join(pkgDir, "dist", "cli.cjs"),
    define: { "import.meta.url": "inkmapModuleUrl" },
    banner: { js: 'const inkmapModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
    metafile: true,
  }),
  buildWebApp(web.jsEntry, join(pkgDir, "dist", "web", "app.js")),
  build({
    entryPoints: [join(agySource, "src", "main.mjs")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    external: ["sidecar_sdk"],
    outfile: join(agySidecar, "main.mjs"),
  }),
  build({
    absWorkingDir: root,
    entryPoints: [join(vscodeDir, "src", "extension.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    external: ["vscode"],
    define: { "process.env.INKMAP_DEFAULT_BILLING_ORIGIN": JSON.stringify(process.env.INKMAP_BILLING_ORIGIN ?? "") },
    outfile: join(vscodeBundle, "dist", "extension.js"),
  }),
  writeJSON(join(vscodeBundle, "package.json"), { ...vscodeCleanPkg, version }),
  copyFile(join(vscodeDir, "package.nls.json"), join(vscodeBundle, "package.nls.json")),
  copyFile(join(vscodeDir, "package.nls.zh-cn.json"), join(vscodeBundle, "package.nls.zh-cn.json")),
  copyFile(join(vscodeDir, "images", "icon.png"), join(vscodeBundle, "images", "icon.png")),
  writeFile(join(pkgDir, "dist", "web", "index.html"), web.html, "utf8"),
  syncCliCodexHtml(),
  copyFile(codexHtml, join(pkgDir, "dist", "codex.html")),
  copyFile(join(agySource, "plugin.json"), join(agyBundle, "plugin.json")),
  copyFile(join(agySource, "mcp_config.json"), join(agyBundle, "mcp_config.json")),
  copyFile(join(agySource, "sidecar.json"), join(agySidecar, "sidecar.json")),
  copyFile(join(agySource, "src", "bridge.js"), join(agySidecar, "bridge.js")),
  copyTree(join(agySource, "skills"), join(agyBundle, "skills")),
  copyTree(join(agySource, "rules"), join(agyBundle, "rules")),
  copyFile(join(vscodeDir, "images", "icon.svg"), join(agyBundle, "assets", "logo.svg")),
  copyFile(join(vscodeDir, "images", "icon.png"), join(codexPlugin, "assets", "icon.png")),
  copyFile(join(vscodeDir, "LICENSE.md"), join(pkgDir, "LICENSE.md")),
  copyFile(join(root, "packages", "cli", "NPM_README.md"), join(pkgDir, "README.md")),
  copyFile(join(dshBuiltDir, "package.json"), join(harnessBundle, "package.json")),
  copyFile(join(dshBuiltDir, "host.js"), join(harnessBundle, "host.js")),
  copyFile(join(dshBuiltDir, "client.js"), join(harnessBundle, "client.js")),
  copyFile(join(dshBuiltDir, "cordis.patch.yml"), join(harnessBundle, "cordis.patch.yml")),
  copyFile(join(dshBuiltDir, "icon.svg"), join(harnessBundle, "icon.svg")),
  copyFile(join(dshBuiltDir, "README.md"), join(harnessBundle, "README.md")),
  copyFile(join(dshBuiltDir, "README.zh.md"), join(harnessBundle, "README.zh.md")),
  copyTree(join(dshBuiltDir, "locale"), join(harnessBundle, "locale")),
]);

const binScript = `#!/usr/bin/env node
"use strict";
require("../dist/cli.cjs").main(process.argv.slice(2)).catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
`;
const binPath = join(pkgDir, "bin", "inkmap.cjs");
await writeFile(binPath, binScript, "utf8");
await chmod(binPath, 0o755);

await writeCodexPluginManifests(codexPlugin, join(codexBundle, ".agents", "plugins"), version);
await writeFile(join(pkgDir, "THIRD_PARTY_NOTICES.md"), await thirdPartyNotices(cliBuild.metafile), "utf8");

// Official MCP Registry manifest + zero-dependency package.json
const mcpName = "io.github.zhiyuanvision-lang/inkmap-markdown-mindmap-markmap";
const serverManifest = {
  $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: mcpName,
  title: "Inkmap — Editable Mindmap, Markmap, Mind Map & Mermaid 思维导图/脑图",
  description: "Two-way Markdown mindmap (markmap), Mermaid flowchart & outline MCP App | 双向思维导图/脑图/流程图/大纲",
  version,
  websiteUrl: "https://zhiyuanv.com/software.html",
  icons: [
    {
      src: "https://raw.githubusercontent.com/zhiyuanvision-lang/InkMap/main/packages/vscode/images/icon.png",
      mimeType: "image/png",
      sizes: ["128x128"],
    },
  ],
  repository: {
    url: "https://github.com/zhiyuanvision-lang/InkMap",
    source: "github",
  },
  packages: [
    {
      registryType: "npm",
      identifier: "inkmap-mcp",
      version,
      transport: { type: "stdio" },
      packageArguments: [{ type: "positional", value: "mcp" }],
    },
  ],
};
const rootPluginDescription = "Interactive two-way Markdown mind map (markmap), Mermaid flowchart & XMind outline MCP App | 双向编辑 Markdown 思维导图、脑图、流程图与大纲";
const rootPluginKeywords = [
  "mcp", "mcp-server", "mcp-app", "model-context-protocol",
  "markdown", "mindmap", "mind-map", "mind map", "markmap", "mermaid",
  "flowchart", "diagram", "outline", "xmind", "katex", "latex",
  "claude-plugin", "cursor-plugin", "codex-plugin",
  "思维导图", "脑图", "大纲", "流程图", "架构图", "组织结构图", "鱼骨图", "双向同步"
];
const sharedPluginMeta = {
  name: "inkmap",
  displayName: "Inkmap — Markdown Mind Map & Mermaid 思维导图",
  version,
  description: rootPluginDescription,
  author: { name: "Zhiyuan Vision", email: "contact@zhiyuanv.com", url: "https://zhiyuanv.com" },
  homepage: "https://zhiyuanv.com/software.html",
  repository: "https://github.com/zhiyuanvision-lang/InkMap",
  license: "SEE LICENSE IN LICENSE.md",
  logo: "./packages/vscode/images/icon.png",
  keywords: rootPluginKeywords,
};
await Promise.all([
  mkdir(join(root, ".claude-plugin"), { recursive: true }),
  mkdir(join(root, ".cursor-plugin"), { recursive: true }),
]);
await Promise.all([
  writeJSON(join(pkgDir, "server.json"), serverManifest),
  writeJSON(join(root, "server.json"), serverManifest),
  writeJSON(join(root, "plugin.json"), {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    ...sharedPluginMeta,
    skills: "./skills",
    mcpServers: "./mcp.json",
    extensions: {
      "com.openai": {
        requires_local_executor: true,
        interface: {
          displayName: "Inkmap — Mind Map & Mermaid 思维导图",
          logo: "./packages/vscode/images/icon.png",
          composerIcon: "./packages/vscode/images/icon.png",
        },
      },
    },
  }),
  writeJSON(join(root, ".claude-plugin", "plugin.json"), {
    ...sharedPluginMeta,
    skills: "./skills",
    mcpServers: "./.mcp.json",
  }),
  writeJSON(join(root, ".claude-plugin", "marketplace.json"), {
    name: "inkmap-marketplace",
    owner: { name: "Zhiyuan Vision", email: "contact@zhiyuanv.com" },
    metadata: {
      description: rootPluginDescription,
      version,
    },
    plugins: [
      {
        name: "inkmap",
        source: "./",
        description: rootPluginDescription,
        version,
        author: { name: "Zhiyuan Vision", email: "contact@zhiyuanv.com" },
        homepage: "https://zhiyuanv.com/software.html",
        repository: "https://github.com/zhiyuanvision-lang/InkMap",
        category: "productivity",
        keywords: rootPluginKeywords,
      },
    ],
  }),
  writeJSON(join(root, ".cursor-plugin", "plugin.json"), {
    ...sharedPluginMeta,
    skills: "./skills",
    mcpServers: "./mcp.json",
  }),
  writeJSON(join(pkgDir, "package.json"), {
    name: "inkmap-mcp",
    version,
    description: "Interactive two-way Markdown mind map (markmap) & Mermaid flowchart editor / MCP App for Claude, Codex, Antigravity, Cursor, VS Code, Qoder & DeepSeek Harness | Markdown 双向思维导图、脑图、流程图与大纲",
    mcpName,
    license: "SEE LICENSE IN LICENSE.md",
    homepage: "https://zhiyuanv.com/software.html",
    repository: {
      type: "git",
      url: "git+https://github.com/zhiyuanvision-lang/InkMap.git",
    },
    author: "Zhiyuan Vision <contact@zhiyuanv.com>",
    bin: {
      "inkmap-mcp": "bin/inkmap.cjs",
      inkmap: "bin/inkmap.cjs",
    },
    main: "./dist/cli.cjs",
    files: [
      "bin",
      "dist",
      "LICENSE.md",
      "THIRD_PARTY_NOTICES.md",
      "README.md",
      "server.json",
    ],
    engines: {
      node: ">=20",
    },
    keywords: [
      "mcp",
      "mcp-server",
      "mcp-app",
      "model-context-protocol",
      "markdown",
      "mindmap",
      "mind-map",
      "mind map",
      "markmap",
      "mermaid",
      "flowchart",
      "diagram",
      "outline",
      "xmind",
      "katex",
      "latex",
      "claude",
      "claude-code",
      "claude-plugin",
      "codex",
      "codex-plugin",
      "cursor",
      "cursor-plugin",
      "vscode",
      "antigravity",
      "deepseek-harness",
      "dsh",
      "dsh-plugin",
      "qoder",
      "trae",
      "windsurf",
      "workbuddy",
      "codebuddy",
      "思维导图",
      "脑图",
      "大纲",
      "流程图",
      "架构图",
      "组织结构图",
      "鱼骨图",
      "时间轴",
      "双向同步",
      "知识库",
      "笔记",
    ],
  }),
]);

const packed = JSON.parse(runNpm(["pack", "--json", "--pack-destination", outRoot], { cwd: pkgDir, encoding: "utf8" }));
console.log(join(outRoot, packed[0].filename));
