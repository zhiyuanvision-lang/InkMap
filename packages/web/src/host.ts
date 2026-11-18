import type { Ad, LicenseState, PhoneSignInResult, ViewState, WechatOrderResult } from "@inkmap/core";
import { detectDefaultLocale, locale as currentUiLocale, t, type Locale } from "./i18n";
import { revealMarkdownLines } from "./md-lines";

export interface DocState {
  name: string;
  md: string;
  version: string;
  viewState?: ViewState;
  /** False when the host cannot safely write this resource. */
  writable?: boolean;
}

export interface ChatTarget {
  startLine: number;
  endLine: number;
  text?: string;
}

export type SaveResult = { ok: true; version: string } | { ok: false; doc: DocState };

export interface HostCapabilities {
  /** The destination of a successful save. Individual documents can still be read-only. */
  readonly saveTarget: "editor" | "file" | "copy";
  /** The account actions the host and its distribution channel can offer. */
  readonly account: "purchase" | "restore" | "none";
  /** Fit tools into a narrow panel. */
  readonly compact?: boolean;
  /** Render without loading remote or ungranted document assets. */
  readonly restrictAssets?: boolean;
}

/** Where the document lives. The CLI serves it over HTTP; the editor extension posts messages. */
export interface Host {
  /** Prefix for resolving relative image paths in the document. */
  assetBase: string;
  locale: Locale;
  /** Read after load(), which may discover the host's capabilities. */
  readonly capabilities: HostCapabilities;
  load(): Promise<DocState>;
  save(md: string, baseVersion: string): Promise<SaveResult>;
  onExternalChange(listener: (doc: DocState) => void): void;
  /** The text editor's cursor moved to `line` (zero-based). */
  onReveal?(listener: (line: number) => void): void;
  /** The user picked the node starting at `line` (zero-based). */
  select?(line: number, endLine?: number): void;
  /** Called immediately when the mind map data or frontmatter changes. */
  onMapMarkdownChange?(md: string): void;
  /** Flushes any debounced host-side Markdown editor changes into the mind map before saving. */
  flushPendingEdits?(): Promise<void> | void;
  /** Called when the user switches UI language in the toolbar. */
  refreshLanguage?(): void;
  /** Set when the host can hand Markdown lines to an AI chat; resolves false where there is none. */
  canAddToChat?(): Promise<boolean>;
  /** Sends document lines `startLine`..`endLine` (zero-based, inclusive) to the chat; `text` narrows that to part of them. Without a target it only opens the chat. */
  addToChat?(target?: ChatTarget): void;
  /** The user pressed the chat shortcut (the host owns the keybinding). */
  onChatRequest?(listener: () => void): void;
  /** Persists the current fold and viewport state for this document, without touching the Markdown file. */
  saveView?(state: ViewState): void;
  /** Set when the host owns the undo history (the editor undoes the document itself on Cmd+Z). */
  history?: { undo(): void; redo(): void };

  license(): Promise<LicenseState>;
  checkout(mode: "buy" | "restore"): Promise<void>;
  orderPro?(): Promise<WechatOrderResult>;
  openExternalUrl?(url: string): void;
  phoneSignIn?: {
    send(phone: string): Promise<PhoneSignInResult>;
    verify(phone: string, code: string): Promise<PhoneSignInResult<LicenseState>>;
  };
  signOut(): Promise<void>;
  onLicenseChange(listener: (state: LicenseState) => void): void;
  ads(): Promise<Ad[]>;
  /** Saves an exported file given as a data URL; resolves false when the user cancels. */
  saveFile(name: string, dataUrl: string): Promise<boolean>;
  /** Reports an anonymous feature or funnel event count to the host. */
  track?(event: string): void;
}

export class PopupBlockedError extends Error {
  constructor(message: string, public readonly url?: string) {
    super(message);
  }
}

export const browserLocale = (): Locale => detectDefaultLocale();

interface HttpFileEntry {
  path: string;
  label: string;
  group: "active" | "project";
}

export class HttpHost implements Host {
  private base = /^\/s\/[a-f0-9]{48}\/$/.test(location.pathname) ? location.pathname : "/";
  private sidebar = this.base !== "/";
  private account: HostCapabilities["account"] = this.sidebar ? "restore" : "purchase";
  private hostAccountNavigation = false;
  private currentFile: string | null = null;
  private currentMd = "";
  private currentVersion = "";
  private cachedFiles: HttpFileEntry[] = [];
  private expandedKeys = new Set<string>();
  private initializedExpansionForFile = "";
  private treeOpen = false;
  private mdOpen = false;
  private treeWidthPx = 240;
  private mdWidthPx = 420;
  private mdEditTimer = 0;
  private activeStartLine = 0;
  private activeEndLine = 0;
  private treeBtnEl: HTMLButtonElement | null = null;
  private splitBtnEl: HTMLButtonElement | null = null;
  private treePaneEl: HTMLElement | null = null;
  private treeTitleEl: HTMLElement | null = null;
  private treeCloseBtnEl: HTMLButtonElement | null = null;
  private treeBodyEl: HTMLElement | null = null;
  private treeSearchEl: HTMLInputElement | null = null;
  private mdPaneEl: HTMLElement | null = null;
  private mdTitleEl: HTMLElement | null = null;
  private mdLineBadgeEl: HTMLElement | null = null;
  private mdCloseBtnEl: HTMLButtonElement | null = null;
  private mdGutterEl: HTMLElement | null = null;
  private mdBandEl: HTMLElement | null = null;
  private mdTextareaEl: HTMLTextAreaElement | null = null;
  private externalListeners: ((doc: DocState) => void)[] = [];
  private revealListeners: ((line: number) => void)[] = [];

  get capabilities(): HostCapabilities {
    return { saveTarget: "file", account: this.account, compact: this.sidebar, restrictAssets: this.sidebar };
  }
  assetBase = this.base + "doc-assets/";
  locale = browserLocale();
  private events = new EventSource(this.base + "api/events");

  private uiText(zh: string, en: string) {
    return currentUiLocale() === "zh" ? zh : en;
  }

  private parseFileEntry(item: HttpFileEntry) {
    const label = typeof item.label === "string" ? item.label : "";
    const sepIdx = label.indexOf(" / ");
    if (sepIdx > 0) {
      const project = label.slice(0, sepIdx).trim();
      const rel = label.slice(sepIdx + 3).replace(/\\/g, "/");
      return { project, rel, item };
    }
    const rel = (label || (item.path || "").split(/[\\/]/).pop() || "").replace(/\\/g, "/");
    const normPath = (item.path || "").replace(/\\/g, "/");
    const suffix = "/" + rel;
    let project = this.uiText("当前项目", "Workspace");
    if (normPath.endsWith(suffix)) {
      const rootDir = normPath.slice(0, normPath.length - suffix.length);
      project = rootDir.split("/").filter(Boolean).pop() || project;
    }
    return { project, rel, item };
  }

