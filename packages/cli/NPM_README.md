# Inkmap — Interactive Markdown Mind Map & MCP App

**Inkmap（墨图）** opens and edits local `.md` / `.markmap.md` files as an interactive, two-way synced mind map — directly inside **DeepSeek Harness (`dsh-inkmap`)**, **Claude Desktop**, **OpenAI Codex Desktop**, **Google Antigravity**, **Cursor**, **Claude Code**, **VS Code**, or your **local browser** (macOS, Ubuntu/Linux, Windows).

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
npx -y inkmap-mcp@latest install deepseek      # DeepSeek Harness (dsh-inkmap)
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

无需手动下载压缩包或手改 JSON 路径，终端执行一行命令即可自动检测并配置本机已安装的 **DeepSeek Harness (`dsh-inkmap`)、Claude Desktop、Claude Code、Google Antigravity、OpenAI Codex、Cursor**：

```bash
npx -y inkmap-mcp@latest install
```

在 **DeepSeek Harness** 中，你也可以直接在左侧 **「插件」** 页面：
- 点击右上角 **「+ 添加插件」** 输入 **`dsh-inkmap`** 一键安装；
- 或开启「实验性插件 -> 自定义插件索引」，添加索引源 **`https://zhiyuanv.com/dsh-index.json`**，在「发现」标签页搜索 **「思维导图」** 即可找到并安装 **Inkmap 思维导图**。

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

### 3. 7 天免费试用与 Pro 终身版开通（跨客户端账号同步）

- **7 天全功能免费试用**：首次安装后即可免登录使用全部功能 7 天。
- **如何购买与激活 Inkmap Pro 终身版（¥29.90 一次买断 · 永久使用）**：
  1. **前往官网或独立工作台开通**：
     - **官方网站直达**：[https://zhiyuanv.com/software.html#inkmap-pricing](https://zhiyuanv.com/software.html#inkmap-pricing)（¥29.90 微信扫码一次买断，免费包含后续全部更新）；
     - **或本地独立浏览器 / VS Code 扩展内开通**：在终端运行 `npx -y inkmap-mcp@latest 你的文档.md` 或在 VS Code 扩展内点击右上角 **「购买 Pro」**。
  2. **在各 AI 客户端内一键同步权益**：
     - 遵循各客户端应用商店规范，Claude / ChatGPT Codex / Cursor / Antigravity 的对话内嵌导图面板仅展示「登录」入口（不展示价格与付款链接）。
     - 您在官网或独立工作台开通 Pro 后，只需在任意客户端导图右上角点击 **「登录」** 并验证同一账号，**Pro 终身权益即刻自动跨端同步**！

### 4. 卸载配置

```bash
npx -y inkmap-mcp@latest uninstall
```

---

## Free Trial & Lifetime Pro (Cross-Client Sync)

- **7-Day Free Trial**: Enjoy full access to all features for 7 days from first use — no credit card or sign-in required.
- **How to Upgrade & Sync Pro Across All Clients (US\$15.00 Lifetime)**:
  1. **Purchase Lifetime Pro on the Official Website**: Visit [https://zhiyuanv.com/software.html#inkmap-pricing](https://zhiyuanv.com/software.html#inkmap-pricing) (**US\$15.00** one-time purchase via international bank card, all future updates included), or run `npx -y inkmap-mcp@latest notes.md` in your browser and click **Buy Pro**.
  2. **Sign In Anywhere to Sync**: Inside embedded MCP App panels (Claude Desktop, OpenAI Codex, Cursor, Google Antigravity), click **Sign in** in the top-right corner with the same account — your Lifetime Pro entitlement syncs automatically across every client and device.

---

## Links & License

- **Official Website & Pricing**: [https://zhiyuanv.com/software.html#inkmap-pricing](https://zhiyuanv.com/software.html#inkmap-pricing)
- **VS Code Extension**: [Inkmap on VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=inkmap.inkmap-vscode) | [Open VSX Registry](https://open-vsx.org/extension/inkmap/inkmap-vscode)
- **Pricing**: 7-day full-featured free trial; one-time lifetime Pro license linked to your account across devices.
- **License**: Proprietary EULA (`SEE LICENSE IN LICENSE.md`); bundled open-source notices in `THIRD_PARTY_NOTICES.md`.
