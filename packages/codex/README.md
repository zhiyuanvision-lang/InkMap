# Inkmap for Codex 桌面版

在 ChatGPT 桌面应用的 Codex 模式中，把本地 Markdown 文件作为思维导图在对话右侧打开。

1. 安装或更新 ChatGPT 桌面应用和 [Node.js 22 或更新版本](https://nodejs.org/)。macOS 上安装脚本会尝试使用 ChatGPT 自带的 Codex CLI。如果找不到 `codex`，请安装或更新 [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) 后重新打开终端。
2. 解压 ZIP，在解压后的 `inkmap-codex-desktop` 文件夹中打开终端，运行：

   ```sh
   node install.mjs
   ```

3. 完全退出并重新打开 ChatGPT 桌面应用。在 Codex 模式下进入本地项目，打开 `.md` 或 `.markmap.md` 文件，从文件的打开菜单选 **Inkmap Mind Map**。导图会出现在右侧。文件可写时，编辑会保存回原 Markdown。

安装后可以删除解压目录。更新时用新版 ZIP 重复第 2、3 步。若旧会话里显示「未能显示 Inkmap Mind Map」，请在同一项目的新会话里重新打开文件。

如果之前从源码目录安装过 Inkmap，可运行 `codex plugin marketplace remove inkmap-local` 移除旧插件源，再运行安装脚本。

## English

Install or update ChatGPT desktop and Node.js 22 or later. On macOS the installer can use the CLI bundled with ChatGPT. If the installer cannot find `codex`, install or update the [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) and reopen your terminal.

Unzip the package, open a terminal in `inkmap-codex-desktop`, and run `node install.mjs`. Quit and relaunch ChatGPT desktop. In Codex mode, open a Markdown file from a local project and select **Inkmap Mind Map** from the file's open menu. Edits are saved to the original Markdown when the file is writable.

Run the installer from a newer ZIP to update. If a chat opened before installation cannot display Inkmap, open the file in a new chat in the same project.

If you previously installed Inkmap from a source checkout, run `codex plugin marketplace remove inkmap-local` to remove the old marketplace, then run the installer.