  private renderMdGutterAndBand() {
    if (!this.mdTextareaEl) return;
    const totalLines = Math.max(1, this.mdTextareaEl.value.split("\n").length);
    const sLine = Math.max(0, Math.min(this.activeStartLine, totalLines - 1));
    const eLine = Math.max(sLine, Math.min(this.activeEndLine, totalLines - 1));
    if (this.mdLineBadgeEl) {
      const label = sLine === eLine ? `${sLine + 1}` : `${sLine + 1}–${eLine + 1}`;
      this.mdLineBadgeEl.textContent = this.uiText(`行 ${label}`, `Ln ${label}`);
    }
    if (this.mdGutterEl) {
      const nums: string[] = [];
      for (let i = 0; i < totalLines; i++) {
        const active = i >= sLine && i <= eLine;
        nums.push(`<div class="md-gutter-ln${active ? " is-active" : ""}">${i + 1}</div>`);
      }
      this.mdGutterEl.innerHTML = nums.join("");
      this.mdGutterEl.scrollTop = this.mdTextareaEl.scrollTop;
    }
    if (this.mdBandEl) {
      const lineHeight = 20.8; // 13px * 1.6
      const padTop = 12;
      const top = padTop + sLine * lineHeight - this.mdTextareaEl.scrollTop;
      const height = Math.max(1, eLine - sLine + 1) * lineHeight;
      this.mdBandEl.style.transform = `translateY(${top}px)`;
      this.mdBandEl.style.height = `${height}px`;
    }
  }

  private syncMdPane(md = this.currentMd, force = false) {
    if (this.mdTitleEl) {
      const fileName = this.currentFile ? this.currentFile.split(/[\\/]/).pop() || "Markdown" : "Markdown";
      this.mdTitleEl.textContent = fileName;
      this.mdTitleEl.title = this.currentFile || fileName;
    }
    if (!this.mdTextareaEl) return;
    if (force || document.activeElement !== this.mdTextareaEl) {
      if (this.mdTextareaEl.value !== md) this.mdTextareaEl.value = md;
    }
    this.renderMdGutterAndBand();
  }

  private applyWorkspaceLayout(fitAfter = false) {
    const treeW = this.treeOpen ? this.treeWidthPx : 0;
    const mdW = this.mdOpen ? this.mdWidthPx : 0;
    const mapLeft = treeW + mdW;
    const mdLeft = treeW;

    document.documentElement.classList.toggle("http-ide-active", mapLeft > 0);
    document.documentElement.style.setProperty("--http-tree-w", `${treeW}px`);
    document.documentElement.style.setProperty("--http-md-left", `${mdLeft}px`);
    document.documentElement.style.setProperty("--http-md-w", `${mdW}px`);
    document.documentElement.style.setProperty("--http-map-left", `${mapLeft}px`);

    if (this.treePaneEl) this.treePaneEl.hidden = !this.treeOpen;
    if (this.mdPaneEl) this.mdPaneEl.hidden = !this.mdOpen;
    if (this.treeBtnEl) {
      this.treeBtnEl.dataset.active = String(this.treeOpen);
      const span = this.treeBtnEl.querySelector("span");
      if (span) span.textContent = this.uiText("项目目录", "Files");
      this.treeBtnEl.title = this.treeOpen
        ? this.uiText("隐藏左侧项目文件目录树", "Hide project file tree sidebar")
        : this.uiText("显示左侧项目文件目录树", "Show project file tree sidebar");
    }
    if (this.splitBtnEl) {
      this.splitBtnEl.dataset.active = String(this.mdOpen);
      this.splitBtnEl.textContent = this.mdOpen
        ? this.uiText("仅留导图", "Map Only")
        : this.uiText("左MD/右导图", "Split MD");
      this.splitBtnEl.title = this.mdOpen
        ? this.uiText("关闭左侧 Markdown 源文件，仅保留右侧思维导图", "Close left Markdown source and keep mind map")
        : this.uiText("打开左侧原始 Markdown、右侧思维导图分屏对比与编辑", "Open left raw Markdown + right mind map split view");
    }
    if (this.treeTitleEl) this.treeTitleEl.textContent = this.uiText("项目文件 (Explorer)", "Project Explorer");
    if (this.treeCloseBtnEl) this.treeCloseBtnEl.textContent = this.uiText("× 收起", "× Hide");
    if (this.treeSearchEl) this.treeSearchEl.placeholder = this.uiText("搜索项目 .md 文件…", "Filter .md files…");
    if (this.mdCloseBtnEl) this.mdCloseBtnEl.textContent = this.uiText("× 关闭MD", "× Close MD");

    if (this.mdOpen) this.syncMdPane(this.currentMd, true);
    if (this.treeOpen) this.renderTreeDom();

    requestAnimationFrame(() => {
      try {
        const api = (window as any).inkmap;
        api?.mindMap?.resize();
        if (fitAfter) api?.mindMap?.view?.fit();
      } catch {}
    });
  }

