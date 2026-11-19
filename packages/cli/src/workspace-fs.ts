/**
 * Filesystem helpers shared by the local HTTP editor (server.ts), the MCP workspace manager (mcp-files.ts),
 * and the Antigravity sidecar (packages/antigravity/src/main.mjs) so confinement rules stay identical.
 */
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { detectOsLocale } from "./license.js";

/** A message in the computer's language (the same decision as the edition, see detectOsLocale). */
export const say = (zh: string, en: string) => (detectOsLocale() === "zh" ? zh : en);

export const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;

export const SKIP_SCAN_DIRS: ReadonlySet<string> = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "dist-codex", "dist-workbuddy",
  "build", "out", ".next", ".nuxt", ".agents", ".agent", ".gemini", ".codex",
  ".venv", "venv", "target", "coverage", ".tmp",
]);

const MARKMAP_RE = /\.markmap\.md$/i;

/** True when `target` is `root` or lies beneath it (both should be resolved/real paths). */
export function insideOrEqual(root: string, target: string): boolean {
  if (root === target) return true;
  const rel = relative(root, target);
  return Boolean(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

/** True when any path segment between `root` and `target` starts with a dot. */
export function hasHiddenSegment(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (!rel || rel === ".") return false;
  return rel.split(sep).some(part => part.startsWith("."));
}

/** True when `rawTarget` or one of its ancestors up to `realRoot` is a symbolic link. */
export async function hasSymlinkUnderRoot(realRoot: string, rawTarget: string): Promise<boolean> {
  let cur = rawTarget;
  while (cur && cur !== dirname(cur)) {
    const st = await lstat(cur);
    if (st.isSymbolicLink()) return true;
    if ((await realpath(cur)) === realRoot) return false;
    cur = dirname(cur);
  }
  return false;
}

/**
 * Converts a `file://` URI (including Windows `file:///c%3A/...`) or an absolute path to a local path. `platform`
 * selects Windows or POSIX rules (default: this computer's), so the conversion can be tested anywhere.
 */
export function uriToPath(uri?: unknown, platform: NodeJS.Platform = process.platform): string | null {
  if (typeof uri !== "string" || !uri.trim()) return null;
  const trimmed = uri.trim();
  const windows = platform === "win32";
  try {
    if (trimmed.startsWith("file://")) {
      const path = fileURLToPath(trimmed.replace(/^file:\/\/\/([a-zA-Z])%3[aA](?=\/|$)/, "file:///$1:"), { windows });
      // A bare drive (`c:`) means "the current folder on drive C"; a workspace URI always means the drive root.
      return windows && /^[a-zA-Z]:$/.test(path) ? path + "\\" : path;
    }
    if ((windows ? win32 : posix).isAbsolute(trimmed)) return trimmed;
  } catch { /* Not a valid file URI. */ }
  return null;
}

/** Nearest ancestor containing `.git`, stopping at the home directory; falls back to the file's directory. */
export async function findProjectRoot(filePath: string): Promise<string> {
  const home = await realpath(homedir()).catch(() => homedir());
  let cur = dirname(filePath);
  while (cur && cur !== dirname(cur) && cur !== home) {
    try {
      await lstat(join(cur, ".git"));
      return cur;
    } catch { /* Keep walking up. */ }
    cur = dirname(cur);
  }
  return dirname(filePath);
}

export interface ScannedMarkdown {
  path: string;
  mtimeMs: number;
}

/**
 * Lists regular, non-symlinked Markdown files under `rootDir` (skipping hidden and build folders).
 * `.markmap.md` files come first; then recent files first when `byRecent`, otherwise by path.
 */
export async function scanMarkdownFiles(
  rootDir: string,
  { maxFiles = 200, maxDepth = 4, byRecent = false } = {},
): Promise<ScannedMarkdown[]> {
  const found: ScannedMarkdown[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > maxDepth || found.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) break;
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_SCAN_DIRS.has(entry.name)) await walk(full, depth + 1);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        try {
          const info = await lstat(full);
          if (!info.isFile() || info.size > MAX_MARKDOWN_BYTES) continue;
          const real = await realpath(full);
          if (real === full && insideOrEqual(rootDir, real)) found.push({ path: real, mtimeMs: info.mtimeMs });
        } catch { /* Raced with a delete or permission change. */ }
      }
    }
  }
  await walk(rootDir, 0);
  found.sort((a, b) => {
    const am = MARKMAP_RE.test(a.path) ? 0 : 1;
    const bm = MARKMAP_RE.test(b.path) ? 0 : 1;
    if (am !== bm) return am - bm;
    if (byRecent && Math.abs(b.mtimeMs - a.mtimeMs) > 1000) return b.mtimeMs - a.mtimeMs;
    return a.path.localeCompare(b.path);
  });
  return found;
}

