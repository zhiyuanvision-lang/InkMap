import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { serve, type DocSource, type Served } from "../../cli/src/server";
import { docDir, docName, replaceText } from "./documents";

/** Serves open documents to the browser editor; one local server per document. */
export class BrowserServers implements vscode.Disposable {
  private readonly servers = new Map<string, Promise<Served>>();

  constructor(
    private readonly webRoot: string,
    private readonly log: vscode.OutputChannel,
  ) {}

  async open(uri: vscode.Uri) {
    const key = uri.toString();
    let served = this.servers.get(key);
    if (!served) {
      served = serve({ source: documentSource(uri), webRoot: this.webRoot, port: 0, log: msg => this.log.appendLine(`[${docName(uri)}] ${msg}`) });
      this.servers.set(key, served);
      served.catch(() => this.servers.delete(key));
    }
    const { url } = await served;
    this.log.appendLine(`[${docName(uri)}] ${url}`);
    await openUrl(url);
    return url;
  }

  dispose() {
    for (const served of this.servers.values()) served.then(s => s.close(), () => {});
    this.servers.clear();
  }
}

function documentSource(uri: vscode.Uri): DocSource {
  const document = () => vscode.workspace.openTextDocument(uri);
  return {
    name: docName(uri),
    dir: docDir(uri)?.fsPath ?? "",
    read: async () => (await document()).getText(),
    async write(md) {
      const doc = await document();
      if (!(await replaceText(doc, md))) throw new Error("文档无法修改（可能是只读文件）");
      if (vscode.workspace.getConfiguration("inkmap").get<boolean>("browserAutoSave", true) && !doc.isUntitled) await doc.save();
    },
    watch(onChange) {
      const sub = vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.toString() === uri.toString() && e.contentChanges.length) onChange();
      });
      return () => sub.dispose();
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