  private renderTreeDom() {
    if (!this.treeBodyEl) return;
    const filterText = (this.treeSearchEl?.value ?? "").trim().toLowerCase();
    const isFiltering = Boolean(filterText);

    interface FileLeaf { name: string; path: string; rel: string; project: string; isMarkmap: boolean }
    interface FolderNode { name: string; key: string; folders: Map<string, FolderNode>; sortedFolders: FolderNode[]; files: FileLeaf[]; totalFiles: number }
    interface ProjNode { name: string; key: string; active: boolean; count: number; root: FolderNode }

    const projMap = new Map<string, ProjNode>();
    for (const raw of this.cachedFiles) {
      const { project, rel, item } = this.parseFileEntry(raw);
      if (filterText && !project.toLowerCase().includes(filterText) && !rel.toLowerCase().includes(filterText)) continue;
      let proj = projMap.get(project);
      if (!proj) {
        proj = {
          name: project,
          key: `proj:${project}`,
          active: item.group === "active",
          count: 0,
          root: { name: "", key: `proj:${project}`, folders: new Map(), sortedFolders: [], files: [], totalFiles: 0 },
        };
        projMap.set(project, proj);
      }
      if (item.group === "active") proj.active = true;
      proj.count++;

      const parts = rel.split("/").filter(Boolean);
      const fileName = parts.pop() || rel;
      let curr = proj.root;
      let acc = `proj:${project}`;
      for (const seg of parts) {
        acc += `/${seg}`;
        let next = curr.folders.get(seg);
        if (!next) {
          next = { name: seg, key: acc, folders: new Map(), sortedFolders: [], files: [], totalFiles: 0 };
          curr.folders.set(seg, next);
        }
        curr = next;
      }
      curr.files.push({
        name: fileName,
        path: item.path,
        rel,
        project,
        isMarkmap: /\.markmap\.md$/i.test(fileName),
      });
    }

    const compactAndSort = (folder: FolderNode) => {
      const compacted: FolderNode[] = [];
      for (const child of folder.folders.values()) {
        while (child.files.length === 0 && child.folders.size === 1) {
          const only = [...child.folders.values()][0]!;
          child.name = `${child.name}/${only.name}`;
          child.key = only.key;
          child.folders = only.folders;
          child.files = only.files;
        }
        compactAndSort(child);
        compacted.push(child);
      }
      compacted.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
      folder.sortedFolders = compacted;
      folder.files.sort((a, b) => {
        if (a.isMarkmap !== b.isMarkmap) return a.isMarkmap ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      });
      let total = folder.files.length;
      for (const c of compacted) total += c.totalFiles;
      folder.totalFiles = total;
    };

    const projects = [...projMap.values()];
    for (const p of projects) compactAndSort(p.root);
    projects.sort((a, b) => (a.active !== b.active ? (a.active ? -1 : 1) : a.name.localeCompare(b.name)));

    if (this.currentFile && this.initializedExpansionForFile !== this.currentFile) {
      this.initializedExpansionForFile = this.currentFile;
      for (const p of projects) {
        if (p.active) this.expandedKeys.add(p.key);
        const mark = (f: FolderNode): boolean => {
          let hit = f.files.some(x => x.path === this.currentFile);
          for (const s of f.sortedFolders) if (mark(s)) hit = true;
          if (hit) this.expandedKeys.add(f.key);
          return hit;
        };
        if (mark(p.root)) this.expandedKeys.add(p.key);
      }
    }

    this.treeBodyEl.innerHTML = "";
    if (!projects.length) {
      const empty = document.createElement("div");
      empty.className = "http-tree-empty";
      empty.textContent = isFiltering
        ? this.uiText("无匹配的 Markdown 文件", "No matching Markdown files")
        : this.uiText("未找到 Markdown 文件", "No Markdown files");
      this.treeBodyEl.appendChild(empty);
      return;
    }

    const chevronSvg = `<svg class="http-tree-chevron" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>`;
    const folderSvg = `<svg class="http-tree-icon http-icon-folder" viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M1.75 2.5A1.75 1.75 0 0 0 0 4.25v7.5C0 12.716.784 13.5 1.75 13.5h12.5A1.75 1.75 0 0 0 16 11.75v-5.5A1.75 1.75 0 0 0 14.25 4.5H7.82a.25.25 0 0 1-.177-.073L6.28 3.063A1.75 1.75 0 0 0 5.043 2.5H1.75Z"/></svg>`;
    const mapFileSvg = `<svg class="http-tree-icon http-icon-map" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="3.5" cy="8" r="1.75"/><circle cx="12.5" cy="4" r="1.75"/><circle cx="12.5" cy="12" r="1.75"/><path d="M5.25 7.3L10.75 4.7M5.25 8.7l5.5 2.6"/></svg>`;
    const mdFileSvg = `<svg class="http-tree-icon http-icon-md" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 1.5H4A1.5 1.5 0 0 0 2.5 3v10A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5V5.5L9.5 1.5Z"/><path d="M9.5 1.5v4h4"/></svg>`;

    const renderFolder = (folder: FolderNode, container: HTMLElement, depth: number) => {
      for (const sub of folder.sortedFolders) {
        const isOpen = isFiltering || this.expandedKeys.has(sub.key);
        const group = document.createElement("div");
        group.className = "http-tree-group";

        const row = document.createElement("button");
        row.type = "button";
        row.className = `http-tree-row http-tree-folder ${isOpen ? "is-open" : ""}`;
        row.style.paddingLeft = `${8 + depth * 13}px`;
        row.innerHTML = `${chevronSvg}${folderSvg}<span class="http-tree-label"></span><span class="http-tree-count">${sub.totalFiles}</span>`;
        row.querySelector(".http-tree-label")!.textContent = sub.name;
        row.title = sub.name;
        row.addEventListener("click", () => {
          if (this.expandedKeys.has(sub.key)) this.expandedKeys.delete(sub.key);
          else this.expandedKeys.add(sub.key);
          this.renderTreeDom();
        });
        group.appendChild(row);

        if (isOpen) {
          const children = document.createElement("div");
          children.className = "http-tree-children";
          renderFolder(sub, children, depth + 1);
          group.appendChild(children);
        }
        container.appendChild(group);
      }

      for (const file of folder.files) {
        const isSelected = file.path === this.currentFile;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `http-tree-row http-tree-file ${isSelected ? "is-selected" : ""}`;
        btn.style.paddingLeft = `${8 + depth * 13}px`;
        btn.innerHTML = `<span class="http-tree-check">${isSelected ? "✓" : ""}</span>${file.isMarkmap ? mapFileSvg : mdFileSvg}<span class="http-tree-label"></span>${file.isMarkmap ? `<span class="http-tree-tag">${this.uiText("导图", "Map")}</span>` : ""}`;
        btn.querySelector(".http-tree-label")!.textContent = file.name;
        btn.title = `${file.project} / ${file.rel}`;
        btn.addEventListener("click", () => {
          void this.switchFile(file.path);
        });
        container.appendChild(btn);
      }
    };

    for (const proj of projects) {
      const isOpen = isFiltering || this.expandedKeys.has(proj.key) || projects.length === 1;
      const wrap = document.createElement("div");
      wrap.className = "http-tree-project";

      const head = document.createElement("button");
      head.type = "button";
      head.className = `http-tree-row http-tree-proj-header ${isOpen ? "is-open" : ""}`;
      head.innerHTML = `${chevronSvg}${folderSvg}<span class="http-tree-label"></span><span class="http-tree-count">${proj.count}</span>`;
      head.querySelector(".http-tree-label")!.textContent = proj.name;
      head.addEventListener("click", () => {
        if (this.expandedKeys.has(proj.key)) this.expandedKeys.delete(proj.key);
        else this.expandedKeys.add(proj.key);
        this.renderTreeDom();
      });
      wrap.appendChild(head);

      if (isOpen) {
        const body = document.createElement("div");
        body.className = "http-tree-proj-body";
        renderFolder(proj.root, body, 1);
        wrap.appendChild(body);
      }
      this.treeBodyEl.appendChild(wrap);
    }
  }