/** Workspace folders the user has opened in Google Antigravity (from `~/.gemini/config/projects/*.json`). */
export async function discoverAntigravityProjects(): Promise<Array<{ path: string; name: string }>> {
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
        const p = uriToPath(r?.gitFolder?.folderUri || r?.folderUri);
        if (!p) continue;
        const real = await realpath(p).catch(() => null);
        if (real) roots.push({ path: real, name: String(data.name || basename(real)) });
      }
    } catch { /* Skip malformed project files. */ }
  }
  return roots;
}

/** Path of the file through which MCP tools ask editor panes to switch documents. */
export function targetStateFile(): string {
  return join(process.env.INKMAP_HOME || join(homedir(), ".inkmap"), "antigravity-target.json");
}

/** Reads and validates the current target selection; returns null for missing, symlinked, or oversized files. */
export async function readTargetSelection(): Promise<{ file: string; workspace: string; seq: number; editorOnly?: true } | null> {
  try {
    const raw = JSON.parse(await readFile(targetStateFile(), "utf8"));
    if (typeof raw?.file !== "string" || !/\.md$/i.test(raw.file)) return null;
    const info = await lstat(raw.file);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_MARKDOWN_BYTES) return null;
    const file = await realpath(raw.file);
    if (file !== raw.file) return null;
    const workspace = typeof raw.workspace === "string"
      ? await realpath(raw.workspace).catch(() => dirname(file))
      : dirname(file);
    if (!insideOrEqual(workspace, file)) return null;
    return { file, workspace, seq: Number(raw.seq) || 0, ...(raw.editorOnly === true && { editorOnly: true as const }) };
  } catch {
    return null;
  }
}

/** Runs async operations one at a time, in call order (a failed operation does not block later ones). */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work);
    tail = next.catch(() => {});
    return next;
  };
}

export interface WorkspaceRoot {
  path: string;
  name: string;
  active: boolean;
}

/**
 * Where MCP App panels and the Antigravity sidecar may open Markdown: folders from `INKMAP_WORKSPACES`, the client's
 * workspace URIs, projects registered by model tool calls, the workspace of the last model-selected file and the
 * Antigravity projects (never the home or Antigravity config folder itself), else the working directory.
 */
