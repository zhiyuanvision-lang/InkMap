---
name: inkmap
description: 用 Inkmap 在 Antigravity 右侧辅助面板中将本地 Markdown (.md, .markmap.md) 文件作为可编辑的思维导图打开。当用户要求用 Inkmap、思维导图或脑图查看/编辑 Markdown 文件时使用。
---

# 在 Antigravity 右侧面板打开 Inkmap 思维导图

1. **确认目标 Markdown 文件**：
   - 优先使用用户在消息中 `@` 引用或明确指定的本地 `.md` / `.markmap.md` 文件路径。
   - 如果用户未指定具体文件，先在当前工作区查找 `.markmap.md` 或 `.md` 文件；若有多个候选文件且意图不唯一，请用户选择。
2. **切换 Inkmap 右侧面板的当前文件**：
   运行本技能所属插件中的 `sidecars/inkmap/select.mjs`（无需读取 Markdown 正文），将目标文件设为 Inkmap 面板的当前活动文档：
   ```bash
   node "<插件目录>/sidecars/inkmap/select.mjs" "<目标 Markdown 文件绝对路径>"
   ```
   > 若已安装到全局配置，默认路径为 `~/.gemini/config/plugins/inkmap/sidecars/inkmap/select.mjs`。
3. **在回复中提供一键打开胶囊按钮**：
   在回复中输出以下 `sidecar://` 链接，方便用户一键在 Antigravity 右侧辅助面板打开或聚焦 Inkmap 思维导图：
   ```markdown
   [Inkmap](sidecar://inkmap/inkmap/)
   ```
   同时简短说明：点击上方按钮（或右侧面板顶部 `+` → **Inkmap**）即可在右侧直接编辑导图，所有增删改查实时写回原 `.md` 文件，也可在导图顶部下拉框随时切换其他 Markdown 文件或点击「源码」对照查看。
