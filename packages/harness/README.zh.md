# Inkmap 思维导图（DeepSeek Harness 原生双向脑图与流程图工作台）

将工作区内的本地 Markdown (`.md` / `.markmap.md`) 文件直接在 **DeepSeek Harness 右侧分栏** 渲染为可交互、可双向拖拽编辑的思维导图（Markmap 增强替代）与 Mermaid 流程图。修改导图毫秒级逐字节写回原文件，未改动段落 100% 原样保留。

![Inkmap 双向实时同步演示](https://www.zhiyuanv.com/assets/inkmap/demo-sync-zh.gif)

## 🚀 3 秒上手使用指南

1. **右侧栏一键打开**：在 DeepSeek Harness 中预览任意 `.md` 文件时，点击右上角预览工具栏的 **「Inkmap」** 按钮，即可在右侧并排打开可编辑思维导图。
2. **全屏三栏工作台**：需要同时对照项目目录树与源码精修时，点击导图工具栏右上角的 **「浏览器打开」** 即可一键展开全屏三栏 IDE 工作台。
3. **在线免安装体验台**：https://www.zhiyuanv.com/inkmap.html

## ✨ 核心特性动态展示

### 1. 节点内嵌 Mermaid 流程图 + LaTeX 公式 + 表格实时编辑
在节点下放置 ` ```mermaid ` 代码块，支持直接在导图节点内高清渲染流程图、时序图、状态图，点击 **「编辑流程图源码」**（`⌘E`）即可实时修改重绘，支持独立弹窗无损缩放：

![Inkmap 内嵌 Mermaid 流程图编辑演示](https://www.zhiyuanv.com/assets/inkmap/demo-mermaid-zh.gif)

### 2. 9 种专业结构 · 夜色护眼主题 · 全屏逐节点放映
一键切换逻辑结构图、左右思维导图、组织结构图、目录组织图、时间轴、鱼骨图及夜色深色主题；点击 **「演示」** 直接当 PPT 逐节点聚焦汇报，支持导出高清 PNG、矢量 SVG 与离线交互 HTML：

![Inkmap 多布局、深色主题与演示放映](https://www.zhiyuanv.com/assets/inkmap/demo-layouts-zh.gif)

## ⌨️ 常用快捷键速查

| 操作 | 快捷键 / 方式 | 操作 | 快捷键 / 方式 |
| :--- | :--- | :--- | :--- |
| **新增子节点** | `Tab` | **编辑流程图 / 公式 / 表格源码** | 双击节点 或 `⌘E` (`Ctrl+E`) |
| **新增同级节点** | `Enter` | **上下调整节点顺序** | `⌘↑` / `⌘↓` (`Alt+↑` / `Alt+↓`) |
| **新增父级节点** | `Shift + Tab` | **全图查找与批量替换** | `⌘F` (`Ctrl+F`) |
| **删除 / 拖拽重组** | `Backspace` / 鼠标拖拽 | **立即保存 / 撤销重做** | `⌘S` / `⌘Z` / `⇧⌘Z` |

- **官方网站与全平台支持**：https://www.zhiyuanv.com/software.html
