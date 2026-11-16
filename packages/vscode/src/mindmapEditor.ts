import { hasAccess, sanitizeViewState, type Ad } from "@inkmap/core";
import { openCheckout } from "./license";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import * as vscode from "vscode";
import type { LicenseService } from "../../cli/src/license";
import { addLinesToChat, chatAvailable, openChat, docDir, docName, replaceText, type DocState } from "./documents";
import { webviewHtml } from "./html";
import { isChinese, t } from "./i18n";

const VIEW_STATE_PREFIX = "inkmap.viewState:";

type FromWebview =
  | { type: "ready" }
  | { type: "save"; id: number; md: string; baseVersion: string }
  | { type: "select"; line: number }
  | { type: "viewState"; state: unknown }
  | { type: "addToChat"; startLine?: number; endLine?: number; text?: string }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "checkout"; id: number; mode: "buy" | "restore" }
  | { type: "orderPro"; id: number }
  | { type: "sendPhoneCode"; id: number; phone: string }
  | { type: "signInByPhone"; id: number; phone: string; code: string }
  | { type: "signOut"; id: number }
  | { type: "saveFile"; id: number; name: string; dataUrl: string };

const CHANGE_DELAY = 120;
const REVEAL_DELAY = 150;

export class MindmapEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = "inkmap.mindmap";
  private readonly panels = new Set<vscode.WebviewPanel>();

  /** The chat shortcut was pressed: the focused mind map says what is selected. Anywhere else it just opens the chat. */
  requestChat(): void | Thenable<unknown> {
    const panel = [...this.panels].find(p => p.active);
    return panel ? panel.webview.postMessage({ type: "requestChat" }) : openChat();
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly license: LicenseService,
    private readonly ads: () => Promise<Ad[]>,
  ) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const webview = panel.webview;
    this.panels.add(panel);
    const webRoot = vscode.Uri.joinPath(this.context.extensionUri, "dist", "web");
    const assets = docDir(document.uri);
    webview.options = {
      enableScripts: true,
      localResourceRoots: [webRoot, ...(assets ? [assets] : []), ...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri)],
    };
    webview.html = await editorHtml(webview, webRoot, assets);

    const viewKey = VIEW_STATE_PREFIX + document.uri.toString();
    const state = (): DocState => {
      const viewState = document.uri.scheme === "untitled"
        ? undefined
        : sanitizeViewState(this.context.workspaceState.get(viewKey));
      return {
        name: docName(document.uri),
        md: document.getText(),
        version: String(document.version),
        ...(viewState && { viewState }),
      };
    };
    const post = (msg: unknown) => webview.postMessage(msg);
    const syncLicense = async () => {
      const state = await this.license.state();
      if (panel.visible && this.panels.has(panel)) await post({ type: "license", state });
    };
    const disposables: vscode.Disposable[] = [];
    let applying = false;
    let changeTimer: NodeJS.Timeout | undefined;
    let revealTimer: NodeJS.Timeout | undefined;

    const unlisten = this.license.onChange(license => post({ type: "license", state: license }));
    disposables.push(
      { dispose: unlisten },
      // A hidden panel can miss a license update. Send the latest state when it becomes visible again.
      panel.onDidChangeViewState(({ webviewPanel }) => {
        if (webviewPanel.visible) void syncLicense();
      }),
      vscode.window.onDidChangeWindowState(({ focused }) => {
        if (focused && panel.visible) void syncLicense();
      }),
      vscode.workspace.onDidChangeTextDocument(e => {
        if (applying || e.document !== document || !e.contentChanges.length) return;
        clearTimeout(changeTimer);
        changeTimer = setTimeout(() => post({ type: "change", doc: state() }), CHANGE_DELAY);
      }),
      vscode.window.onDidChangeTextEditorSelection(e => {
        const userMoved = e.kind === vscode.TextEditorSelectionChangeKind.Keyboard || e.kind === vscode.TextEditorSelectionChangeKind.Mouse;
        if (!userMoved || e.textEditor.document !== document) return;
        clearTimeout(revealTimer);
        revealTimer = setTimeout(() => post({ type: "reveal", line: e.selections[0].active.line }), REVEAL_DELAY);
      }),
      webview.onDidReceiveMessage(async (msg: FromWebview) => {
        const accountAction = msg.type === "checkout" || msg.type === "orderPro" || msg.type === "signOut" || msg.type === "sendPhoneCode" || msg.type === "signInByPhone";
        if (!accountAction && msg.type !== "ready" && msg.type !== "viewState" && !hasAccess(await this.license.state())) {
          if ("id" in msg) return post({ type: "error", id: msg.id, message: t("trialExpired") });
          return;
        }
        switch (msg.type) {
          case "ready": {
            const [license, ads] = await Promise.all([this.license.state(), this.ads()]);
            return post({ type: "doc", doc: state(), license, ads, chat: await chatAvailable() });
          }
          case "viewState": {
            if (document.uri.scheme === "untitled") return;
            const cleaned = sanitizeViewState(msg.state);
            if (cleaned) await this.context.workspaceState.update(viewKey, cleaned);
            return;
          }
          case "save": {
            if (msg.baseVersion !== String(document.version)) return post({ type: "conflict", id: msg.id, doc: state() });
            applying = true;
            try {
              const ok = await replaceText(document, msg.md);
              if (!ok) return post({ type: "error", id: msg.id, message: t("readOnly") });
            } finally {
              applying = false;
            }
            return post({ type: "saved", id: msg.id, version: String(document.version) });
          }
          case "undo":
          case "redo":
            return vscode.commands.executeCommand(msg.type);
          case "select": {
            const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
            if (!editor) return;
            const pos = new vscode.Position(Math.min(msg.line, document.lineCount - 1), 0);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            return;
          }
          case "addToChat":
            return msg.startLine === undefined || msg.endLine === undefined ? openChat() : addLinesToChat(document, msg.startLine, msg.endLine, msg.text);
          case "checkout":
            try {
              if (msg.mode !== "buy" && msg.mode !== "restore") throw new Error("Invalid checkout mode");
              await openCheckout(this.license, msg.mode);
              return post({ type: "checkout", id: msg.id });
            } catch (error) {
              return post({ type: "error", id: msg.id, message: error instanceof Error ? error.message : t("checkoutFailed") });
            }
          case "orderPro":
            try {
              const result = await this.license.orderPro();
              if (result.status === "redirect" && !await vscode.env.openExternal(vscode.Uri.parse(result.url))) {
                throw new Error(t("checkoutFailed"));
              }
              return post({ type: "proOrder", id: msg.id, result });
            } catch (error) {
              return post({ type: "error", id: msg.id, message: error instanceof Error ? error.message : t("checkoutFailed") });
            }
          case "signOut":
            await this.license.deactivate();
            return post({ type: "signedOut", id: msg.id });
          case "sendPhoneCode":
            return post({ type: "phoneCodeSent", id: msg.id, result: await this.license.sendPhoneCode(msg.phone) });
          case "signInByPhone":
            return post({ type: "phoneSignIn", id: msg.id, result: await this.license.signInByPhone(msg.phone, msg.code) });
          case "saveFile":
            return post({ type: "fileSaved", id: msg.id, saved: await saveDataUrl(msg.name, msg.dataUrl, assets) });
        }
      }),
    );

    panel.onDidDispose(() => {
      this.panels.delete(panel);
      clearTimeout(changeTimer);
      clearTimeout(revealTimer);
      disposables.forEach(d => d.dispose());
    });
  }
}

async function saveDataUrl(name: string, dataUrl: string, dir: vscode.Uri | undefined): Promise<boolean> {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) return false;
  const ext = name.split(".").pop() ?? "";
  const target = await vscode.window.showSaveDialog({
    defaultUri: dir ? vscode.Uri.joinPath(dir, name) : undefined,
    filters: { [ext.toUpperCase()]: [ext] },
    saveLabel: t("saveExport"),
  });
  if (!target) return false;
  const body = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8");
  await writeFile(target.fsPath, body);
  return true;
}

async function editorHtml(webview: vscode.Webview, webRoot: vscode.Uri, assets: vscode.Uri | undefined): Promise<string> {
  return webviewHtml(await readFile(vscode.Uri.joinPath(webRoot, "index.html").fsPath, "utf8"), {
    webBase: webview.asWebviewUri(webRoot).toString(),
    assetBase: assets ? webview.asWebviewUri(assets).toString() + "/" : "",
    cspSource: webview.cspSource,
    nonce: randomBytes(16).toString("base64"),
    locale: isChinese() ? "zh-cn" : vscode.env.language,
  });
}