  async flushPendingEdits() {
    if (this.mdEditTimer) {
      window.clearTimeout(this.mdEditTimer);
      this.mdEditTimer = 0;
      await (window as any).inkmap?.load?.(this.currentMd, true);
    }
  }

  private async switchFile(filePath: string) {
    if (!filePath || filePath === this.currentFile) return;
    await this.flushPendingEdits();
    await (window as any).inkmap?.flushSave?.();
    const res = await fetch(this.base + "api/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: filePath }),
    });
    if (!res.ok) return;
    const data = await res.json();
    this.currentFile = data.currentFile ?? filePath;
    if (Array.isArray(data.files)) this.cachedFiles = data.files;
    if (data.doc) {
      this.currentMd = data.doc.md;
      this.currentVersion = data.doc.version;
      this.syncMdPane(data.doc.md, true);
      this.renderTreeDom();
      this.externalListeners.forEach(fn => fn(data.doc));
      window.setTimeout(() => {
        try { (window as any).inkmap?.mindMap?.view?.fit(); } catch {}
      }, 120);
    }
  }

  private mountWorkspaceControls(autoOpenIde: boolean) {
    const bar = document.getElementById("bar");
    if (!bar || document.getElementById("http-tree-btn")) return;

    const style = document.createElement("style");
    style.textContent = `
      :root.http-ide-active #bar {
        top: 0 !important; left: 0 !important; right: 0 !important;
        min-height: 44px; border-radius: 0 !important;
        border-top: none !important; border-left: none !important; border-right: none !important;
        border-bottom: 1px solid var(--ui-border-strong, rgba(31,35,41,.15)) !important;
        box-shadow: none !important; padding: 4px 12px !important;
        background: var(--ui-solid, #fff) !important;
      }
      :root.http-ide-active #map {
        top: var(--toolbar-height, 44px) !important;
        left: var(--http-map-left, 0px) !important;
        width: calc(100vw - var(--http-map-left, 0px)) !important;
        height: calc(100vh - var(--toolbar-height, 44px)) !important;
      }
      #http-tree-btn, #http-split-btn {
        display: inline-flex; align-items: center; gap: 5px; height: 29px; padding: 0 10px;
        border: 1px solid var(--ui-border, rgba(31,35,41,.1)); border-radius: 7px;
        background: var(--ui-subtle, #f6f7f9); font-size: 12px; font-weight: 560;
      }
      #http-tree-btn:hover, #http-split-btn:hover {
        background: var(--ui-hover, rgba(31,35,41,.06)); border-color: var(--ui-border-strong, rgba(31,35,41,.16));
      }
      #http-tree-btn[data-active="true"], #http-split-btn[data-active="true"] {
        background: color-mix(in srgb, var(--ui-primary, #336df4) 12%, transparent);
        border-color: color-mix(in srgb, var(--ui-primary, #336df4) 30%, transparent);
        color: var(--ui-primary, #336df4); font-weight: 600;
      }
      #http-tree-pane, #http-md-pane {
        position: fixed; top: var(--toolbar-height, 44px); bottom: 0; z-index: 30;
        display: flex; flex-direction: column;
        background: var(--ui-solid, #fff); color: var(--ui-text, #1f2329);
        border-right: 1px solid var(--ui-border-strong, rgba(31,35,41,.16));
        border-radius: 0; box-shadow: none; overflow: hidden;
      }
      #http-tree-pane {
        left: 0; width: var(--http-tree-w, 240px);
        background: var(--ui-subtle, #f6f7f9);
      }
      #http-md-pane {
        left: var(--http-md-left, 240px); width: var(--http-md-w, 420px);
      }
      #http-tree-pane[hidden], #http-md-pane[hidden] { display: none !important; }
      .http-pane-header {
        display: flex; align-items: center; justify-content: space-between; gap: 6px;
        height: 35px; padding: 0 10px; box-sizing: border-box;
        border-bottom: 1px solid var(--ui-border, rgba(31,35,41,.09));
        background: var(--ui-subtle, #f6f7f9); font-size: 12px; flex: none;
      }
      .http-pane-title {
        display: inline-flex; align-items: center; gap: 5px;
        font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;
      }
      .http-md-line-badge {
        font-size: 11px; font-weight: 560; font-variant-numeric: tabular-nums;
        padding: 1px 6px; border-radius: 4px;
        background: color-mix(in srgb, var(--ui-primary, #336df4) 12%, transparent);
        color: var(--ui-primary, #336df4); flex: none;
      }
      .http-pane-close {
        border: 1px solid var(--ui-border-strong, rgba(31,35,41,.15)); background: var(--ui-solid, #fff);
        color: var(--ui-muted, #646a73); border-radius: 5px; padding: 2px 7px; font-size: 11px; cursor: pointer;
      }
      .http-pane-close:hover { background: var(--ui-hover, rgba(31,35,41,.06)); color: var(--ui-text, #1f2329); }
      .http-tree-search-box {
        padding: 6px 8px; border-bottom: 1px solid var(--ui-border, rgba(31,35,41,.08)); flex: none;
      }
      .http-tree-search {
        width: 100%; box-sizing: border-box; border: 1px solid var(--ui-border-strong, rgba(31,35,41,.15));
        border-radius: 6px; padding: 4px 8px; font-size: 12px; background: var(--ui-solid, #fff);
        color: var(--ui-text, #1f2329); outline: none;
      }
      .http-tree-search:focus { border-color: var(--ui-primary, #336df4); }
      .http-tree-body { flex: 1; overflow-y: auto; padding: 6px; scrollbar-width: thin; }
      .http-tree-row {
        display: flex; align-items: center; gap: 5px; width: 100%; box-sizing: border-box;
        min-height: 26px; padding: 3px 7px; border: 0; border-radius: 6px;
        background: transparent; color: var(--ui-text, #1f2329); font-size: 12px;
        cursor: pointer; text-align: left;
      }
      .http-tree-row:hover { background: var(--ui-hover, rgba(31,35,41,.06)); }
      .http-tree-proj-header { font-weight: 650; color: var(--ui-muted, #646a73); }
      .http-tree-folder { font-weight: 550; }
      .http-tree-chevron { flex: none; color: var(--ui-muted, #646a73); transition: transform .14s ease; }
      .http-tree-folder.is-open > .http-tree-chevron,
      .http-tree-proj-header.is-open > .http-tree-chevron { transform: rotate(90deg); }
      .http-tree-icon { flex: none; }
      .http-icon-folder { color: #e09f3e; }
      .http-icon-map { color: var(--ui-primary, #336df4); }
      .http-icon-md { color: var(--ui-muted, #646a73); }
      .http-tree-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .http-tree-count {
        flex: none; font-size: 10px; color: var(--ui-muted, #646a73);
        background: color-mix(in srgb, var(--ui-text, #1f2329) 6%, transparent);
        padding: 0 5px; border-radius: 999px;
      }
      .http-tree-check { width: 11px; flex: none; font-size: 11px; font-weight: 700; color: var(--ui-primary, #336df4); }
      .http-tree-tag {
        flex: none; font-size: 10px; font-weight: 600; padding: 0 4px; border-radius: 4px;
        background: color-mix(in srgb, var(--ui-primary, #336df4) 12%, transparent); color: var(--ui-primary, #336df4);
      }
      .http-tree-file.is-selected {
        background: color-mix(in srgb, var(--ui-primary, #336df4) 12%, transparent);
        color: var(--ui-primary, #336df4); font-weight: 600;
      }
      .http-tree-empty { padding: 16px 10px; text-align: center; font-size: 12px; color: var(--ui-muted, #646a73); }
      .http-md-body {
        position: relative; flex: 1; display: flex; min-height: 0; overflow: hidden;
        background: var(--ui-solid, #fff);
      }
      #http-md-gutter {
        width: 40px; flex: none; overflow: hidden; user-select: none;
        padding: 12px 6px 12px 0; box-sizing: border-box; text-align: right;
        background: color-mix(in srgb, var(--ui-subtle, #f6f7f9) 65%, var(--ui-solid, #fff));
        border-right: 1px solid var(--ui-border, rgba(31,35,41,.08));
        font: 11.5px/20.8px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        color: var(--ui-muted, #646a73); font-variant-numeric: tabular-nums;
      }
      .md-gutter-ln { height: 20.8px; padding-right: 4px; }
      .md-gutter-ln.is-active {
        color: var(--ui-primary, #336df4); font-weight: 700;
        background: color-mix(in srgb, var(--ui-primary, #336df4) 12%, transparent);
      }
      .http-md-editor-stage {
        position: relative; flex: 1; min-width: 0; height: 100%; overflow: hidden;
      }
      #http-md-band {
        position: absolute; left: 0; right: 0; top: 0; height: 20.8px; pointer-events: none;
        background: color-mix(in srgb, var(--ui-primary, #336df4) 10%, transparent);
        border-left: 2.5px solid var(--ui-primary, #336df4);
        transition: transform .06s ease-out, height .06s ease-out;
      }
      #http-md-textarea {
        position: relative; z-index: 1; width: 100%; height: 100%; box-sizing: border-box;
        border: 0; outline: none; resize: none;
        padding: 12px 14px; background: transparent; color: var(--ui-text, #1f2329);
        font: 13px/20.8px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        tab-size: 2; white-space: pre; overflow: auto;
      }
      .http-pane-resizer {
        position: absolute; top: 0; right: 0; bottom: 0; width: 5px; z-index: 5; cursor: col-resize; background: transparent;
        transition: background .12s ease;
      }
      .http-pane-resizer:hover, .http-pane-resizer:active { background: var(--ui-primary, #336df4); }
    `;
    document.head.appendChild(style);

    this.treeBtnEl = document.createElement("button");
    this.treeBtnEl.id = "http-tree-btn";
    this.treeBtnEl.type = "button";
    this.treeBtnEl.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M1.75 2.5A1.75 1.75 0 0 0 0 4.25v7.5C0 12.716.784 13.5 1.75 13.5h12.5A1.75 1.75 0 0 0 16 11.75v-5.5A1.75 1.75 0 0 0 14.25 4.5H7.82a.25.25 0 0 1-.177-.073L6.28 3.063A1.75 1.75 0 0 0 5.043 2.5H1.75Z"/></svg><span>${this.uiText("项目目录", "Files")}</span>`;
    this.treeBtnEl.addEventListener("click", () => {
      this.treeOpen = !this.treeOpen;
      this.applyWorkspaceLayout(true);
      this.treeBtnEl?.blur();
    });

    this.splitBtnEl = document.createElement("button");
    this.splitBtnEl.id = "http-split-btn";
    this.splitBtnEl.type = "button";
    this.splitBtnEl.addEventListener("click", () => {
      this.mdOpen = !this.mdOpen;
      if (this.mdOpen) this.track("split_view");
      this.applyWorkspaceLayout(true);
      this.splitBtnEl?.blur();
    });

    const sepEl = document.createElement("span");
    sepEl.className = "sep";
    bar.prepend(this.treeBtnEl, this.splitBtnEl, sepEl);

    this.treePaneEl = document.createElement("aside");
    this.treePaneEl.id = "http-tree-pane";
    this.treePaneEl.hidden = true;
    this.treePaneEl.innerHTML = `
      <div class="http-pane-header">
        <span class="http-pane-title" id="http-tree-title">${this.uiText("项目文件 (Explorer)", "Project Explorer")}</span>
        <button type="button" class="http-pane-close" id="http-tree-close">${this.uiText("× 收起", "× Hide")}</button>
      </div>
      <div class="http-tree-search-box">
        <input type="search" class="http-tree-search" placeholder="${this.uiText("搜索项目 .md 文件…", "Filter .md files…")}" />
      </div>
      <div class="http-tree-body" role="tree"></div>
      <div class="http-pane-resizer" id="http-tree-resizer" title="${this.uiText("拖拽调整目录树宽度", "Drag to resize file tree")}"></div>
    `;
    document.body.appendChild(this.treePaneEl);
    this.treeTitleEl = this.treePaneEl.querySelector("#http-tree-title");
    this.treeCloseBtnEl = this.treePaneEl.querySelector("#http-tree-close");
    this.treeBodyEl = this.treePaneEl.querySelector(".http-tree-body");
    this.treeSearchEl = this.treePaneEl.querySelector(".http-tree-search");
    this.treeSearchEl?.addEventListener("input", () => this.renderTreeDom());
    this.treeCloseBtnEl?.addEventListener("click", () => {
      this.treeOpen = false;
      this.applyWorkspaceLayout(true);
    });

    const treeResizer = this.treePaneEl.querySelector<HTMLElement>("#http-tree-resizer");
    treeResizer?.addEventListener("pointerdown", e => {
      e.preventDefault();
      treeResizer.setPointerCapture(e.pointerId);
      const onMove = (ev: PointerEvent) => {
        this.treeWidthPx = Math.max(170, Math.min(420, Math.round(ev.clientX)));
        this.applyWorkspaceLayout(false);
      };
      const onUp = () => {
        treeResizer.removeEventListener("pointermove", onMove);
        treeResizer.removeEventListener("pointerup", onUp);
        treeResizer.removeEventListener("pointercancel", onUp);
        try { (window as any).inkmap?.mindMap?.view?.fit(); } catch {}
      };
      treeResizer.addEventListener("pointermove", onMove);
      treeResizer.addEventListener("pointerup", onUp);
      treeResizer.addEventListener("pointercancel", onUp);
    });

    this.mdPaneEl = document.createElement("aside");
    this.mdPaneEl.id = "http-md-pane";
    this.mdPaneEl.hidden = true;
    this.mdPaneEl.innerHTML = `
      <div class="http-pane-header">
        <span class="http-pane-title" id="http-md-title">Markdown</span>
        <span class="http-md-line-badge" id="http-md-line-badge">Ln 1</span>
        <button type="button" class="http-pane-close" id="http-md-close">${this.uiText("× 关闭MD", "× Close MD")}</button>
      </div>
      <div class="http-md-body">
        <div id="http-md-gutter" aria-hidden="true"></div>
        <div class="http-md-editor-stage">
          <div id="http-md-band" aria-hidden="true"></div>
          <textarea id="http-md-textarea" spellcheck="false"></textarea>
        </div>
      </div>
      <div class="http-pane-resizer" id="http-md-resizer" title="${this.uiText("拖拽调整原文件窗口宽度", "Drag to resize Markdown pane")}"></div>
    `;
    document.body.appendChild(this.mdPaneEl);
    this.mdTitleEl = this.mdPaneEl.querySelector("#http-md-title");
    this.mdLineBadgeEl = this.mdPaneEl.querySelector("#http-md-line-badge");
    this.mdCloseBtnEl = this.mdPaneEl.querySelector("#http-md-close");
    this.mdGutterEl = this.mdPaneEl.querySelector("#http-md-gutter");
    this.mdBandEl = this.mdPaneEl.querySelector("#http-md-band");
    this.mdTextareaEl = this.mdPaneEl.querySelector("#http-md-textarea");
    this.mdCloseBtnEl?.addEventListener("click", () => {
      this.mdOpen = false;
      this.applyWorkspaceLayout(true);
    });
    this.mdTextareaEl?.addEventListener("scroll", () => {
      this.renderMdGutterAndBand();
    });

    const handleCursorMove = () => {
      if (!this.mdTextareaEl) return;
      const startPos = this.mdTextareaEl.selectionStart ?? 0;
      const endPos = this.mdTextareaEl.selectionEnd ?? startPos;
      const startLine = this.mdTextareaEl.value.slice(0, startPos).split("\n").length - 1;
      const endLine = this.mdTextareaEl.value.slice(0, endPos).split("\n").length - 1;
      this.activeStartLine = startLine;
      this.activeEndLine = Math.max(startLine, endLine);
      this.renderMdGutterAndBand();
      this.revealListeners.forEach(fn => fn(startLine));
    };
    this.mdTextareaEl?.addEventListener("click", handleCursorMove);
    this.mdTextareaEl?.addEventListener("keyup", e => {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(e.key)) {
        handleCursorMove();
      }
    });
    this.mdTextareaEl?.addEventListener("input", () => {
      const nextMd = this.mdTextareaEl!.value;
      this.currentMd = nextMd;
      const startPos = this.mdTextareaEl!.selectionStart ?? 0;
      const startLine = nextMd.slice(0, startPos).split("\n").length - 1;
      this.activeStartLine = startLine;
      this.activeEndLine = startLine;
      this.renderMdGutterAndBand();
      window.clearTimeout(this.mdEditTimer);
      this.mdEditTimer = window.setTimeout(() => {
        const api = (window as any).inkmap;
        if (api?.load) {
          void api.load(nextMd, true).then(() => {
            this.revealListeners.forEach(fn => fn(startLine));
          });
        }
      }, 280);
    });

    const mdResizer = this.mdPaneEl.querySelector<HTMLElement>("#http-md-resizer");
    mdResizer?.addEventListener("pointerdown", e => {
      e.preventDefault();
      mdResizer.setPointerCapture(e.pointerId);
      const onMove = (ev: PointerEvent) => {
        const mdLeft = this.treeOpen ? this.treeWidthPx : 0;
        const maxW = Math.max(260, Math.round(window.innerWidth * 0.65) - mdLeft);
        this.mdWidthPx = Math.max(220, Math.min(maxW, Math.round(ev.clientX - mdLeft)));
        this.applyWorkspaceLayout(false);
      };
      const onUp = () => {
        mdResizer.removeEventListener("pointermove", onMove);
        mdResizer.removeEventListener("pointerup", onUp);
        mdResizer.removeEventListener("pointercancel", onUp);
        try { (window as any).inkmap?.mindMap?.view?.fit(); } catch {}
      };
      mdResizer.addEventListener("pointermove", onMove);
      mdResizer.addEventListener("pointerup", onUp);
      mdResizer.addEventListener("pointercancel", onUp);
    });

    if (autoOpenIde) {
      this.treeOpen = true;
      this.mdOpen = true;
    }
    this.applyWorkspaceLayout(false);
  }

  async load(): Promise<DocState> {
    const [res, capabilities, filesRes] = await Promise.all([
      fetch(this.base + "api/doc"),
      fetch(this.base + "api/capabilities").then(r => (r.ok ? r.json() : null)).catch(() => null),
      fetch(this.base + "api/files").then(r => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (!res.ok) throw new Error(`读取文档失败：${res.status}`);
    if (capabilities) {
      this.account = capabilities.purchase === true ? "purchase" : "restore";
    } else if (this.sidebar) {
      this.account = "restore";
    }
    this.hostAccountNavigation = capabilities?.accountNavigation === "host" &&
      new URLSearchParams(location.search).get("account-navigation") === "host" && window.parent !== window;

    const doc = (await res.json()) as DocState & { currentFile?: string };
    this.currentMd = doc.md;
    this.currentVersion = doc.version;
    this.currentFile = filesRes?.currentFile ?? doc.currentFile ?? null;
    if (Array.isArray(filesRes?.files)) {
      this.cachedFiles = filesRes.files;
    }
    const ideParam = new URLSearchParams(location.search).get("ide") === "1";
    const autoOpen = !this.sidebar && (ideParam || capabilities?.ideWorkspace === true);
    this.mountWorkspaceControls(autoOpen);
    this.syncMdPane(doc.md, true);
    return doc;
  }

  onReveal(listener: (line: number) => void) {
    this.revealListeners.push(listener);
  }

  select(line: number, endLine = line) {
    this.activeStartLine = Math.max(0, line);
    this.activeEndLine = Math.max(this.activeStartLine, endLine);
    if (!this.mdTextareaEl || !this.mdOpen) return;
    revealMarkdownLines(this.mdTextareaEl, this.activeStartLine, this.activeEndLine);
    this.renderMdGutterAndBand();
  }

  onMapMarkdownChange(md: string) {
    this.currentMd = md;
    this.syncMdPane(md, false);
  }

  refreshLanguage() {
    this.applyWorkspaceLayout(false);
  }

  async save(md: string, baseVersion: string): Promise<SaveResult> {
    this.currentMd = md;
    this.syncMdPane(md, false);
    const res = await fetch(this.base + "api/doc", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ md, baseVersion }),
    });
    if (res.status === 409) {
      const conflictDoc = await res.json();
      this.currentMd = conflictDoc.md;
      this.currentVersion = conflictDoc.version;
      this.syncMdPane(conflictDoc.md, true);
      return { ok: false, doc: conflictDoc };
    }
    if (!res.ok) throw new Error(`保存失败：${res.status}`);
    const saved = await res.json();
    this.currentVersion = saved.version;
    return { ok: true, ...saved };
  }

  onExternalChange(listener: (doc: DocState) => void) {
    this.externalListeners.push(listener);
    this.events.addEventListener("change", e => {
      const next = JSON.parse((e as MessageEvent).data) as DocState & { currentFile?: string };
      const fileChanged = Boolean(next.currentFile && next.currentFile !== this.currentFile);
      const mdChanged = next.md !== this.currentMd;
      this.currentMd = next.md;
      this.currentVersion = next.version;
      if (next.currentFile) this.currentFile = next.currentFile;
      if (fileChanged || mdChanged) this.syncMdPane(next.md, fileChanged);
      if (this.treeOpen) this.renderTreeDom();
      listener(next);
    });
  }

  saveView(state: ViewState) {
    void fetch(this.base + "api/view", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(state),
      keepalive: true,
    }).catch(() => {});
  }

  async license(): Promise<LicenseState> {
    const res = await fetch(this.base + "api/license");
    return res.ok ? res.json() : { pro: false };
  }

  async checkout(mode: "buy" | "restore"): Promise<void> {
    if (mode === "restore" && this.hostAccountNavigation) {
      await new Promise<void>((resolve, reject) => {
        const id = crypto.randomUUID();
        const type = "inkmap:open-account";
        function done(ok: boolean) {
          window.clearTimeout(timer);
          window.removeEventListener("message", receive);
          if (ok) resolve();
          else reject(new Error(t("signInPageUnavailable")));
        }
        function receive(event: MessageEvent) {
          if (event.source === window.parent && event.data?.type === type && event.data.id === id) done(event.data.ok === true);
        }
        const timer = window.setTimeout(() => done(false), 12_000);
        window.addEventListener("message", receive);
        // The parent receives a request identifier and checkout mode. It creates the account link using its own lease.
        window.parent.postMessage({ type, id, mode }, "*");
      });
      return;
    }
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const res = await fetch(this.base + "api/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, locale: currentUiLocale() }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      if (!tab) throw new PopupBlockedError(t("allowAccountPopups"), body.url);
      tab.location.replace(body.url);
    } catch (error) {
      tab?.close();
      throw error;
    }
  }

  async orderPro(): Promise<WechatOrderResult> {
    const res = await fetch(this.base + "api/order-pro", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale: currentUiLocale() }),
    });
    if (res.status === 501) {
      await this.checkout("buy");
      return { status: "redirect", url: "about:blank" };
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    const result = body.result as WechatOrderResult;
    if (result.status === "redirect" && /^https:\/\//.test(result.url)) {
      window.open(result.url, "_blank", "noopener,noreferrer");
    }
    return result;
  }

  openExternalUrl(url: string) {
    if (/^https:\/\//.test(url)) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  phoneSignIn?: Host["phoneSignIn"] = {
    send: async (phone: string): Promise<PhoneSignInResult> => {
      const res = await fetch(this.base + "api/phone-send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone, locale: currentUiLocale() }),
      });
      if (!res.ok) return { ok: false, reason: "unavailable" };
      return (await res.json()).result;
    },
    verify: async (phone: string, code: string): Promise<PhoneSignInResult<LicenseState>> => {
      const res = await fetch(this.base + "api/phone-verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone, code }),
      });
      if (!res.ok) return { ok: false, reason: "unavailable" };
      return (await res.json()).result;
    },
  };

  async signOut(): Promise<void> {
    const res = await fetch(this.base + "api/signout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? res.statusText);
    }
  }

  onLicenseChange(listener: (state: LicenseState) => void) {
    this.events.addEventListener("license", e => listener(JSON.parse((e as MessageEvent).data)));
    const refresh = () => { void this.license().then(listener).catch(() => {}); };
    window.addEventListener("focus", refresh);
    window.addEventListener("pagehide", () => window.removeEventListener("focus", refresh), { once: true });
  }

  async ads(): Promise<Ad[]> {
    const res = await fetch(this.base + "api/ads").catch(() => null);
    return res?.ok ? res.json() : [];
  }

  async saveFile(name: string, dataUrl: string) {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = name;
    a.click();
    return true;
  }

  track(event: string) {
    void fetch(this.base + "api/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event }),
    }).catch(() => {});
  }
}

