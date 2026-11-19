import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { sanitizeViewState, type ViewState } from "@inkmap/core";
import { fileSource } from "./server.js";
import {
  MAX_MARKDOWN_BYTES as MAX_BYTES,
  createSerialQueue,
  createWorkspaceAccess,
  findProjectRoot as findGitRoot,
  insideOrEqual,
  readTargetSelection,
  say,
  scanMarkdownFiles,
  targetStateFile,
} from "./workspace-fs.js";


const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");
let lastTargetSeq = 0;

function nextTargetSeq(): number {
  lastTargetSeq = Math.max(Date.now(), lastTargetSeq + 1);
  return lastTargetSeq;
}

interface McpFileItem {
  path: string;
  uri: string;
  label: string;
  group: "active" | "project";
}

interface McpDocPayload {
  name: string;
  md: string;
  version: string;
  writable: boolean;
  viewState?: ViewState;
}

export async function writeTargetSelection(
  filePath: string,
  workspaceDir?: string,
  /** `editorOnly`: an app UI asked the IDE to focus this file; open panels keep their own documents. */
  extra?: { openInEditorPane?: boolean; editorUrl?: string; editorOnly?: boolean },
) {
  const real = await realpath(filePath);
  const info = await lstat(real);
  if (!info.isFile() || info.size > MAX_BYTES || !/\.md$/i.test(real)) {
    throw new Error(say("请选择 5 MiB 以内的 .md 或 .markmap.md 文件。", "Choose a .md or .markmap.md file up to 5 MiB."));
  }
  const workspace = workspaceDir
    ? await realpath(workspaceDir).catch(() => findGitRoot(real))
    : await findGitRoot(real);
  const statePath = targetStateFile();
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const seq = nextTargetSeq();
  const payload = {
    file: real,
    workspace,
    seq,
    updatedAt: new Date().toISOString(),
    ...(extra?.openInEditorPane && { openInEditorPane: true }),
    ...(extra?.editorUrl && { editorUrl: extra.editorUrl }),
    ...(extra?.editorOnly && { editorOnly: true }),
  };
  const tmp = `${statePath}.${process.pid}.${seq}`;
  try {
    await writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await rename(tmp, statePath);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return payload;
}

export function createMcpWorkspaceManager() {
  let activeFile: string | null = null;
  let internalSeq = 0;

  const serialized = createSerialQueue();

  const access = createWorkspaceAccess();
  async function allowedRoots(extraWorkspaceUris: string[] = []) {
    const { roots, target } = await access.allowedRoots(extraWorkspaceUris);
    return { roots, target, effectiveSeq: Math.max(internalSeq, target?.seq || 0) };
  }
  const assertAllowedFile = access.assertAllowedFile;

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
      const files = await scanMarkdownFiles(root.path, { byRecent: true });
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
    open: (options: { path?: string; workspace?: string; fromModel?: boolean; openInEditorPane?: boolean } = {}) =>
      serialized(async () => {
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
            internalSeq = Math.max(internalSeq + 1, nextTargetSeq());
          }
        }
        const { files, target, targetSeq } = await collectFiles(extraUris);
        let finalTargetSeq = targetSeq;
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
          finalTargetSeq = Math.max(finalTargetSeq, saved.seq);
        }
        if (!chosen) {
          return {
            files,
            currentFile: null as string | null,
            currentFileUri: null as string | null,
            targetSeq: finalTargetSeq,
            doc: {
              name: "Inkmap",
              md: say(
                "# Inkmap\n\n- 请在当前工作区中添加或选择一份 `.md` / `.markmap.md` 文件\n- 或在对话中让 AI 用 Inkmap 打开指定文档\n",
                "# Inkmap\n\n- Add or pick a `.md` / `.markmap.md` file in this workspace\n- Or ask the AI to open a document with Inkmap\n",
              ),
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
          targetSeq: finalTargetSeq,
          doc,
        };
      }),

    poll: (options: { file?: string; version?: string; targetSeq?: number } = {}) =>
      serialized(async () => {
        const target = await readTargetSelection();
        const effectiveSeq = Math.max(internalSeq, target?.seq || 0);
        const clientSeq = Number(options.targetSeq) || 0;
        // Only a model-driven target selection (written by inkmap_open) moves a panel to another file. A panel's own
        // UI switch (which bumps internalSeq / activeFile) must not drag other panels sharing this server along.
        const desiredFile = target && target.seq > clientSeq && !target.editorOnly ? target.file : null;
        if (desiredFile && desiredFile !== options.file) {
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
      }),

    save: (options: { file?: string; md: string; baseVersion?: string }) =>
      serialized(async () => {
        const target = options.file || activeFile;
        if (!target) throw new Error(say("未选择要保存的 Markdown 文件。", "No Markdown file is selected to save."));
        const file = await assertAllowedFile(target);
        if (typeof options.md !== "string" || Buffer.byteLength(options.md, "utf8") > MAX_BYTES) {
          throw new Error(say("Markdown 内容无效或超过 5 MiB 限制。", "The Markdown is invalid or larger than 5 MiB."));
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
      }),

    saveView: (options: { file?: string; state: unknown }) =>
      serialized(async () => {
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
      }),
  };
}
