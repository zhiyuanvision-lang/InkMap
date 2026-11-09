import * as vscode from "vscode";
import { BrowserServers } from "./browser";
import { targetUri } from "./documents";
import { MindmapEditorProvider } from "./mindmapEditor";

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("Inkmap");
  const browsers = new BrowserServers(vscode.Uri.joinPath(context.extensionUri, "dist", "web").fsPath, log);

  const withUri = (run: (uri: vscode.Uri) => unknown) => (arg?: unknown) => {
    const uri = targetUri(arg);
    if (!uri) return vscode.window.showWarningMessage("请先打开一个 Markdown 文件");
    return run(uri);
  };

  const openToSide = withUri(uri =>
    vscode.commands.executeCommand("vscode.openWith", uri, MindmapEditorProvider.viewType, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
    }),
  );

  context.subscriptions.push(
    log,
    browsers,
    vscode.window.registerCustomEditorProvider(MindmapEditorProvider.viewType, new MindmapEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("inkmap.open", openToSide),
    vscode.commands.registerCommand("inkmap.openToSide", openToSide),
    vscode.commands.registerCommand(
      "inkmap.showSource",
      withUri(uri => vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: false })),
    ),
    vscode.commands.registerCommand(
      "inkmap.openInBrowser",
      withUri(async uri => {
        try {
          const url = await browsers.open(uri);
          const pick = await vscode.window.showInformationMessage(`思维导图已在浏览器打开：${url}`, "复制链接");
          if (pick) await vscode.env.clipboard.writeText(url);
        } catch (err) {
          vscode.window.showErrorMessage(`无法在浏览器打开思维导图：${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    ),
  );
}

export function deactivate() {}
