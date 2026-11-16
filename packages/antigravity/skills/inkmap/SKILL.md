---
name: inkmap
description: 用 Inkmap 在 Antigravity 右侧辅助面板中将本地 Markdown (.md, .markmap.md) 文件作为可编辑的思维导图打开。当用户要求用 Inkmap、思维导图或脑图查看/编辑 Markdown 文件时使用。
---

# 用 Inkmap 打开 Markdown 思维导图

1. **确认目标 Markdown 文件**：
   - 优先使用用户在消息中 `@` 引用或明确指定的本地 `.md` / `.markmap.md` 文件绝对路径。
   - 如果用户只给出了项目名或文件名（如跨工作区引用），先定位该 `.md` / `.markmap.md` 的绝对路径。
2. **调用 `inkmap_open` MCP 工具切换并激活导图文档**：
   - 调用插件自带的 MCP 工具 `inkmap_open`（归属于 `inkmap_inkmap` 服务，若为懒加载则先读取其 schema 再通过 `call_mcp_tool` 调用），传入：
     ```json
     {
       "path": "/绝对路径/xxx.markmap.md",
       "workspace": "/所属工作区根目录绝对路径"
     }
     ```
   - 该调用会将目标文件同步写入 Inkmap 当前活动文档状态（无需把整份 Markdown 原文读入大模型上下文）；在已开启 MCP Apps 的宿主版本中会自动展开右侧面板，在当前版本中已打开的右侧 Inkmap 面板也会在 1 秒内自动切换到该文档。
3. **在回复中附上一键打开胶囊按钮**：
   - 在回复中输出以下 `sidecar://` 链接，确保当右侧面板尚未打开时用户可一键展开：
     ```markdown
     [Inkmap](sidecar://inkmap/inkmap/)
     ```
   - 简短说明：点击上方按钮（或右侧面板顶部 `+` $\rightarrow$ **Inkmap**，或左侧边栏 **Inkmap**）即可直接编辑思维导图并实时写回原 `.md` 文件。
