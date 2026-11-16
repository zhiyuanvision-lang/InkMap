# Inkmap MCP App for Google Antigravity

基于 **MCP App（`@modelcontextprotocol/ext-apps`）** 标准，在 **Antigravity 2.0** 右侧辅助面板（Auxiliary Pane）及左侧全局面板中将本地工作区的 Markdown（`.md`、`.markmap.md`）作为交互式思维导图打开与编辑，修改实时写回原文件；AI 修改文件或调用 `inkmap_open` 工具时，右侧导图面板自动弹出并实时刷新。

## 安装（Antigravity 2.0 桌面端）

解压 `inkmap-antigravity-0.2.0.zip` 后，在解压目录运行：

```bash
node install.mjs
```

安装脚本会将插件配置到 `~/.gemini/config/plugins/inkmap`。

## 使用方式

1. **在对话中自动弹出（推荐）**：
   直接在对话中告诉 AI：「用 Inkmap 打开 `@xxx.md`」或「把方案整理成思维导图并用 Inkmap 打开」。AI 调用 `inkmap_open` 工具后，**右侧辅助面板会自动展开 Inkmap 思维导图**。
2. **从界面直接点开**：
   - 点击右侧辅助面板顶部的 **`+`** 按钮 $\rightarrow$ 选择 **Inkmap**；
   - 或在左侧边栏点击 **Inkmap** 打开全宽导图画布。
3. **文件切换与分屏对照**：
   - 导图工具栏左上角的下拉框会自动列出当前工作区及已注册项目中的所有 `.markmap.md` 和 `.md` 文件，点击即可切换。
   - 点击 **「左MD/右导图」** 可开启左侧源码 + 右侧导图同屏对比编辑；点击 **「原文件」** 可在右侧辅助面板并排打开原生文件视图。
4. **节点发送到对话**：
   选中导图中的任意节点，点击浮动的 **「发送到对话」**，该节点对应的 Markdown 片段会自动作为上下文胶囊挂载到聊天输入框。

## Antigravity IDE（基于 VS Code）

如果你使用的是 **Antigravity IDE**，也可以直接安装 VS Code 扩展包 `inkmap.vsix`，在文件右键菜单选择「Open as Inkmap」或在编辑器右上角点击「在侧边打开思维导图」。
