# Inkmap 墨图

把 Markdown 大纲当作思维导图来编辑。导图里的改动会实时写回 Markdown，Markdown 的改动也会实时出现在导图里。

## 两种用法

- **编辑器旁边**：打开 `.md` 文件，点编辑器右上角的导图按钮，或在资源管理器、编辑区、标签页上右键选「Open as Inkmap」，左栏是 Markdown、右栏是思维导图。
- **浏览器**：点地球按钮（或命令「Inkmap: 在浏览器中打开思维导图」），在 Chrome 中编辑导图；改动写回编辑器中的文档并自动保存。

两栏联动：在 Markdown 中移动光标，导图会定位到对应节点；点击导图节点，Markdown 跳到对应行。

## 导图操作

| 操作 | 按键 |
| --- | --- |
| 新增同级 / 子节点 | Enter / Tab |
| 编辑节点 | 双击，或选中后直接输入 |
| 编辑表格、图片等富内容 | 双击节点，或 Cmd/Ctrl+E 打开源码面板 |
| 删除 | Delete / Backspace |
| 展开选中节点的所有子孙节点 | Shift+/，右键节点菜单，或工具栏「展开子孙」 |
| 撤销 / 重做 | Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z（编辑器中，与 Markdown 共用撤销记录）；Cmd/Ctrl+Z / Cmd/Ctrl+Y（浏览器中） |
| 移动节点 | 拖动 |

## 设置

- `inkmap.browser`：`chrome`（默认）或 `default`（系统默认浏览器）。
- `inkmap.browserAutoSave`：浏览器中修改后是否自动保存文档，默认开启。
