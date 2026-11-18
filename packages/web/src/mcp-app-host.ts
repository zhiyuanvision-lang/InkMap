import type { App } from "@modelcontextprotocol/ext-apps";
import type { LicenseState, PhoneSignInResult, ViewState } from "@inkmap/core";
import { z } from "zod";
import { browserLocale, type ChatTarget, type DocState, type Host, type HostCapabilities, type SaveResult } from "./host";
import { revealMarkdownLines } from "./md-lines";
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
  openedInEditorPane?: boolean;
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
  private fileTriggerBtn: HTMLButtonElement | null = null;
  private fileTriggerNameEl: HTMLElement | null = null;
  private fileTriggerDirEl: HTMLElement | null = null;
  private filePopoverEl: HTMLElement | null = null;
  private fileSearchInputEl: HTMLInputElement | null = null;
  private fileTreeBodyEl: HTMLElement | null = null;
  private cachedFiles: McpFileEntry[] = [];
  private expandedKeys = new Set<string>();
  private initializedExpansionForFile = "";
  private splitMdBtn: HTMLButtonElement | null = null;
  private openRawBtn: HTMLButtonElement | null = null;
  private fullscreenBtn: HTMLButtonElement | null = null;
  private openBrowserBtn: HTMLButtonElement | null = null;
  private mdPaneEl: HTMLElement | null = null;
  private mdTextareaEl: HTMLTextAreaElement | null = null;
  private mdTitleEl: HTMLElement | null = null;
  private mdLineBadgeEl: HTMLElement | null = null;
  private mdCloseBtnEl: HTMLElement | null = null;
  private mdGutterEl: HTMLElement | null = null;
  private mdBandEl: HTMLElement | null = null;
  private splitOpen = false;
  private splitWidthPct = 42;
  private mdEditTimer = 0;
  private activeStartLine = 0;
  private activeEndLine = 0;
  private revealListeners: ((line: number) => void)[] = [];

  constructor(
    private app: App,
    private initialInput?: { path?: string; workspace?: string },
    private initialSnapshot?: McpWorkspaceSnapshot,
  ) {}

  private parseFileEntry(item: McpFileEntry) {
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
    let project = sidebarText("当前项目", "Workspace");
    if (normPath.endsWith(suffix)) {
      const rootDir = normPath.slice(0, normPath.length - suffix.length);
      project = rootDir.split("/").filter(Boolean).pop() || project;
    }
    return { project, rel, item };
  }

  private buildProjectTree(files: McpFileEntry[], filterText = "") {
    interface TreeFileNode {
      name: string;
      path: string;
      rel: string;
      project: string;
      isMarkmap: boolean;
    }
    interface TreeFolderNode {
      name: string;
      key: string;
      folders: Map<string, TreeFolderNode>;
      sortedFolders: TreeFolderNode[];
      files: TreeFileNode[];
      totalFiles: number;
    }
    interface TreeProjectNode {
      name: string;
      key: string;
      active: boolean;
      count: number;
      root: TreeFolderNode;
    }

    const q = filterText.trim().toLowerCase();
    const projectMap = new Map<string, TreeProjectNode>();

    for (const raw of files) {
      const { project, rel, item } = this.parseFileEntry(raw);
      if (q && !project.toLowerCase().includes(q) && !rel.toLowerCase().includes(q)) continue;
      let proj = projectMap.get(project);
      if (!proj) {
        proj = {
          name: project,
          key: `proj:${project}`,
          active: item.group === "active",
          count: 0,
          root: { name: "", key: `proj:${project}`, folders: new Map(), sortedFolders: [], files: [], totalFiles: 0 },
        };
        projectMap.set(project, proj);
      }
      if (item.group === "active") proj.active = true;
      proj.count++;

      const parts = rel.split("/").filter(Boolean);
      const fileName = parts.pop() || rel;
      let curr = proj.root;
      let pathAcc = `proj:${project}`;
      for (const seg of parts) {
        pathAcc += `/${seg}`;
        let next = curr.folders.get(seg);
        if (!next) {
          next = { name: seg, key: pathAcc, folders: new Map(), sortedFolders: [], files: [], totalFiles: 0 };
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

    const compactAndSort = (folder: TreeFolderNode) => {
      const compacted: TreeFolderNode[] = [];
      for (const child of folder.folders.values()) {
        while (child.files.length === 0 && child.folders.size === 1) {
          const onlySub = [...child.folders.values()][0]!;
          child.name = `${child.name}/${onlySub.name}`;
          child.key = onlySub.key;
          child.folders = onlySub.folders;
          child.files = onlySub.files;
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
      for (const c of compacted) total += c.totalFiles || 0;
      folder.totalFiles = total;
    };

    const projects = [...projectMap.values()];
    for (const p of projects) compactAndSort(p.root);
    projects.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
    return projects;
  }

  private ensureSelectedAncestorsExpanded(projects: ReturnType<McpAppHost["buildProjectTree"]>, selectedPath: string | null) {
    if (!selectedPath || this.initializedExpansionForFile === selectedPath) return;
    this.initializedExpansionForFile = selectedPath;
    for (const p of projects) {
      if (p.active) this.expandedKeys.add(p.key);
      const markFolder = (folder: typeof p.root): boolean => {
        let hasSelected = folder.files.some(f => f.path === selectedPath);
        for (const sub of folder.sortedFolders) {
          if (markFolder(sub)) hasSelected = true;
        }
        if (hasSelected) this.expandedKeys.add(folder.key);
        return hasSelected;
      };
      if (markFolder(p.root)) {
        this.expandedKeys.add(p.key);
      }
    }
  }

  private closeFilePopover() {
    if (!this.filePopoverEl || this.filePopoverEl.hidden) return;
    this.filePopoverEl.hidden = true;
    this.fileTriggerBtn?.setAttribute("aria-expanded", "false");
  }

  private toggleFilePopover() {
    if (!this.filePopoverEl) return;
    const nextOpen = this.filePopoverEl.hidden;
    if (nextOpen) {
      this.renderTreeDom();
      this.filePopoverEl.hidden = false;
      this.fileTriggerBtn?.setAttribute("aria-expanded", "true");
      requestAnimationFrame(() => {
        const selectedRow = this.fileTreeBodyEl?.querySelector<HTMLElement>(".ag-tree-file.is-selected");
        selectedRow?.scrollIntoView({ block: "nearest" });
        this.fileSearchInputEl?.focus();
      });
    } else {
      this.closeFilePopover();
    }
  }

  private renderTreeDom() {
    if (!this.fileTreeBodyEl) return;
    const filterText = this.fileSearchInputEl?.value ?? "";
    const isFiltering = Boolean(filterText.trim());
    const projects = this.buildProjectTree(this.cachedFiles, filterText);
    this.ensureSelectedAncestorsExpanded(projects, this.currentFile);

    this.fileTreeBodyEl.innerHTML = "";
    if (!projects.length) {
      const empty = document.createElement("div");
      empty.className = "ag-tree-empty";
      empty.textContent = isFiltering
        ? sidebarText("无匹配的 Markdown 文件", "No matching Markdown files")
        : sidebarText("未找到 Markdown 文件", "No Markdown files");
      this.fileTreeBodyEl.appendChild(empty);
      return;
    }

    const chevronSvg = `<svg class="ag-tree-chevron" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>`;
    const folderSvg = `<svg class="ag-tree-icon ag-icon-folder" viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M1.75 2.5A1.75 1.75 0 0 0 0 4.25v7.5C0 12.716.784 13.5 1.75 13.5h12.5A1.75 1.75 0 0 0 16 11.75v-5.5A1.75 1.75 0 0 0 14.25 4.5H7.82a.25.25 0 0 1-.177-.073L6.28 3.063A1.75 1.75 0 0 0 5.043 2.5H1.75Z"/></svg>`;
    const mapFileSvg = `<svg class="ag-tree-icon ag-icon-map" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="3.5" cy="8" r="1.75"/><circle cx="12.5" cy="4" r="1.75"/><circle cx="12.5" cy="12" r="1.75"/><path d="M5.25 7.3L10.75 4.7M5.25 8.7l5.5 2.6"/></svg>`;
    const mdFileSvg = `<svg class="ag-tree-icon ag-icon-md" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 1.5H4A1.5 1.5 0 0 0 2.5 3v10A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5V5.5L9.5 1.5Z"/><path d="M9.5 1.5v4h4"/></svg>`;

    const renderFolderContents = (folder: (typeof projects)[number]["root"], container: HTMLElement, depth: number) => {
      for (const sub of folder.sortedFolders) {
        const isOpen = isFiltering || this.expandedKeys.has(sub.key);
        const folderWrap = document.createElement("div");
        folderWrap.className = "ag-tree-group";

        const row = document.createElement("button");
        row.type = "button";
        row.className = `ag-tree-row ag-tree-folder ${isOpen ? "is-open" : ""}`;
        row.style.paddingLeft = `${10 + depth * 14}px`;
        row.innerHTML = `${chevronSvg}${folderSvg}<span class="ag-tree-label"></span><span class="ag-tree-count">${sub.totalFiles}</span>`;
        row.querySelector(".ag-tree-label")!.textContent = sub.name;
        row.title = sub.name;
        row.addEventListener("click", e => {
          e.stopPropagation();
          if (this.expandedKeys.has(sub.key)) this.expandedKeys.delete(sub.key);
          else this.expandedKeys.add(sub.key);
          this.renderTreeDom();
        });
        folderWrap.appendChild(row);

        if (isOpen) {
          const childrenBox = document.createElement("div");
          childrenBox.className = "ag-tree-children";
          renderFolderContents(sub, childrenBox, depth + 1);
          folderWrap.appendChild(childrenBox);
        }
        container.appendChild(folderWrap);
      }

      for (const file of folder.files) {
        const isSelected = file.path === this.currentFile;
        const fileBtn = document.createElement("button");
        fileBtn.type = "button";
        fileBtn.className = `ag-tree-row ag-tree-file ${isSelected ? "is-selected" : ""}`;
        fileBtn.style.paddingLeft = `${10 + depth * 14}px`;
        fileBtn.innerHTML = `<span class="ag-tree-Check">${isSelected ? "✓" : ""}</span>${file.isMarkmap ? mapFileSvg : mdFileSvg}<span class="ag-tree-label"></span>${file.isMarkmap ? `<span class="ag-tree-tag">${sidebarText("导图", "Map")}</span>` : ""}`;
        fileBtn.querySelector(".ag-tree-label")!.textContent = file.name;
        fileBtn.title = `${file.project} / ${file.rel}`;
        fileBtn.addEventListener("click", e => {
          e.stopPropagation();
          this.closeFilePopover();
          void this.switchFile(file.path);
        });
        container.appendChild(fileBtn);
      }
    };

    for (const proj of projects) {
      const isOpen = isFiltering || this.expandedKeys.has(proj.key) || projects.length === 1;
      const projWrap = document.createElement("div");
      projWrap.className = "ag-tree-project";

      if (projects.length > 1 || !proj.active) {
        const headerBtn = document.createElement("button");
        headerBtn.type = "button";
        headerBtn.className = `ag-tree-row ag-tree-proj-header ${isOpen ? "is-open" : ""}`;
        headerBtn.innerHTML = `${chevronSvg}${folderSvg}<span class="ag-tree-label"></span>${proj.active ? `<span class="ag-tree-active-badge">${sidebarText("当前工作区", "Workspace")}</span>` : ""}<span class="ag-tree-count">${proj.count}</span>`;
        headerBtn.querySelector(".ag-tree-label")!.textContent = proj.name;
        headerBtn.addEventListener("click", e => {
          e.stopPropagation();
          if (this.expandedKeys.has(proj.key)) this.expandedKeys.delete(proj.key);
          else this.expandedKeys.add(proj.key);
          this.renderTreeDom();
        });
        projWrap.appendChild(headerBtn);
      } else {
        const topHeader = document.createElement("div");
        topHeader.className = "ag-tree-proj-banner";
        topHeader.innerHTML = `${folderSvg}<span class="ag-tree-label"></span><span class="ag-tree-active-badge">${sidebarText("当前工作区", "Workspace")}</span><span class="ag-tree-count">${proj.count}</span>`;
        topHeader.querySelector(".ag-tree-label")!.textContent = proj.name;
        projWrap.appendChild(topHeader);
      }

      if (isOpen) {
        const body = document.createElement("div");
        body.className = "ag-tree-proj-body";
        renderFolderContents(proj.root, body, projects.length > 1 ? 1 : 0);
        projWrap.appendChild(body);
      }
      this.fileTreeBodyEl.appendChild(projWrap);
    }
  }

  private async callTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
    const result = await this.app.callServerTool({ name, arguments: args });
    if (result.isError) {
      const textBlock = result.content.find(item => item.type === "text");
      throw new Error(textBlock && "text" in textBlock ? textBlock.text : `${name} failed.`);
    }
    return (result.structuredContent as Record<string, any>) ?? {};
  }

  private renderMdGutterAndBand() {
    if (!this.mdTextareaEl) return;
    const totalLines = Math.max(1, this.mdTextareaEl.value.split("\n").length);
    const sLine = Math.max(0, Math.min(this.activeStartLine, totalLines - 1));
    const eLine = Math.max(sLine, Math.min(this.activeEndLine, totalLines - 1));
    if (this.mdLineBadgeEl) {
      const label = sLine === eLine ? `${sLine + 1}` : `${sLine + 1}–${eLine + 1}`;
      this.mdLineBadgeEl.textContent = sidebarText(`行 ${label}`, `Ln ${label}`);
    }
    if (this.mdGutterEl) {
      const nums: string[] = [];
      for (let i = 0; i < totalLines; i++) {
        const active = i >= sLine && i <= eLine;
        nums.push(`<div class="ag-gutter-ln${active ? " is-active" : ""}">${i + 1}</div>`);
      }
      this.mdGutterEl.innerHTML = nums.join("");
      this.mdGutterEl.scrollTop = this.mdTextareaEl.scrollTop;
    }
    if (this.mdBandEl) {
      const lineHeight = 20.8;
      const padTop = 12;
      const top = padTop + sLine * lineHeight - this.mdTextareaEl.scrollTop;
      const height = Math.max(1, eLine - sLine + 1) * lineHeight;
      this.mdBandEl.style.transform = `translateY(${top}px)`;
      this.mdBandEl.style.height = `${height}px`;
    }
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
    this.renderMdGutterAndBand();
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
    if (this.openRawBtn) {
      this.openRawBtn.textContent = sidebarText("原文件", "Raw");
      this.openRawBtn.title = sidebarText("在侧栏并排打开原始 Markdown 文件预览", "Open raw Markdown file in side pane");
    }
    if (this.openBrowserBtn) {
      const span = this.openBrowserBtn.querySelector("span");
      if (span) span.textContent = sidebarText("大屏打开", "Browser");
      this.openBrowserBtn.title = sidebarText("在独立浏览器窗口大屏打开双向同步思维导图", "Open two-way synced mind map in standalone browser window");
    }
    if (this.mdCloseBtnEl) {
      this.mdCloseBtnEl.textContent = sidebarText("× 关闭MD", "× Close MD");
    }
    if (this.fileSearchInputEl) {
      this.fileSearchInputEl.placeholder = sidebarText("搜索项目 Markdown 文件…", "Filter Markdown files…");
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
    this.cachedFiles = Array.isArray(files) ? files : [];
    if (this.fileSelectEl) {
      this.fileSelectEl.innerHTML = "";
      for (const item of this.cachedFiles) {
        const opt = document.createElement("option");
        opt.value = item.path;
        opt.textContent = item.label;
        if (item.path === selected) opt.selected = true;
        this.fileSelectEl.appendChild(opt);
      }
      this.fileSelectEl.disabled = !this.cachedFiles.length;
    }
    if (this.openRawBtn) this.openRawBtn.disabled = !selected;
    if (this.openBrowserBtn) this.openBrowserBtn.disabled = !selected;
    if (this.fileTriggerBtn) {
      this.fileTriggerBtn.disabled = !this.cachedFiles.length;
      const found = this.cachedFiles.find(f => f.path === selected) || this.cachedFiles[0];
      if (!found) {
        if (this.fileTriggerNameEl) this.fileTriggerNameEl.textContent = sidebarText("未找到 Markdown 文件", "No Markdown files");
        if (this.fileTriggerDirEl) this.fileTriggerDirEl.hidden = true;
      } else {
        const { project, rel } = this.parseFileEntry(found);
        const parts = rel.split("/").filter(Boolean);
        const fileName = parts.pop() || rel;
        const dirHint = parts.length ? `${project}/${parts[parts.length - 1]}` : project;
        if (this.fileTriggerNameEl) this.fileTriggerNameEl.textContent = fileName;
        if (this.fileTriggerDirEl) {
          this.fileTriggerDirEl.textContent = dirHint;
          this.fileTriggerDirEl.hidden = false;
        }
        this.fileTriggerBtn.title = `${project} / ${rel}`;
      }
    }
    if (this.filePopoverEl && !this.filePopoverEl.hidden) {
      this.renderTreeDom();
    }
  }

  private mountToolbarControls() {
    const bar = document.getElementById("bar");
    if (!bar || document.getElementById("ag-file-select")) return;

    const style = document.createElement("style");
    style.textContent = `
      html, body { margin: 0; height: 100%; overflow: hidden; background: var(--ink-bg) !important; color: var(--ui-text) !important; }
      #map { position: fixed; inset: 0; width: 100vw; height: 100vh; transition: left .12s ease, width .12s ease; }
      :root.ag-split-active #bar {
        top: var(--banner-offset, 0px) !important; left: 0 !important; right: 0 !important;
        min-height: 44px; border-radius: 0 !important;
        border-top: none !important; border-left: none !important; border-right: none !important;
        border-bottom: 1px solid var(--ui-border-strong, rgba(31,35,41,.15)) !important;
        box-shadow: none !important; padding: 4px 10px !important;
        background: var(--ui-solid, #fff) !important;
      }
      :root.ag-split-active #map {
        top: calc(var(--banner-offset, 0px) + var(--toolbar-height, 44px)) !important;
        left: var(--ag-split-left, 42vw) !important;
        width: calc(100vw - var(--ag-split-left, 42vw)) !important;
        height: calc(100vh - var(--banner-offset, 0px) - var(--toolbar-height, 44px)) !important;
      }
      #ag-file-select { display: none !important; }
      .ag-file-picker-wrap { position: relative; display: inline-flex; align-items: center; }
      #ag-file-trigger {
        display: inline-flex; align-items: center; gap: 5px; max-width: 210px; height: 28px;
        padding: 0 9px; border-radius: 7px; border: 1px solid var(--ui-border-strong, rgba(31,35,41,.14));
        background: var(--ui-subtle, rgba(31,35,41,.04)); color: var(--ui-text, #1f2329);
        font-size: 12.5px; cursor: pointer; transition: background .12s, border-color .12s;
      }
      #ag-file-trigger:hover:not(:disabled), #ag-file-trigger[aria-expanded="true"] {
        background: var(--ui-hover, rgba(31,35,41,.08));
        border-color: color-mix(in srgb, var(--ui-primary, #336df4) 45%, var(--ui-border-strong, rgba(31,35,41,.2)));
      }
      .ag-trigger-icon { flex: none; color: var(--ui-primary, #336df4); display: inline-flex; }
      .ag-trigger-name {
        font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
      }
      .ag-trigger-dir {
        font-size: 11px; color: var(--ui-muted, #646a73); background: color-mix(in srgb, var(--ui-text, #1f2329) 7%, transparent);
        padding: 1px 5px; border-radius: 4px; max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: none;
      }
      .ag-trigger-caret { flex: none; opacity: .65; transition: transform .15s ease; }
      #ag-file-trigger[aria-expanded="true"] .ag-trigger-caret { transform: rotate(180deg); }
      #ag-file-tree-popover {
        position: fixed; top: calc(var(--toolbar-height, 40px) + 14px); left: 10px;
        width: min(360px, calc(100vw - 24px)); max-height: min(72vh, 520px); z-index: 120;
        display: flex; flex-direction: column;
        background: var(--ui-solid, #fff); color: var(--ui-text, #1f2329);
        border: 1px solid var(--ui-border-strong, rgba(31,35,41,.16)); border-radius: 11px;
        box-shadow: 0 12px 32px rgba(15, 23, 42, .16), 0 2px 6px rgba(15, 23, 42, .08);
        overflow: hidden;
      }
      #ag-file-tree-popover[hidden] { display: none !important; }
      .ag-tree-header {
        display: flex; align-items: center; gap: 6px; padding: 8px 10px;
        border-bottom: 1px solid var(--ui-border, rgba(31,35,41,.08));
        background: var(--ui-subtle, #f8f9fb);
      }
      .ag-tree-search-wrap {
        flex: 1; display: flex; align-items: center; gap: 6px;
        background: var(--ui-solid, #fff); border: 1px solid var(--ui-border-strong, rgba(31,35,41,.15));
        border-radius: 6px; padding: 4px 8px;
      }
      .ag-tree-search-wrap:focus-within {
        border-color: var(--ui-primary, #336df4);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--ui-primary, #336df4) 18%, transparent);
      }
      .ag-tree-search-icon { color: var(--ui-muted, #646a73); flex: none; }
      .ag-tree-search {
        flex: 1; border: 0; outline: none; background: transparent; color: var(--ui-text, #1f2329);
        font-size: 12px; min-width: 0; padding: 0;
      }
      .ag-tree-body {
        flex: 1; overflow-y: auto; padding: 6px 6px 8px;
        scrollbar-width: thin;
      }
      .ag-tree-project + .ag-tree-project {
        margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--ui-border, rgba(31,35,41,.08));
      }
      .ag-tree-proj-banner, .ag-tree-proj-header {
        display: flex; align-items: center; gap: 6px; width: 100%; box-sizing: border-box;
        padding: 5px 8px; border-radius: 6px; font-size: 11.5px; font-weight: 650;
        color: var(--ui-muted, #646a73); letter-spacing: .01em;
      }
      .ag-tree-proj-header {
        border: 0; background: transparent; cursor: pointer; text-align: left;
      }
      .ag-tree-proj-header:hover { background: var(--ui-hover, rgba(31,35,41,.06)); color: var(--ui-text, #1f2329); }
      .ag-tree-active-badge {
        font-size: 10px; font-weight: 600; padding: 1px 5px; border-radius: 4px;
        background: color-mix(in srgb, var(--ui-primary, #336df4) 12%, transparent);
        color: var(--ui-primary, #336df4);
      }
      .ag-tree-row {
        display: flex; align-items: center; gap: 6px; width: 100%; box-sizing: border-box;
        min-height: 27px; padding: 3px 8px; border: 0; border-radius: 6px;
        background: transparent; color: var(--ui-text, #1f2329); font-size: 12.5px;
        cursor: pointer; text-align: left; transition: background .1s;
      }
      .ag-tree-row:hover { background: var(--ui-hover, rgba(31,35,41,.06)); }
      .ag-tree-folder { font-weight: 550; color: var(--ui-text, #1f2329); }
      .ag-tree-chevron {
        flex: none; color: var(--ui-muted, #646a73); transition: transform .14s ease;
      }
      .ag-tree-folder.is-open > .ag-tree-chevron,
      .ag-tree-proj-header.is-open > .ag-tree-chevron {
        transform: rotate(90deg);
      }
      .ag-tree-icon { flex: none; }
      .ag-icon-folder { color: #e09f3e; }
      :root[data-theme="dark"] .ag-icon-folder { color: #f0b454; }
      .ag-icon-map { color: var(--ui-primary, #336df4); }
      .ag-icon-md { color: var(--ui-muted, #646a73); }
      .ag-tree-label {
        flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .ag-tree-count {
        flex: none; font-size: 10.5px; color: var(--ui-muted, #646a73);
        background: color-mix(in srgb, var(--ui-text, #1f2329) 6%, transparent);
        padding: 0 5px; border-radius: 999px; font-weight: 500;
      }
      .ag-tree-Check {
        width: 12px; flex: none; font-size: 11px; font-weight: 700;
        color: var(--ui-primary, #336df4); text-align: center;
      }
      .ag-tree-tag {
        flex: none; font-size: 10px; font-weight: 600; padding: 0 5px; border-radius: 4px;
        background: color-mix(in srgb, var(--ui-primary, #336df4) 12%, transparent);
        color: var(--ui-primary, #336df4);
      }
      .ag-tree-file.is-selected {
        background: color-mix(in srgb, var(--ui-primary, #336df4) 12%, transparent);
        color: var(--ui-primary, #336df4); font-weight: 600;
      }
      .ag-tree-empty {
        padding: 20px 12px; text-align: center; font-size: 12px; color: var(--ui-muted, #646a73);
      }
      #ag-open-raw, #ag-split-md, #ag-fullscreen-btn, #ag-browser-btn { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
      #ag-split-md[data-active="true"] { background: color-mix(in srgb, var(--ui-primary, #336df4) 14%, transparent); color: var(--ui-primary, #336df4); font-weight: 600; }
      #ag-md-pane {
        position: fixed; top: calc(var(--banner-offset, 0px) + var(--toolbar-height, 44px)); left: 0; bottom: 0;
        width: var(--ag-split-left, 42vw); z-index: 30;
        display: flex; flex-direction: column;
        background: var(--ui-solid, #fff); color: var(--ui-text, #1f2329);
        border-right: 1px solid var(--ui-border-strong, rgba(31,35,41,.16));
        border-radius: 0; box-shadow: none; overflow: hidden;
      }
      #ag-md-pane[hidden] { display: none !important; }
      .ag-md-header {
        display: flex; align-items: center; justify-content: space-between; gap: 6px;
        height: 34px; padding: 0 10px; box-sizing: border-box;
        border-bottom: 1px solid var(--ui-border, rgba(31,35,41,.09));
        background: var(--ui-subtle, #f6f7f9); font-size: 12px; flex: none;
      }
      .ag-md-title {
        font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;
      }
      .ag-md-line-badge {
        font-size: 11px; font-weight: 560; font-variant-numeric: tabular-nums;
        padding: 1px 6px; border-radius: 4px;
        background: color-mix(in srgb, var(--ui-primary, #336df4) 12%, transparent);
        color: var(--ui-primary, #336df4); flex: none;
      }
      .ag-md-close {
        border: 1px solid var(--ui-border-strong, rgba(31,35,41,.15)); background: var(--ui-solid, #fff);
        color: var(--ui-muted, #646a73); border-radius: 5px; padding: 2px 7px; font-size: 11px; cursor: pointer;
      }
      .ag-md-close:hover { background: var(--ui-hover, rgba(31,35,41,.06)); color: var(--ui-text, #1f2329); }
      .ag-md-body {
        position: relative; flex: 1; display: flex; min-height: 0; overflow: hidden;
        background: var(--ui-solid, #fff);
      }
      #ag-md-gutter {
        width: 38px; flex: none; overflow: hidden; user-select: none;
        padding: 12px 5px 12px 0; box-sizing: border-box; text-align: right;
        background: color-mix(in srgb, var(--ui-subtle, #f6f7f9) 65%, var(--ui-solid, #fff));
        border-right: 1px solid var(--ui-border, rgba(31,35,41,.08));
        font: 11px/20.8px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        color: var(--ui-muted, #646a73); font-variant-numeric: tabular-nums;
      }
      .ag-gutter-ln { height: 20.8px; padding-right: 3px; }
      .ag-gutter-ln.is-active {
        color: var(--ui-primary, #336df4); font-weight: 700;
        background: color-mix(in srgb, var(--ui-primary, #336df4) 12%, transparent);
      }
      .ag-md-editor-stage {
        position: relative; flex: 1; min-width: 0; height: 100%; overflow: hidden;
      }
      #ag-md-band {
        position: absolute; left: 0; right: 0; top: 0; height: 20.8px; pointer-events: none;
        background: color-mix(in srgb, var(--ui-primary, #336df4) 10%, transparent);
        border-left: 2.5px solid var(--ui-primary, #336df4);
        transition: transform .06s ease-out, height .06s ease-out;
      }
      #ag-md-textarea {
        position: relative; z-index: 1; width: 100%; height: 100%; box-sizing: border-box;
        border: 0; outline: none; resize: none;
        padding: 12px 12px; background: transparent; color: var(--ui-text, #1f2329);
        font: 13px/20.8px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        tab-size: 2; white-space: pre; overflow: auto;
      }
      #ag-md-resizer {
        position: absolute; top: 0; right: 0; bottom: 0; width: 5px; z-index: 5; cursor: col-resize;
        background: transparent; transition: background .12s ease;
      }
      #ag-md-resizer:hover, #ag-md-resizer:active { background: var(--ui-primary, #336df4); }
    `;
    document.head.appendChild(style);

    this.fileSelectEl = document.createElement("select");
    this.fileSelectEl.id = "ag-file-select";
    this.fileSelectEl.hidden = true;
    this.fileSelectEl.addEventListener("change", () => {
      const next = this.fileSelectEl?.value;
      if (next) void this.switchFile(next);
    });

    const pickerWrap = document.createElement("div");
    pickerWrap.className = "ag-file-picker-wrap";

    this.fileTriggerBtn = document.createElement("button");
    this.fileTriggerBtn.id = "ag-file-trigger";
    this.fileTriggerBtn.type = "button";
    this.fileTriggerBtn.setAttribute("aria-haspopup", "tree");
    this.fileTriggerBtn.setAttribute("aria-expanded", "false");
    this.fileTriggerBtn.innerHTML = `
      <span class="ag-trigger-icon"><svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M1.75 2.5A1.75 1.75 0 0 0 0 4.25v7.5C0 12.716.784 13.5 1.75 13.5h12.5A1.75 1.75 0 0 0 16 11.75v-5.5A1.75 1.75 0 0 0 14.25 4.5H7.82a.25.25 0 0 1-.177-.073L6.28 3.063A1.75 1.75 0 0 0 5.043 2.5H1.75Z"/></svg></span>
      <span class="ag-trigger-name">Markdown</span>
      <span class="ag-trigger-dir" hidden></span>
      <svg class="ag-trigger-caret" viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5l3 3 3-3"/></svg>
    `;
    this.fileTriggerNameEl = this.fileTriggerBtn.querySelector(".ag-trigger-name");
    this.fileTriggerDirEl = this.fileTriggerBtn.querySelector(".ag-trigger-dir");
    this.fileTriggerBtn.addEventListener("click", e => {
      e.stopPropagation();
      this.toggleFilePopover();
    });

    this.filePopoverEl = document.createElement("div");
    this.filePopoverEl.id = "ag-file-tree-popover";
    this.filePopoverEl.hidden = true;
    this.filePopoverEl.innerHTML = `
      <div class="ag-tree-header">
        <div class="ag-tree-search-wrap">
          <svg class="ag-tree-search-icon" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14" stroke-linecap="round"/></svg>
          <input type="search" class="ag-tree-search" placeholder="${sidebarText("搜索项目 Markdown 文件…", "Filter Markdown files…")}" />
        </div>
      </div>
      <div class="ag-tree-body" role="tree"></div>
    `;
    this.fileSearchInputEl = this.filePopoverEl.querySelector(".ag-tree-search");
    this.fileTreeBodyEl = this.filePopoverEl.querySelector(".ag-tree-body");
    this.fileSearchInputEl?.addEventListener("input", () => this.renderTreeDom());
    this.filePopoverEl.addEventListener("click", e => e.stopPropagation());
    document.body.appendChild(this.filePopoverEl);

    document.addEventListener("pointerdown", e => {
      if (!this.filePopoverEl || this.filePopoverEl.hidden) return;
      const target = e.target as Node | null;
      if (target && (this.filePopoverEl.contains(target) || this.fileTriggerBtn?.contains(target))) return;
      this.closeFilePopover();
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && this.filePopoverEl && !this.filePopoverEl.hidden) {
        this.closeFilePopover();
      }
    });

    pickerWrap.append(this.fileSelectEl, this.fileTriggerBtn);

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
    const hostName = this.app.getHostVersion()?.name ?? "";
    if (!/antigravity/i.test(hostName)) {
      this.openRawBtn.hidden = true;
    }
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

    this.fullscreenBtn = document.createElement("button");
    this.fullscreenBtn.id = "ag-fullscreen-btn";
    this.fullscreenBtn.type = "button";
    const syncFullscreenBtn = () => {
      if (!this.fullscreenBtn) return;
      const ctx = this.app.getHostContext();
      const canFs = Boolean(ctx?.availableDisplayModes?.includes("fullscreen"));
      this.fullscreenBtn.hidden = !canFs;
      const isFs = ctx?.displayMode === "fullscreen";
      this.fullscreenBtn.textContent = isFs ? sidebarText("退出全屏", "Exit Fullscreen") : sidebarText("全屏", "Fullscreen");
      this.fullscreenBtn.title = isFs
        ? sidebarText("退出宿主全屏卡片视图", "Return to inline card view")
        : sidebarText("在当前软件内全屏展开导图", "Expand mind map to fullscreen inside host");
    };
    syncFullscreenBtn();
    this.app.addEventListener("hostcontextchanged", () => syncFullscreenBtn());
    this.fullscreenBtn.addEventListener("click", () => {
      const ctx = this.app.getHostContext();
      const nextMode = ctx?.displayMode === "fullscreen" ? "inline" : "fullscreen";
      void this.app.requestDisplayMode({ mode: nextMode }).then(res => {
        if (res.mode === "inline") {
          void this.app.sendSizeChanged({ height: 560 }).catch(() => {});
        }
        syncFullscreenBtn();
        window.setTimeout(() => {
          try {
            const api = (window as any).inkmap;
            api?.mindMap?.resize();
            api?.mindMap?.view?.fit();
          } catch {}
        }, 80);
      }).catch(() => {
        if (this.fullscreenBtn) this.fullscreenBtn.hidden = true;
      });
      this.fullscreenBtn?.blur();
    });

    this.openBrowserBtn = document.createElement("button");
    this.openBrowserBtn.id = "ag-browser-btn";
    this.openBrowserBtn.type = "button";
    this.openBrowserBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4"/><path d="M13.5 2.5 7.5 8.5"/><path d="M7 3.5H3.8A1.3 1.3 0 0 0 2.5 4.8v7.4c0 .72.58 1.3 1.3 1.3h7.4c.72 0 1.3-.58 1.3-1.3V9"/></svg><span>${sidebarText("大屏打开", "Browser")}</span>`;
    this.openBrowserBtn.title = sidebarText("在独立浏览器窗口大屏打开双向同步思维导图", "Open two-way synced mind map in standalone browser window");
    if (/antigravity/i.test(hostName)) {
      this.openBrowserBtn.hidden = true;
    }
    this.openBrowserBtn.addEventListener("click", () => {
      void this.callTool("inkmap_open_browser", {
        ...(this.currentFile && { file: this.currentFile }),
      }).catch(() => {});
      this.openBrowserBtn?.blur();
    });

    const sepEl = document.createElement("span");
    sepEl.className = "sep";

    bar.prepend(pickerWrap, this.splitMdBtn, this.openRawBtn, this.fullscreenBtn, this.openBrowserBtn, sepEl);

    let lastHeight = window.innerHeight;
    window.addEventListener("resize", () => {
      const nextHeight = window.innerHeight;
      const grewFromCompact = lastHeight < 300 && nextHeight >= 360;
      const modeShifted = Math.abs(nextHeight - lastHeight) > 160;
      lastHeight = nextHeight;
      requestAnimationFrame(() => {
        try {
          const api = (window as any).inkmap;
          api?.mindMap?.resize();
          if (grewFromCompact || modeShifted) {
            api?.mindMap?.view?.fit();
          }
        } catch {}
      });
    });

    this.mdPaneEl = document.createElement("aside");
    this.mdPaneEl.id = "ag-md-pane";
    this.mdPaneEl.hidden = true;
    this.mdPaneEl.innerHTML = `
      <div class="ag-md-header">
        <span class="ag-md-title" id="ag-md-title">Markdown</span>
        <span class="ag-md-line-badge" id="ag-md-line-badge">Ln 1</span>
        <button type="button" class="ag-md-close" id="ag-md-close"></button>
      </div>
      <div class="ag-md-body">
        <div id="ag-md-gutter" aria-hidden="true"></div>
        <div class="ag-md-editor-stage">
          <div id="ag-md-band" aria-hidden="true"></div>
          <textarea id="ag-md-textarea" spellcheck="false"></textarea>
        </div>
      </div>
      <div id="ag-md-resizer"></div>
    `;
    document.body.appendChild(this.mdPaneEl);
    this.mdTitleEl = document.getElementById("ag-md-title");
    this.mdLineBadgeEl = document.getElementById("ag-md-line-badge");
    this.mdCloseBtnEl = document.getElementById("ag-md-close");
    this.mdGutterEl = document.getElementById("ag-md-gutter");
    this.mdBandEl = document.getElementById("ag-md-band");
    this.mdTextareaEl = document.getElementById("ag-md-textarea") as HTMLTextAreaElement | null;
    if (this.mdCloseBtnEl) {
      this.mdCloseBtnEl.textContent = sidebarText("× 关闭MD", "× Close MD");
      this.mdCloseBtnEl.addEventListener("click", () => {
        this.splitOpen = false;
        this.applySplitLayout(true);
      });
    }
    if (this.mdTextareaEl) {
      this.mdTextareaEl.addEventListener("scroll", () => {
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
      this.mdTextareaEl.addEventListener("click", handleCursorMove);
      this.mdTextareaEl.addEventListener("keyup", e => {
        if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(e.key)) {
          handleCursorMove();
        }
      });
      this.mdTextareaEl.addEventListener("input", () => {
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

  async flushPendingEdits() {
    if (this.mdEditTimer) {
      window.clearTimeout(this.mdEditTimer);
      this.mdEditTimer = 0;
      await (window as any).inkmap?.load?.(this.currentMd, true);
    }
  }

  async switchFile(filePath: string) {
    if (!filePath || filePath === this.currentFile) return;
    await this.flushPendingEdits();
    await (window as any).inkmap?.flushSave?.();
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

  onReveal(listener: (line: number) => void) {
    this.revealListeners.push(listener);
  }

  select(line: number, endLine = line) {
    this.activeStartLine = Math.max(0, line);
    this.activeEndLine = Math.max(this.activeStartLine, endLine);
    if (!this.mdTextareaEl || !this.splitOpen) return;
    revealMarkdownLines(this.mdTextareaEl, this.activeStartLine, this.activeEndLine);
    this.renderMdGutterAndBand();
  }

  onMapMarkdownChange(md: string) {
    this.currentMd = md;
    this.syncMdPaneContent(md, false);
  }

  refreshLanguage() {
    this.applySplitLayout(false);
    this.renderFilePicker(this.cachedFiles, this.currentFile);
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
    const { url } = await this.callTool("inkmap_restore_access", { locale: this.locale });
    if (typeof url !== "string" || new URL(url).protocol !== "https:") {
      throw new Error("Invalid account link.");
    }
    const opened = await this.app.openLink({ url });
    if (opened.isError) throw new Error("Unable to open account login.");
  }

  phoneSignIn = {
    send: async (phone: string): Promise<PhoneSignInResult> => {
      const { result } = await this.callTool("inkmap_phone_send", { phone, locale: this.locale });
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
