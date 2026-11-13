# Inkmap for Google Antigravity

在 **Antigravity 2.0** 右侧辅助面板（Auxiliary Pane）中把本地工作区的 Markdown（`.md`、`.markmap.md`）作为思维导图打开和编辑，修改实时写回原文件；AI 智能体或文本编辑器修改文件后，导图自动刷新。

## 安装（Antigravity 2.0 桌面端）

解压 `inkmap-antigravity-0.1.0.zip` 后，在解压目录运行：

```bash
node install.mjs
```

安装脚本会将插件配置到 `~/.gemini/config/plugins/inkmap`。

## 使用方式

1. **从右侧面板直接打开**：
   点击对话或右侧面板顶部的 **`+`** 按钮，选择 **Inkmap**，即可在右侧面板打开当前工作区的 Markdown 思维导图。
2. **在顶部下拉框切换文档 / 对照源码**：
   - 导图工具栏左侧的下拉框会自动列出当前工作区及已注册项目中的所有 `.markmap.md` 和 `.md` 文件（`.markmap.md` 优先置顶），点击即可切换。
   - 点击下拉框旁的 **「源码」** 按钮，可在右侧辅助面板并排打开原始 Markdown 文件视图。
3. **从对话中唤起**：
   在对话中输入「用 Inkmap 打开 `@xxx.md`」，AI 会自动将该文件设为当前导图文档，并给出 `[Inkmap](sidecar://inkmap/inkmap/)` 一键打开按钮。
4. **节点发送到对话**：
   选中导图中的任意节点，点击浮动的 **「发送到对话」**，即可将该节点对应的 Markdown 片段附加到当前 Antigravity 对话输入框。

## Antigravity IDE（基于 VS Code）

如果你使用的是 **Antigravity IDE**，也可以直接安装 VS Code 扩展包 `inkmap.vsix`，在文件右键菜单选择「Open as Inkmap」或在编辑器右上角点击「在侧边打开思维导图」。
