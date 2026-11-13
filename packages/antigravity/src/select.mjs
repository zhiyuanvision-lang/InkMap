import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_BYTES = 5 * 1024 * 1024;

export function targetStateFile() {
  const base = process.env.INKMAP_HOME ?? join(homedir(), ".inkmap");
  return join(base, "antigravity-target.json");
}

function inside(root, file) {
  const rel = relative(root, file);
  return Boolean(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

export async function selectTargetFile(rawFile, rawWorkspace) {
  if (typeof rawFile !== "string" || !/\.md$/i.test(rawFile.trim())) {
    throw new Error("请指定一个 .md 或 .markmap.md 文件路径。");
  }
  const candidate = resolve(rawFile.trim());
  const info = await lstat(candidate);
  if (!info.isFile() || info.size > MAX_BYTES) {
    throw new Error("请选择 5 MiB 以内的普通 Markdown 文件。");
  }
  const file = await realpath(candidate);
  if (file !== candidate && !/\.md$/i.test(file)) {
    throw new Error("无效的 Markdown 文件路径。");
  }

  let workspace = dirname(file);
  if (rawWorkspace) {
    const resolvedWs = await realpath(resolve(rawWorkspace)).catch(() => null);
    if (resolvedWs && inside(resolvedWs, file)) workspace = resolvedWs;
  } else {
    const cwd = await realpath(process.cwd()).catch(() => null);
    if (cwd && inside(cwd, file)) workspace = cwd;
  }

  const statePath = targetStateFile();
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const temp = `${statePath}.${process.pid}.${randomUUID()}`;
  const payload = { file, workspace, seq: Date.now() };
  try {
    await writeFile(temp, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
    await rename(temp, statePath);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
  return payload;
}

if (process.argv[1] && /select\.m?js$/i.test(process.argv[1])) {
  const args = process.argv.slice(2);
  let fileArg = "";
  let workspaceArg = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--workspace" && args[i + 1]) {
      workspaceArg = args[++i];
    } else if (!fileArg) {
      fileArg = args[i];
    }
  }
  selectTargetFile(fileArg, workspaceArg).then(
    ({ file }) => {
      console.log(`已选定 Inkmap 文档：${file}`);
      console.log("在对话中输出以下胶囊按钮即可在右侧打开：[Inkmap](sidecar://inkmap/inkmap/)");
    },
    error => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
