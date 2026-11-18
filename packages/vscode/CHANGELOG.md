# Changelog

## 0.3.6

- **Multi-Platform Marketplace Search & Discovery Optimization**: Added bilingual search titles, descriptions, and enriched keyword coverage across Open VSX (Cursor, Trae, Windsurf), VS Code Marketplace, Official MCP Registry (`server.json`), Antigravity, Claude, Codex, Qoder, and DeepSeek Harness plugin catalogs.

## 0.3.5

- **Decoupled Category 1 vs. Category 2 Verification Emails**: In-plugin direct checkout emails (Category 1) now show only the 6-digit verification code and Pro perks overview with zero external jump buttons; Category 2 emails include a device-bound Magic Link that automatically signs in the open plugin window without manual code entry and syncs Pro access upon 1-step payment.
- **OS-Level Language & Timezone Detection**: Domestic (`¥29.9`) vs. Overseas (`$15`) edition routing now strictly reads the computer's OS system language and OS timezone (`detectOsLocale`), ignoring IDE/client UI language overrides (`vscode.env.language`), and removes legacy Command Palette browser-redirect commands.

## 0.3.4

- **Streamlined Two-Category Account & Payment UX**:
  - **Category 1 (In-Plugin Direct Checkout)**: VS Code, Cursor, DeepSeek Harness, Qoder, and Browser IDE display payment directly inside the plugin (WeChat Pay QR **¥29.9** for Domestic edition, Card Checkout **\$15** for Overseas edition) with zero redundant browser links or popups.
  - **Category 2 (Inline Email Sign-In + Email Checkout Link)**: OpenAI Codex, Claude Desktop, Claude Code, and Google Antigravity share the unified MCP App codebase and inline 6-digit email verification (auto-verifies immediately on the 6th digit).
- **Strict Domestic (`¥29.9`) vs. Overseas (`$15`) Edition Separation**: Automatic detection by system timezone (`Asia/Shanghai`, etc.) or language (`zh*`) with zero cross-currency leakage across UI and verification emails, plus complete multi-client Pro perks coverage (`Cursor`, `VS Code`, `DeepSeek Harness`, `Qoder`, `WorkBuddy`, `Claude`, `Codex`, `Antigravity`, `Trae`).

## 0.3.3

- **DeepSeek Harness Inline Pro Purchase & Email Verification**: Enabled inline WeChat Pay QR checkout, inline email verification sign-in, and official web checkout links directly inside the DeepSeek Harness sidebar (`dsh-inkmap`).

## 0.3.2

- **DeepSeek Harness Full Integration (`dsh-inkmap`)**: Upgraded the DeepSeek Harness sidebar plugin with the full 3-column workspace controls (Project Explorer + Live Markdown Split Pane + Mind Map), localized Chinese/English plugin metadata & details, automatic cross-client installation from VS Code / Cursor / `inkmap-mcp install`, and official plugin index support (`https://zhiyuanv.com/dsh-index.json`).

## 0.3.1

- **Explicit Save Shortcut (`⌘S` / `Ctrl+S`)**: Intercept `⌘S` / `Ctrl+S` in the capture phase to prevent the browser's "Save Page As" dialog, immediately commit any active inline or Markdown edits, flush the file save to disk, and display a confirmation toast (`已保存 · <filename>`).

## 0.3.0

- **Cursor Right-Pane Instant Preview**: Opening a Markdown mind map via MCP App in Cursor now instructs the agent to auto-open the right-side Browser Preview (`browser_navigate` with `side: true`) on the same turn, and renders a direct clickable preview link on the compact banner so clicking **Open in Right Pane** opens the preview immediately without sending an extra chat prompt.
- **Full Mind Map Keyboard Shortcuts**: Moved mind map shortcut dispatch (`Tab`, `Enter`, `⇧Tab`, `⌘↑` / `⌘↓`, `⌘E`, `⇧/`, `⌫`, `⌘Z` / `⌘⇧Z`, `F2`, and direct typing) to the `window` capture phase so shortcuts work reliably inside Cursor BrowserView without focus-stealing from the left Markdown pane.
- **One-Click Email Magic-Link Checkout & 10-Minute Code Validity**: Clicking the purchase button in verification emails now pre-verifies the recipient email and jumps straight to Step 2 payment with a unified 10-minute verification window.

## 0.2.9

- Unified Email verification code registration & sign-in for both domestic and international users, plus automatic language/timezone detection (`zh` / `Asia/Shanghai`).
- Docked 3-column Browser IDE Workspace (Project File Tree + Live Markdown Split Pane with line numbers & active line highlight + Mind Map) with two-way line-to-node selection sync and complete node context menu shortcuts (`Tab`, `Enter`, `⇧Tab`, `⌘↑`, `⌘↓`, `⌫`).
- Redesigned account & membership popover with direct links to official pricing & web checkout (`zhiyuanv.com/software.html`), on-screen presentation playback controls (`Prev / Next / Exit`), and Cursor 3.30 Glass editor bridge support.

## 0.2.4

- Inline WeChat Pay checkout and phone verification directly inside the account popover, unlocking Pro automatically upon payment.
- Simplified top-right account button (avatar + compact membership badge) and expanded Pro lifetime perks overview.
- Automatically refresh Pro access after sign-in; browser sign-in remains available as an explicit alternative.

## 0.2.3

- Simplify the connected account display and add an English / Chinese language selector to the map and Pro dialog.
- Cursor: select a node and click **Add to Chat** at its top-right corner, or use the node's right-click menu, to send its Markdown lines to the chat.
- Restore Inkmap Pro across supported editors with a Yunfan account.

## 0.2.2

- Simplify the upgrade dialog by hiding the account row until an account is connected.

## 0.2.0

- 7-day free trial with all features. Continued use requires Pro. Pro is a one-time purchase through Yunfan, with all future updates included. Sign in to purchase or restore access.
- Pro: no ads, editing in Chrome, PNG / SVG export, 7 extra layouts, 3 extra themes, find and replace, presentation mode.
- Find nodes in the map (`⌘F` / `Ctrl+F`).
- Layout and theme are saved in the document's front matter.
- English and Chinese interface, following the editor's display language.
- Compact toolbar: expand-to-level menu and icon buttons for undo and redo.

## 0.1.1

- **Open as Inkmap** in the explorer, editor and tab context menus.
- Expand everything under the selected node (`Shift+/`, context menu or toolbar).

## 0.1.0

- Mind map beside the editor, linked to the Markdown cursor both ways.
- Mind map in the browser, written back to the editor's document.