export function createWorkspaceAccess() {
  /** Git projects added because a model tool call opened a file in them (real path → label). */
  const sessionWorkspaces = new Map<string, string>();

  async function allowedRoots(extraWorkspaceUris: readonly unknown[] = []) {
    const roots = new Map<string, WorkspaceRoot>();
    const home = await realpath(homedir()).catch(() => homedir());
    const configDir = await realpath(process.env.ANTIGRAVITY_CONFIG_DIR || join(home, ".gemini", "config")).catch(() => "");

    const addRoot = async (rawPath: string | null, active: boolean, label?: string) => {
      if (!rawPath) return;
      const real = await realpath(rawPath).catch(() => null);
      if (!real || dirname(real) === real || real === home) return;
      if (configDir && insideOrEqual(configDir, real)) return;
      const existing = roots.get(real);
      if (!existing) roots.set(real, { path: real, name: label || basename(real), active });
      else if (active) existing.active = true;
    };

    for (const raw of (process.env.INKMAP_WORKSPACES || "").split(delimiter).filter(Boolean)) {
      await addRoot(uriToPath(raw) || resolve(raw), true);
    }
    for (const uri of extraWorkspaceUris) {
      if (typeof uri === "string" && uri.trim()) await addRoot(uriToPath(uri) || resolve(uri.trim()), true);
    }
    for (const [path, name] of sessionWorkspaces) await addRoot(path, true, name);
    const target = await readTargetSelection();
    if (target) await addRoot(target.workspace, roots.size === 0);
    for (const project of await discoverAntigravityProjects()) await addRoot(project.path, false, project.name);
    if (roots.size === 0) await addRoot(process.cwd(), true);
    return { roots: [...roots.values()], target };
  }

  /**
   * The real path of the Markdown file `candidatePath` names (an absolute path, a path relative to the active root,
   * or a `file://` URI), provided it lies inside an allowed root, the last model-selected file or an Antigravity
   * brain artifact; throws otherwise. With `registerOutside` (a model tool call naming a file in another project),
   * a file elsewhere adds its git project to this session's workspaces instead of being refused.
   */
  async function assertAllowedFile(candidatePath: unknown, extraWorkspaceUris: readonly unknown[] = [], registerOutside = false): Promise<string> {
    if (typeof candidatePath !== "string" || !candidatePath.trim()) {
      throw new Error(say("未指定 Markdown 文件。", "No Markdown file was given."));
    }
    const { roots, target } = await allowedRoots(extraWorkspaceUris);
    const trimmed = candidatePath.trim();
    let raw = uriToPath(trimmed);
    if (!raw) {
      const base = roots.find(r => r.active)?.path || roots[0]?.path || process.cwd();
      raw = isAbsolute(trimmed) ? resolve(trimmed) : resolve(base, trimmed);
    }
    const notMarkdown = () => new Error(say("请选择 .md 或 .markmap.md 文件。", "Choose a .md or .markmap.md file."));
    if (!/\.md$/i.test(raw)) throw notMarkdown();
    const info = await lstat(raw).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isFile() || info.size > MAX_MARKDOWN_BYTES) {
      throw new Error(say("请选择 5 MiB 以内的普通 Markdown 文件。", "Choose a regular Markdown file up to 5 MiB."));
    }
    const real = await realpath(raw);
    if (!/\.md$/i.test(real)) throw notMarkdown();

    const home = await realpath(homedir()).catch(() => homedir());
    const brainRoot = await realpath(join(home, ".gemini", "antigravity", "brain")).catch(() => null);
    const inBrainArtifact = Boolean(
      brainRoot &&
        insideOrEqual(brainRoot, real) &&
        !hasHiddenSegment(brainRoot, real) &&
        !(await hasSymlinkUnderRoot(brainRoot, raw)),
    );
    const hiddenError = () => new Error(say("不支持访问隐藏目录中的文件。", "Files in hidden folders are not allowed."));
    const symlinkError = () => new Error(say("不支持符号链接目录中的文件。", "Files inside symlinked folders are not allowed."));
    if (!inBrainArtifact && insideOrEqual(home, real) && hasHiddenSegment(home, real)) throw hiddenError();

    const matchedRoot = roots.find(r => insideOrEqual(r.path, real));
    if (!inBrainArtifact && !(target && target.file === real) && !matchedRoot) {
      if (!registerOutside) {
        throw new Error(say("该文件不在当前允许的工作区或项目目录内。", "This file is outside the allowed workspaces and projects."));
      }
      const project = await findProjectRoot(real);
      if (await hasSymlinkUnderRoot(project, raw)) throw symlinkError();
      if (hasHiddenSegment(project, real)) throw hiddenError();
      sessionWorkspaces.set(project, basename(project));
      return real;
    }
    if (matchedRoot) {
      if (await hasSymlinkUnderRoot(matchedRoot.path, raw)) throw symlinkError();
      if (hasHiddenSegment(matchedRoot.path, real)) throw hiddenError();
    }
    return real;
  }

  return { allowedRoots, assertAllowedFile };
}
