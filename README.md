# Inkmap（墨图）

把 Markdown 大纲当作思维导图来编辑：在浏览器里像飞书思维导图一样增删、拖拽、改写节点，改动实时写回 `.md` 文件；文件在编辑器里或被 AI 智能体修改后，导图自动刷新。

文档始终是普通 Markdown，Cursor、Codex 等智能体可以直接读写。基于 [simple-mind-map](https://github.com/wanglin2/mind-map) 绘制。

## 使用

```bash
npm install
npm run build
npm install -g ./packages/cli   # 安装 inkmap 命令

inkmap path/to/outline.md        # 打开浏览器编辑
inkmap outline.md --port 5000 --no-open
```

### VS Code / Cursor 插件

```bash
npm run package:vscode
cursor --install-extension packages/vscode/dist/inkmap.vsix   # VS Code 用 code --install-extension
```

打开 `.md` 文件后，编辑器右上角有两个按钮（资源管理器右键菜单和命令面板里也有）：

- **在侧边打开思维导图**：左栏 Markdown、右栏导图，改动直接进入编辑器中的文档（与 Markdown 共用撤销记录，`⌘Z` / `⇧⌘Z`）。在 Markdown 中移动光标，导图定位到对应节点；点导图节点，Markdown 跳到对应行。
- **在浏览器中打开思维导图**：在 Chrome 中编辑，改动写回编辑器中的文档并自动保存。设置 `inkmap.browser` 可改为系统默认浏览器，`inkmap.browserAutoSave` 可关闭自动保存。

`.md` 默认仍用普通编辑器打开；也可以右键标签页选「重新打开编辑器的方式…」→「Inkmap 思维导图」。

### 操作

| 操作 | 方式 |
| --- | --- |
| 新增子节点 / 同级节点 | `Tab` / `Enter` |
| 编辑文字 | 双击节点，或选中后直接打字；`Enter` 完成 |
| 删除 | `Delete` / `Backspace` |
| 移动 | 拖拽节点 |
| 撤销 / 重做 | `⌘Z` / `⌘Y`，或工具栏按钮（插件中为 `⌘Z` / `⇧⌘Z`） |
| 编辑表格、图片、多行内容 | 双击该节点，或选中后 `⌘E`，在右侧面板改 Markdown 源码 |
| 平移 / 缩放 | 触控板或滚轮平移，`⌘` + 滚轮或双指捏合缩放 |

在节点里输入 Markdown 语法（如 `**加粗**`、`` `代码` ``）后会按 Markdown 渲染。

### 文件格式

- 标题和列表项都是节点；只有一个顶级标题时它就是根节点，否则用 front matter 的 `title` 作根节点。
- 列表项下缩进的内容（续行、表格、图片）属于该节点。图片标题写数字时作为显示宽度：`![图](a.png "600")`。
- front matter 中 `markmap.layout: two-sided` 时左右两侧展开，否则向右展开。
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
npm test                         # core 单元测试
npm run build && npm test -w inkmap   # 端到端测试（需要本机 Chrome，可用 CHROME_PATH 指定）
npm test -w inkmap-vscode        # 插件 webview 消息协议测试（需先 build）
npm run dev                      # 编辑器热更新；另开终端运行 inkmap <文件> 提供接口
```

## 计划

- 节点搜索、大纲多选批量操作、导出图片