interface VsCodeApi {
  postMessage(message: unknown): void;
}

/** Messages exchanged with the editor extension. */
export type ToExtension =
  | { type: "ready" }
  | { type: "save"; id: number; md: string; baseVersion: string }
  | { type: "mapMarkdownChange"; md: string }
  | { type: "select"; line: number; endLine?: number }
  | { type: "viewState"; state: ViewState }
  | ({ type: "addToChat" } & Partial<ChatTarget>)
  | { type: "undo" }
  | { type: "redo" }
  | { type: "checkout"; id: number; mode: "buy" | "restore"; locale?: string }
  | { type: "orderPro"; id: number; locale?: string }
  | { type: "openExternal"; url: string }
  | { type: "sendPhoneCode"; id: number; phone: string; locale?: string }
  | { type: "signInByPhone"; id: number; phone: string; code: string }
  | { type: "signOut"; id: number }
  | { type: "saveFile"; id: number; name: string; dataUrl: string }
  | { type: "telemetry"; event: string };

export type FromExtension =
  | { type: "doc"; doc: DocState; license: LicenseState; ads: Ad[]; chat?: boolean }
  | { type: "change"; doc: DocState }
  | { type: "saved"; id: number; version: string }
  | { type: "conflict"; id: number; doc: DocState }
  | { type: "error"; id: number; message: string }
  | { type: "reveal"; line: number }
  | { type: "requestChat" }
  | { type: "license"; state: LicenseState }
  | { type: "checkout"; id: number }
  | { type: "proOrder"; id: number; result: WechatOrderResult }
  | { type: "phoneCodeSent"; id: number; result: PhoneSignInResult }
  | { type: "phoneSignIn"; id: number; result: PhoneSignInResult<LicenseState> }
  | { type: "signedOut"; id: number }
  | { type: "fileSaved"; id: number; saved: boolean };

