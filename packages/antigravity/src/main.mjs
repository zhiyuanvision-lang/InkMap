import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, normalize, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { YUNFAN_BILLING_ORIGIN, hasAccess, sanitizeViewState } from "@inkmap/core";
import { detectOsLocale, fileSessionStorage, licenseService } from "../../cli/dist/license.js";
import { fileSource, serve } from "../../cli/dist/server.js";
import {
  MAX_MARKDOWN_BYTES as MAX_BYTES,
  createSerialQueue,
  createWorkspaceAccess,
  insideOrEqual,
  readTargetSelection,
  scanMarkdownFiles,
} from "../../cli/dist/workspace-fs.js";

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
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".json": "application/json; charset=utf-8",
};

const hash = text => createHash("sha1").update(text).digest("hex");

function openExternalUrl(url) {
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) return;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(cmd, args, () => {});
}

async function openBrowserWindow(url) {
  if (process.env.INKMAP_NO_OPEN === "1" || typeof url !== "string" || !/^http:\/\/127\.0\.0\.1:[0-9]+\//.test(url)) return;
  const run = (cmd, args) =>
    new Promise(done => {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.on("error", () => done(false));
      child.on("exit", code => done(code === 0));
      child.unref();
    });
  if (process.platform === "darwin") {
    if (await run("open", ["-a", "Google Chrome", url])) return;
    await run("open", [url]);
    return;
  }
  if (process.platform === "win32") {
    if (await run("cmd", ["/c", "start", "", "chrome", url])) return;
    await run("cmd", ["/c", "start", "", url]);
    return;
  }
  if (await run("google-chrome", [url])) return;
  await run("xdg-open", [url]);
}

export function createAntigravitySidecar({
  app,
  webRoot = defaultWebRoot,
  billingOrigin = () => process.env.INKMAP_BILLING_ORIGIN || YUNFAN_BILLING_ORIGIN,
} = {}) {
  const license = licenseService(fileSessionStorage(), billingOrigin, { loginOnly: true, host: "antigravity" });
  let browserLicense = null;
  let browserServed = null;
  let activeFile = null;
  const serialized = createSerialQueue();
  const say = (zh, en) => (detectOsLocale() === "zh" ? zh : en);
  /** Roots shown by the full-window browser editor; refreshed in place on every "Open in Browser". */
  const browserRoots = [];
  /** The file each open panel shows (by the panel id its bridge sends), so images resolve per panel. */
  const panelFiles = new Map();
  const rememberPanel = (panel, file) => {
    if (typeof panel !== "string" || !panel || !file) return;
    panelFiles.delete(panel);
    panelFiles.set(panel, file);
    if (panelFiles.size > 64) panelFiles.delete(panelFiles.keys().next().value);
  };
  // The same confinement rules as the MCP server (packages/cli/src/workspace-fs.ts).
  const { allowedRoots, assertAllowedFile } = createWorkspaceAccess();
  const assertAllowedMarkdownFile = (candidatePath, workspaceUris = []) => assertAllowedFile(candidatePath, workspaceUris);

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
      const files = (await scanMarkdownFiles(root.path)).map(entry => entry.path);
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

  const rawHtml = readFileSync(join(webRoot, "index.html"), "utf8");
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob: https:; font-src 'self' data:; base-uri 'none'; form-action 'none'; object-src 'none'">`;
  app.page("/", () => {
    const osLoc = detectOsLocale();
    return rawHtml
      .replace(/<html\b([^>]*)>/i, () => `<html lang="${osLoc === "zh" ? "zh-CN" : "en"}" data-os-locale="${osLoc}">`)
      .replace("<head>", () => `<head>\n  ${cspMeta}\n  <script src="/preload.js"></script>\n  <script src="/bridge.js"></script>`);
  });

  const bridgeJs = readFileSync(join(__dirname, "bridge.js"), "utf8");
  app.page("/bridge.js", () => bridgeJs);
  app.api("/bridge.js", () => new SidecarResponse(bridgeJs, { contentType: "application/javascript; charset=utf-8" }), "GET");

  let preloadedAppJs = null;
  try {
    preloadedAppJs = readFileSync(join(webRoot, "app.js"), "utf8");
    app.page("/app.js", () => preloadedAppJs);
  } catch {}

  function registerStaticDir(dir, prefix = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const route = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        registerStaticDir(full, route);
      } else if (entry.isFile() && route !== "/index.html") {
        const contentType = TYPES[extname(entry.name).toLowerCase()] || "application/octet-stream";
        const body = route === "/app.js" && preloadedAppJs ? Buffer.from(preloadedAppJs, "utf8") : readFileSync(full);
        app.api(route, () => new SidecarResponse(body, {
          contentType,
          headers: { "Cache-Control": "private, max-age=3600" },
        }), "GET");
      }
    }
  }
  registerStaticDir(webRoot);

  app.api("/api/init", data => serialized(async () => {
    const workspaceUris = Array.isArray(data?.workspaceUris) ? data.workspaceUris : [];
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
          md: say(
            "# Inkmap\n\n- 请在工作区中添加或选择一份 `.md` / `.markmap.md` 文件\n- 或在对话中告诉 AI：「用 Inkmap 打开某文件」\n",
            "# Inkmap\n\n- Add or pick a `.md` / `.markmap.md` file in this workspace\n- Or ask the AI: \"Open <file> with Inkmap\"\n",
          ),
          version: "empty",
          writable: false,
        },
      };
    }
    activeFile = chosen;
    rememberPanel(data?.panel, chosen);
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
  }), "POST");

  app.api("/api/open", data => serialized(async () => {
    const workspaceUris = Array.isArray(data?.workspaceUris) ? data.workspaceUris : [];
    const file = await assertAllowedMarkdownFile(data?.file, workspaceUris);
    activeFile = file;
    rememberPanel(data?.panel, file);
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
  }), "POST");

  const pollHandler = data => serialized(async () => {
    const target = await readTargetSelection();
    const clientSeq = Number(data?.targetSeq) || 0;
    // A focus request from one panel's UI (`editorOnly`) moves the IDE editor, not the other panels.
    if (target && target.seq > clientSeq && !target.editorOnly && target.file !== data?.file) {
      activeFile = target.file;
      rememberPanel(data?.panel, target.file);
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
      const valid = await assertAllowedMarkdownFile(file, Array.isArray(data?.workspaceUris) ? data.workspaceUris : []);
      const { doc } = await readDocState(valid);
      if (data?.version && doc.version !== data.version) {
        return { changed: true, doc, targetSeq: target?.seq || clientSeq };
      }
      return { unchanged: true, targetSeq: target?.seq || clientSeq };
    } catch {
      return { unchanged: true, targetSeq: target?.seq || clientSeq };
    }
  });
  app.api("/api/poll", pollHandler, "GET");
  app.api("/api/poll", pollHandler, "POST");

  app.api("/api/save", data => serialized(async () => {
    const workspaceUris = Array.isArray(data?.workspaceUris) ? data.workspaceUris : [];
    const file = await assertAllowedMarkdownFile(data?.file || activeFile, workspaceUris);
    const md = data?.md;
    if (typeof md !== "string" || Buffer.byteLength(md, "utf8") > MAX_BYTES) {
      throw new Error(say("Markdown 内容无效或超过 5 MiB 限制。", "The Markdown is invalid or larger than 5 MiB."));
    }
    if (!hasAccess(await license.state())) {
      throw new Error(say("Inkmap 免费试用已到期，请登录或解锁 Pro。", "The Inkmap trial has ended. Sign in or unlock Pro."));
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
  }), "POST");

  app.api("/api/telemetry", async data => {
    const ev = typeof data?.event === "string" ? data.event : "";
    if (ev) license.track?.(ev, 1, "antigravity");
    return { ok: true };
  }, "POST");

  app.api("/api/open-browser", data => serialized(async () => {
    if (!hasAccess(await license.state())) {
      throw new Error(say("Inkmap 免费试用已到期，请先登录已购账号恢复 Pro。", "The Inkmap trial has ended. Sign in with the account that bought Pro first."));
    }
    const workspaceUris = Array.isArray(data?.workspaceUris) ? data.workspaceUris : [];
    const targetFile = await assertAllowedMarkdownFile(data?.file || activeFile, workspaceUris);
    const { roots } = await allowedRoots(workspaceUris);
    // serve() reads this array on every request, so the browser's file tree follows workspace changes.
    browserRoots.splice(0, browserRoots.length, ...roots.map(r => r.path));
    license.track?.("feature_browser", 1, "antigravity");
    if (!browserServed) {
      browserServed = (async () => {
        browserLicense ??= licenseService(fileSessionStorage(), billingOrigin, { host: "antigravity" });
        return serve({
          source: await fileSource(targetFile),
          webRoot,
          host: "127.0.0.1",
          port: 0,
          license: browserLicense,
          sidebar: false,
          workspaceRoots: browserRoots,
        });
      })();
      browserServed.catch(() => {
        browserServed = null;
      });
    }
    const served = await browserServed;
    await served.switchToFile?.(targetFile, { trustCaller: true }).catch(() => {});
    await openBrowserWindow(served.url);
    return { ok: true, url: served.url };
  }), "POST");

  app.api("/api/view", data => serialized(async () => {
    const workspaceUris = Array.isArray(data?.workspaceUris) ? data.workspaceUris : [];
    const file = await assertAllowedMarkdownFile(data?.file || activeFile, workspaceUris).catch(() => null);
    if (!file) return { ok: false };
    const cleaned = sanitizeViewState(data?.state);
    if (cleaned) {
      const source = await fileSource(file);
      await source.writeView?.(cleaned).catch(() => {});
    }
    return { ok: true };
  }), "POST");

  app.api("/api/license", async () => await license.state(), "GET");

  app.api("/api/checkout", async data => {
    const locale = typeof data?.locale === "string" ? data.locale : undefined;
    const url = await license.connect("restore", locale);
    openExternalUrl(url);
    return { url };
  }, "POST");

  app.api("/api/phone-send", async data => {
    const locale = typeof data?.locale === "string" ? data.locale : undefined;
    return { result: await license.sendPhoneCode(String(data?.phone ?? ""), locale) };
  }, "POST");

  app.api("/api/phone-verify", async data => {
    const locale = typeof data?.locale === "string" ? data.locale : undefined;
    return { result: await license.signInByPhone(String(data?.phone ?? ""), String(data?.code ?? ""), locale) };
  }, "POST");

  app.api("/api/signout", async () => {
    await license.deactivate();
    return { state: await license.state() };
  }, "POST");

  app.api("/api/doc-asset", async data => {
    const notFound = () => new SidecarResponse("not found", { status: 404 });
    const file = (typeof data?.panel === "string" && panelFiles.get(data.panel)) || activeFile;
    const rel = typeof data?.path === "string" ? data.path.replace(/\?.*$/, "") : "";
    if (!file || !rel) return notFound();
    try {
      const dir = await realpath(dirname(file));
      const decoded = decodeURIComponent(rel);
      const candidate = /^(?:[\\/]|[A-Za-z]:[\\/])/.test(decoded)
        ? normalize(decoded)
        : normalize(join(dir, decoded));
      if (!insideOrEqual(dir, candidate) || candidate === dir) return notFound();
      const realAsset = await realpath(candidate);
      if (!insideOrEqual(dir, realAsset) || !/\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(realAsset)) return notFound();
      const info = await lstat(realAsset);
      if (!info.isFile() || info.size > MAX_BYTES) return notFound();
      const ext = extname(realAsset).toLowerCase();
      const type = TYPES[ext] || "application/octet-stream";
      const headers = { "Cache-Control": "no-cache" };
      if (ext === ".svg") {
        headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";
      }
      return new SidecarResponse(await readFile(realAsset), {
        contentType: type,
        headers,
      });
    } catch {
      return notFound();
    }
  }, "GET");

  return {
    app,
    license,
    close: async () => {
      browserLicense?.dispose?.();
      license.dispose?.();
      if (browserServed) {
        const s = await browserServed.catch(() => null);
        await s?.close();
      }
    },
  };
}

if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  const sdk = await import("sidecar_sdk").catch(() =>
    import(pathToFileURL(join(homedir(), ".gemini", "config", "node_modules", "sidecar_sdk", "index.mjs")).href),
  );
  const { app } = createAntigravitySidecar({ app: new sdk.SidecarApp() });
  app.run();
}
