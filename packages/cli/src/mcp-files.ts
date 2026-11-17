import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sanitizeViewState, type ViewState } from "@inkmap/core";
import { fileSource } from "./server.js";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_SCAN_DEPTH = 4;
const MAX_FILES = 200;
const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "dist-codex",
  "dist-workbuddy",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".agents",
  ".agent",
  ".gemini",
  ".codex",
  ".venv",
  "venv",
  "target",
  "coverage",
  ".tmp",
]);

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");

export interface McpFileItem {
  path: string;
  uri: string;
  label: string;
  group: "active" | "project";
}

export interface McpDocPayload {
  name: string;
  md: string;
  version: string;
  writable: boolean;
  viewState?: ViewState;
}

export function targetStateFile(): string {
  const base = process.env.INKMAP_HOME || join(homedir(), ".inkmap");
  return join(base, "antigravity-target.json");
}

function insideOrEqual(root: string, target: string): boolean {
  if (root === target) return true;
  const rel = relative(root, target);
  return Boolean(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

function hasHiddenSegment(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (!rel || rel === ".") return false;
  return rel.split(sep).some(part => part.startsWith("."));
}

async function hasSymlinkUnderRoot(realRoot: string, rawTarget: string): Promise<boolean> {
  let cur = rawTarget;
  while (cur && cur !== dirname(cur)) {
    const st = await lstat(cur);
    if (st.isSymbolicLink()) return true;
    const realCur = await realpath(cur);
    if (realCur === realRoot) return false;
    cur = dirname(cur);
  }
  return false;
}

function uriToPath(uri?: string): string | null {
  if (typeof uri !== "string" || !uri.trim()) return null;
  const trimmed = uri.trim();
  try {
    if (trimmed.startsWith("file://")) return fileURLToPath(trimmed);
    if (isAbsolute(trimmed)) return trimmed;
  } catch {}
  return null;
}

async function findGitRoot(filePath: string): Promise<string> {
  let cur = dirname(filePath);
  const home = await realpath(homedir()).catch(() => homedir());
  while (cur && cur !== dirname(cur) && cur !== home) {
    try {
      await lstat(join(cur, ".git"));
      return cur;
    } catch {}
    cur = dirname(cur);
  }
  return dirname(filePath);
}

export async function writeTargetSelection(
  filePath: string,
  workspaceDir?: string,
  extra?: { openInEditorPane?: boolean; editorUrl?: string },
) {
  const real = await realpath(filePath);
  const info = await lstat(real);
  if (!info.isFile() || info.size > MAX_BYTES || !/\.md$/i.test(real)) {
    throw new Error("请选择 5 MiB 以内的 .md 或 .markmap.md 文件。");
  }
  const workspace = workspaceDir
    ? await realpath(workspaceDir).catch(() => findGitRoot(real))
    : await findGitRoot(real);
  const statePath = targetStateFile();
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const payload = {
    file: real,
    workspace,
    seq: Date.now(),
    updatedAt: new Date().toISOString(),
    ...(extra?.openInEditorPane && { openInEditorPane: true }),
    ...(extra?.editorUrl && { editorUrl: extra.editorUrl }),
  };
  const tmp = `${statePath}.${process.pid}.${Date.now()}`;
  try {
    await writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await rename(tmp, statePath);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return payload;
}

async function readTargetSelection(): Promise<{ file: string; workspace: string; seq: number } | null> {
  try {
    const raw = JSON.parse(await readFile(targetStateFile(), "utf8"));
    if (typeof raw?.file !== "string" || !/\.md$/i.test(raw.file)) return null;
    const info = await lstat(raw.file);
    if (!info.isFile() || info.size > MAX_BYTES) return null;
    const file = await realpath(raw.file);
    if (file !== raw.file) return null;
    const workspace = typeof raw.workspace === "string"
      ? await realpath(raw.workspace).catch(() => dirname(file))
      : dirname(file);
    if (!insideOrEqual(workspace, file)) return null;
    return { file, workspace, seq: Number(raw.seq) || 0 };
  } catch {
    return null;
  }
}

async function discoverAntigravityProjects(): Promise<Array<{ path: string; name: string }>> {
  const projectsDir = join(process.env.ANTIGRAVITY_CONFIG_DIR || join(homedir(), ".gemini", "config"), "projects");
  const roots: Array<{ path: string; name: string }> = [];
  let entries: string[] = [];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return roots;
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const data = JSON.parse(await readFile(join(projectsDir, name), "utf8"));
      const resources = Array.isArray(data?.projectResources?.resources) ? data.projectResources.resources : [];
      for (const r of resources) {
        const uri = r?.gitFolder?.folderUri || r?.folderUri;
        const p = uriToPath(uri);
        if (!p) continue;
        const real = await realpath(p).catch(() => null);
        if (real) roots.push({ path: real, name: String(data.name || basename(real)) });
      }
    } catch {}
  }
  return roots;
}

async function scanMarkdownFiles(rootDir: string): Promise<Array<{ path: string; mtimeMs: number }>> {
  const found: Array<{ path: string; mtimeMs: number }> = [];
  async function walk(dir: string, depth: number) {
    if (depth > MAX_SCAN_DEPTH || found.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES) break;
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        try {
          const info = await lstat(full);
          if (info.isFile() && info.size <= MAX_BYTES) {
            const real = await realpath(full);
            if (real === full && insideOrEqual(rootDir, real)) {
              found.push({ path: real, mtimeMs: info.mtimeMs });
            }
          }
        } catch {}
      }
    }
  }
  await walk(rootDir, 0);
  found.sort((a, b) => {
    const aMarkmap = /\.markmap\.md$/i.test(a.path) ? 0 : 1;
    const bMarkmap = /\.markmap\.md$/i.test(b.path) ? 0 : 1;
    if (aMarkmap !== bMarkmap) return aMarkmap - bMarkmap;
    if (Math.abs(b.mtimeMs - a.mtimeMs) > 1000) return b.mtimeMs - a.mtimeMs;
    return a.path.localeCompare(b.path);
  });
  return found;
}

