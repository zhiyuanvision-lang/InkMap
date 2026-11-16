import type { App } from "@modelcontextprotocol/ext-apps";
import type { LicenseState, PhoneSignInResult, ViewState } from "@inkmap/core";
import { z } from "zod";
import { browserLocale, type ChatTarget, type DocState, type Host, type HostCapabilities, type SaveResult } from "./host";
import { downloadFile, sidebarText } from "./sidebar-shell";

interface McpFileEntry {
  path: string;
  uri: string;
  label: string;
  group: "active" | "project";
}

export interface McpWorkspaceSnapshot {
  files?: McpFileEntry[];
  currentFile?: string | null;
  currentFileUri?: string | null;
  targetSeq?: number;
  license?: Record<string, unknown>;
  doc?: DocState;
}

const ToggleAuxPaneResultSchema = z.object({
  isError: z.boolean().optional(),
}).passthrough();

function parseLicense(raw?: Record<string, unknown> | null): LicenseState {
  if (!raw || typeof raw !== "object") return { pro: false };
  return {
    pro: raw.pro === true,
    ...(typeof raw.trialUntil === "number" && { trialUntil: raw.trialUntil }),
    ...(raw.connected === true && { connected: true }),
    ...(typeof raw.account === "string" && { account: raw.account }),
  };
}

export class McpAppHost implements Host {
  readonly assetBase = "";
  readonly locale = browserLocale();
  readonly capabilities = {
    saveTarget: "file",
    account: "restore",
    compact: true,
    restrictAssets: true,
  } satisfies HostCapabilities;

  private currentFile: string | null = null;
  private currentFileUri: string | null = null;
  private currentVersion = "";
  private currentMd = "";
  private targetSeq = 0;
  private saving = false;
  private polling = false;
  private currentLicense?: LicenseState;
  private licenseCheck?: Promise<LicenseState>;
  private changeListener?: (doc: DocState) => void;

  private fileSelectEl: HTMLSelectElement | null = null;
  private splitMdBtn: HTMLButtonElement | null = null;
  private openRawBtn: HTMLButtonElement | null = null;
  private mdPaneEl: HTMLElement | null = null;
  private mdTextareaEl: HTMLTextAreaElement | null = null;
  private mdTitleEl: HTMLElement | null = null;
  private splitOpen = false;
  private splitWidthPct = 42;
  private mdEditTimer = 0;

  constructor(
    private app: App,
    private initialInput?: { path?: string; workspace?: string },
    private initialSnapshot?: McpWorkspaceSnapshot,
  ) {}

