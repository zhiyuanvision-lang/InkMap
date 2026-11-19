# Inkmap Monorepo — AI Agent Architecture & Multi-Platform Sync Guide

Whenever you modify or add any feature to Inkmap (including mind map editing, Markdown sync, Mermaid diagrams, keyboard shortcuts, UI toolbar, or membership/checkout), **you MUST follow these rules so every change automatically takes effect across all supported platforms**.

---

## 1. Single Source of Truth (`packages/core` + `packages/web`)

Inkmap ships across three underlying host transport layers, all rendering the **exact same `@inkmap/web` frontend**:

1. **Native IDE Extension Webview (`VsCodeHost`)**:
   - Platforms: **VS Code**, **Cursor**, **Trae**, **Windsurf**, **VSCodium** (`packages/vscode` — thin file-bridge shell; keep wrapper changes minimal).
2. **Local Loopback HTTP / Sidebar (`HttpHost`)**:
   - Platforms: **DeepSeek Harness** (`dsh-inkmap` in `packages/harness`), **Qoder** (`packages/qoder`), **Standalone Browser IDE** (`packages/cli`), and **Cursor Right-Pane Preview**.
3. **Single-File Embedded MCP App (`McpAppHost` / `CodexHost` / `BuddyHost`)**:
   - Platforms: **OpenAI Codex**, **Claude Desktop**, **Claude Code**, **Google Antigravity** (`packages/web/src/codex-entry.ts`), and **WorkBuddy** (`packages/web/src/buddy-entry.ts`).

### Mandatory Implementation Rules
- **Rule 1**: Implement **100% of editor, canvas, node rendering, shortcut, layout, theme, and account UI changes inside `packages/core` and `packages/web`**. Never implement a feature inside only one platform wrapper (`packages/vscode`, `packages/harness`, `packages/qoder`, or `packages/antigravity`).
- **Rule 2**: Whenever a new feature requires host cooperation (e.g., file I/O, external URL opening, chat context), add the method to the shared `Host` interface in `packages/web/src/host.ts` and implement it across `VsCodeHost` (`host.ts`), `HttpHost` (`host.ts`), `McpAppHost` (`mcp-app-host.ts`), and `CodexHost` (`codex-host.ts`).

---

## 2. Two Product & Checkout Categories (Strict Separation)

From the user & billing perspective, there are **only two categories**:

1. **Category 1 (`capabilities.account === "purchase"` — In-Plugin Direct Checkout)**:
   - Applies to: **VS Code, Cursor, DeepSeek Harness, Qoder, Standalone Browser IDE**.
   - Flow: User clicks `Buy Pro` -> verifies email inline (email prefilled with the last address used; auto-submits at 6 digits; Category 1 email shows **only the 6-digit code + Pro perks**, never a purchase jump button) -> displays payment **directly inside the plugin** (WeChat Pay QR `¥29.9` for Domestic, Card Checkout `$15` for Overseas). Do **not** add redundant "Open in Browser" or external website payment links.
2. **Category 2 (`capabilities.account === "restore"` — Device-Bound Magic Link Email)**:
   - Applies to: **OpenAI Codex, Claude Desktop, Claude Code, Google Antigravity** inline MCP App panels.
   - Flow: the email holds a **Device-Bound Magic Link** (one button: sign in + pay on the web) + a 6-digit backup code. Minimize steps:
     - When the trial has ended, the paywall shows the email form itself (no close button), prefilled with the last address used on this computer (`LicenseState.lastSignIn`), focus on `Send code` — one click sends the email.
     - After the trial, an account **without Pro is never kept signed in** (`licenseService` → `mustPayFirst` / `parkUnpaidSession`): a typed code returns `{ ok: false, reason: "notPro" }`, and an already signed-in unpaid account is signed out. Their tokens stay in the license service's **waiting list** instead.
     - The waiting list (persisted, polled every 2.5 s for 30 min, then every 30 s for up to 3 days) holds every email's pending token (`X-Inkmap-Pending-Token`, bound by the server when the email button is clicked) and every verified-but-unpaid token. Pro belongs to the account, so the first token that turns `active` after payment — by any route — signs in automatically, **no code needed**.
     - During the trial, clicking the email button (or typing the code) signs in right away, as before.

### Domestic (`¥29.9`) vs. Overseas (`$15`) Rule
- Determined **strictly by the computer's OS timezone (`Asia/Shanghai`, etc.) OR the computer's OS system language (`zh*`)** via `detectOsLocale()` in `packages/cli/src/license.ts` (injected as `<html data-os-locale="zh|en">`).
- **Never** use IDE/plugin client UI language (`vscode.env.language` or Electron `--lang`) to switch editions, and **never** expose `$15` to Domestic (`zh`) users or `¥29.9` / WeChat Pay to Overseas (`en`) users.

---

## 3. Mandatory Build, Parity Verification & Hot-Sync Command

After **every** feature or bugfix change in `packages/core`, `packages/web`, `packages/cli`, or `packages/vscode`, you **MUST** run:

```bash
npm run sync:all
```

What `npm run sync:all` executes automatically:
1. `npm run package:platforms` — Rebuilds `@inkmap/core`, `@inkmap/web` (standard + single-file MCP App + WorkBuddy), `@inkmap/cli`, `dsh-inkmap`, `inkmap-vscode` (`.vsix`), Codex, Qoder, Antigravity, and `inkmap-mcp` npm tarball.
2. `npm run verify:parity` — Asserts version alignment, identical Vite bundle hashes across VS Code & Harness & CLI, and artifact freshness across all 3 host runtimes.
3. `npm test && npm run test:sidebars` — Runs all unit, E2E Puppeteer webview, and packaged MCP App / Harness / Codex / Antigravity / npm sandbox tests.
4. `node dist/npm/inkmap-mcp/bin/inkmap.cjs install` — Hot-updates all locally installed clients on the developer's machine (Claude, Claude Code, Cursor, VS Code, Antigravity, Codex, DeepSeek Harness).
