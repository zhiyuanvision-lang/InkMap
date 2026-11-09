import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { Ad } from "@inkmap/core";
import * as vscode from "vscode";
import type { LicenseService } from "../../cli/src/license";
import { docDir, docName, replaceText, type DocState } from "./documents";
import { webviewHtml } from "./html";
import { t } from "./i18n";

type FromWebview =
  | { type: "ready" }
  | { type: "save"; id: number; md: string; baseVersion: string }
  | { type: "select"; line: number }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "activate"; id: number; code: string }
  | { type: "saveFile"; id: number; name: string; dataUrl: string };

const CHANGE_DELAY = 120;
const REVEAL_DELAY = 150;

export class MindmapEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = "inkmap.mindmap";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly license: LicenseService,
    private readonly ads: () => Promise<Ad[]>,
  ) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const webview = panel.webview;
    const webRoot = vscode.Uri.joinPath(this.context.extensionUri, "dist", "web");
    const assets = docDir(document.uri);
    webview.options = {
      enableScripts: true,
      localResourceRoots: [webRoot, ...(assets ? [assets] : []), ...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri)],
    };
    webview.html = await editorHtml(webview, webRoot, assets);

    const state = (): DocState => ({ name: docName(document.uri), md: document.getText(), version: String(document.version) });
    const post = (msg: unknown) => webview.postMessage(msg);
    const disposables: vscode.Disposable[] = [];
    let applying = false;
    let changeTimer: NodeJS.Timeout | undefined;
    let revealTimer: NodeJS.Timeout | undefined;

    const unlisten = this.license.onChange(license => post({ type: "license", state: license }));
    disposables.push(
      { dispose: unlisten },
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
        switch (msg.type) {
          case "ready": {
            const [license, ads] = await Promise.all([this.license.state(), this.ads()]);
            return post({ type: "doc", doc: state(), license, ads });
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
          case "activate":
            return post({ type: "activated", id: msg.id, result: await this.license.activate(msg.code) });
          case "saveFile":
            return post({ type: "fileSaved", id: msg.id, saved: await saveDataUrl(msg.name, msg.dataUrl, assets) });
        }
      }),
    );

    panel.onDidDispose(() => {
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
    locale: vscode.env.language,
  });
}
