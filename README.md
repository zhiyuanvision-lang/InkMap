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

### 操作

| 操作 | 方式 |
| --- | --- |
| 新增子节点 / 同级节点 | `Tab` / `Enter` |
| 编辑文字 | 双击节点，或选中后直接打字；`Enter` 完成 |
| 删除 | `Delete` / `Backspace` |
| 移动 | 拖拽节点 |
| 撤销 / 重做 | `⌘Z` / `⇧⌘Z`，或工具栏按钮 |
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

`Host` 接口把编辑器和文档来源分开：命令行用 HTTP 和 SSE，之后的 VS Code / Cursor 插件可用 webview 消息实现同一接口，复用整个编辑器。

## 开发

```bash
npm test                         # core 单元测试
npm run build && npm test -w inkmap   # 端到端测试（需要本机 Chrome，可用 CHROME_PATH 指定）
npm run dev                      # 编辑器热更新；另开终端运行 inkmap <文件> 提供接口
```

## 计划

- VS Code / Cursor 插件：以自定义编辑器打开 `.md`，复用 `packages/web`
- 节点搜索、大纲多选批量操作、导出图片
