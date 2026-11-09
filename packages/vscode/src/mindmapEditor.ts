import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import { docDir, docName, replaceText, type DocState } from "./documents";
import { webviewHtml } from "./html";

type FromWebview =
  | { type: "ready" }
  | { type: "save"; id: number; md: string; baseVersion: string }
  | { type: "select"; line: number }
  | { type: "undo" }
  | { type: "redo" };

const CHANGE_DELAY = 120;
const REVEAL_DELAY = 150;

export class MindmapEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = "inkmap.mindmap";

  constructor(private readonly context: vscode.ExtensionContext) {}

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

    disposables.push(
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
          case "ready":
            return post({ type: "doc", doc: state() });
          case "save": {
            if (msg.baseVersion !== String(document.version)) return post({ type: "conflict", id: msg.id, doc: state() });
            applying = true;
            try {
              const ok = await replaceText(document, msg.md);
              if (!ok) return post({ type: "error", id: msg.id, message: "文档无法修改（可能是只读文件）" });
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
          }
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

async function editorHtml(webview: vscode.Webview, webRoot: vscode.Uri, assets: vscode.Uri | undefined): Promise<string> {
  return webviewHtml(await readFile(vscode.Uri.joinPath(webRoot, "index.html").fsPath, "utf8"), {
    webBase: webview.asWebviewUri(webRoot).toString(),
    assetBase: assets ? webview.asWebviewUri(assets).toString() + "/" : "",
    cspSource: webview.cspSource,
    nonce: randomBytes(16).toString("base64"),
  });
}
