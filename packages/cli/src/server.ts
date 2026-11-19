import { hasAccess, sanitizeViewState, type ViewState } from "@inkmap/core";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { watch } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { detectOsLocale, type LicenseService } from "./license.js";
import { findProjectRoot, hasHiddenSegment, insideOrEqual as insideRoot, MAX_MARKDOWN_BYTES, scanMarkdownFiles } from "./workspace-fs.js";

const MAX_BODY = 20 * 1024 * 1024;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
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
  ".json": "application/json",
};

/** Where the served document comes from: a file on disk, or a document open in an editor. */
export interface DocSource {
  name: string;
  /** Stable identifier for storing per-document view state on disk. */
  key?: string;
  /** Directory that relative image paths resolve against. */
  dir: string;
  read(): Promise<string>;
  write(md: string): Promise<void>;
  /** Calls `onChange` whenever the text may have changed elsewhere; returns a disposer. */
  watch(onChange: () => void): () => void;
  readView?(): Promise<ViewState | undefined>;
  writeView?(state: ViewState): Promise<void>;
}

export interface ServeOptions {
  source: DocSource;
  /** Directory holding the built web editor. */
  webRoot: string;
  port?: number;
  host?: string;
  log?: (msg: string) => void;
  /** Membership; without it the editor runs as the free edition. */
  license?: LicenseService;
  /** For embedded clients: one random per-process URL on loopback. */
  sidebar?: boolean;
  /** Enable checkout in a sidebar distribution that allows it. */
  sidebarPurchase?: boolean;
  /** An embedding desktop host can open the account flow in the system browser. */
  sidebarAccountNavigation?: boolean;
  /** Auto-open the 3-column IDE workspace (file tree + left Markdown + right mind map) on load. */
  ideWorkspace?: boolean;
  /** Explicit workspace directories for scanning project Markdown files. */
  workspaceRoots?: string[];
  /**
   * Only allow switching to files inside `workspaceRoots` (and `INKMAP_WORKSPACES`), not the git project around the
   * open file. Embedding hosts that confine the editor to a session directory (DeepSeek Harness) set this.
   */
  confineToWorkspaceRoots?: boolean;
  /** Opens another document when the user picks a file in the tree; defaults to reading it from disk. */
  openSource?: (path: string) => Promise<DocSource>;
  /** Offer checkout outside sidebars (default true); a companion of a restore-only sidebar passes false. */
  allowPurchase?: boolean;
}

export interface Served {
  url: string;
  switchToFile?: (filePath: string, options?: { trustCaller?: boolean }) => Promise<void>;
  /** Accepts requests addressed to `host` (e.g. a VS Code Remote port-forwarding domain) in addition to loopback. */
  allowHost(host: string): void;
  close(): Promise<void>;
}

/** An error carrying the HTTP status the request handler should answer with. */
class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]+$/i;

const hash = (s: string) => createHash("sha1").update(s).digest("hex");

function docName(path: string) {
  return basename(path).replace(/\.md$/i, "").replace(/\.markmap$/i, "");
}

function viewStateFile(key: string): string {
  const base = process.env.INKMAP_HOME || join(homedir(), ".inkmap");
  return join(base, "view-state", hash(key) + ".json");
}

async function readDiskViewState(key: string): Promise<ViewState | undefined> {
  try {
    return sanitizeViewState(JSON.parse(await readFile(viewStateFile(key), "utf8")));
  } catch {
    return undefined;
  }
}