  private async callTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
    const result = await this.app.callServerTool({ name, arguments: args });
    if (result.isError) {
      const textBlock = result.content.find(item => item.type === "text");
      throw new Error(textBlock && "text" in textBlock ? textBlock.text : `${name} failed.`);
    }
    return (result.structuredContent as Record<string, any>) ?? {};
  }

  private syncMdPaneContent(md = this.currentMd, force = false) {
    if (this.mdTitleEl) {
      const fileName = this.currentFile ? this.currentFile.split(/[\\/]/).pop() || "Markdown" : "Markdown";
      this.mdTitleEl.textContent = fileName;
      this.mdTitleEl.title = this.currentFile || fileName;
    }
    if (!this.mdTextareaEl) return;
    if (force || document.activeElement !== this.mdTextareaEl) {
      if (this.mdTextareaEl.value !== md) this.mdTextareaEl.value = md;
    }
  }

  private applySplitLayout(fitAfter = false) {
    document.documentElement.classList.toggle("ag-split-active", this.splitOpen);
    document.documentElement.style.setProperty("--ag-split-left", `${this.splitWidthPct}vw`);
    if (this.mdPaneEl) this.mdPaneEl.hidden = !this.splitOpen;
    if (this.splitMdBtn) {
      this.splitMdBtn.dataset.active = this.splitOpen ? "true" : "false";
      this.splitMdBtn.textContent = this.splitOpen
        ? sidebarText("仅留导图", "Map Only")
        : sidebarText("左MD/右导图", "Split MD");
      this.splitMdBtn.title = this.splitOpen
        ? sidebarText("关闭左侧 Markdown，仅保留右侧思维导图", "Close left Markdown pane and keep mind map only")
        : sidebarText("开启左 Markdown 源码、右思维导图分屏对比与编辑", "Split screen: Markdown on left, Mind Map on right");
    }
    if (this.splitOpen) this.syncMdPaneContent(this.currentMd, true);
    requestAnimationFrame(() => {
      try {
        const api = (window as any).inkmap;
        api?.mindMap?.resize();
        if (fitAfter) api?.mindMap?.view?.fit();
      } catch {}
    });
  }

  private renderFilePicker(files: McpFileEntry[] = [], selected = this.currentFile) {
    if (!this.fileSelectEl) return;
    this.fileSelectEl.innerHTML = "";
    if (!files.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = sidebarText("未找到 Markdown 文件", "No Markdown files");
      this.fileSelectEl.appendChild(opt);
      this.fileSelectEl.disabled = true;
      if (this.openRawBtn) this.openRawBtn.disabled = true;
      return;
    }
    this.fileSelectEl.disabled = false;
    if (this.openRawBtn) this.openRawBtn.disabled = !selected;

    const activeFiles = files.filter(f => f.group === "active");
    const projectFiles = files.filter(f => f.group !== "active");

    const appendOptions = (parent: HTMLElement, list: McpFileEntry[]) => {
      for (const item of list) {
        const opt = document.createElement("option");
        opt.value = item.path;
        opt.textContent = item.label;
        opt.title = item.path;
        if (item.path === selected) opt.selected = true;
        parent.appendChild(opt);
      }
    };

    if (activeFiles.length && projectFiles.length) {
      const g1 = document.createElement("optgroup");
      g1.label = sidebarText("当前工作区", "Active Workspace");
      appendOptions(g1, activeFiles);
      const g2 = document.createElement("optgroup");
      g2.label = sidebarText("其他项目", "Other Projects");
      appendOptions(g2, projectFiles);
      this.fileSelectEl.append(g1, g2);
    } else {
      appendOptions(this.fileSelectEl, files);
    }
  }

  private mountToolbarControls() {
    const bar = document.getElementById("bar");
    if (!bar || document.getElementById("ag-file-select")) return;

    const style = document.createElement("style");
    style.textContent = `
      html, body { margin: 0; height: 100%; overflow: hidden; background: var(--ink-bg) !important; color: var(--ui-text) !important; }
      #map { position: fixed; inset: 0; width: 100vw; height: 100vh; transition: left .12s ease, width .12s ease; }
      :root.ag-split-active #map { left: var(--ag-split-left, 42vw); width: calc(100vw - var(--ag-split-left, 42vw)); }
      #ag-file-select { max-width: 190px; font-weight: 550; text-overflow: ellipsis; overflow: hidden; }
      #ag-open-raw, #ag-split-md { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
      #ag-split-md[data-active="true"] { background: color-mix(in srgb, var(--ui-primary, #336df4) 14%, transparent); color: var(--ui-primary, #336df4); font-weight: 600; }
      #ag-md-pane {
        position: fixed; top: calc(var(--toolbar-height, 40px) + 18px); left: 12px; bottom: 12px;
        width: calc(var(--ag-split-left, 42vw) - 16px); z-index: 30;
        display: flex; flex-direction: column;
        background: var(--ui-solid, #fff); color: var(--ui-text, #1f2329);
        border: 1px solid var(--ui-border-strong, rgba(31,35,41,.15)); border-radius: 10px;
        box-shadow: var(--ui-shadow, 0 4px 16px rgba(31,35,41,.08)); overflow: hidden;
      }
      #ag-md-pane[hidden] { display: none !important; }
      .ag-md-header {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 7px 10px; border-bottom: 1px solid var(--ui-border, rgba(31,35,41,.09));
        background: var(--ui-subtle, #f6f7f9); font-size: 12px;
      }
      .ag-md-title {
        font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;
      }
      .ag-md-close {
        border: 1px solid var(--ui-border-strong, rgba(31,35,41,.15)); background: var(--ui-solid, #fff);
        color: var(--ui-text, #1f2329); border-radius: 5px; padding: 2px 8px; font-size: 11.5px; cursor: pointer;
      }
      .ag-md-close:hover { background: var(--ui-hover, rgba(31,35,41,.06)); }
      #ag-md-textarea {
        flex: 1; width: 100%; box-sizing: border-box; border: 0; outline: none; resize: none;
        padding: 12px 14px; background: var(--ui-solid, #fff); color: var(--ui-text, #1f2329);
        font: 12.5px/1.6 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        tab-size: 2;
      }
      #ag-md-resizer {
        position: absolute; top: 0; right: 0; bottom: 0; width: 5px; cursor: col-resize;
        background: transparent;
      }
      #ag-md-resizer:hover { background: color-mix(in srgb, var(--ui-primary, #336df4) 35%, transparent); }
    `;
    document.head.appendChild(style);

    this.fileSelectEl = document.createElement("select");
    this.fileSelectEl.id = "ag-file-select";
    this.fileSelectEl.setAttribute("aria-label", sidebarText("选择 Markdown 文件", "Select Markdown file"));
    this.fileSelectEl.title = sidebarText("切换要查看或编辑的 Markdown 导图文件", "Switch Markdown file");
    this.fileSelectEl.addEventListener("change", () => {
      const next = this.fileSelectEl?.value;
      if (next) void this.switchFile(next);
      this.fileSelectEl?.blur();
    });

    this.splitMdBtn = document.createElement("button");
    this.splitMdBtn.id = "ag-split-md";
    this.splitMdBtn.type = "button";
    this.splitMdBtn.addEventListener("click", () => {
      this.splitOpen = !this.splitOpen;
      this.applySplitLayout(true);
      this.splitMdBtn?.blur();
    });

    this.openRawBtn = document.createElement("button");
    this.openRawBtn.id = "ag-open-raw";
    this.openRawBtn.type = "button";
    this.openRawBtn.textContent = sidebarText("原文件", "Raw");
    this.openRawBtn.title = sidebarText("在侧栏并排打开原始 Markdown 文件预览", "Open raw Markdown file in side pane");
    this.openRawBtn.addEventListener("click", () => {
      if (this.currentFileUri) {
        void this.app.request(
          {
            method: "com.google.antigravity/toggle-aux-pane",
            params: { tabType: "fileView", uri: this.currentFileUri },
          } as any,
          ToggleAuxPaneResultSchema as any,
        ).catch(() => {
          if (this.openRawBtn) this.openRawBtn.hidden = true;
        });
      }
      this.openRawBtn?.blur();
    });

    const sepEl = document.createElement("span");
    sepEl.className = "sep";

    bar.prepend(this.fileSelectEl, this.splitMdBtn, this.openRawBtn, sepEl);

    this.mdPaneEl = document.createElement("aside");
    this.mdPaneEl.id = "ag-md-pane";
    this.mdPaneEl.hidden = true;
    this.mdPaneEl.innerHTML = `
      <div class="ag-md-header">
        <span class="ag-md-title" id="ag-md-title">Markdown</span>
        <button type="button" class="ag-md-close" id="ag-md-close"></button>
      </div>
      <textarea id="ag-md-textarea" spellcheck="false"></textarea>
      <div id="ag-md-resizer"></div>
    `;
    document.body.appendChild(this.mdPaneEl);
    this.mdTitleEl = document.getElementById("ag-md-title");
    this.mdTextareaEl = document.getElementById("ag-md-textarea") as HTMLTextAreaElement | null;
    const closeBtn = document.getElementById("ag-md-close");
    if (closeBtn) {
      closeBtn.textContent = sidebarText("× 关闭MD", "× Close MD");
      closeBtn.addEventListener("click", () => {
        this.splitOpen = false;
        this.applySplitLayout(true);
      });
    }
    if (this.mdTextareaEl) {
      this.mdTextareaEl.addEventListener("input", () => {
        const nextMd = this.mdTextareaEl!.value;
        this.currentMd = nextMd;
        window.clearTimeout(this.mdEditTimer);
        this.mdEditTimer = window.setTimeout(() => {
          const api = (window as any).inkmap;
          if (api?.load) void api.load(nextMd, true);
        }, 320);
      });
    }
    const resizer = document.getElementById("ag-md-resizer");
    if (resizer) {
      resizer.addEventListener("pointerdown", e => {
        e.preventDefault();
        resizer.setPointerCapture(e.pointerId);
        const onMove = (ev: PointerEvent) => {
          const pct = Math.max(24, Math.min(68, (ev.clientX / Math.max(1, window.innerWidth)) * 100));
          this.splitWidthPct = Math.round(pct * 10) / 10;
          this.applySplitLayout(false);
        };
        const onUp = () => {
          resizer.removeEventListener("pointermove", onMove);
          resizer.removeEventListener("pointerup", onUp);
          resizer.removeEventListener("pointercancel", onUp);
          try { (window as any).inkmap?.mindMap?.view?.fit(); } catch {}
        };
        resizer.addEventListener("pointermove", onMove);
        resizer.addEventListener("pointerup", onUp);
        resizer.addEventListener("pointercancel", onUp);
      });
    }
    this.applySplitLayout(false);
  }

  private applySnapshot(snapshot: McpWorkspaceSnapshot, doc: DocState) {
    this.currentFile = snapshot.currentFile ?? null;
    this.currentFileUri = snapshot.currentFileUri ?? null;
    this.currentVersion = doc.version;
    this.currentMd = doc.md;
    if (typeof snapshot.targetSeq === "number") {
      this.targetSeq = Math.max(this.targetSeq, snapshot.targetSeq);
    }
    if (snapshot.license) {
      this.currentLicense = parseLicense(snapshot.license);
    }
    if (snapshot.files) {
      this.renderFilePicker(snapshot.files, this.currentFile);
    }
    this.syncMdPaneContent(doc.md, true);
  }

  async switchFile(filePath: string) {
    if (!filePath || filePath === this.currentFile) return;
    const data = await this.callTool("inkmap_doc_open", { path: filePath });
    if (!data.doc) return;
    this.applySnapshot(data, data.doc);
    this.changeListener?.(data.doc);
    window.setTimeout(() => {
      try { (window as any).inkmap?.mindMap?.view?.fit(); } catch {}
    }, 120);
  }

  async handleHostToolUpdate(args?: { path?: string; workspace?: string }, snapshot?: McpWorkspaceSnapshot) {
    if (snapshot?.doc) {
      this.applySnapshot(snapshot, snapshot.doc);
      this.changeListener?.(snapshot.doc);
      window.setTimeout(() => {
        try { (window as any).inkmap?.mindMap?.view?.fit(); } catch {}
      }, 120);
      return;
    }
    const targetPath = snapshot?.currentFile || args?.path;
    const data = await this.callTool("inkmap_doc_open", {
      ...(targetPath && { path: targetPath }),
      ...(args?.workspace && { workspace: args.workspace }),
    });
    if (data.doc) {
      this.applySnapshot(data, data.doc);
      this.changeListener?.(data.doc);
      window.setTimeout(() => {
        try { (window as any).inkmap?.mindMap?.view?.fit(); } catch {}
      }, 120);
    }
  }

  async load(): Promise<DocState> {
    this.mountToolbarControls();
    if (this.initialSnapshot?.doc) {
      const doc = this.initialSnapshot.doc;
      this.applySnapshot(this.initialSnapshot, doc);
      return doc;
    }
    const targetPath = this.initialSnapshot?.currentFile || this.initialInput?.path;
    const data = await this.callTool("inkmap_doc_open", {
      ...(targetPath && { path: targetPath }),
      ...(this.initialInput?.workspace && { workspace: this.initialInput.workspace }),
    });
    const doc = data.doc as DocState;
    this.applySnapshot(data, doc);
    return doc;
  }

  async save(md: string, baseVersion: string): Promise<SaveResult> {
    if (!this.currentFile) {
      throw new Error(sidebarText("当前未选择可保存的 Markdown 文件。", "No writable Markdown file is selected."));
    }
    this.saving = true;
    try {
      const res = await this.callTool("inkmap_doc_save", {
        file: this.currentFile,
        md,
        baseVersion,
      });
      if (res.conflict && res.doc) {
        const doc = res.doc as DocState;
        this.currentVersion = doc.version;
        this.currentMd = doc.md;
        this.syncMdPaneContent(doc.md, true);
        return { ok: false, doc };
      }
      this.currentVersion = String(res.version || "");
      this.currentMd = md;
      this.syncMdPaneContent(md, false);
      return { ok: true, version: this.currentVersion };
    } finally {
      this.saving = false;
    }
  }

  onExternalChange(listener: (doc: DocState) => void) {
    this.changeListener = listener;
    const timer = window.setInterval(async () => {
      if (this.saving || this.polling) return;
      this.polling = true;
      try {
        const res = await this.callTool("inkmap_doc_poll", {
          ...(this.currentFile && { file: this.currentFile }),
          ...(this.currentVersion && { version: this.currentVersion }),
          targetSeq: this.targetSeq,
        });
        if (typeof res.targetSeq === "number") {
          this.targetSeq = Math.max(this.targetSeq, res.targetSeq);
        }
        if (res.switchedFile && res.doc) {
          this.applySnapshot(
            {
              files: res.files,
              currentFile: res.switchedFile,
              currentFileUri: res.currentFileUri,
              targetSeq: res.targetSeq,
            },
            res.doc as DocState,
          );
          listener(res.doc as DocState);
          window.setTimeout(() => {
            try { (window as any).inkmap?.mindMap?.view?.fit(); } catch {}
          }, 120);
        } else if (res.changed && res.doc) {
          const doc = res.doc as DocState;
          this.currentVersion = doc.version;
          this.currentMd = doc.md;
          this.syncMdPaneContent(doc.md, true);
          listener(doc);
        }
      } catch {
        // Ignore transient poll errors while pane is backgrounded
      } finally {
        this.polling = false;
      }
    }, 1500);

    window.addEventListener("pagehide", () => window.clearInterval(timer), { once: true });
  }

  saveView(state: ViewState) {
    if (!this.currentFile) return;
    void this.callTool("inkmap_doc_view", { file: this.currentFile, state }).catch(() => {});
  }

  async canAddToChat(): Promise<boolean> {
    const caps = this.app.getHostCapabilities();
    return Boolean(caps?.updateModelContext || caps?.message);
  }

  addToChat(target?: ChatTarget) {
    if (!this.currentFile) return;
    const lines = this.currentMd.split("\n");
    const s = Math.max(0, Math.min(target?.startLine ?? 0, Math.max(0, lines.length - 1)));
    const e = Math.max(s, Math.min(target?.endLine ?? s, Math.max(0, lines.length - 1)));
    const snippet = target?.text || lines.slice(s, e + 1).join("\n");
    const formatted = `来自 \`${this.currentFile}\`（第 ${s + 1}–${e + 1} 行）：\n\`\`\`markdown\n${snippet}\n\`\`\``;
    const caps = this.app.getHostCapabilities();
    if (caps?.updateModelContext) {
      void this.app.updateModelContext({
        content: [{ type: "text", text: formatted }],
      }).catch(() => {});
    } else if (caps?.message) {
      void this.app.sendMessage({
        role: "user",
        content: [{ type: "text", text: formatted }],
      }).catch(() => {});
    }
  }

  license(): Promise<LicenseState> {
    return this.licenseCheck ??= this.callTool("inkmap_access")
      .then(raw => {
        const parsed = parseLicense(raw);
        this.currentLicense = parsed;
        return parsed;
      })
      .finally(() => {
        this.licenseCheck = undefined;
      });
  }

  async checkout(mode: "buy" | "restore") {
    if (mode !== "restore") throw new Error("Only account restoration is supported.");
    const { url } = await this.callTool("inkmap_restore_access");
    if (typeof url !== "string" || new URL(url).protocol !== "https:") {
      throw new Error("Invalid account link.");
    }
    const opened = await this.app.openLink({ url });
    if (opened.isError) throw new Error("Unable to open account login.");
  }

  phoneSignIn = {
    send: async (phone: string): Promise<PhoneSignInResult> => {
      const { result } = await this.callTool("inkmap_phone_send", { phone });
      return result as PhoneSignInResult;
    },
    verify: async (phone: string, code: string): Promise<PhoneSignInResult<LicenseState>> => {
      const { result } = await this.callTool("inkmap_phone_verify", { phone, code });
      if (result?.ok && result.value) {
        this.currentLicense = result.value;
      }
      return result as PhoneSignInResult<LicenseState>;
    },
  };

  async signOut() {
    await this.callTool("inkmap_disconnect_access");
    this.currentLicense = { pro: false };
  }

  onLicenseChange(listener: (state: LicenseState) => void) {
    const check = () => void this.license().then(listener).catch(() => {});
    const interval = window.setInterval(check, 4500);
    window.addEventListener("focus", check);
    window.addEventListener("pagehide", () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", check);
    }, { once: true });
  }

  async ads() {
    return [];
  }

  async saveFile(name: string, dataUrl: string): Promise<boolean> {
    const data = /^data:(image\/(?:png|svg\+xml));base64,([\s\S]+)$/.exec(dataUrl);
    if (data && this.app.getHostCapabilities()?.downloadFile) {
      const { isError } = await this.app.downloadFile({
        contents: [{
          type: "resource",
          resource: { uri: "file:///" + encodeURIComponent(name), mimeType: data[1], blob: data[2] },
        }],
      });
      if (!isError) return true;
    }
    return downloadFile(name, dataUrl);
  }
}
