import { hasAccess, PRODUCT } from "@inkmap/core";
import { existsSync, mkdirSync, watch } from "node:fs";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import * as vscode from "vscode";
import { adFeed } from "../../cli/src/license";
import { BrowserServers } from "./browser";
import { chatAvailable, targetUri } from "./documents";
import { t } from "./i18n";
import { extensionLicense, offerPro, openCheckout } from "./license";
import { MindmapEditorProvider } from "./mindmapEditor";

function insideOrEqual(root: string, target: string): boolean {
  if (root === target) return true;
  const rel = relative(root, target);
  return Boolean(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

function resolveEditorUri(filePath: string): vscode.Uri {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const folderPath = folder.uri.fsPath || folder.uri.path;
    if (folderPath && insideOrEqual(folderPath, filePath)) {
      const rel = relative(folderPath, filePath).split(sep).join("/");
      return rel ? vscode.Uri.joinPath(folder.uri, rel) : folder.uri;
    }
  }
  const first = vscode.workspace.workspaceFolders?.[0];
  if (first && first.uri.scheme !== "file") {
    return first.uri.with({ path: filePath });
  }
  return vscode.Uri.file(filePath);
}

function findColumnForFile(fileUri: vscode.Uri): vscode.ViewColumn {
  const targetFs = fileUri.fsPath || fileUri.path;
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input as { uri?: vscode.Uri } | undefined;
      if (input?.uri && (input.uri.fsPath === targetFs || input.uri.path === targetFs)) {
        return group.viewColumn;
      }
      if (tab.label && targetFs.endsWith(sep + tab.label.replace(/^Preview\s+/i, ""))) {
        return group.viewColumn;
      }
    }
  }
  return vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active;
}

function localEditorUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

async function openUrlInEditorPane(url: string) {
  await vscode.commands.executeCommand("workbench.action.openBrowserEditor", {
    url,
    preserveFocus: false,
    inactive: false,
    reuseExistingUrlTab: true,
  });
}

async function openFileInEditorPane(filePath: string) {
  const fileUri = resolveEditorUri(filePath);
  const viewColumn = findColumnForFile(fileUri);
  await vscode.commands.executeCommand("vscode.openWith", fileUri, MindmapEditorProvider.viewType, {
    viewColumn,
    preserveFocus: false,
  });
}

