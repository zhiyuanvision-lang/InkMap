# Changelog

## 0.3.17

- **Edit Flowcharts Directly in the Diagram Viewer**: Click any flowchart node, line or subgraph title to edit it in place — rename, add a next node (`Tab`), add a standalone node, connect two nodes, change the shape, add or remove text on a line, delete, with undo / redo. Every change is written back to the Mermaid block in the Markdown; the source pane no longer pops open on a click (it stays available from the toolbar).
- **Smoother Typing Next to Diagrams**: Editing the Markdown while the diagram viewer is open no longer stutters, the open viewer now follows edits made in the Markdown, and a diagram is redrawn only after a short pause while you type inside its `mermaid` block.
- **Mind Map Layout by Default**: A document that has not chosen a layout opens as a mind map with branches on both sides; documents with a chosen layout are unchanged.
- **Two-Way Sync Fixes**: An outside change is no longer overwritten by stale text in the Markdown pane or wrongly marked as saved; the save status recovers after an undo; `⌘S` no longer reports "Saved" when the save failed. Shortcut labels read `Ctrl` / `Shift` on Windows and Linux.
- **Account & Payment**: A paid account keeps Pro for 7 days while the billing server cannot be reached; an in-plugin payment in progress is no longer interrupted by another Inkmap client on the same computer; the end-of-trial sign-in form can no longer be dismissed with `Esc`.
- **Installer**: `inkmap install` now detects VS Code, Trae, Windsurf and VSCodium as well, and keeps the permissions and symlinks of the client configuration files it updates. Antigravity lists Inkmap once instead of twice.
- **Hardening**: `<style>` and `<form>` in a Markdown file can no longer restyle the editor; "Open in Browser" no longer hangs on Linux; the MCP server exits when its client disconnects.

## 0.3.16

- **DeepSeek Harness Visibility & Linux Host Fix**: Upgraded the Markdown toolbar button to a high-contrast `Inkmap 思维导图` / `Inkmap Mind Map` pill for instant discoverability, and allowed wildcard (`0.0.0.0` / `::`) local server binds on Linux/WSL/Docker while still strictly enforcing loopback client connections.

## 0.3.13

- **Streamlined Extension Display Title**: Refined Marketplace & Open VSX display title (`Inkmap — Markdown Mindmap & Markmap 思维导图`) for cleaner tab/sidebar readability and higher search relevance.

## 0.3.12

- **Top-of-Document Markdown CodeLens Quick Actions**: Added non-intrusive `⇄ Open as Inkmap Mind Map | Open in Browser` (`⇄ 用 Inkmap 思维导图打开 | 浏览器全屏打开`) CodeLens buttons at line 1 of every `.md` file so newly installed users can open a side-by-side editable mind map or full-screen browser canvas in a single click (configurable via `inkmap.codeLens`).

## 0.3.11

- **DeepSeek Harness Setup Now Asks First**: The extension no longer edits DeepSeek Harness's desktop profile or runs `dsh plugin add` on its own at startup. The first time it finds DeepSeek Harness without the Inkmap plugin, it asks once (Install / No thanks) and remembers the answer; the new **Inkmap: Install in DeepSeek Harness** command installs it at any time.
- **Fewer Steps to Sign In & Pay**: The email field is prefilled with the last address used on this computer. On Claude, Codex and Antigravity panels, the end-of-trial screen opens the email form directly, and paying from the email unlocks Pro automatically without typing the code — even when the email is opened late, an earlier email is used, or the code was entered before paying.
- **Markdown Round-Trip Fixes**: Front matter with non-ASCII or spaced keys (such as `标题:` or `Last Modified:`) is recognized; quoted titles round-trip; a lone `-` or `2024.` line no longer splits a paragraph; a code fence left open in a node no longer swallows the nodes after it; UTF-8 BOM and CRLF files are written back unchanged.
- **Mermaid & Editing Fixes**: "Edit diagram" selects the right Mermaid block even when other code blocks contain Mermaid samples; an invalid diagram is no longer re-rendered on every keystroke; braces inside quoted flowchart labels are kept; switching files with an unsaved edit now says that the edit was not written.
- **Browser Editor Hardening**: "Open in Browser" only answers its own loopback or VS Code port-forwarded address and same-origin writes (blocking DNS rebinding), opens symlinked files as the same document, and also serves `.avif`, `.bmp` and `.ico` images.

## 0.3.10

- **Studio Animated GIF Walkthroughs & Upgraded Visual Usage Guide**: Replaced static Marketplace & repository screenshots with three annotated animated GIF demos (real-time Markdown ⇄ Mindmap line sync & `Tab` write-back, inline Mermaid flowchart & KaTeX `⌘E` live source editing, and 9 layouts + Dusk dark theme + fullscreen spotlight presentation) alongside a streamlined 3-second quick-start and shortcut cheat sheet.

## 0.3.9

- **First-Run Markdown Onboarding & Multi-Host Activation Funnel**: Added a one-time side-by-side mind map quick-open tip when opening a Markdown file for the first time, plus accurate activation funnel & host detection across VS Code, Cursor, Trae, Windsurf, Qoder, DeepSeek Harness, and MCP clients.
- **Store Listing Animated Demo & `Mindmap` Search Ranking**: Added animated two-way Markdown & Mermaid showcase GIFs, live browser playground link (`zhiyuanv.com/inkmap.html`), and exact `Mindmap` title indexing across VS Code Marketplace and Open VSX.

## 0.3.8

- **Redesigned Brand Icon**: Crafted a clean, high-contrast Aurora Mind Tree squircle icon (`icon.svg` / `icon.png`) and browser tab favicon, sharp from 16×16 IDE tab pills up to 400×400 Marketplace banners.
- **Unified "Open in Browser" (`浏览器打开`) Toolbar Action**: Added a one-click full-screen browser launch button across VS Code, Cursor, Antigravity Sidecar, DeepSeek Harness, Qoder, Claude, and Codex with live two-way file sync (automatically hidden when already inside a standalone browser window).
- **Antigravity One-Click Mind Map Pill & Rich Markdown Rendering**: Added automatic `sidecar://inkmap/inkmap/` entrypoint rules, lossless horizontal-rule (`---`) & unindented fenced block round-tripping, formatted nested ```` ```markdown ```` cards, CJK punctuation-flanked bold (`**“...”**`), and automatic line wrapping inside code blocks.

## 0.3.7

- **Interactive Standalone HTML Export & Store ASO**: Added zero-dependency interactive HTML export (`exportAs("html")`), trial PNG/SVG watermark (removed automatically for Pro), and `AI` / `Notebooks` Marketplace categories.

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
