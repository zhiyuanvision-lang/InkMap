# Inkmap — Interactive Markdown Mind Map & MCP App

**Inkmap（墨图）** opens and edits local `.md` / `.markmap.md` files as an interactive, two-way synced mind map — directly inside **Claude Desktop**, **OpenAI Codex Desktop**, **Google Antigravity**, **Cursor**, **Claude Code**, **VS Code**, or your **local browser** (macOS, Ubuntu/Linux, Windows).

- **Two-way live sync**: Edit nodes on the mind map or let your AI agent rewrite the `.md` file — both stay in sync instantaneously without corrupting Markdown formatting, tables, code blocks, KaTeX math, or Mermaid diagrams.
- **Native MCP App (`@modelcontextprotocol/ext-apps`)**: Renders the interactive mind map canvas (`ui://inkmap/markdown.html`) directly inside MCP App-enabled AI clients.
- **100% Local Privacy**: Your Markdown documents stay on your machine and are never uploaded.

---

## Quick Install (One Command — macOS / Ubuntu / Windows)

Automatically detect and configure all AI clients installed on your machine (Claude Desktop, Claude Code, Cursor, Google Antigravity, OpenAI Codex):

```bash
npx -y inkmap-mcp@latest install
```

Or target a specific client:

```bash
npx -y inkmap-mcp@latest install claude        # Claude Desktop (macOS / Windows / Ubuntu)
npx -y inkmap-mcp@latest install claude-code   # Claude Code CLI
npx -y inkmap-mcp@latest install antigravity   # Google Antigravity
npx -y inkmap-mcp@latest install codex         # OpenAI Codex Desktop
npx -y inkmap-mcp@latest install cursor        # Cursor
```

Optionally pre-authorize workspace directories:

```bash
npx -y inkmap-mcp@latest install claude --workspace ~/projects
```

---

## Standard MCP Server Configuration

If you prefer adding Inkmap manually to `claude_desktop_config.json`, `.cursor/mcp.json`, or via `claude mcp add`:

```bash
claude mcp add --scope user inkmap -- npx -y inkmap-mcp@latest mcp
```

```json
{
  "mcpServers": {
    "inkmap": {
      "command": "npx",
      "args": ["-y", "inkmap-mcp@latest", "mcp"]
    }
  }
}
```

Then ask your AI assistant:
> *"Open `docs/architecture.markmap.md` with Inkmap"*

---

## Local Browser Mode (CLI)

Open any Markdown outline directly in your default browser with live two-way file sync:

```bash
npx -y inkmap-mcp@latest notes.markmap.md
```

---

## 中文快速指南

### 1. 一键自动安装到本机 AI 客户端（支持 Ubuntu / macOS / Windows）

无需手动下载压缩包或手改 JSON 路径，终端执行一行命令即可自动检测并配置本机已安装的 **Claude Desktop、Claude Code、Google Antigravity、OpenAI Codex、Cursor**：

```bash
npx -y inkmap-mcp@latest install
```

也可以指定单个客户端或预设工作区目录：

```bash
npx -y inkmap-mcp@latest install claude --workspace ~/projects
```

安装完成后重启对应客户端，在对话中直接说：
> *“用 Inkmap 打开 `xxx.markmap.md`”*

### 2. 本地浏览器独立打开 Markdown 导图

```bash
npx -y inkmap-mcp@latest 你的文档.markmap.md
```

### 3. 卸载配置

```bash
npx -y inkmap-mcp@latest uninstall
```

---

## Links & License

- **Website & Downloads**: https://www.zhiyuanv.com/software.html
- **VS Code Extension**: [Inkmap on VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=inkmap.inkmap-vscode)
- **Pricing**: 7-day full-featured free trial; one-time lifetime Pro license linked to your account across devices.
- **License**: Proprietary EULA (`SEE LICENSE IN LICENSE.md`); bundled open-source notices in `THIRD_PARTY_NOTICES.md`.