function startMcpTargetBridge(): vscode.Disposable {
  const inkmapDir = process.env.INKMAP_HOME || join(homedir(), ".inkmap");
  const targetPath = join(inkmapDir, "antigravity-target.json");
  const ackPath = join(inkmapDir, "antigravity-target-ack.json");
  const statusPath = join(inkmapDir, "vscode-bridge-status.json");
  let lastSeq = Date.now() - 10_000;
  let debounceTimer: NodeJS.Timeout | undefined;
  let disposed = false;

  const writeBridgeStatus = async () => {
    try {
      if (!existsSync(inkmapDir)) mkdirSync(inkmapDir, { recursive: true, mode: 0o700 });
      await writeFile(statusPath, JSON.stringify({
        pid: process.pid,
        activatedAt: Date.now(),
        appName: vscode.env.appName,
        remoteName: vscode.env.remoteName,
        focused: vscode.window.state.focused,
        folders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.toString()),
      }, null, 2), { mode: 0o600 });
    } catch {}
  };

  const syncInitialSeq = async () => {
    try {
      const raw = JSON.parse(await readFile(targetPath, "utf8"));
      if (typeof raw?.seq === "number" && raw.seq < Date.now() - 8000) {
        lastSeq = raw.seq;
      }
    } catch {}
    await checkTarget();
  };

  const checkTarget = async () => {
    if (disposed) return;
    try {
      const raw = JSON.parse(await readFile(targetPath, "utf8"));
      if (!raw || raw.openInEditorPane !== true) return;
      const seq = Number(raw.seq) || 0;
      if (seq <= lastSeq || typeof raw.file !== "string") return;

      const realTarget = await realpath(raw.file).catch(() => raw.file as string);
      const folders = vscode.workspace.workspaceFolders ?? [];
      let matchesWindow = false;
      for (const folder of folders) {
        const folderPath = folder.uri.fsPath || folder.uri.path;
        if (!folderPath) continue;
        const realFolder = await realpath(folderPath).catch(() => folderPath);
        if (insideOrEqual(realFolder, realTarget)) {
          matchesWindow = true;
          break;
        }
      }
      if (!matchesWindow && vscode.window.state.focused) {
        matchesWindow = true;
      }

      if (!matchesWindow) return;
      lastSeq = seq;
      const editorUrl = localEditorUrl(raw.editorUrl);
      if (editorUrl) await openUrlInEditorPane(editorUrl);
      else await openFileInEditorPane(realTarget);
      await writeFile(ackPath, JSON.stringify({
        seq,
        file: realTarget,
        ok: true,
        handledAt: Date.now(),
      }, null, 2), { mode: 0o600 }).catch(() => {});
    } catch (err) {
      await writeFile(ackPath, JSON.stringify({
        seq: lastSeq,
        ok: false,
        error: String(err instanceof Error ? err.message : err),
        handledAt: Date.now(),
      }, null, 2), { mode: 0o600 }).catch(() => {});
    }
  };

  void writeBridgeStatus();
  void syncInitialSeq();
  try {
    if (!existsSync(inkmapDir)) mkdirSync(inkmapDir, { recursive: true, mode: 0o700 });
    const watcher = watch(inkmapDir, (_event, filename) => {
      if (filename && filename !== "antigravity-target.json") return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void checkTarget();
      }, 60);
    });
    const pollFallback = setInterval(() => {
      void checkTarget();
    }, 1200);
    return {
      dispose() {
        disposed = true;
        clearTimeout(debounceTimer);
        clearInterval(pollFallback);
        watcher.close();
      },
    };
  } catch {
    return { dispose() { disposed = true; } };
  }
}

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("Inkmap");
  const license = extensionLicense(context);
  const ads = adFeed(PRODUCT.adFeedUrl);
  const browsers = new BrowserServers(context, vscode.Uri.joinPath(context.extensionUri, "dist", "web").fsPath, log, license, ads);

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

  const editors = new MindmapEditorProvider(context, license, ads);
  chatAvailable().then(available => vscode.commands.executeCommand("setContext", "inkmap.chatAvailable", available));

  context.subscriptions.push(
    log,
    license,
    browsers,
    startMcpTargetBridge(),
    vscode.window.registerUriHandler({
      handleUri(uri) {
        if (uri.path === "/open") {
          const target = new URLSearchParams(uri.query).get("path");
          if (target) void openFileInEditorPane(target);
        }
      },
    }),
    vscode.window.registerCustomEditorProvider(MindmapEditorProvider.viewType, editors, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("inkmap.addToChat", () => editors.requestChat()),
    vscode.commands.registerCommand("inkmap.open", openToSide),
    vscode.commands.registerCommand("inkmap.openToSide", openToSide),
    vscode.commands.registerCommand(
      "inkmap.showSource",
      withUri(uri => vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: false })),
    ),
    vscode.commands.registerCommand(
      "inkmap.openInBrowser",
      withUri(async uri => {
        if (!hasAccess(await license.state()) && !(await offerPro(license))) return;
        try {
          license.track?.("feature_browser");
          const url = await browsers.open(uri);
          const pick = await vscode.window.showInformationMessage(t("browserOpened", { url }), t("copyLink"));
          if (pick) await vscode.env.clipboard.writeText(url);
        } catch (err) {
          vscode.window.showErrorMessage(t("browserFailed", { error: err instanceof Error ? err.message : String(err) }));
        }
      }),
    ),
    vscode.commands.registerCommand("inkmap.upgrade", () => offerPro(license)),
    vscode.commands.registerCommand("inkmap.restorePro", async () => {
      try { await openCheckout(license, "restore"); }
      catch (error) { vscode.window.showErrorMessage(error instanceof Error ? error.message : t("checkoutFailed")); }
    }),
    vscode.commands.registerCommand("inkmap.signOut", async () => {
      const remove = t("remove");
      if ((await vscode.window.showWarningMessage(t("removeConfirm"), { modal: true }, remove)) !== remove) return;
      await license.deactivate();
      vscode.window.showInformationMessage(t("removed"));
    }),
  );
}

export function deactivate() {}