export class VsCodeHost implements Host {
  readonly capabilities = {
    saveTarget: "editor",
    account: window.INKMAP_ACCOUNT_MODE ?? "purchase",
  } satisfies HostCapabilities;
  private nextId = 1;
  private waiting = new Map<number, (msg: FromExtension) => void>();
  private listeners: Partial<Record<FromExtension["type"], ((msg: any) => void)[]>> = {};
  private first?: Promise<Extract<FromExtension, { type: "doc" }>>;
  private currentLicense?: LicenseState;

  constructor(
    private api: VsCodeApi,
    public assetBase: string,
    public locale: Locale,
  ) {
    window.addEventListener("message", e => {
      const msg = e.data as FromExtension;
      if (!msg || typeof msg !== "object") return;
      if ("id" in msg && this.waiting.has(msg.id)) {
        this.waiting.get(msg.id)!(msg);
        this.waiting.delete(msg.id);
      }
      if (msg.type === "license") this.currentLicense = msg.state;
      this.listeners[msg.type]?.forEach(fn => fn(msg));
    });
  }

  private on<T extends FromExtension["type"]>(type: T, fn: (msg: Extract<FromExtension, { type: T }>) => void) {
    const key: FromExtension["type"] = type;
    this.listeners[key] = [...(this.listeners[key] ?? []), fn as (msg: any) => void];
  }

