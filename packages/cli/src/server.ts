import { hasAccess, sanitizeViewState, type Ad, type ViewState } from "@inkmap/core";
import { createHash, randomBytes } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
import type { LicenseService } from "./license.js";

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
  ads?: () => Promise<Ad[]>;
  /** For embedded clients: one random per-process URL on loopback. */
  sidebar?: boolean;
  /** Enable checkout in a sidebar distribution that allows it. */
  sidebarPurchase?: boolean;
  /** An embedding desktop host can open the account flow in the system browser. */
  sidebarAccountNavigation?: boolean;
}

export interface Served {
  url: string;
  close(): Promise<void>;
}

const hash = (s: string) => createHash("sha1").update(s).digest("hex");

export function docName(path: string) {
  return basename(path).replace(/\.md$/i, "").replace(/\.markmap$/i, "");
}

function viewStateFile(key: string): string {
  const base = process.env.INKMAP_HOME ?? join(homedir(), ".inkmap");
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
  const path = resolve(file);
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
      return () => watcher.close();
    },
    readView: () => readDiskViewState(path),
    writeView: state => writeDiskViewState(path, state),
  };
}

/** Resolves `rel` under `root`, or returns null when it would escape it. */
function within(root: string, rel: string): string | null {
  const base = root.endsWith(sep) ? root : root + sep;
  const full = normalize(join(root, decodeURIComponent(rel)));
  return full.startsWith(base) ? full : null;
}

