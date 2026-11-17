import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { YUNFAN_BILLING_ORIGIN, hasAccess, sanitizeViewState } from "@inkmap/core";
import { fileSessionStorage, licenseService } from "../../cli/dist/license.js";
import { fileSource } from "../../cli/dist/server.js";
import { targetStateFile } from "./select.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultWebRoot = join(__dirname, "web");

class SidecarResponse {
  constructor(body, { contentType = "text/plain", status = 200, headers } = {}) {
    this.body = body;
    this.contentType = contentType;
    this.status = status;
    this.headers = headers;
  }
}
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_SCAN_DEPTH = 4;
const MAX_FILES = 200;
const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".agents",
  ".agent",
  ".gemini",
  ".venv",
  "venv",
  "target",
  "coverage",
]);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".json": "application/json; charset=utf-8",
};

const hash = text => createHash("sha1").update(text).digest("hex");

function insideOrEqual(root, target) {
  if (root === target) return true;
  const rel = relative(root, target);
  return Boolean(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

function uriToPath(uri) {
  if (typeof uri !== "string" || !uri) return null;
  try {
    if (uri.startsWith("file://")) return fileURLToPath(uri);
    if (isAbsolute(uri)) return uri;
  } catch {}
  return null;
}

async function readTargetSelection() {
  try {
    const raw = JSON.parse(await readFile(targetStateFile(), "utf8"));
    if (typeof raw?.file !== "string" || !/\.md$/i.test(raw.file)) return null;
    const file = await realpath(raw.file);
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_BYTES) return null;
    const workspace = typeof raw.workspace === "string"
      ? await realpath(raw.workspace).catch(() => dirname(file))
      : dirname(file);
    if (!insideOrEqual(workspace, file)) return null;
    return { file, workspace, seq: Number(raw.seq) || 0 };
  } catch {
    return null;
  }
}

async function discoverAntigravityProjects() {
  const projectsDir = join(process.env.ANTIGRAVITY_CONFIG_DIR || join(homedir(), ".gemini", "config"), "projects");
  const roots = [];
  let entries = [];
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
        if (real) roots.push({ path: real, name: data.name || basename(real) });
      }
    } catch {}
  }
  return roots;
}

async function scanMarkdownFiles(rootDir) {
  const found = [];
  async function walk(dir, depth) {
    if (depth > MAX_SCAN_DEPTH || found.length >= MAX_FILES) return;
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES) break;
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        try {
          const info = await lstat(full);
          if (info.isFile() && info.size <= MAX_BYTES) {
            const real = await realpath(full);
            if (insideOrEqual(rootDir, real)) found.push(real);
          }
        } catch {}
      }
    }
  }
  await walk(rootDir, 0);
  found.sort((a, b) => {
    const aMarkmap = /\.markmap\.md$/i.test(a) ? 0 : 1;
    const bMarkmap = /\.markmap\.md$/i.test(b) ? 0 : 1;
    if (aMarkmap !== bMarkmap) return aMarkmap - bMarkmap;
    return a.localeCompare(b);
  });
  return found;
}

function openExternalUrl(url) {
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) return;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(cmd, args, () => {});
}

