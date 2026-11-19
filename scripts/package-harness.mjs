import { build } from "esbuild";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packageName } from "../packages/harness/src/shared.mjs";
import { copyTree, productVersion, removeStaleArtifacts, ROOT as root, runNpm } from "./lib/bundle-utils.mjs";

const out = join(root, "dist", "sidebars");
const target = join(out, packageName);
const version = await productVersion();
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

const readmeZh = `# Inkmap 思维导图（DeepSeek Harness 原生双向脑图与流程图工作台）

将工作区内的本地 Markdown (\`.md\` / \`.markmap.md\`) 文件直接在 **DeepSeek Harness 右侧分栏** 渲染为可交互、可双向拖拽编辑的思维导图（Markmap 增强替代）与 Mermaid 流程图。修改导图毫秒级逐字节写回原文件，未改动段落 100% 原样保留。

![Inkmap 双向实时同步演示](https://www.zhiyuanv.com/gifs/demo-sync-zh.gif)

## 🚀 3 秒上手使用指南

1. **右侧栏一键打开**：在 DeepSeek Harness 中预览任意 \`.md\` 文件时，点击右上角预览工具栏的 **「Inkmap」** 按钮，即可在右侧并排打开可编辑思维导图。
2. **全屏三栏工作台**：需要同时对照项目目录树与源码精修时，点击导图工具栏右上角的 **「浏览器打开」** 即可一键展开全屏三栏 IDE 工作台。
3. **在线免安装体验台**：https://www.zhiyuanv.com/inkmap.html

## ✨ 核心特性动态展示

### 1. 节点内嵌 Mermaid 流程图 + LaTeX 公式 + 表格实时编辑
在节点下放置 \` \`\`\`mermaid \` 代码块，支持直接在导图节点内高清渲染流程图、时序图、状态图，点击 **「编辑流程图源码」**（\`⌘E\`）即可实时修改重绘，支持独立弹窗无损缩放：

![Inkmap 内嵌 Mermaid 流程图编辑演示](https://www.zhiyuanv.com/gifs/demo-mermaid-zh.gif)

### 2. 9 种专业结构 · 夜色护眼主题 · 全屏逐节点放映
一键切换逻辑结构图、左右思维导图、组织结构图、目录组织图、时间轴、鱼骨图及夜色深色主题；点击 **「演示」** 直接当 PPT 逐节点聚焦汇报，支持导出高清 PNG、矢量 SVG 与离线交互 HTML：

![Inkmap 多布局、深色主题与演示放映](https://www.zhiyuanv.com/gifs/demo-layouts-zh.gif)

## ⌨️ 常用快捷键速查

| 操作 | 快捷键 / 方式 | 操作 | 快捷键 / 方式 |
| :--- | :--- | :--- | :--- |
| **新增子节点** | \`Tab\` | **编辑流程图 / 公式 / 表格源码** | 双击节点 或 \`⌘E\` (\`Ctrl+E\`) |
| **新增同级节点** | \`Enter\` | **上下调整节点顺序** | \`⌘↑\` / \`⌘↓\` (\`Alt+↑\` / \`Alt+↓\`) |
| **新增父级节点** | \`Shift + Tab\` | **全图查找与批量替换** | \`⌘F\` (\`Ctrl+F\`) |
| **删除 / 拖拽重组** | \`Backspace\` / 鼠标拖拽 | **立即保存 / 撤销重做** | \`⌘S\` / \`⌘Z\` / \`⇧⌘Z\` |

- **官方网站与全平台支持**：https://www.zhiyuanv.com/software.html
`;

const readmeEn = `# Inkmap — Two-Way Markdown Mindmap & Mermaid Editor for DeepSeek Harness

Render and edit local Markdown (\`.md\` / \`.markmap.md\`) files as interactive two-way mind maps (Markmap alternative) and Mermaid flowcharts directly inside the **DeepSeek Harness right sidebar**.

![Inkmap Two-Way Sync Demo](https://www.zhiyuanv.com/gifs/demo-sync-en.gif)

## Quick Start

1. **Open in Right Sidebar**: Preview any \`.md\` file in DeepSeek Harness and click **Inkmap** in the top-right preview toolbar.
2. **Full-Screen 3-Column Browser IDE**: Click **Open in Browser** in the Inkmap toolbar for a full-screen Project Tree + Markdown + Mind Map workspace.
3. **Live Browser Playground**: https://www.zhiyuanv.com/inkmap.html?lang=en

## Inline Mermaid Diagrams, 9 Layouts & Presentation Mode

![Inkmap Inline Mermaid Demo](https://www.zhiyuanv.com/gifs/demo-mermaid-en.gif)

![Inkmap Layouts & Presentation Demo](https://www.zhiyuanv.com/gifs/demo-layouts-en.gif)

- **Shortcuts**: \`Tab\` (child), \`Enter\` (sibling), \`Shift+Tab\` (parent), \`⌘↑/↓\` (move), \`⌘E\` (edit Markdown/Mermaid source), \`⌘F\` (find & replace), \`⌘S\` (save).
- **Website**: https://www.zhiyuanv.com/software.html?lang=en
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
  copyTree(join(root, "packages", "web", "dist"), join(target, "web")),
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

const packed = JSON.parse(runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", out], {
  cwd: target, encoding: "utf8",
}));
await removeStaleArtifacts(out, new RegExp(`^${packageName}-.+\\.tgz$`), packed[0].filename);
console.log(join(out, packed[0].filename));
