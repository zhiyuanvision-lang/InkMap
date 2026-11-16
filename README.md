# Inkmap（墨图）

把 Markdown 大纲当作思维导图来编辑：在浏览器里像飞书思维导图一样增删、拖拽、改写节点，改动实时写回 `.md` 文件；文件在编辑器里或被 AI 智能体修改后，导图自动刷新。

文档始终是普通 Markdown，Cursor、Codex 等智能体可以直接读写。基于 [simple-mind-map](https://github.com/wanglin2/mind-map) 绘制。

在 ChatGPT 桌面应用的 Codex 模式下，可以从 Markdown 文件的打开菜单选择 **Inkmap Mind Map**，在右侧查看和编辑导图。见 [Codex 桌面版安装说明](packages/codex/README.md)。

其他编辑器和桌面应用的接入方式见 [多平台安装与验收](SIDEBARS.md)。

## 一键安装（支持 Claude / Cursor / Codex / Antigravity / VS Code）

### 1. 自动配置本机所有 AI 客户端（MCP App + 编辑器扩展）

在终端执行一行命令，自动检测并安装到本机已有的 **Claude Desktop、Claude Code、Cursor、Google Antigravity、OpenAI Codex Desktop**：

```bash
npx -y inkmap-mcp@latest install
```

### 2. VS Code / Cursor / Trae / Windsurf 插件市场安装

- **VS Code 官方市场**：[Inkmap on VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=inkmap.inkmap-vscode)
- **Open VSX 市场（Cursor / Windsurf / Trae）**：[Inkmap on Open VSX](https://open-vsx.org/extension/inkmap/inkmap-vscode)

### 3. 本地命令行直接用浏览器打开

```bash
npx -y inkmap-mcp@latest path/to/outline.md
```

### 4. 源码构建与开发安装

```bash
npm install
npm run build
npm install -g ./packages/cli   # 安装 inkmap 命令

inkmap path/to/outline.md        # 打开浏览器编辑
inkmap outline.md --port 5000 --no-open
```

打开 `.md` 文件后，编辑器右上角有两个按钮（资源管理器右键菜单和命令面板里也有）：

- **在侧边打开思维导图**（右键菜单中为「Open as Inkmap」）：左栏 Markdown、右栏导图，改动直接进入编辑器中的文档（与 Markdown 共用撤销记录，`⌘Z` / `⇧⌘Z`）。在 Markdown 中移动光标，导图定位到对应节点；点导图节点，Markdown 跳到对应行。
- **在浏览器中打开思维导图**：在 Chrome 中编辑，改动写回编辑器中的文档并自动保存。设置 `inkmap.browser` 可改为系统默认浏览器，`inkmap.browserAutoSave` 可关闭自动保存。

`.md` 默认仍用普通编辑器打开；也可以右键标签页选「重新打开编辑器的方式…」→「Inkmap 思维导图」。

### 操作

| 操作 | 方式 |
| --- | --- |
| 新增子节点 / 同级节点 | `Tab` / `Enter` |
| 编辑文字 | 双击节点，或选中后直接打字；`Enter` 完成 |
| 删除 | `Delete` / `Backspace` |
| 展开选中节点的所有子孙节点 | `⇧/`，右键节点菜单，或工具栏「展开子孙」 |
| 移动 | 拖拽节点 |
| 撤销 / 重做 | `⌘Z` / `⌘Y`，或工具栏按钮（插件中为 `⌘Z` / `⇧⌘Z`） |
| 编辑表格、图片、多行内容 | 双击该节点，或选中后 `⌘E`，在右侧面板改 Markdown 源码 |
| 平移 / 缩放 | 触控板或滚轮平移，`⌘` + 滚轮或双指捏合缩放 |

在节点里输入 Markdown 语法（如 `**加粗**`、`` `代码` ``）后会按 Markdown 渲染。

### 7 天免费试用与 Pro 终身版购买（跨端账号同步）

首次使用起可免登录试用全部功能 7 天。到期后一次性买断 **Inkmap Pro 终身版**（**¥29.90 微信扫码一次买断**，包含后续全部更新）即可永久使用，原始 Markdown 文件始终可在任意文本编辑器中打开。

- **开通入口**：
  1. **官方网站购买与下载**：[https://zhiyuanv.com/software.html#inkmap-pricing](https://zhiyuanv.com/software.html#inkmap-pricing)
  2. **独立浏览器工作台 / VS Code 插件内购买**：运行 `npx -y inkmap-mcp@latest 你的文件.md` 或在 VS Code 扩展导图右上角点击 **「购买 Pro」**。
- **在 AI 客户端（MCP App）内同步权益**：
  - 遵循各客户端商店规范，内嵌 MCP App 面板仅提供中性的 **「登录」** 按钮（不展示价格与外链）。
  - 您在官网或独立工作台完成购买后，在 Claude、Codex、Cursor、Antigravity、VS Code 任一客户端右上角点击 **「登录」** 并验证同一账号，Pro 终身权益即刻自动跨端同步。

### 文件格式

- 标题和列表项都是节点；只有一个顶级标题时它就是根节点，否则用 front matter 的 `title` 作根节点。
- 列表项下缩进的内容（续行、表格、图片）属于该节点。图片标题写数字时作为显示宽度：`![图](a.png "600")`。
- 工具栏选的结构和配色保存在 front matter 的 `inkmap.layout`、`inkmap.theme` 中；没有设置时，`markmap.layout: two-sided` 表示左右两侧展开，否则向右展开。
- 没有改动的部分按原文写回；新增或移动的节点使用 `- ` 和两个空格缩进。

## 结构

| 包 | 作用 |
| --- | --- |
| `packages/core` | Markdown 与节点树互转，保证无改动时逐字节还原 |
| `packages/web` | 浏览器编辑器（Vite 构建），通过 `Host` 接口读写文档 |
| `packages/cli` | `inkmap` 命令：本地 HTTP 服务、文件监听、推送外部修改 |
| `packages/vscode` | VS Code / Cursor 插件：侧边导图（webview 自定义编辑器）和浏览器导图（复用 cli 的服务） |

`Host` 接口把编辑器和文档来源分开：命令行和插件的浏览器模式用 HTTP 和 SSE，插件的侧边导图用 webview 消息，复用同一个编辑器。

## 开发

```bash
npm run build && npm test       # 全部测试：core 单元测试、命令行端到端、插件 webview、发码服务（需要本机 Chrome，可用 CHROME_PATH 指定）
npm run dev                      # 编辑器热更新；另开终端运行 inkmap <文件> 提供接口
```

## 计划

- 大纲多选批量操作
