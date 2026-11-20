import { detectOsLocale } from "../../cli/src/license";

const zh = {
  openMarkdownFirst: "请先打开一个 Markdown 文件",
  browserOpened: "思维导图已在浏览器打开：{url}",
  copyLink: "复制链接",
  browserFailed: "无法在浏览器打开思维导图：{error}",
  readOnly: "文档无法修改（可能是只读文件）",
  trialExpired: "7 天试用已结束。请购买 Pro，或登录已购买 Pro 的账号。",
  checkoutFailed: "无法打开购买页面。",
  saveExport: "导出",
  onboardingTip: "💡 Inkmap 思维导图已就绪：点击即可在右侧并排打开可双向编辑的脑图与流程图",
  onboardingAction: "立即打开思维导图",
  welcomeTip: "💡 Inkmap 思维导图已安装：一键打开示例脑图体验双向编辑，或在任意 .md 文件点击右下角「思维导图」",
  welcomeAction: "打开示例导图",
  statusBarLabel: "$(type-hierarchy) 思维导图",
  statusBarTooltip: "用 Inkmap 在侧边打开当前 Markdown 的可编辑思维导图",
  codeLensOpen: "⇄ 用 Inkmap 思维导图打开",
  codeLensOpenTooltip: "在右侧并排打开当前 Markdown 的双向可编辑思维导图",
  codeLensBrowser: "浏览器全屏打开",
  codeLensBrowserTooltip: "在独立浏览器窗口全屏打开当前导图，实时双向同步回原文件",
  welcomeDoc: `# Inkmap 思维导图快速上手

- ✨ 双向实时同步
  - 双击任意节点直接编辑，自动写回 Markdown 源文件
  - 选中节点按 \`Tab\` 添加子节点，按 \`Enter\` 添加同级节点
- 🧭 常用入口
  - 编辑任意 \`.md\` 文件时，点击右下角状态栏 **思维导图** 按钮
  - 或点击编辑器右上角导图图标，在侧边并排预览与编辑
- 📊 原生 Mermaid 流程图
  \`\`\`mermaid
  graph LR
    A[Markdown 文档] --> B[Inkmap 思维导图]
    B --> C[双向编辑 & 导出 PNG/SVG/HTML]
  \`\`\`
- 📐 LaTeX 公式支持
  - 质能方程：$E = mc^2$
`,
  harnessOffer: "检测到 DeepSeek Harness。要把 Inkmap 思维导图插件安装到 DeepSeek Harness 吗？这会在它的桌面配置中加入 Inkmap 插件索引并安装插件。",
  harnessInstall: "安装",
  harnessNoThanks: "不用了",
  harnessInstalling: "正在把 Inkmap 安装到 DeepSeek Harness…",
  harnessInstalled: "已把 Inkmap 安装到 DeepSeek Harness，重启 DeepSeek Harness 后即可使用。",
  harnessConfigured: "已在 DeepSeek Harness 中加入 Inkmap 插件索引；未找到 dsh 命令，请在 DeepSeek Harness 的「插件」页安装 Inkmap。",
  harnessAlready: "DeepSeek Harness 中已安装 Inkmap。",
  harnessNotFound: "未找到 DeepSeek Harness 桌面版。",
  harnessFailed: "安装到 DeepSeek Harness 失败：{error}",
};

type Key = keyof typeof zh;

const en: Record<Key, string> = {
  openMarkdownFirst: "Open a Markdown file first",
  browserOpened: "Mind map opened in the browser: {url}",
  copyLink: "Copy link",
  browserFailed: "Could not open the mind map in the browser: {error}",
  readOnly: "The document cannot be modified (it may be read-only)",
  trialExpired: "Your 7-day trial has ended. Buy Pro or sign in to an account that has Pro.",
  checkoutFailed: "Could not open checkout.",
  saveExport: "Export",
  onboardingTip: "💡 Inkmap is ready: Open this Markdown file side-by-side as an interactive two-way mind map",
  onboardingAction: "Open Mind Map",
  welcomeTip: "💡 Inkmap Mind Map is installed: Try the interactive welcome mind map, or click “Mind Map” in the status bar on any .md file",
  welcomeAction: "Open Demo Mind Map",
  statusBarLabel: "$(type-hierarchy) Mind Map",
  statusBarTooltip: "Open this Markdown file side-by-side in Inkmap Mind Map",
  codeLensOpen: "⇄ Open as Inkmap Mind Map",
  codeLensOpenTooltip: "Open this Markdown file side-by-side as a two-way editable mind map",
  codeLensBrowser: "Open in Browser",
  codeLensBrowserTooltip: "Open full-screen in browser with live two-way file sync",
  welcomeDoc: `# Welcome to Inkmap Mind Map

- ✨ Two-Way Markdown Sync
  - Double-click any node to edit — changes write directly back to Markdown
  - Press \`Tab\` to add a child node, \`Enter\` to add a sibling node
- 🧭 Quick Entry Points
  - Click **Mind Map** in the bottom-right status bar on any \`.md\` file
  - Or click the Inkmap icon in the editor title bar to open side-by-side
- 📊 Native Mermaid Diagrams
  \`\`\`mermaid
  graph LR
    A[Markdown File] --> B[Inkmap Mind Map]
    B --> C[Two-Way Edit & Export PNG/SVG/HTML]
  \`\`\`
- 📐 LaTeX Math
  - Mass–energy equivalence: $E = mc^2$
`,
  harnessOffer: "DeepSeek Harness is installed. Add the Inkmap mind map plugin to it? This adds the Inkmap plugin index to its desktop profile and installs the plugin.",
  harnessInstall: "Install",
  harnessNoThanks: "No thanks",
  harnessInstalling: "Installing Inkmap in DeepSeek Harness…",
  harnessInstalled: "Inkmap was installed in DeepSeek Harness. Restart DeepSeek Harness to use it.",
  harnessConfigured: "The Inkmap plugin index was added to DeepSeek Harness, but the dsh command was not found. Install Inkmap from the Plugins page in DeepSeek Harness.",
  harnessAlready: "Inkmap is already installed in DeepSeek Harness.",
  harnessNotFound: "DeepSeek Harness desktop was not found.",
  harnessFailed: "Could not install Inkmap in DeepSeek Harness: {error}",
};

const isChinese = () => detectOsLocale() === "zh";

export function t(key: Key, vars: Record<string, string> = {}): string {
  return (isChinese() ? zh : en)[key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}
