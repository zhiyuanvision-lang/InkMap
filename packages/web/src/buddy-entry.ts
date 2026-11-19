import { TRIAL_MS, hasAccess } from "@inkmap/core";
import { browserAccess, browserRestoreOrigin } from "./browser-access";
import { browserLocale, type DocState, type Host, type HostCapabilities, type SaveResult } from "./host";
import { mount, showEditorError } from "./main";
import { downloadFile, sidebarGate, sidebarText } from "./sidebar-shell";

type FileHandle = {
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(md: string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
};
type Picker = (options: { multiple: false; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileHandle[]>;
const MAX_BYTES = 5 * 1024 * 1024;
const TRIAL_KEY = "inkmap-workbuddy-trial-start";
const mdName = (name: string) => /\.md$/i.test(name);

function trialDeadline() {
  try {
    const now = Date.now();
    let value = localStorage.getItem(TRIAL_KEY);
    if (value === null) localStorage.setItem(TRIAL_KEY, value = String(now));
    const start = Number(value);
    if (Number.isSafeInteger(start) && start > 0 && start <= now) return start + TRIAL_MS;
  } catch { /* No persisted trial in this sandbox. */ }
}

async function fileText(file: File) {
  if (!mdName(file.name) || file.size > MAX_BYTES) throw new Error(sidebarText("请选择 5 MB 以内的 Markdown 文件。", "Select a Markdown file up to 5 MB."));
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
}

class BuddyHost implements Host {
  readonly locale = browserLocale();
  readonly assetBase = "";
  readonly capabilities: HostCapabilities;
  private revision = 0;
  private writing = false;
  private watching = false;
  private changeListeners: ((doc: DocState) => void)[] = [];
  private doc: DocState;

  constructor(readonly filename: string, md: string, private access: ReturnType<typeof browserAccess>, private handle?: FileHandle) {
    this.capabilities = {
      saveTarget: handle ? "file" : "copy",
      account: browserRestoreOrigin ? "restore" : "none",
      compact: true,
      restrictAssets: true,
    };
    this.doc = { name: filename.replace(/(?:\.markmap)?\.md$/i, ""), md, version: "0" };
  }

  private update(md: string) {
    if (md !== this.doc.md) this.doc = { ...this.doc, md, version: String(++this.revision) };
    return this.doc;
  }
  async load() { return this.doc; }
  async save(md: string, baseVersion: string): Promise<SaveResult> {
    if (!hasAccess(await this.license())) throw new Error("Inkmap access is inactive.");
    if (new TextEncoder().encode(md).byteLength > MAX_BYTES) throw new Error(sidebarText("Markdown 文件超出 5 MB。", "Markdown exceeds 5 MB."));
    this.writing = true;
    try {
      if (this.handle) this.update(await fileText(await this.handle.getFile()));
      if (baseVersion !== this.doc.version) return { ok: false, doc: this.doc };
      if (this.handle && md !== this.doc.md) {
        const out = await this.handle.createWritable();
        try {
          if (this.update(await fileText(await this.handle.getFile())).version !== baseVersion) {
            await out.abort();
            return { ok: false, doc: this.doc };
          }
          await out.write(md);
          await out.close();
        } catch (error) {
          await out.abort().catch(() => {});
          throw error;
        }
      }
      return { ok: true, version: this.update(md).version };
    } finally {
      this.writing = false;
    }
  }
  onExternalChange(listener: (doc: DocState) => void) {
    const handle = this.handle;
    if (!handle) return;
    this.changeListeners.push(listener);
    if (this.watching) return;
    this.watching = true;
    const timer = window.setInterval(async () => {
      if (this.writing) return;
      const before = this.doc;
      try {
        const md = await fileText(await handle.getFile());
        if (!this.writing && this.doc === before && md !== before.md) {
          const updated = this.update(md);
          this.changeListeners.forEach(fn => fn(updated));
        }
      } catch { /* A save may replace the file temporarily. */ }
    }, 1500);
    window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
  }
  license() { return this.access.state(); }
  async checkout(mode: "buy" | "restore") {
    if (mode !== "restore" || this.capabilities.account === "none") throw new Error("Account restoration is unavailable.");
    const tab = window.open("about:blank", "_blank");
    if (!tab) throw new Error(sidebarText("请允许在浏览器中打开登录窗口。", "Allow the account sign-in window to open."));
    tab.opener = null;
    try {
      const url = new URL(await this.access.restore());
      url.searchParams.set("lang", this.locale);
      tab.location.replace(url.toString());
    } catch (error) {
      tab.close();
      throw error;
    }
  }
  signOut() { return this.access.signOut(); }
  onLicenseChange(listener: (state: Awaited<ReturnType<BuddyHost["license"]>>) => void) {
    if (this.capabilities.account === "none") return;
    const update = () => void this.license().then(listener).catch(() => {});
    const timer = window.setInterval(update, 4000);
    window.addEventListener("focus", update);
    window.addEventListener("pagehide", () => {
      clearInterval(timer);
      window.removeEventListener("focus", update);
    }, { once: true });
  }
  saveFile = downloadFile;
}

const gate = sidebarGate(sidebarText(
  "选择 Markdown 文件。若当前面板不支持写入本地文件，修改后可下载 Markdown 副本。",
  "Select a Markdown file. If this panel cannot write to local files, you can download an edited Markdown copy.",
));
const deadline = trialDeadline();
const access = browserAccess(browserRestoreOrigin, deadline);
const input = document.createElement("input");
input.type = "file";
input.accept = ".md,text/markdown";
input.hidden = true;
const open = document.createElement("button");
open.type = "button";
open.textContent = sidebarText("打开 Markdown", "Open Markdown");
gate.panel.append(open, input);
const errorBox = document.createElement("p");
errorBox.setAttribute("role", "alert");
gate.panel.append(errorBox);
const showError = (err: unknown) => { errorBox.textContent = String(err instanceof Error ? err.message : err); };

async function edit(file: File, handle?: FileHandle) {
  if (!browserRestoreOrigin && (!deadline || Date.now() >= deadline)) return;
  const md = await fileText(file);
  gate.close();
  const host = new BuddyHost(file.name, md, access, handle);
  try {
    const editor = await mount(host);
    let exported = editor.currentMarkdown();
    const createDownload = () => {
      const download = document.createElement("button");
      download.type = "button";
      download.textContent = sidebarText("下载 Markdown", "Download Markdown");
      download.addEventListener("click", () => {
        const text = editor.currentMarkdown();
        const url = URL.createObjectURL(new Blob([text === initial ? md : text], { type: "text/markdown;charset=utf-8" }));
        void downloadFile(file.name, url);
        exported = text;
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      });
      return download;
    };
    const initial = exported;
    const download = createDownload();
    download.id = "buddy-download-markdown";
    document.querySelector("#status")?.before(download);
    if (host.capabilities.saveTarget === "copy") {
      document.querySelector(".upgrade-card")?.append(createDownload());
      // A copy is in memory; warn even when the editor's save queue is empty.
      window.addEventListener("beforeunload", e => {
        if (editor.currentMarkdown() !== exported) e.preventDefault();
      });
    }
  } catch (error) { showEditorError(error); }
}

if (!browserRestoreOrigin && (!deadline || Date.now() >= deadline)) {
  open.hidden = true;
  gate.note.textContent = sidebarText(
    "当前面板的试用不可用。已开通会员的用户可在 Inkmap 桌面端或本机浏览器版恢复权益。",
    "A trial is unavailable in this panel. Existing members can restore access in the Inkmap extension or local browser editor.",
  );
}

open.addEventListener("click", async () => {
  errorBox.textContent = "";
  const picker = (window as Window & { showOpenFilePicker?: Picker }).showOpenFilePicker;
  // The picker requires a top-level or same-origin context and a secure origin.
  if (!picker || window.top !== window) return input.click();
  let handle: FileHandle | undefined;
  try {
    [handle] = await picker.call(window, { multiple: false, types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }] });
  } catch (error) {
    if (error instanceof DOMException && (error.name === "SecurityError" || error.name === "NotAllowedError")) input.click();
    else if ((error as Error).name !== "AbortError") showError(error);
    return;
  }
  if (handle) await handle.getFile().then(file => edit(file, handle)).catch(showError);
});
input.addEventListener("change", () => {
  const file = input.files?.[0];
  if (file) void edit(file).catch(showError);
  input.value = "";
});