  private post(msg: ToExtension) {
    this.api.postMessage(msg);
  }

  private request<T>(build: (id: number) => ToExtension, read: (msg: FromExtension) => T): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, msg => {
        if (msg.type === "error") reject(new Error(msg.message));
        else resolve(read(msg));
      });
      this.post(build(id));
    });
  }

  private hello() {
    return (this.first ??= new Promise(resolve => {
      this.on("doc", msg => resolve(msg));
      this.post({ type: "ready" });
    }));
  }

  async load(): Promise<DocState> {
    return (await this.hello()).doc;
  }

  save(md: string, baseVersion: string): Promise<SaveResult> {
    return this.request(
      id => ({ type: "save", id, md, baseVersion }),
      msg => (msg.type === "saved" ? { ok: true, version: msg.version } : { ok: false, doc: (msg as Extract<FromExtension, { type: "conflict" }>).doc }),
    );
  }

  onExternalChange(listener: (doc: DocState) => void) {
    this.on("change", msg => listener(msg.doc));
  }

  onReveal(listener: (line: number) => void) {
    this.on("reveal", msg => listener(msg.line));
  }

  select(line: number, endLine?: number) {
    this.post({ type: "select", line, ...(endLine !== undefined && { endLine }) });
  }

  onMapMarkdownChange(md: string) {
    this.post({ type: "mapMarkdownChange", md });
  }

  saveView(state: ViewState) {
    this.post({ type: "viewState", state });
  }

  async canAddToChat() {
    return (await this.hello()).chat === true;
  }

  addToChat(target?: ChatTarget) {
    this.post({ type: "addToChat", ...target });
  }

  onChatRequest(listener: () => void) {
    this.on("requestChat", () => listener());
  }

  history = {
    undo: () => this.post({ type: "undo" }),
    redo: () => this.post({ type: "redo" }),
  };

  async license(): Promise<LicenseState> {
    return this.currentLicense ?? (await this.hello()).license;
  }

  checkout(mode: "buy" | "restore"): Promise<void> {
    return this.request(
      id => ({ type: "checkout", id, mode, locale: currentUiLocale() }),
      () => undefined,
    );
  }

  orderPro(): Promise<WechatOrderResult> {
    return this.request(
      id => ({ type: "orderPro", id, locale: currentUiLocale() }),
      msg => {
        const { result } = msg as Extract<FromExtension, { type: "proOrder" }>;
        if (result.status === "active") this.currentLicense = result.state;
        return result;
      },
    );
  }

  openExternalUrl(url: string) {
    if (/^https:\/\//.test(url)) {
      this.post({ type: "openExternal", url });
    }
  }

  phoneSignIn = {
    send: (phone: string) => this.request(
      id => ({ type: "sendPhoneCode", id, phone, locale: currentUiLocale() }),
      msg => (msg as Extract<FromExtension, { type: "phoneCodeSent" }>).result,
    ),
    verify: (phone: string, code: string) => this.request(
      id => ({ type: "signInByPhone", id, phone, code }),
      msg => {
        const { result } = msg as Extract<FromExtension, { type: "phoneSignIn" }>;
        if (result.ok) this.currentLicense = result.value;
        return result;
      },
    ),
  };

  signOut(): Promise<void> {
    return this.request(
      id => ({ type: "signOut", id }),
      () => undefined,
    );
  }

  onLicenseChange(listener: (state: LicenseState) => void) {
    this.on("license", msg => listener(msg.state));
  }

  async ads(): Promise<Ad[]> {
    return (await this.hello()).ads;
  }

  saveFile(name: string, dataUrl: string): Promise<boolean> {
    return this.request(
      id => ({ type: "saveFile", id, name, dataUrl }),
      msg => (msg as Extract<FromExtension, { type: "fileSaved" }>).saved,
    );
  }

  track(event: string) {
    this.post({ type: "telemetry", event });
  }
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
    /** Set by the extension before the editor script runs. */
    INKMAP_ASSET_BASE?: string;
    INKMAP_LOCALE?: string;
    INKMAP_ACCOUNT_MODE?: HostCapabilities["account"];
  }
}

export function detectHost(): Host {
  if (window.acquireVsCodeApi) {
    const locale: Locale = detectDefaultLocale(window.INKMAP_LOCALE);
    return new VsCodeHost(window.acquireVsCodeApi(), window.INKMAP_ASSET_BASE ?? "", locale);
  }
  return new HttpHost();
}
