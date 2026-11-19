# Inkmap（墨图）— Editable Markdown Mindmap & Mermaid Flowchart MCP App

[**⚡ Live Browser Playground (Zero Install)**](https://www.zhiyuanv.com/inkmap.html) · [**🌐 Official Website & Docs**](https://www.zhiyuanv.com/software.html) · [**📦 GitHub Repository**](https://github.com/zhiyuanvision-lang/InkMap)

**Inkmap** turns plain local `.md` / `.markmap.md` files into an interactive, two-way synced mind map (**Markmap** alternative) and **Mermaid** flowchart workspace — directly inside **Cursor**, **VS Code**, **DeepSeek Harness (`dsh-inkmap`)**, **Claude Desktop**, **Claude Code**, **OpenAI Codex**, **Google Antigravity**, **Qoder**, **Trae**, or your **local browser**.

![Inkmap Two-Way Live Sync Demo](https://www.zhiyuanv.com/gifs/demo-sync-en.gif)

---

## ⚡ Quick Install (1 Command — macOS / Windows / Linux)

Automatically detect and configure all AI clients & IDEs installed on your machine:

```bash
npx -y inkmap-mcp@latest install
```

| Platform / Client | CLI Target Command | How to Open Inkmap |
| :--- | :--- | :--- |
| **Cursor / VS Code / Trae / Windsurf** | `npx -y inkmap-mcp@latest install cursor` | Click the top-right **Mindmap icon** on any `.md` file, or right-click -> **Open as Inkmap** |
| **DeepSeek Harness** | `npx -y inkmap-mcp@latest install deepseek` | Preview any `.md` file and click **Inkmap** in the top-right preview toolbar |
| **Claude Desktop / Claude Code** | `npx -y inkmap-mcp@latest install claude` | Ask Claude: *"Open `README.md` with Inkmap"* |
| **OpenAI Codex / Antigravity** | `npx -y inkmap-mcp@latest install codex` | Ask the agent to open any `.md` outline in Inkmap (or select **Inkmap Mind Map**) |
| **Standalone 3-Column Browser IDE** | `npx -y inkmap-mcp@latest path/to/notes.md` | Opens full-screen Project File Tree + live Markdown editor + mind map in browser |

### Standard Manual MCP Configuration (`mcp.json`)

```json
{
  "mcpServers": {
    "inkmap": {
      "command": "npx",
      "args": ["-y", "inkmap-mcp@latest", "mcp"]
    }
  }
}
```

---

## ✨ Visual Feature Highlights

### 1. Inline Mermaid Diagrams, KaTeX Math & Markdown Tables
Render and edit `mermaid` flowcharts, sequence diagrams, state machines, KaTeX formulas, and Markdown tables right inside mind map branches (`⌘E` / `Ctrl+E`):

![Inkmap Inline Mermaid & Math Demo](https://www.zhiyuanv.com/gifs/demo-mermaid-en.gif)

### 2. 9 Professional Layouts, Dusk Dark Theme & Presentation Mode
Switch between **Logic Chart, Mind Map, Org Chart, Catalog, Timelines, and Fishbone**, toggle **Dusk dark mode**, present node-by-node in **Presentation Mode**, and export crisp **PNG, vector SVG, or standalone interactive HTML**:

![Inkmap Layouts, Dark Mode & Presentation Demo](https://www.zhiyuanv.com/gifs/demo-layouts-en.gif)

---

## 🇨🇳 中文快速上手指南

![Inkmap 双向实时同步动态演示](https://www.zhiyuanv.com/gifs/demo-sync-zh.gif)

### 1. 一行命令自动接入全平台客户端

```bash
npx -y inkmap-mcp@latest install
```

- **Cursor / VS Code / Trae / Windsurf**：打开任意 `.md` 文件，点击右上角导图分栏图标（或右键选 `Open as Inkmap`），左改源码、右拖脑图毫秒级逐字节双向同步。
- **DeepSeek Harness**：在左侧「插件」页右上角点 `+ 添加插件` 输入 **`dsh-inkmap`** 安装；预览任意 `.md` 时点击右上角 **「Inkmap」** 即可在右侧并排编辑导图与流程图。
- **Claude / Codex / Antigravity**：直接在对话中说 *“用 Inkmap 打开 `xxx.md`”* 即可自动弹出交互导图面板。
- **在线免安装直接试玩**：访问 **[zhiyuanv.com/inkmap.html](https://www.zhiyuanv.com/inkmap.html)**。

### 2. 常用快捷键速查

| 操作 | 快捷键 | 操作 | 快捷键 |
| :--- | :--- | :--- | :--- |
| 新增子节点 / 同级节点 | `Tab` / `Enter` | 编辑节点内 Mermaid / 公式 / 表格 | 双击节点 或 `⌘E` (`Ctrl+E`) |
| 新增父级节点 | `Shift + Tab` | 上下移动同级节点顺序 | `⌘↑` / `⌘↓` (`Alt+↑` / `Alt+↓`) |
| 删除节点 / 自由重组 | `Backspace` / 鼠标拖拽 | 全图搜索与批量替换 | `⌘F` (`Ctrl+F`) |

### 3. 7 天免登录免费试用 & Pro 终身买断（10 端通用）
- 首次使用自动享 **7 天全功能免费试用**（免注册登录，文档 100% 保存在本地磁盘）。
- 在插件右上角账号菜单即可一键开通 **Inkmap Pro 终身版**（一次买断永久使用，无自动续费），登录同一邮箱即可在 **Cursor、VS Code、DeepSeek Harness、Qoder、WorkBuddy、Claude、Codex、Antigravity、Trae** 全端同步激活。详见 [官网说明](https://www.zhiyuanv.com/software.html#inkmap-pricing)。
