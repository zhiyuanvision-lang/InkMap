import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { sanitizeViewState } from "@inkmap/core";
import type { LicenseService } from "../../cli/src/license";
import { serve, type DocSource, type Served } from "../../cli/src/server";
import { docDir, docName, replaceText } from "./documents";
import { t } from "./i18n";

const VIEW_STATE_PREFIX = "inkmap.viewState:";

/** Serves open documents to the browser editor; one local server per document. */
export class BrowserServers implements vscode.Disposable {
  private readonly servers = new Map<string, Promise<Served>>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly webRoot: string,
    private readonly log: vscode.OutputChannel,
    private readonly license: LicenseService,
  ) {}

  async open(uri: vscode.Uri) {
    const key = uri.toString();
    let served = this.servers.get(key);
    if (!served) {
      const workspaceRoots = (vscode.workspace.workspaceFolders ?? [])
        .filter(f => f.uri.scheme === "file")
        .map(f => f.uri.fsPath);
      served = serve({
        source: documentSource(uri, this.context),
        webRoot: this.webRoot,
        port: 0,
        log: msg => this.log.appendLine(`[${docName(uri)}] ${msg}`),
        license: this.license,
        workspaceRoots,
        // Files picked in the browser tree still go through VS Code's document model (dirty buffers, save hooks).
        openSource: async path => documentSource(vscode.Uri.file(path), this.context),
      });
      this.servers.set(key, served);
      served.catch(() => this.servers.delete(key));
    }
    const server = await served;
    // The user may have switched this browser window to another file; bring it back to the requested document.
    if (uri.scheme === "file") await server.switchToFile?.(uri.fsPath, { trustCaller: true }).catch(() => {});
    // In Remote / Codespaces the page is reached through a forwarded host; let the server accept it.
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(server.url));
    if (external.authority && external.authority.toLowerCase() !== new URL(server.url).host) server.allowHost(external.authority);
    const url = external.toString(true);
    this.log.appendLine(`[${docName(uri)}] ${url}`);
    await openUrl(url);
    return url;
  }

  dispose() {
    for (const served of this.servers.values()) served.then(s => s.close(), () => {});
    this.servers.clear();
  }
}

function documentSource(uri: vscode.Uri, context: vscode.ExtensionContext): DocSource {
  const document = () => vscode.workspace.openTextDocument(uri);
  const viewKey = VIEW_STATE_PREFIX + uri.toString();
  return {
    name: docName(uri),
    ...(uri.scheme === "file" && { key: uri.fsPath }),
    dir: docDir(uri)?.fsPath ?? "",
    read: async () => (await document()).getText(),
    async write(md) {
      const doc = await document();
      if (!(await replaceText(doc, md))) throw new Error(t("readOnly"));
      if (vscode.workspace.getConfiguration("inkmap").get<boolean>("browserAutoSave", true) && !doc.isUntitled) await doc.save();
    },
    watch(onChange) {
      const sub = vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.toString() === uri.toString() && e.contentChanges.length) onChange();
      });
      return () => sub.dispose();
    },
    readView: async () => (uri.scheme === "untitled" ? undefined : sanitizeViewState(context.workspaceState.get(viewKey))),
    writeView: async state => {
      if (uri.scheme !== "untitled") await context.workspaceState.update(viewKey, state);
    },
  };
}

async function openUrl(url: string) {
  const fallback = () => vscode.env.openExternal(vscode.Uri.parse(url));
  if (vscode.workspace.getConfiguration("inkmap").get<string>("browser", "chrome") !== "chrome") return fallback();
  const [cmd, args] =
    process.platform === "darwin" ? ["open", ["-a", "Google Chrome", url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", "chrome", url]]
    : ["google-chrome", [url]];
  const ok = await new Promise<boolean>(done => {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => done(false));
    child.on("exit", code => done(code === 0));
    child.unref();
  });
  if (!ok) await fallback();
}