export function createMcpWorkspaceManager() {
  let activeFile: string | null = null;
  let internalSeq = 0;
  const sessionWorkspaces = new Map<string, string>(); // realpath -> label

  async function allowedRoots(extraWorkspaceUris: string[] = []) {
    const roots = new Map<string, { path: string; name: string; active: boolean }>();
    const home = await realpath(homedir()).catch(() => homedir());
    const configDir = await realpath(process.env.ANTIGRAVITY_CONFIG_DIR || join(home, ".gemini", "config")).catch(() => "");

    const addRoot = async (rawPath: string | null, active: boolean, label?: string) => {
      if (!rawPath) return;
      const real = await realpath(rawPath).catch(() => null);
      if (!real || real === sep || real === home) return;
      if (configDir && insideOrEqual(configDir, real)) return;
      if (!roots.has(real)) {
        roots.set(real, { path: real, name: label || basename(real), active });
      } else if (active) {
        roots.get(real)!.active = true;
      }
    };

    const envRoots = (process.env.INKMAP_WORKSPACES || "").split(delimiter).filter(Boolean);
    for (const r of envRoots) {
      await addRoot(uriToPath(r) || resolve(r), true);
    }
    for (const uri of extraWorkspaceUris) {
      await addRoot(uriToPath(uri) || resolve(uri), true);
    }
    for (const [p, name] of sessionWorkspaces) {
      await addRoot(p, true, name);
    }

    const target = await readTargetSelection();
    if (target) {
      await addRoot(target.workspace, roots.size === 0);
    }
    for (const proj of await discoverAntigravityProjects()) {
      await addRoot(proj.path, false, proj.name);
    }
    if (roots.size === 0) {
      await addRoot(process.cwd(), true);
    }
    const effectiveSeq = Math.max(internalSeq, target?.seq || 0);
    return { roots: [...roots.values()], target, effectiveSeq };
  }

  async function assertAllowedFile(candidatePath: string, extraWorkspaceUris: string[] = [], allowRegisterFromModel = false): Promise<string> {
    if (!candidatePath?.trim()) throw new Error("未指定 Markdown 文件。");
    const { roots, target } = await allowedRoots(extraWorkspaceUris);
    const trimmed = candidatePath.trim();
    let raw = uriToPath(trimmed);
    if (!raw) {
      if (isAbsolute(trimmed)) {
        raw = resolve(trimmed);
      } else {
        const baseRoot = roots.find(r => r.active)?.path || roots[0]?.path || process.cwd();
        raw = resolve(baseRoot, trimmed);
      }
    }
    if (!/\.md$/i.test(raw)) throw new Error("请选择 .md 或 .markmap.md 文件。");
    const info = await lstat(raw);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_BYTES) {
      throw new Error("请选择 5 MiB 以内的普通 Markdown 文件。");
    }
    const real = await realpath(raw);
    if (!/\.md$/i.test(real)) {
      throw new Error("不支持符号链接或非 Markdown 文件。");
    }

    const home = await realpath(homedir()).catch(() => homedir());
    if (insideOrEqual(home, real) && hasHiddenSegment(home, real)) {
      throw new Error("不支持访问隐藏配置目录中的文件。");
    }

    const matchedRoot = roots.find(r => insideOrEqual(r.path, real));
    const permitted = (target && target.file === real) || Boolean(matchedRoot);
    if (!permitted) {
      if (!allowRegisterFromModel) {
        throw new Error("该文件不在当前允许的工作区或项目目录内。");
      }
      const ws = await findGitRoot(real);
      if (await hasSymlinkUnderRoot(ws, raw)) {
        throw new Error("不支持符号链接目录中的文件。");
      }
      if (hasHiddenSegment(ws, real)) {
        throw new Error("不支持访问隐藏目录中的文件。");
      }
      sessionWorkspaces.set(ws, basename(ws));
      const savedTarget = await writeTargetSelection(real, ws);
      internalSeq = Math.max(internalSeq, savedTarget.seq);
      return real;
    }
    if (matchedRoot) {
      if (await hasSymlinkUnderRoot(matchedRoot.path, raw)) {
        throw new Error("不支持符号链接目录中的文件。");
      }
      if (hasHiddenSegment(matchedRoot.path, real)) {
        throw new Error("不支持访问隐藏目录中的文件。");
      }
    }
    return real;
  }

  async function readDocState(filePath: string) {
    const source = await fileSource(filePath);
    const [md, viewState] = await Promise.all([source.read(), source.readView?.()]);
    const doc: McpDocPayload = {
      name: source.name,
      md,
      version: sha1(md),
      writable: true,
      ...(viewState && { viewState }),
    };
    return { source, doc };
  }

  async function collectFiles(extraWorkspaceUris: string[] = []) {
    const { roots, target, effectiveSeq } = await allowedRoots(extraWorkspaceUris);
    const items: McpFileItem[] = [];
    const seen = new Set<string>();

    if (target && !seen.has(target.file)) {
      const owner = roots.find(r => insideOrEqual(r.path, target.file));
      const rel = owner ? relative(owner.path, target.file) : basename(target.file);
      items.push({
        path: target.file,
        uri: pathToFileURL(target.file).href,
        label: owner && roots.length > 1 ? `${owner.name} / ${rel}` : rel,
        group: owner?.active ? "active" : "project",
      });
      seen.add(target.file);
    }

    for (const root of roots) {
      const files = await scanMarkdownFiles(root.path);
      for (const entry of files) {
        if (seen.has(entry.path)) continue;
        seen.add(entry.path);
        const rel = relative(root.path, entry.path);
        items.push({
          path: entry.path,
          uri: pathToFileURL(entry.path).href,
          label: roots.length > 1 ? `${root.name} / ${rel}` : rel,
          group: root.active ? "active" : "project",
        });
      }
    }
    return { files: items, target, targetSeq: effectiveSeq };
  }

  return {
    async open(options: { path?: string; workspace?: string; fromModel?: boolean; openInEditorPane?: boolean } = {}) {
      const extraUris = options.workspace ? [options.workspace] : [];
      let explicitFile: string | null = null;
      if (options.path?.trim()) {
        explicitFile = await assertAllowedFile(options.path, extraUris, Boolean(options.fromModel));
        if (options.fromModel) {
          const saved = await writeTargetSelection(explicitFile, options.workspace, {
            openInEditorPane: options.openInEditorPane,
          });
          internalSeq = Math.max(internalSeq, saved.seq);
        } else {
          internalSeq = Math.max(internalSeq + 1, Date.now());
        }
      }
      const { files, target, targetSeq } = await collectFiles(extraUris);
      let chosen = explicitFile;
      if (!chosen && target?.file) chosen = target.file;
      if (!chosen && activeFile && files.some(f => f.path === activeFile)) chosen = activeFile;
      if (!chosen) {
        const activeGroup = files.filter(f => f.group === "active");
        chosen = (activeGroup[0] || files[0])?.path || null;
      }
      if (chosen && !explicitFile && options.fromModel && options.openInEditorPane) {
        const saved = await writeTargetSelection(chosen, options.workspace, { openInEditorPane: true });
        internalSeq = Math.max(internalSeq, saved.seq);
      }
      if (!chosen) {
        return {
          files,
          currentFile: null as string | null,
          currentFileUri: null as string | null,
          targetSeq,
          doc: {
            name: "Inkmap",
            md: "# Inkmap\n\n- 请在当前工作区中添加或选择一份 `.md` / `.markmap.md` 文件\n- 或在对话中让 AI 用 Inkmap 打开指定文档\n",
            version: "empty",
            writable: false,
          } satisfies McpDocPayload,
        };
      }
      activeFile = chosen;
      const { doc } = await readDocState(chosen);
      return {
        files,
        currentFile: chosen,
        currentFileUri: pathToFileURL(chosen).href,
        targetSeq,
        doc,
      };
    },

    async poll(options: { file?: string; version?: string; targetSeq?: number } = {}) {
      const target = await readTargetSelection();
      const effectiveSeq = Math.max(internalSeq, target?.seq || 0);
      const clientSeq = Number(options.targetSeq) || 0;
      const desiredFile = target && (target.seq >= internalSeq) ? target.file : activeFile;
      if (desiredFile && effectiveSeq > clientSeq && desiredFile !== options.file) {
        activeFile = desiredFile;
        const [{ doc }, { files }] = await Promise.all([
          readDocState(desiredFile),
          collectFiles(),
        ]);
        return {
          switchedFile: desiredFile,
          currentFileUri: pathToFileURL(desiredFile).href,
          files,
          targetSeq: effectiveSeq,
          doc,
        };
      }
      const file = options.file || activeFile;
      if (!file) return { unchanged: true, targetSeq: effectiveSeq };
      try {
        const valid = await assertAllowedFile(file);
        const { doc } = await readDocState(valid);
        if (options.version && doc.version !== options.version) {
          return { changed: true, doc, targetSeq: effectiveSeq };
        }
        return { unchanged: true, targetSeq: effectiveSeq };
      } catch {
        return { unchanged: true, targetSeq: effectiveSeq };
      }
    },

    async save(options: { file?: string; md: string; baseVersion?: string }) {
      const target = options.file || activeFile;
      if (!target) throw new Error("未选择要保存的 Markdown 文件。");
      const file = await assertAllowedFile(target);
      if (typeof options.md !== "string" || Buffer.byteLength(options.md, "utf8") > MAX_BYTES) {
        throw new Error("Markdown 内容无效或超过 5 MiB 限制。");
      }
      const { source, doc } = await readDocState(file);
      if (options.baseVersion && options.baseVersion !== doc.version) {
        return { ok: false as const, conflict: true as const, doc };
      }
      if (options.md !== doc.md) {
        await source.write(options.md);
      }
      activeFile = file;
      return { ok: true as const, version: sha1(options.md) };
    },

    async saveView(options: { file?: string; state: unknown }) {
      const target = options.file || activeFile;
      if (!target) return { ok: false };
      const file = await assertAllowedFile(target).catch(() => null);
      if (!file) return { ok: false };
      const cleaned = sanitizeViewState(options.state);
      if (cleaned) {
        const source = await fileSource(file);
        await source.writeView?.(cleaned).catch(() => {});
      }
      return { ok: true };
    },
  };
}
