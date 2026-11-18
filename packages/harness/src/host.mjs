import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { YUNFAN_BILLING_ORIGIN } from "@inkmap/core";
import { fileSessionStorage, licenseService } from "../../cli/dist/license.js";
import { fileSource, serve } from "../../cli/dist/server.js";
import { route, selectedFile } from "./shared.mjs";

export const name = "inkmap";
export const inject = ["webServer", "connection", "sessions", "fs"];
const webRoot = fileURLToPath(new URL("./web/", import.meta.url));
const maxBytes = 5 * 1024 * 1024;
const loopback = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

class FileUnavailable extends Error {}

async function workspaceFile(ctx, address) {
  const file = selectedFile(address);
  if (!file || !isAbsolute(file.path)) throw new FileUnavailable();
  const header = ctx.sessions.get(file.sessionId)?.header
    ?? (await ctx.get("sessionPersistence")?.stat(file.sessionId))?.header;
  if (!header?.cwd) throw new FileUnavailable();

  // Require a verified local mapping. Remote and sandbox-only paths have no such mapping.
  const { fs } = ctx;
  const local = async path => {
    const mapped = fs.processPathFromHostPath(path);
    if (mapped === undefined) throw new FileUnavailable();
    const target = await fs.resolve(mapped);
    const hostPath = fs.processPath(target);
    if (typeof hostPath !== "string") throw new FileUnavailable();
    const roundTrip = fs.processPathFromHostPath(hostPath);
    if (roundTrip === undefined || (await fs.resolve(roundTrip)).targetKey !== target.targetKey) throw new FileUnavailable();
    return realpath(hostPath);
  };
  const [root, path] = await Promise.all([local(header.cwd), local(file.path)]);
  const child = relative(root, path);
  if (!child || isAbsolute(child) || child === ".." || child.startsWith(".." + sep) || !/\.md$/i.test(path)) {
    throw new FileUnavailable();
  }
  return { root, path };
}

async function assertFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > maxBytes || await realpath(path) !== path) throw new FileUnavailable();
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return null; }
}

export function apply(ctx) {
  const license = licenseService(fileSessionStorage(), () => YUNFAN_BILLING_ORIGIN, { loginOnly: true });
  const editors = new Map();
  const leases = new Map();
  let disposed = false;

  function closeEditor(path, editor) {
    if (editors.get(path) === editor) editors.delete(path);
    return editor.server.then(server => server.close(), () => {});
  }

  ctx.effect(() => {
    const unregister = ctx.webServer.register({
      kind: "exact",
      path: route,
      async handler(req, res) {
        const rejection = ctx.connection.requestRejection(req);
        if (rejection !== undefined) return json(res, rejection, {});
        if (!loopback.has(ctx.webServer.host) || !loopback.has(req.socket.remoteAddress?.replace(/^::ffff:/, ""))) {
          return json(res, 403, {});
        }
        if (req.method !== "POST" && req.method !== "DELETE") return json(res, 405, {});
        if (req.headers["content-type"] !== "application/json") return json(res, 415, {});
        const body = await readBody(req).catch(() => null);
        if (!body || typeof body !== "object") return json(res, 400, {});
        if (req.method === "DELETE") {
          const path = leases.get(body?.lease);
          if (path === undefined) return json(res, 200, {});
          leases.delete(body.lease);
          const editor = editors.get(path);
          if (editor && --editor.users === 0) await closeEditor(path, editor);
          return json(res, 200, {});
        }
        if (body.action === "sign-in") {
          if (disposed || !leases.has(body.lease)) return json(res, 404, {});
          try {
            return json(res, 200, { url: await license.connect("restore") });
          } catch {
            return json(res, 502, {});
          }
        }
        try {
          const { root, path } = await workspaceFile(ctx, body?.address);
          await assertFile(path);
          if (disposed) return json(res, 503, {});
          let editor = editors.get(path);
          if (!editor) {
            const server = fileSource(path).then(source => serve({
              source: {
                ...source,
                workspaceRoot: root,
                read: async () => { await assertFile(path); return source.read(); },
                write: async md => {
                  if (Buffer.byteLength(md) > maxBytes) throw new FileUnavailable();
                  await assertFile(path);
                  return source.write(md);
                },
              },
              webRoot, license, port: 0, sidebar: true, sidebarAccountNavigation: true, workspaceRoots: [root],
            }));
            editor = { users: 0, server };
            editors.set(path, editor);
            void server.catch(() => {
              if (editors.get(path)?.server === server) editors.delete(path);
            });
          }
          const server = await editor.server;
          if (disposed) return json(res, 503, {});
          const lease = randomUUID();
          leases.set(lease, path);
          editor.users++;
          return json(res, 200, { url: server.url, lease });
        } catch (error) {
          const unavailable = error instanceof FileUnavailable || ["ENOENT", "EACCES", "EPERM"].includes(error?.code);
          return json(res, unavailable ? 404 : 500, {});
        }
      },
    });
    return () => {
      disposed = true;
      unregister();
      license.dispose();
      leases.clear();
      for (const [path, editor] of editors) void closeEditor(path, editor);
    };
  }, "Inkmap local editor sessions");
}
