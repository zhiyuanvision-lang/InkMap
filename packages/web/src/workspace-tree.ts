/**
 * Shared workspace UI helpers for hosts that show a project file tree and a split Markdown pane
 * (`HttpHost` for the browser IDE / sidebars and `McpAppHost` for MCP App panels).
 */
import { MD_LINE_HEIGHT, MD_PAD_TOP } from "./md-lines";

/** The editor API that `mount()` exposes on `window.inkmap` (see main.ts). */
export interface EditorApi {
  load(md: string, local: boolean, resetHistory?: boolean): Promise<void>;
  flushSave(): Promise<void>;
  currentMarkdown(): string;
  mindMap: { resize(): void; view: { fit(): void } };
}

export const editorApi = (): EditorApi | undefined => (window as unknown as { inkmap?: EditorApi }).inkmap;

/** Resizes the canvas on the next frame (optionally fitting it), ignoring a not-yet-mounted editor. */
export function resizeMap(fit = false) {
  requestAnimationFrame(() => {
    try {
      const api = editorApi();
      api?.mindMap.resize();
      if (fit) api?.mindMap.view.fit();
    } catch { /* Editor not mounted yet. */ }
  });
}

/** Fits the canvas after layout settles, e.g. after switching documents. */
export function fitMapSoon(delay = 120) {
  window.setTimeout(() => {
    try { editorApi()?.mindMap.view.fit(); } catch { /* Editor not mounted yet. */ }
  }, delay);
}

export interface WorkspaceFileEntry {
  path: string;
  label: string;
  group: "active" | "project";
}

export interface TreeFile {
  name: string;
  path: string;
  rel: string;
  project: string;
  isMarkmap: boolean;
}

export interface TreeFolder {
  name: string;
  key: string;
  folders: Map<string, TreeFolder>;
  sortedFolders: TreeFolder[];
  files: TreeFile[];
  totalFiles: number;
}

export interface TreeProject {
  name: string;
  key: string;
  active: boolean;
  count: number;
  root: TreeFolder;
}

const MARKMAP_RE = /\.markmap\.md$/i;
const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

/** Splits a host-provided `"Project / rel/path.md"` label (or a bare path) into project and relative path. */
export function parseFileEntry(item: WorkspaceFileEntry, fallbackProject: string) {
  const label = typeof item.label === "string" ? item.label : "";
  const sepIdx = label.indexOf(" / ");
  if (sepIdx > 0) {
    return { project: label.slice(0, sepIdx).trim(), rel: label.slice(sepIdx + 3).replace(/\\/g, "/"), item };
  }
  const rel = (label || (item.path || "").split(/[\\/]/).pop() || "").replace(/\\/g, "/");
  const normPath = (item.path || "").replace(/\\/g, "/");
  const suffix = "/" + rel;
  let project = fallbackProject;
  if (normPath.endsWith(suffix)) {
    project = normPath.slice(0, normPath.length - suffix.length).split("/").filter(Boolean).pop() || project;
  }
  return { project, rel, item };
}

function newFolder(name: string, key: string): TreeFolder {
  return { name, key, folders: new Map(), sortedFolders: [], files: [], totalFiles: 0 };
}

/** Collapses single-child folder chains (`a/b/c`), sorts folders and files, and counts files. */
function compactAndSort(folder: TreeFolder) {
  const compacted: TreeFolder[] = [];
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
  compacted.sort(byName);
  folder.sortedFolders = compacted;
  folder.files.sort((a, b) => (a.isMarkmap !== b.isMarkmap ? (a.isMarkmap ? -1 : 1) : byName(a, b)));
  folder.totalFiles = folder.files.length + compacted.reduce((sum, c) => sum + c.totalFiles, 0);
}

/** Groups flat workspace entries into projects → folders → files, filtered by `filterText`. */
export function buildProjectTree(files: WorkspaceFileEntry[], filterText: string, fallbackProject: string): TreeProject[] {
  const q = filterText.trim().toLowerCase();
  const projects = new Map<string, TreeProject>();
  for (const raw of files) {
    const { project, rel, item } = parseFileEntry(raw, fallbackProject);
    if (q && !project.toLowerCase().includes(q) && !rel.toLowerCase().includes(q)) continue;
    let proj = projects.get(project);
    if (!proj) {
      proj = { name: project, key: `proj:${project}`, active: false, count: 0, root: newFolder("", `proj:${project}`) };
      projects.set(project, proj);
    }
    if (item.group === "active") proj.active = true;
    proj.count++;

    const parts = rel.split("/").filter(Boolean);
    const fileName = parts.pop() || rel;
    let curr = proj.root;
    let key = proj.key;
    for (const seg of parts) {
      key += `/${seg}`;
      let next = curr.folders.get(seg);
      if (!next) {
        next = newFolder(seg, key);
        curr.folders.set(seg, next);
      }
      curr = next;
    }
    curr.files.push({ name: fileName, path: item.path, rel, project, isMarkmap: MARKMAP_RE.test(fileName) });
  }
  const list = [...projects.values()];
  for (const p of list) compactAndSort(p.root);
  list.sort((a, b) => (a.active !== b.active ? (a.active ? -1 : 1) : byName(a, b)));
  return list;
}

