import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";

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
  ".json": "application/json",
};

/** Where the served document comes from: a file on disk, or a document open in an editor. */
export interface DocSource {
  name: string;
  /** Directory that relative image paths resolve against. */
  dir: string;
  read(): Promise<string>;
  write(md: string): Promise<void>;
  /** Calls `onChange` whenever the text may have changed elsewhere; returns a disposer. */
  watch(onChange: () => void): () => void;
}

export interface ServeOptions {
  source: DocSource;
  /** Directory holding the built web editor. */
  webRoot: string;
  port?: number;
  host?: string;
  log?: (msg: string) => void;
}

export interface Served {
  url: string;
  close(): Promise<void>;
}

const hash = (s: string) => createHash("sha1").update(s).digest("hex");

export function docName(path: string) {
  return basename(path).replace(/\.md$/i, "").replace(/\.markmap$/i, "");
}

export async function fileSource(file: string, log: (msg: string) => void = () => {}): Promise<DocSource> {
  const path = resolve(file);
  if (!(await stat(path)).isFile()) throw new Error(`不是文件：${path}`);
  const dir = dirname(path);
  return {
    name: docName(path),
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
  };
}

/** Resolves `rel` under `root`, or returns null when it would escape it. */
function within(root: string, rel: string): string | null {
  const base = root.endsWith(sep) ? root : root + sep;
  const full = normalize(join(root, decodeURIComponent(rel)));
  return full.startsWith(base) ? full : null;
}

export async function serve({ source, webRoot, port = 4377, host = "127.0.0.1", log = () => {} }: ServeOptions): Promise<Served> {
  let current = await source.read();
  let version = hash(current);
  const clients = new Set<ServerResponse>();

  const docState = () => ({ name: source.name, md: current, version });
  const broadcast = () => {
    const payload = `event: change\ndata: ${JSON.stringify(docState())}\n\n`;
    for (const res of clients) res.write(payload);
  };

  let pending: NodeJS.Timeout | undefined;
  const unwatch = source.watch(() => {
    clearTimeout(pending);
    pending = setTimeout(async () => {
      try {
        const text = await source.read();
        if (hash(text) === version) return;
        current = text;
        version = hash(text);
        log("文档已在别处修改，已推送到页面");
        broadcast();
      } catch {
        // The file may be briefly missing while an editor replaces it.
      }
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
      res.writeHead(200, { "content-type": TYPES[extname(full).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(body);
    } catch {
      json(res, 404, { error: "not found" });
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/doc" && req.method === "GET") return json(res, 200, docState());
      if (url.pathname === "/api/doc" && req.method === "PUT") {
        const { md, baseVersion } = JSON.parse(await readBody(req));
        if (typeof md !== "string") return json(res, 400, { error: "md 必须是字符串" });
        if (baseVersion !== version) return json(res, 409, docState());
        if (md !== current) {
          current = md;
          version = hash(md);
          try {
            await source.write(md);
          } catch (err) {
            current = await source.read();
            version = hash(current);
            throw err;
          }
        }
        return json(res, 200, { version });
      }
      if (url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": connected\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (url.pathname === "/favicon.ico") return void res.writeHead(204).end();
      if (url.pathname.startsWith("/doc-assets/")) return sendFile(res, within(source.dir, url.pathname.slice("/doc-assets/".length)));
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
  let bound: number;
  try {
    bound = await listen(port);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    bound = await listen(0);
  }

  return {
    url: `http://${host}:${bound}/`,
    close: () =>
      new Promise<void>(done => {
        clearTimeout(pending);
        unwatch();
        for (const res of clients) res.end();
        server.close(() => done());
      }),
  };
}