export async function serve({ source, webRoot, port = 4377, host = "127.0.0.1", log = () => {}, license, ads, sidebar = false, sidebarPurchase = false, sidebarAccountNavigation = false }: ServeOptions): Promise<Served> {
  if (sidebar && host !== "127.0.0.1") throw new Error("The sidebar bridge requires loopback.");
  const prefix = sidebar ? `/s/${randomBytes(24).toString("hex")}/` : "/";
  let bound: number;
  let current = await source.read();
  let version = hash(current);
  let viewState = await source.readView?.();
  const clients = new Set<ServerResponse>();

  const docState = () => ({ name: source.name, md: current, version, ...(viewState && { viewState }) });
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
    const text = await source.read();
    if (hash(text) === version) return;
    current = text;
    version = hash(text);
    broadcast();
  }

  let pending: NodeJS.Timeout | undefined;
  const unwatch = source.watch(() => {
    clearTimeout(pending);
    pending = setTimeout(async () => {
      void serialized(refresh).catch(() => {}); // Atomic editor saves can briefly replace the file.
    }, 80);
  });

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
          fail(new Error("请求内容过大"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
      req.on("error", fail);
    });

  const sendFile = async (res: ServerResponse, full: string | null) => {
    if (!full) return json(res, 403, { error: "forbidden" });
    try {
      const body = await readFile(full);
      res.writeHead(200, { "content-type": TYPES[extname(full).toLowerCase()] ?? "application/octet-stream", "cache-control": sidebar ? "no-store" : "no-cache" });
      res.end(body);
    } catch {
      json(res, 404, { error: "not found" });
    }
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (sidebar) {
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; base-uri 'none'; form-action 'none'; object-src 'none'");
        if (req.headers.host !== `127.0.0.1:${bound}` || !url.pathname.startsWith(prefix)) return json(res, 404, { error: "not found" });
        if ((req.method === "PUT" || req.method === "POST") &&
            (req.headers.origin !== `http://127.0.0.1:${bound}` || req.headers["content-type"] !== "application/json")) {
          return json(res, 403, { error: "forbidden" });
        }
        url.pathname = "/" + url.pathname.slice(prefix.length);
      }
      if (url.pathname === "/api/doc" && req.method === "GET") {
        viewState = (await source.readView?.()) ?? viewState;
        if (sidebar) await serialized(refresh);
        return json(res, 200, docState());
      }
      if (url.pathname === "/api/capabilities" && req.method === "GET") {
        return json(res, 200, { purchase: !sidebar || sidebarPurchase, ...(sidebarAccountNavigation && { accountNavigation: "host" }) });
      }
      if (url.pathname === "/api/view" && req.method === "PUT") {
        const cleaned = sanitizeViewState(JSON.parse(await readBody(req)));
        if (cleaned) {
          viewState = cleaned;
          await source.writeView?.(cleaned).catch(() => {});
        }
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/doc" && req.method === "PUT") {
        const { md, baseVersion } = JSON.parse(await readBody(req));
        if (typeof md !== "string") return json(res, 400, { error: "md 必须是字符串" });
        if (!hasAccess((await license?.state()) ?? { pro: false })) return json(res, 403, { error: "Inkmap trial expired" });
        return await serialized(async () => {
          // Re-read before comparing. A filesystem watcher may not have fired yet.
          await refresh();
          if (baseVersion !== version) return json(res, 409, docState());
          if (md !== current) {
            await source.write(md);
            current = md;
            version = hash(md);
            if (sidebar) broadcast();
          }
          return json(res, 200, { version });
        });
      }
      if (url.pathname === "/api/license" && req.method === "GET") return json(res, 200, (await license?.state()) ?? { pro: false });
      const sameOriginPost = () => {
        const origin = req.headers.origin;
        const reqHost = req.headers.host;
        const local = reqHost && /^(127\.0\.0\.1|localhost|\[::1\]):[0-9]+$/.test(reqHost);
        return Boolean(local && origin === "http://" + reqHost && req.headers["content-type"] === "application/json");
      };
      if (url.pathname === "/api/checkout" && req.method === "POST") {
        if (!sameOriginPost()) return json(res, 403, { error: "forbidden" });
        const { mode } = JSON.parse(await readBody(req));
        if (mode !== "buy" && mode !== "restore") return json(res, 400, { error: "invalid checkout mode" });
        if (sidebar && !sidebarPurchase && mode === "buy") return json(res, 403, { error: "forbidden" });
        if (!license) return json(res, 503, { error: "Inkmap checkout is unavailable." });
        return json(res, 200, { url: await license.connect(mode) });
      }
      if (url.pathname === "/api/order-pro" && req.method === "POST") {
        if (!sameOriginPost()) return json(res, 403, { error: "forbidden" });
        if (sidebar && !sidebarPurchase) return json(res, 403, { error: "forbidden" });
        if (!license) return json(res, 503, { error: "Inkmap checkout is unavailable." });
        if (typeof license.orderPro !== "function") return json(res, 501, { fallback: true });
        return json(res, 200, { result: await license.orderPro() });
      }
      if (url.pathname === "/api/phone-send" && req.method === "POST") {
        if (!sameOriginPost()) return json(res, 403, { error: "forbidden" });
        if (!license || typeof license.sendPhoneCode !== "function") return json(res, 501, { fallback: true });
        const { phone } = JSON.parse(await readBody(req));
        return json(res, 200, { result: await license.sendPhoneCode(String(phone ?? "")) });
      }
      if (url.pathname === "/api/phone-verify" && req.method === "POST") {
        if (!sameOriginPost()) return json(res, 403, { error: "forbidden" });
        if (!license || typeof license.signInByPhone !== "function") return json(res, 501, { fallback: true });
        const { phone, code } = JSON.parse(await readBody(req));
        return json(res, 200, { result: await license.signInByPhone(String(phone ?? ""), String(code ?? "")) });
      }
      if (url.pathname === "/api/signout" && req.method === "POST") {
        if (!sameOriginPost()) return json(res, 403, { error: "forbidden" });
        await license?.deactivate();
        return json(res, 200, (await license?.state()) ?? { pro: false });
      }
      if (url.pathname === "/api/ads") return json(res, 200, sidebar ? [] : (await ads?.()) ?? []);
      if (url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": connected\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (url.pathname === "/favicon.ico") return void res.writeHead(204).end();
      if (url.pathname.startsWith("/doc-assets/")) {
        let asset = within(source.dir, url.pathname.slice("/doc-assets/".length));
        if (sidebar && asset) {
          const root = await realpath(source.dir);
          asset = await realpath(asset).catch(() => null);
          if (asset && (!asset.startsWith(root + sep) || !/\.(?:png|jpe?g|gif|webp)$/i.test(asset))) asset = null;
        }
        return sendFile(res, asset);
      }
      return sendFile(res, within(webRoot, url.pathname === "/" ? "index.html" : url.pathname.slice(1)));
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
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
    bound = await listen(port);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    bound = await listen(0);
  }

  return {
    url: `http://${host}:${bound}${prefix}`,
    close: () =>
      new Promise<void>(done => {
        clearTimeout(pending);
        unwatch();
        unlisten();
        for (const res of clients) res.end();
        server.close(() => done());
      }),
  };
}