/** Adds the keys of every project/folder containing `selectedPath` to `expandedKeys`. */
export function expandSelectedAncestors(projects: TreeProject[], selectedPath: string, expandedKeys: Set<string>) {
  const mark = (folder: TreeFolder): boolean => {
    let hit = folder.files.some(f => f.path === selectedPath);
    for (const sub of folder.sortedFolders) if (mark(sub)) hit = true;
    if (hit) expandedKeys.add(folder.key);
    return hit;
  };
  for (const p of projects) {
    if (p.active) expandedKeys.add(p.key);
    if (mark(p.root)) expandedKeys.add(p.key);
  }
}

/** Inline SVG icons for tree rows; `prefix` scopes the CSS classes (`http-tree` / `ag-tree`). */
export function treeIcons(prefix: string, iconPrefix: string) {
  const folderPath = "M1.75 2.5A1.75 1.75 0 0 0 0 4.25v7.5C0 12.716.784 13.5 1.75 13.5h12.5A1.75 1.75 0 0 0 16 11.75v-5.5A1.75 1.75 0 0 0 14.25 4.5H7.82a.25.25 0 0 1-.177-.073L6.28 3.063A1.75 1.75 0 0 0 5.043 2.5H1.75Z";
  return {
    chevron: `<svg class="${prefix}-chevron" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>`,
    folder: `<svg class="${prefix}-icon ${iconPrefix}-folder" viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="${folderPath}"/></svg>`,
    mapFile: `<svg class="${prefix}-icon ${iconPrefix}-map" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="3.5" cy="8" r="1.75"/><circle cx="12.5" cy="4" r="1.75"/><circle cx="12.5" cy="12" r="1.75"/><path d="M5.25 7.3L10.75 4.7M5.25 8.7l5.5 2.6"/></svg>`,
    mdFile: `<svg class="${prefix}-icon ${iconPrefix}-md" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 1.5H4A1.5 1.5 0 0 0 2.5 3v10A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5V5.5L9.5 1.5Z"/><path d="M9.5 1.5v4h4"/></svg>`,
    folderPath,
  };
}

export interface GutterElements {
  textarea: HTMLTextAreaElement | null;
  gutter: HTMLElement | null;
  band: HTMLElement | null;
  badge: HTMLElement | null;
}

/**
 * Renders the line-number gutter, the active-line band, and the "Ln x–y" badge beside a Markdown
 * textarea. The gutter DOM is only rebuilt when the line count or active range changes, so scrolling stays cheap.
 */
export class MarkdownGutter {
  private lastKey = "";

  constructor(
    private readonly lineClass: string,
    private readonly text: (zh: string, en: string) => string,
  ) {}

  /** Forces the next render to rebuild the gutter rows (e.g. after a language switch). */
  invalidate() {
    this.lastKey = "";
  }

  render(el: GutterElements, activeStart: number, activeEnd: number, scrollOnly = false) {
    const { textarea } = el;
    if (!textarea) return;
    const totalLines = Math.max(1, textarea.value.split("\n").length);
    const sLine = Math.max(0, Math.min(activeStart, totalLines - 1));
    const eLine = Math.max(sLine, Math.min(activeEnd, totalLines - 1));
    if (!scrollOnly) {
      if (el.badge) {
        const label = sLine === eLine ? `${sLine + 1}` : `${sLine + 1}–${eLine + 1}`;
        el.badge.textContent = this.text(`行 ${label}`, `Ln ${label}`);
      }
      const key = `${totalLines}:${sLine}:${eLine}`;
      if (el.gutter && key !== this.lastKey) {
        this.lastKey = key;
        const rows: string[] = [];
        for (let i = 0; i < totalLines; i++) {
          rows.push(`<div class="${this.lineClass}${i >= sLine && i <= eLine ? " is-active" : ""}">${i + 1}</div>`);
        }
        el.gutter.innerHTML = rows.join("");
      }
    }
    if (el.gutter) el.gutter.scrollTop = textarea.scrollTop;
    if (el.band) {
      el.band.style.transform = `translateY(${MD_PAD_TOP + sLine * MD_LINE_HEIGHT - textarea.scrollTop}px)`;
      el.band.style.height = `${Math.max(1, eLine - sLine + 1) * MD_LINE_HEIGHT}px`;
    }
  }
}

/** Zero-based line range of the textarea selection. */
export function selectionLines(textarea: HTMLTextAreaElement) {
  const startPos = textarea.selectionStart ?? 0;
  const endPos = textarea.selectionEnd ?? startPos;
  const start = textarea.value.slice(0, startPos).split("\n").length - 1;
  const end = textarea.value.slice(0, endPos).split("\n").length - 1;
  return { start, end: Math.max(start, end) };
}

/** Textarea value for `md`: the pane always edits LF text so line numbers match the parser. */
export const paneText = (md: string) => md.replace(/\r\n?/g, "\n");

/** Converts LF pane text back to the document's original line endings so CRLF files stay CRLF. */
export const withDocumentEol = (paneValue: string, original: string) =>
  /\r\n/.test(original) ? paneValue.replace(/\r?\n/g, "\r\n") : paneValue;