export function createAntigravitySidecar({
  app,
  webRoot = defaultWebRoot,
  billingOrigin = () => process.env.INKMAP_BILLING_ORIGIN || YUNFAN_BILLING_ORIGIN,
} = {}) {
  const license = licenseService(fileSessionStorage(), billingOrigin, { loginOnly: true, host: "antigravity" });
  let activeFile = null;

  async function allowedRoots(workspaceUris = []) {
    const roots = new Map(); // realpath -> { path, name, active }
    const uris = Array.isArray(workspaceUris) ? workspaceUris : [];
    for (const uri of uris) {
      const p = uriToPath(uri);
      if (!p) continue;
      const real = await realpath(p).catch(() => null);
      if (real && !roots.has(real)) {
        roots.set(real, { path: real, name: basename(real), active: true });
      }
    }
    const target = await readTargetSelection();
    if (target && !roots.has(target.workspace)) {
      roots.set(target.workspace, { path: target.workspace, name: basename(target.workspace), active: roots.size === 0 });
    }
    for (const proj of await discoverAntigravityProjects()) {
      if (!roots.has(proj.path)) {
        roots.set(proj.path, { path: proj.path, name: proj.name, active: false });
      }
    }
    if (roots.size === 0) {
      const cwd = await realpath(process.cwd()).catch(() => null);
      if (cwd) roots.set(cwd, { path: cwd, name: basename(cwd), active: true });
    }
    return { roots: [...roots.values()], target };
  }

  async function assertAllowedMarkdownFile(candidatePath, workspaceUris = []) {
    if (typeof candidatePath !== "string" || !candidatePath.trim()) {
      throw new Error("未指定 Markdown 文件。");
    }
    const raw = uriToPath(candidatePath.trim()) || resolve(candidatePath.trim());
    if (!/\.md$/i.test(raw)) throw new Error("请选择 .md 或 .markmap.md 文件。");
    const info = await lstat(raw);
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error("请选择 5 MiB 以内的普通 Markdown 文件。");
    const real = await realpath(raw);
    if (real !== raw || !/\.md$/i.test(real)) throw new Error("不支持符号链接或非 Markdown 文件。");

    const { roots, target } = await allowedRoots(workspaceUris);
    const permitted = (target && target.file === real) || roots.some(r => insideOrEqual(r.path, real));
    if (!permitted) throw new Error("该文件不在当前允许的工作区或项目目录内。");
    return real;
  }

  async function readDocState(filePath) {
    const source = await fileSource(filePath);
    const [md, viewState] = await Promise.all([source.read(), source.readView?.()]);
    return {
      source,
      doc: {
        name: source.name,
        md,
        version: hash(md),
        writable: true,
        ...(viewState && { viewState }),
      },
    };
  }

  async function collectFiles(workspaceUris = []) {
    const { roots, target } = await allowedRoots(workspaceUris);
    const items = [];
    const seen = new Set();

    if (target && !seen.has(target.file)) {
      const owner = roots.find(r => insideOrEqual(r.path, target.file));
      const rel = owner ? relative(owner.path, target.file) : basename(target.file);
      items.push({
        path: target.file,
        uri: pathToFileURL(target.file).href,
        label: owner ? `${owner.name} / ${rel}` : rel,
        group: owner?.active ? "active" : "project",
      });
      seen.add(target.file);
    }

    for (const root of roots) {
      const files = await scanMarkdownFiles(root.path);
      for (const file of files) {
        if (seen.has(file)) continue;
        seen.add(file);
        const rel = relative(root.path, file);
        items.push({
          path: file,
          uri: pathToFileURL(file).href,
          label: roots.length > 1 ? `${root.name} / ${rel}` : rel,
          group: root.active ? "active" : "project",
        });
      }
    }
    return { files: items, target };
  }

  // Serve index.html with preload.js and bridge.js injected before the web bundle.
  const rawHtml = readFileSync(join(webRoot, "index.html"), "utf8");
  const pageHtml = rawHtml.replace(
    "<head>",
    '<head>\n  <script src="/preload.js"></script>\n  <script src="/bridge.js"></script>',
  );
  app.page("/", () => {
    console.log("[inkmap] GET /");
    return pageHtml;
  });

  const bridgeJs = readFileSync(join(__dirname, "bridge.js"), "utf8");
  app.page("/bridge.js", () => {
    console.log("[inkmap] GET /bridge.js");
    return bridgeJs;
  });
  app.api("/bridge.js", () => new SidecarResponse(bridgeJs, { contentType: "application/javascript; charset=utf-8" }), "GET");

  try {
    const appJs = readFileSync(join(webRoot, "app.js"), "utf8");
    app.page("/app.js", () => {
      console.log(`[inkmap] GET /app.js (${appJs.length} chars)`);
      return appJs;
    });
  } catch {}

  app.api("/api/debug", async data => {
    console.log("[inkmap] CLIENT_DEBUG:", JSON.stringify(data));
    return { ok: true };
  }, "POST");

  function registerStaticDir(dir, prefix = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const route = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        registerStaticDir(full, route);
      } else if (entry.isFile() && route !== "/index.html") {
        const contentType = TYPES[extname(entry.name).toLowerCase()] || "application/octet-stream";
        const body = readFileSync(full);
        app.api(route, () => {
          console.log(`[inkmap] GET ${route} (${body.length} bytes)`);
          return new SidecarResponse(body, {
            contentType,
            headers: { "Cache-Control": "private, max-age=3600" },
          });
        }, "GET");
      }
    }
  }
  registerStaticDir(webRoot);

  app.api("/api/init", async data => {
    const workspaceUris = Array.isArray(data?.workspaceUris) ? data.workspaceUris : [];
    console.log(`[inkmap] /api/init workspaces=${JSON.stringify(workspaceUris)} requested=${data?.requestedFile || ""}`);
    const { files, target } = await collectFiles(workspaceUris);
    let chosen = null;
    if (typeof data?.requestedFile === "string" && data.requestedFile.trim()) {
      chosen = await assertAllowedMarkdownFile(data.requestedFile, workspaceUris).catch(() => null);
    }
    if (!chosen && target?.file) {
      chosen = target.file;
    }
    if (!chosen && activeFile && files.some(f => f.path === activeFile)) {
      chosen = activeFile;
    }
    if (!chosen) {
      const activeGroup = files.filter(f => f.group === "active");
      chosen = (activeGroup[0] || files[0])?.path || null;
    }
    const lic = await license.state();
    if (!chosen) {
      return {
        files,
        currentFile: null,
        currentFileUri: null,
        targetSeq: target?.seq || 0,
        license: lic,
        doc: {
          name: "Inkmap",
          md: "# Inkmap\n\n- 请在工作区中添加或选择一份 `.md` / `.markmap.md` 文件\n- 或在对话中告诉 AI：「用 Inkmap 打开某文件」\n",
          version: "empty",
          writable: false,
        },
      };
    }
    activeFile = chosen;
    license.track?.("doc_open", 1, "antigravity");
    const { doc } = await readDocState(chosen);
    return {
      files,
      currentFile: chosen,
      currentFileUri: pathToFileURL(chosen).href,
      targetSeq: target?.seq || 0,
      license: lic,
      doc,
    };
  }, "POST");

  app.api("/api/open", async data => {
    const workspaceUris = Array.isArray(data?.workspaceUris) ? data.workspaceUris : [];
    const file = await assertAllowedMarkdownFile(data?.file, workspaceUris);
    activeFile = file;
    license.track?.("doc_open", 1, "antigravity");
    const [{ doc }, { files, target }] = await Promise.all([
      readDocState(file),
      collectFiles(workspaceUris),
    ]);
    return {
      files,
      currentFile: file,
      currentFileUri: pathToFileURL(file).href,
      targetSeq: target?.seq || 0,
      doc,
    };
  }, "POST");

  const pollHandler = async data => {
    const target = await readTargetSelection();
    const clientSeq = Number(data?.targetSeq) || 0;
    if (target && target.seq > clientSeq && target.file !== data?.file) {
      console.log(`[inkmap] /api/poll SWITCH data=${JSON.stringify(data)} targetSeq=${target.seq}`);
      activeFile = target.file;
      const { doc } = await readDocState(target.file);
      return {
        switchedFile: target.file,
        currentFileUri: pathToFileURL(target.file).href,
        targetSeq: target.seq,
        doc,
      };
    }
    const file = data?.file || activeFile;
    if (!file) return { unchanged: true, targetSeq: target?.seq || clientSeq };
    try {
      const { doc } = await readDocState(file);
      if (data?.version && doc.version !== data.version) {
        return { changed: true, doc, targetSeq: target?.seq || clientSeq };
      }
      return { unchanged: true, targetSeq: target?.seq || clientSeq };
    } catch {
      return { unchanged: true, targetSeq: target?.seq || clientSeq };
    }
  };
  app.api("/api/poll", pollHandler, "GET");
  app.api("/api/poll", pollHandler, "POST");

  app.api("/api/save", async data => {
    const workspaceUris = Array.isArray(data?.workspaceUris) ? data.workspaceUris : [];
    const file = await assertAllowedMarkdownFile(data?.file || activeFile, workspaceUris);
    const md = data?.md;
    if (typeof md !== "string" || Buffer.byteLength(md, "utf8") > MAX_BYTES) {
      throw new Error("Markdown 内容无效或超过 5 MiB 限制。");
    }
    if (!hasAccess(await license.state())) {
      throw new Error("Inkmap 免费试用已到期，请登录或解锁 Pro。");
    }
    const { source, doc } = await readDocState(file);
    if (data?.baseVersion && data.baseVersion !== doc.version) {
      return { ok: false, conflict: true, doc };
    }
    if (md !== doc.md) {
      await source.write(md);
      license.track?.("doc_edit", 1, "antigravity");
    }
    return { ok: true, version: hash(md) };
  }, "POST");

  app.api("/api/telemetry", async data => {
    const ev = typeof data?.event === "string" ? data.event : "";
    if (ev) license.track?.(ev, 1, "antigravity");
    return { ok: true };
  }, "POST");

  app.api("/api/view", async data => {
    const workspaceUris = Array.isArray(data?.workspaceUris) ? data.workspaceUris : [];
    const file = await assertAllowedMarkdownFile(data?.file || activeFile, workspaceUris).catch(() => null);
    if (!file) return { ok: false };
    const cleaned = sanitizeViewState(data?.state);
    if (cleaned) {
      const source = await fileSource(file);
      await source.writeView?.(cleaned).catch(() => {});
    }
    return { ok: true };
  }, "POST");

  app.api("/api/license", async () => await license.state(), "GET");

  app.api("/api/checkout", async () => {
    const url = await license.connect("restore");
    openExternalUrl(url);
    return { url };
  }, "POST");

  app.api("/api/phone-send", async data => {
    return { result: await license.sendPhoneCode(String(data?.phone ?? "")) };
  }, "POST");

  app.api("/api/phone-verify", async data => {
    return { result: await license.signInByPhone(String(data?.phone ?? ""), String(data?.code ?? "")) };
  }, "POST");

  app.api("/api/signout", async () => {
    await license.deactivate();
    return { state: await license.state() };
  }, "POST");

  app.api("/api/doc-asset", async data => {
    const notFound = () => new SidecarResponse("not found", { status: 404 });
    const file = activeFile;
    const rel = typeof data?.path === "string" ? data.path.replace(/\?.*$/, "") : "";
    if (!file || !rel) return notFound();
    try {
      const dir = await realpath(dirname(file));
      const candidate = normalize(join(dir, decodeURIComponent(rel)));
      if (!insideOrEqual(dir, candidate) || candidate === dir) return notFound();
      const realAsset = await realpath(candidate);
      if (!insideOrEqual(dir, realAsset) || !/\.(?:png|jpe?g|gif|webp|svg)$/i.test(realAsset)) return notFound();
      const info = await lstat(realAsset);
      if (!info.isFile() || info.size > MAX_BYTES) return notFound();
      const type = TYPES[extname(realAsset).toLowerCase()] || "application/octet-stream";
      return new SidecarResponse(await readFile(realAsset), {
        contentType: type,
        headers: { "Cache-Control": "no-cache" },
      });
    } catch {
      return notFound();
    }
  }, "GET");

  return { app, license };
}

if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  const sdk = await import("sidecar_sdk").catch(() =>
    import(pathToFileURL(join(homedir(), ".gemini", "config", "node_modules", "sidecar_sdk", "index.mjs")).href),
  );
  const { app } = createAntigravitySidecar({ app: new sdk.SidecarApp() });
  app.run();
}
