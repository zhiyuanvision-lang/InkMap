# Markdown 思维导图 · Inkmap（DeepSeek Harness 原生双向脑图 · 可视化流程图 · 剪贴板贴图）

**AI 智能体输出的几百行冗长复杂 Markdown 看不清主干逻辑？**  
**Inkmap** 在 **DeepSeek Harness 右侧分栏** 将杂乱的本地 `.md` / `.markmap.md` 一键渲染为**条理清晰、可双向拖拽编辑的思维导图**与**可视化 Mermaid 流程图**。支持**剪贴板截图一键粘贴落盘**，每一处修改毫秒级逐字节写回原文件，未改动段落 100% 原样保留。

![Inkmap 双向实时同步演示](https://www.zhiyuanv.com/assets/inkmap/demo-sync-zh.gif)

## 🚀 3 秒上手使用指南

1. **右侧栏一键打开**：在 DeepSeek Harness 中预览任意 `.md` 文件时，点击右上角预览工具栏的 **「Inkmap 思维导图」** 按钮，即可在右侧并排打开可编辑思维导图。
2. **全屏三栏工作台**：需要同时对照项目目录树与源码精修时，点击导图工具栏右上角的 **「浏览器打开」** 即可一键展开全屏三栏 IDE 工作台。
3. **在线免安装体验台**：https://www.zhiyuanv.com/inkmap.html

## ✨ 核心特性动态展示

### 1. 剪贴板截图一键粘贴 & 拖拽插图（自动保存至 `<文档名>.assets/`）
- 选中任意导图节点按 **`⌘V`（`Ctrl+V`）** 粘贴截图（或从文件夹直接拖入 `PNG` / `JPG` / `GIF` / `WebP` 图片），自动作为子图节点插入并渲染；在源码或编辑框内粘贴则直接在光标处插入相对路径链接。
- 图片自动存入同级 `<文档名>.assets/` 文件夹（保留中文可读路径，不覆盖已有文件），无需外接图床，Git 与标准 Markdown 预览器直接兼容。

![Inkmap 剪贴板截图粘贴与自动落盘演示](https://www.zhiyuanv.com/assets/inkmap/demo-paste-zh.gif)

### 2. 节点内嵌可视化 Mermaid 流程图 + LaTeX 公式 + 表格
在节点下放置 ` ```mermaid ` 代码块，直接在导图节点内高清渲染流程图、时序图、状态图；打开大图预览可直接点击流程图节点或连线原地改名、`Tab` 新增后继节点、连线或切换形状，实时写回源码：

![Inkmap 内嵌 Mermaid 流程图编辑演示](https://www.zhiyuanv.com/assets/inkmap/demo-mermaid-zh.gif)

### 3. 9 种专业结构 · 夜色护眼主题 · 全屏逐节点放映
一键切换左右思维导图、逻辑结构图、组织结构图、目录组织图、时间轴、鱼骨图及夜色深色主题；点击 **「演示」** 直接当 PPT 逐节点聚焦汇报，支持导出高清 PNG、矢量 SVG 与离线交互 HTML：

![Inkmap 多布局、深色主题与演示放映](https://www.zhiyuanv.com/assets/inkmap/demo-layouts-zh.gif)

## ⌨️ 常用快捷键速查

| 操作 | 快捷键 / 方式 | 操作 | 快捷键 / 方式 |
| :--- | :--- | :--- | :--- |
| **新增子节点 / 同级节点** | `Tab` / `Enter` | **粘贴剪贴板截图 / 拖入图片** | **`⌘V` (`Ctrl+V`) 或鼠标拖拽图片** |
| **新增父级节点** | `Shift + Tab` | **编辑流程图 / 公式 / 表格源码** | 双击节点 或 `⌘E` (`Ctrl+E`) |
| **上下调整节点顺序** | `⌘↑` / `⌘↓` (`Alt+↑` / `Alt+↓`) | **全图查找与批量替换** | `⌘F` (`Ctrl+F`) |
| **删除 / 拖拽重组** | `Backspace` / 鼠标拖拽 | **立即保存 / 撤销重做** | `⌘S` / `⌘Z` / `⇧⌘Z` |

- **官方网站与全平台支持**：https://www.zhiyuanv.com/software.html