async function writeDiskViewState(key: string, state: ViewState): Promise<void> {
  const target = viewStateFile(key);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${Date.now()}`;
  try {
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

export async function fileSource(file: string, log: (msg: string) => void = () => {}): Promise<DocSource> {
  const path = await realpath(resolve(file)).catch(() => resolve(file));
  if (!(await stat(path)).isFile()) throw new Error(`不是文件：${path}`);
  const dir = dirname(path);
  return {
    name: docName(path),
    key: path,
    dir,
    read: () => readFile(path, "utf8"),
    async write(md) {
      await writeFile(path, md, "utf8");
      log(`已写回 ${path}`);
    },
    watch(onChange) {
      // Watch the directory rather than the file so atomic saves by editors (write + rename) are seen.
      const watcher = watch(dir, (_, changed) => {
        if (!changed || changed === basename(path)) onChange();
      });
      watcher.on("error", () => {});
      return () => watcher.close();
    },
    readView: () => readDiskViewState(path),
    writeView: state => writeDiskViewState(path, state),
  };
}

/** Resolves `rel` under `root`, or returns null when it would escape it. */
function within(root: string, rel: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  const resolvedRoot = resolve(root);
  const base = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  const full = normalize(join(resolvedRoot, decoded));
  return full.startsWith(base) ? full : null;
}

async function openBrowserWindow(url: string) {
  if (process.env.INKMAP_NO_OPEN === "1" || !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]+\//.test(url)) return;
  const run = (cmd: string, args: string[]) =>
    new Promise<boolean>(done => {
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

export async function serve({
  source: initialSource,
  webRoot,
  port = 4377,
  host = "127.0.0.1",
  log = () => {},
  license,
  sidebar = false,
  sidebarPurchase = false,
  sidebarAccountNavigation = false,
  ideWorkspace = false,
  workspaceRoots = [],
  confineToWorkspaceRoots = false,
  openSource = (path: string) => fileSource(path, log),
  allowPurchase = true,
}: ServeOptions): Promise<Served> {
  if (sidebar && host !== "127.0.0.1") throw new Error("The sidebar bridge requires loopback.");
  const prefix = sidebar ? `/s/${randomBytes(24).toString("hex")}/` : "/";
  let activeSource = initialSource;
  let browserCompanion: Promise<Served> | null = null;
  let bound: number;
  let current = await activeSource.read();
  let version = hash(current);
  let viewState = await activeSource.readView?.();
  const clients = new Set<ServerResponse>();
  const canPurchase = sidebar ? sidebarPurchase : allowPurchase;
  const allowedHosts = new Set<string>();
  const urlHost = host.includes(":") ? `[${host}]` : host;

  const docState = () => ({
    name: activeSource.name,
    md: current,
    version,
    ...(activeSource.key && { currentFile: activeSource.key }),
    ...(viewState && { viewState }),
  });
  const send = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(payload);
  };
  const broadcast = () => send("change", docState());
  const unlisten = license?.onChange(state => send("license", state)) ?? (() => {});
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(work: () => Promise<T>) {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  }
  async function refresh() {
    const text = await activeSource.read();
    if (hash(text) === version) return;
    current = text;
    version = hash(text);
    broadcast();
  }

  let pending: NodeJS.Timeout | undefined;
  const scheduleRefresh = () => {
    clearTimeout(pending);
    // Atomic editor saves can briefly replace the file, so a failed read is retried on the next event.
    pending = setTimeout(() => void serialized(refresh).catch(() => {}), 80);
  };
  let unwatch = activeSource.watch(scheduleRefresh);

  const canonicalActiveKey = async () =>
    activeSource.key ? await realpath(activeSource.key).catch(() => activeSource.key) : undefined;

  async function collectWorkspaceFiles() {
    const roots = new Map<string, { path: string; name: string; active: boolean }>();
    if (activeSource.key && !confineToWorkspaceRoots) {
      const realKey = await realpath(activeSource.key).catch(() => activeSource.key!);
      const projRoot = await realpath(await findProjectRoot(realKey)).catch(() => dirname(realKey));
      roots.set(projRoot, { path: projRoot, name: basename(projRoot), active: true });
    }
    const envRoots = [...workspaceRoots, ...(process.env.INKMAP_WORKSPACES || "").split(delimiter)].filter(Boolean);
    for (const raw of envRoots) {
      const real = await realpath(resolve(raw)).catch(() => null);
      if (real && !roots.has(real)) {
        roots.set(real, { path: real, name: basename(real), active: roots.size === 0 });
      }
    }
    const items: Array<{ path: string; label: string; group: "active" | "project" }> = [];
    const seen = new Set<string>();
    for (const root of roots.values()) {
      const files = (await scanMarkdownFiles(root.path)).map(entry => entry.path);
      for (const f of files) {
        if (seen.has(f)) continue;
        seen.add(f);
        const rel = relative(root.path, f);
        items.push({
          path: f,
          label: `${root.name} / ${rel}`,
          group: root.active ? "active" : "project",
        });
      }
    }
    const activeReal = await canonicalActiveKey();
    if (activeSource.key && activeReal && !seen.has(activeReal)) {
      items.unshift({
        path: activeSource.key,
        label: `${basename(activeSource.dir)} / ${basename(activeSource.key)}`,
        group: "active",
      });
    }
    return { roots: [...roots.values()], files: items };
  }

  const zh = () => detectOsLocale() === "zh";

  async function switchSourceToFile(candidatePath: string, trustCaller = false) {
    const notMarkdown = () => new HttpError(400, zh() ? "请选择 .md 或 .markmap.md 文件。" : "Choose a .md or .markmap.md file.");
    if (!candidatePath || typeof candidatePath !== "string" || !/\.md$/i.test(candidatePath)) throw notMarkdown();
    const resolvedCandidate = resolve(candidatePath);
    const rawStat = await lstat(resolvedCandidate).catch(() => null);
    const realTarget = await realpath(resolvedCandidate).catch(() => null);
    const targetStat = realTarget ? await stat(realTarget).catch(() => null) : null;
    // The editor that has a document open may name it through a symlink; files picked in the browser may not.
    if (!rawStat || (rawStat.isSymbolicLink() && !trustCaller) || !realTarget || !targetStat?.isFile() || targetStat.size > MAX_MARKDOWN_BYTES) {
      throw new HttpError(403, zh() ? "请选择 5 MiB 以内的普通 Markdown 文件。" : "Choose a regular Markdown file up to 5 MiB.");
    }
    if (!/\.md$/i.test(realTarget)) throw notMarkdown();
    if (!trustCaller) {
      const { roots } = await collectWorkspaceFiles();
      const matchedRoot = roots.find(r => insideRoot(r.path, realTarget));
      if (!matchedRoot) {
        throw new HttpError(403, zh() ? "该文件不在当前项目工作区内。" : "This file is outside the current workspace.");
      }
      if (hasHiddenSegment(matchedRoot.path, realTarget)) {
        throw new HttpError(403, zh() ? "不支持访问隐藏目录中的文件。" : "Files in hidden folders are not allowed.");
      }
    }
    // Compare canonical paths: a host may name the open document through a symlink or another drive-letter case.
    if ((await canonicalActiveKey()) === realTarget) return;
    // Load the new document completely before tearing down the old one, so a failed read leaves the editor intact.
    // A trusted host gets back the path it asked for, so it reopens the very document it has open.
    const next = await openSource(trustCaller ? resolvedCandidate : realTarget);
    const text = await next.read();
    const nextView = await next.readView?.();
    clearTimeout(pending);
    unwatch();
    activeSource = next;
    current = text;
    version = hash(text);
    viewState = nextView;
    unwatch = activeSource.watch(scheduleRefresh);
    broadcast();
  }

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((ok, fail) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          fail(new HttpError(413, zh() ? "请求内容过大。" : "The request is too large."));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
      req.on("error", fail);
    });

  const sendFile = async (res: ServerResponse, full: string | null) => {
    if (!full) return json(res, 403, { error: "forbidden" });
    try {
      const ext = extname(full).toLowerCase();
      if (ext === ".html") {
        const osLoc = detectOsLocale();
        const htmlText = (await readFile(full, "utf8")).replace(
          /<html\b([^>]*)>/i,
          () => `<html lang="${osLoc === "zh" ? "zh-CN" : "en"}" data-os-locale="${osLoc}">`,
        );
        res.writeHead(200, { "content-type": TYPES[".html"]!, "cache-control": "no-store" });
        res.end(htmlText, "utf8");
        return;
      }
      const body = await readFile(full);
      const headers: Record<string, string> = {
        "content-type": TYPES[ext] ?? "application/octet-stream",
        "cache-control": sidebar ? "no-store" : "no-cache",
      };
      if (ext === ".svg") {
        headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";
      }
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      json(res, 404, { error: "not found" });
    }
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const reqHost = req.headers.host ?? "";
      const hostAllowed = LOOPBACK_HOST.test(reqHost) || allowedHosts.has(reqHost.toLowerCase());
      if (sidebar) {
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; base-uri 'none'; form-action 'none'; object-src 'none'");
        if (reqHost !== `127.0.0.1:${bound}` || !url.pathname.startsWith(prefix)) return json(res, 404, { error: "not found" });
        if ((req.method === "PUT" || req.method === "POST") &&
            (req.headers.origin !== `http://127.0.0.1:${bound}` || req.headers["content-type"] !== "application/json")) {
          return json(res, 403, { error: "forbidden" });
        }
        url.pathname = "/" + url.pathname.slice(prefix.length);
      } else if (!hostAllowed) {
        // Rejects DNS rebinding: only loopback names (or hosts registered with allowHost) may reach the editor.
        return json(res, 403, { error: "forbidden" });
      }
      const sameOriginWrite = () => {
        const origin = req.headers.origin;
        const sameOrigin = origin === "http://" + reqHost || (allowedHosts.has(reqHost.toLowerCase()) && origin === "https://" + reqHost);
        return hostAllowed && sameOrigin && req.headers["content-type"] === "application/json";
      };
      if (!sidebar && req.method === "GET" && /^\/(?:%E3%80%82|%EF%BC%8C|[。，.,;；:：!?！？])+$/i.test(url.pathname)) {
        res.writeHead(302, { Location: "/" + url.search });
        return res.end();
      }
      if (url.pathname === "/api/doc" && req.method === "GET") {
        license?.track?.("doc_open");
        viewState = (await activeSource.readView?.()) ?? viewState;
        if (sidebar) await serialized(refresh);
        return json(res, 200, docState());
      }
      if (url.pathname === "/api/files" && req.method === "GET") {
        const { files } = await collectWorkspaceFiles();
        return json(res, 200, { currentFile: activeSource.key ?? null, files });
      }
      if (url.pathname === "/api/capabilities" && req.method === "GET") {
        return json(res, 200, {
          purchase: canPurchase,
          ...(ideWorkspace && { ideWorkspace: true }),
          ...(sidebarAccountNavigation && { accountNavigation: "host" }),
        });
      }
      if (url.pathname === "/api/view" && req.method === "PUT") {
        if (!sameOriginWrite()) return json(res, 403, { error: "forbidden" });
        const cleaned = sanitizeViewState(JSON.parse(await readBody(req)));
        if (cleaned) {
          viewState = cleaned;
          await activeSource.writeView?.(cleaned).catch(() => {});
        }
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/doc" && req.method === "PUT") {
        if (!sameOriginWrite()) return json(res, 403, { error: "forbidden" });
        const { md, baseVersion } = JSON.parse(await readBody(req));
        if (typeof md !== "string") return json(res, 400, { error: zh() ? "md 必须是字符串。" : "md must be a string." });
        if (!hasAccess((await license?.state()) ?? { pro: false })) return json(res, 403, { error: "Inkmap trial expired" });
        return await serialized(async () => {
          // Re-read before comparing. A filesystem watcher may not have fired yet.
          await refresh();
          if (baseVersion !== version) return json(res, 409, docState());
          if (md !== current) {
            await activeSource.write(md);
            current = md;
            version = hash(md);
            license?.track?.("doc_edit");
            broadcast();
          }
          return json(res, 200, { version });
        });
      }
      if (url.pathname === "/api/license" && req.method === "GET") return json(res, 200, (await license?.state()) ?? { pro: false });
      if (url.pathname === "/api/open" && req.method === "POST") {
        if (!sameOriginWrite()) return json(res, 403, { error: "forbidden" });
        const { file } = JSON.parse(await readBody(req));
        await serialized(() => switchSourceToFile(String(file ?? ""), false));
        license?.track?.("doc_open");
        const { files } = await collectWorkspaceFiles();
        return json(res, 200, { currentFile: activeSource.key ?? null, files, doc: docState() });
      }
      if (url.pathname === "/api/telemetry" && req.method === "POST") {
        if (!sameOriginWrite()) return json(res, 403, { error: "forbidden" });
        const { event } = JSON.parse(await readBody(req));
        if (typeof event === "string" && event) license?.track?.(event);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/open-browser" && req.method === "POST") {
        if (!sameOriginWrite()) return json(res, 403, { error: "forbidden" });
        if (license && !hasAccess(await license.state())) {
          return json(res, 402, { error: detectOsLocale() === "zh" ? "免费试用已到期，请先解锁或恢复 Pro。" : "Trial expired. Unlock or restore Pro first." });
        }
        license?.track?.("feature_browser");
        if (!sidebar) {
          const directUrl = `http://${urlHost}:${bound}/`;
          await openBrowserWindow(directUrl);
          return json(res, 200, { ok: true, url: directUrl });
        }
        if (!browserCompanion) {
          // The full-window companion keeps this sidebar's source wrapper, confinement and purchase policy.
          browserCompanion = serve({
            source: activeSource,
            webRoot,
            host: "127.0.0.1",
            port: 0,
            license,
            sidebar: false,
            workspaceRoots,
            confineToWorkspaceRoots,
            openSource,
            allowPurchase: canPurchase,
          });
          browserCompanion.catch(() => {
            browserCompanion = null;
          });
        }
        const companion = await browserCompanion;
        if (activeSource.key) await companion.switchToFile?.(activeSource.key, { trustCaller: true }).catch(() => {});
        await openBrowserWindow(companion.url);
        return json(res, 200, { ok: true, url: companion.url });
      }
      if (url.pathname === "/api/checkout" && req.method === "POST") {
        if (!sameOriginWrite()) return json(res, 403, { error: "forbidden" });
        const { mode, locale } = JSON.parse(await readBody(req));
        if (mode !== "buy" && mode !== "restore") return json(res, 400, { error: "invalid checkout mode" });
        if (!canPurchase && mode === "buy") return json(res, 403, { error: "forbidden" });
        if (!license) return json(res, 503, { error: "Inkmap checkout is unavailable." });
        return json(res, 200, { url: await (typeof locale === "string" ? license.connect(mode, locale) : license.connect(mode)) });
      }
      if (url.pathname === "/api/order-pro" && req.method === "POST") {
        if (!sameOriginWrite()) return json(res, 403, { error: "forbidden" });
        if (!canPurchase) return json(res, 403, { error: "forbidden" });
        if (!license) return json(res, 503, { error: "Inkmap checkout is unavailable." });
        if (typeof license.orderPro !== "function") return json(res, 501, { fallback: true });
        const { locale } = JSON.parse((await readBody(req)) || "{}");
        return json(res, 200, { result: await (typeof locale === "string" ? license.orderPro(locale) : license.orderPro()) });
      }
      if (url.pathname === "/api/phone-send" && req.method === "POST") {
        if (!sameOriginWrite()) return json(res, 403, { error: "forbidden" });
        if (!license || typeof license.sendPhoneCode !== "function") return json(res, 501, { fallback: true });
        const { phone, locale } = JSON.parse(await readBody(req));
        return json(res, 200, { result: await (typeof locale === "string" ? license.sendPhoneCode(String(phone ?? ""), locale) : license.sendPhoneCode(String(phone ?? ""))) });
      }
      if (url.pathname === "/api/phone-verify" && req.method === "POST") {
        if (!sameOriginWrite()) return json(res, 403, { error: "forbidden" });
        if (!license || typeof license.signInByPhone !== "function") return json(res, 501, { fallback: true });
        const { phone, code, locale } = JSON.parse(await readBody(req));
        return json(res, 200, {
          result: await (typeof locale === "string"
            ? license.signInByPhone(String(phone ?? ""), String(code ?? ""), locale)
            : license.signInByPhone(String(phone ?? ""), String(code ?? ""))),
        });
      }
      if (url.pathname === "/api/signout" && req.method === "POST") {
        if (!sameOriginWrite()) return json(res, 403, { error: "forbidden" });
        await license?.deactivate();
        return json(res, 200, (await license?.state()) ?? { pro: false });
      }
      if (url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": connected\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (url.pathname === "/favicon.ico") return void res.writeHead(204).end();
      if (url.pathname.startsWith("/doc-assets/")) {
        let asset = within(activeSource.dir, url.pathname.slice("/doc-assets/".length));
        if (asset) {
          const root = await realpath(activeSource.dir).catch(() => null);
          asset = await realpath(asset).catch(() => null);
          const allowedExt = sidebar ? /\.(?:png|jpe?g|gif|webp|avif|bmp|ico)$/i : /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
          if (!root || !asset || !insideRoot(root, asset) || !allowedExt.test(asset)) asset = null;
        }
        return sendFile(res, asset);
      }
      return sendFile(res, within(webRoot, url.pathname === "/" ? "index.html" : url.pathname.slice(1)));
    } catch (err) {
      if (res.headersSent) return void res.end();
      const status = err instanceof HttpError ? err.status : err instanceof SyntaxError ? 400 : 500;
      json(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  const listen = (p: number) =>
    new Promise<number>((ok, fail) => {
      server.once("error", fail);
      server.listen(p, host, () => {
        server.off("error", fail);
        ok((server.address() as { port: number }).port);
      });
    });
  try {
    try {
      bound = await listen(port);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      bound = await listen(0);
    }
  } catch (err) {
    clearTimeout(pending);
    unwatch();
    unlisten();
    throw err;
  }

  return {
    url: `http://${urlHost}:${bound}${prefix}`,
    switchToFile: (filePath: string, options?: { trustCaller?: boolean }) =>
      serialized(() => switchSourceToFile(filePath, Boolean(options?.trustCaller))),
    allowHost: (extraHost: string) => {
      if (extraHost) allowedHosts.add(extraHost.toLowerCase());
    },
    close: () =>
      new Promise<void>(done => {
        clearTimeout(pending);
        unwatch();
        unlisten();
        if (browserCompanion) void browserCompanion.then(s => s.close()).catch(() => {});
        for (const res of clients) res.end();
        server.close(() => done());
      }),
  };
}
