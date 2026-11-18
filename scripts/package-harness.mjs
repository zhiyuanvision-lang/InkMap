import { build } from "esbuild";
import { cp, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageName } from "../packages/harness/src/shared.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = join(root, "dist", "sidebars");
const target = join(out, packageName);
const cliPkg = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(join(root, "packages", "cli", "package.json"), "utf8")));
const version = cliPkg.version || "0.3.1";
const manifest = {
  name: packageName,
  version,
  description: "Inkmap 思维导图 — 在 DeepSeek Harness 中将本地 Markdown 实时渲染为可双向编辑的思维导图 (Markmap) 与 Mermaid 流程图 / Interactive two-way Markdown mind map & Mermaid flowchart editor for DeepSeek Harness.",
  type: "module",
  icon: "./icon.svg",
  license: "SEE LICENSE IN LICENSE.md",
  homepage: "https://zhiyuanv.com/software.html",
  repository: {
    type: "git",
    url: "https://github.com/zhiyuanvision-lang/InkMap.git",
    directory: "packages/harness",
  },
  author: "Zhiyuan Vision <support@zhiyuanv.com>",
  keywords: [
    "deepseek-harness",
    "dsh",
    "dsh-plugin",
    "dsh-bundle",
    "inkmap",
    "mindmap",
    "mind-map",
    "mind map",
    "markmap",
    "mermaid",
    "markdown",
    "outline",
    "flowchart",
    "diagram",
    "xmind",
    "brainstorm",
    "katex",
    "latex",
    "思维导图",
    "脑图",
    "大纲",
    "流程图",
    "架构图",
    "组织结构图",
    "鱼骨图",
    "时间轴",
    "知识库",
    "笔记",
    "双向同步",
    "可视化",
  ],
  engines: { dsh: ">=0.2.0-0 <1.0.0" },
  exports: {
    ".": "./host.js",
    "./client": "./client.js",
    "./package.json": "./package.json",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
  },
  files: [
    "host.js",
    "client.js",
    "web",
    "cordis.patch.yml",
    "icon.svg",
    "locale/*.json",
    "README.md",
    "README.zh.md",
    "LICENSE.md",
    "THIRD_PARTY_NOTICES.md",
  ],
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

const localeEn = {
  meta: {
    title: "Inkmap — Markdown mind map & Mermaid editor",
    description: "Open local Markdown files as interactive two-way mind maps (Markmap) and Mermaid flowcharts in the right sidebar, with real-time file sync.",
    detail: "README.md",
  },
};

const localeZh = {
  meta: {
    title: "Inkmap 思维导图（Markdown 双向脑图与流程图）",
    description: "在右侧栏将本地 Markdown 文件实时渲染为可双向编辑的思维导图（Markmap）与 Mermaid 流程图，修改导图自动写回源文件。",
    detail: "README.zh.md",
  },
};

const readmeZh = `# Inkmap 思维导图（DeepSeek Harness 原生插件）

将工作区内的本地 Markdown (\`.md\` / \`.markmap.md\`) 文件直接在 **DeepSeek Harness 右侧分栏** 渲染为可交互、可双向编辑的思维导图（Markmap）与 Mermaid 流程图。

## 核心特性

- **右侧栏一键打开**：在 DeepSeek Harness 中预览任意 \`.md\` 文件时，点击右上角工具栏的 **「Inkmap（用 Inkmap 打开）」** 按钮，即可在右侧并排打开可编辑思维导图。
- **Markdown ⇄ 思维导图双向实时同步**：在思维导图中增删改查或拖拽重组节点，底层 \`.md\` 源文件毫秒级自动写回，未修改段落原样保留。
- **全套思维导图快捷键**：支持 \`Tab\`（添加子节点）、\`Enter\`（添加同级节点）、\`Shift+Tab\`（添加父节点）、\`⌘↑\` / \`⌘↓\`（上下移动节点）、\`⌘E\`（编辑节点 Markdown）、\`⌘S\`（立即保存）、\`Backspace\`（删除节点）及双击内联编辑。
- **Mermaid 流程图 + LaTeX 数学公式 + Markdown 表格**：节点内原生渲染复杂流程图、状态图、时序图、数学公式与多列表格，支持独立弹窗无损缩放与源码实时编辑。
- **9 种专业结构与 4 套主题配色**：逻辑结构图、左右思维导图、组织结构图、目录组织图、时间轴、鱼骨图及深色护眼主题，支持一键导出高清 PNG 与矢量 SVG。

## 安装方式

- **方式一（在 DeepSeek Harness 插件页安装）**：打开左侧「插件」-> 点击右上角「+ 添加插件」-> 输入 \`dsh-inkmap\` 回车即可安装并自动启用。
- **方式二（命令行一键安装全平台）**：
  \`\`\`bash
  npx -y inkmap-mcp@latest install
  \`\`\`
- **官方网站**：https://zhiyuanv.com/software.html
`;

const readmeEn = `# Inkmap — Markdown mind map & Mermaid editor for DeepSeek Harness

Render and edit local Markdown (\`.md\` / \`.markmap.md\`) files as interactive mind maps (Markmap) and Mermaid flowcharts directly inside the **DeepSeek Harness right sidebar**.

## Highlights

- **One-click sidebar action**: When previewing any \`.md\` file in DeepSeek Harness, click **Inkmap** in the top-right document preview toolbar to open an interactive mind map tab beside the preview.
- **Real-time two-way Markdown sync**: Add, edit, reorder, or drag-and-drop nodes on the canvas and changes are written back to your local \`.md\` file immediately while preserving unmodified lines.
- **Full mind map keyboard shortcuts**: \`Tab\` (insert child), \`Enter\` (insert sibling), \`Shift+Tab\` (insert parent), \`⌘↑\` / \`⌘↓\` (move node), \`⌘E\` (edit node Markdown), \`⌘S\` (save immediately), and \`Backspace\` (delete).
- **Mermaid diagrams, LaTeX math & tables**: Native inline rendering of Mermaid flowcharts/sequence/state diagrams, KaTeX math formulas, and Markdown tables.
- **9 layouts, 4 themes & PNG/SVG export**: Switch between logical structure, mind map, org chart, catalog, timeline, and fishbone layouts with dark mode and high-resolution export.

## Installation

- **In DeepSeek Harness**: Open **Plugins** -> Click **+ Add plugin** -> Enter \`dsh-inkmap\`.
- **One-line CLI installer**:
  \`\`\`bash
  npx -y inkmap-mcp@latest install
  \`\`\`
- **Website**: https://zhiyuanv.com/software.html
`;

await rm(target, { recursive: true, force: true });
await mkdir(join(target, "locale"), { recursive: true });
await writeFile(join(target, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
await writeFile(join(target, "cordis.patch.yml"), `- insert:\n    - id: inkmap\n      name: ${packageName}\n`);
await writeFile(join(target, "locale", "en.json"), JSON.stringify(localeEn, null, 2) + "\n");
await writeFile(join(target, "locale", "zh.json"), JSON.stringify(localeZh, null, 2) + "\n");
await writeFile(join(target, "README.md"), readmeEn, "utf8");
await writeFile(join(target, "README.zh.md"), readmeZh, "utf8");
await Promise.all([
  cp(join(root, "packages", "web", "dist"), join(target, "web"), { recursive: true }),
  copyFile(join(root, "packages", "vscode", "images", "icon.svg"), join(target, "icon.svg")),
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
