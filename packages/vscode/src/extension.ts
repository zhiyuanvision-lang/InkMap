import { PRODUCT } from "@inkmap/core";
import * as vscode from "vscode";
import { adFeed } from "../../cli/src/license";
import { BrowserServers } from "./browser";
import { targetUri } from "./documents";
import { t } from "./i18n";
import { extensionLicense, offerPro, promptForCode } from "./license";
import { MindmapEditorProvider } from "./mindmapEditor";

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("Inkmap");
  const license = extensionLicense(context);
  const ads = adFeed(PRODUCT.adFeedUrl);
  const browsers = new BrowserServers(vscode.Uri.joinPath(context.extensionUri, "dist", "web").fsPath, log, license, ads);

  const withUri = (run: (uri: vscode.Uri) => unknown) => (arg?: unknown) => {
    const uri = targetUri(arg);
    if (!uri) return vscode.window.showWarningMessage(t("openMarkdownFirst"));
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
    vscode.window.registerCustomEditorProvider(MindmapEditorProvider.viewType, new MindmapEditorProvider(context, license, ads), {
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
        if (!(await license.state()).pro && !(await offerPro(license, "browser"))) return;
        try {
          const url = await browsers.open(uri);
          const pick = await vscode.window.showInformationMessage(t("browserOpened", { url }), t("copyLink"));
          if (pick) await vscode.env.clipboard.writeText(url);
        } catch (err) {
          vscode.window.showErrorMessage(t("browserFailed", { error: err instanceof Error ? err.message : String(err) }));
        }
      }),
    ),
    vscode.commands.registerCommand("inkmap.upgrade", () => offerPro(license)),
    vscode.commands.registerCommand("inkmap.enterLicense", () => promptForCode(license)),
    vscode.commands.registerCommand("inkmap.removeLicense", async () => {
      const remove = t("remove");
      if ((await vscode.window.showWarningMessage(t("removeConfirm"), { modal: true }, remove)) !== remove) return;
      await license.deactivate();
      vscode.window.showInformationMessage(t("removed"));
    }),
  );
}

export function deactivate() {}
