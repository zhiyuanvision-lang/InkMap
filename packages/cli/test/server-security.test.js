import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fileSource, serve } from "../dist/server.js";

const WEB = fileURLToPath(new URL("../dist/web/", import.meta.url));
const license = { state: async () => ({ pro: true }), onChange: () => () => {} };

/** Plain http.request, because fetch() cannot send a spoofed Host header. */
function raw(url, { method = "GET", headers = {}, body, setHost = true } = {}) {
  return new Promise((ok, fail) => {
    const req = request(url, { method, headers, setHost }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => (text += chunk));
      res.on("end", () => ok({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", fail);
    req.end(body);
  });
}

async function setup(t, options = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "inkmap-sec-")));
  const prev = { home: process.env.INKMAP_HOME, workspaces: process.env.INKMAP_WORKSPACES };
  // Keep view state out of ~/.inkmap and ignore any workspace list from the developer's shell.
  process.env.INKMAP_HOME = join(dir, ".home");
  delete process.env.INKMAP_WORKSPACES;
  const ws = join(dir, "ws");
  await mkdir(join(ws, ".git"), { recursive: true });
  await mkdir(join(ws, ".private"));
  const file = join(ws, "notes.md");
  await writeFile(file, "# Notes\n\n- a\n");
  await writeFile(join(ws, "other.md"), "# Other\n");
  await writeFile(join(ws, ".private", "secret.md"), "# Secret\n");
  await writeFile(join(ws, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(ws, "pic.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  await writeFile(join(dir, "outside.png"), "secret");
  await writeFile(join(dir, "outside.md"), "# Out\n");
  // Windows needs a privilege to create symlinks; the symlink cases are skipped without it.
  const canSymlink = await symlink(join(dir, "outside.png"), join(ws, "link.png")).then(() => true, () => false);
  const served = await serve({ source: await fileSource(file), webRoot: WEB, port: 0, license, ...options });
  t.after(async () => {
    await served.close();
    if (prev.home === undefined) delete process.env.INKMAP_HOME;
    else process.env.INKMAP_HOME = prev.home;
    if (prev.workspaces !== undefined) process.env.INKMAP_WORKSPACES = prev.workspaces;
    await rm(dir, { recursive: true, force: true });
  });
  const parsed = new URL(served.url);
  return { dir, ws, file, canSymlink, url: served.url, port: parsed.port, origin: parsed.origin };
}

test("a loopback server rejects DNS-rebinding Host headers", async t => {
  const { url, port } = await setup(t);
  assert.equal((await raw(url + "api/doc", { headers: { host: `evil.example:${port}` } })).status, 403);
  assert.equal((await raw(url + "index.html", { headers: { host: `evil.example:${port}` } })).status, 403);
  assert.equal((await raw(url + "api/doc", { headers: { host: "127.0.0.1" } })).status, 403);
  assert.ok([400, 403].includes((await raw(url + "api/doc", { setHost: false })).status));
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
    assert.equal((await raw(url + "api/doc", { headers: { host } })).status, 200, host);
  }
});

test("allowHost admits a forwarded host and its https origin", async t => {
  const prev = { home: process.env.INKMAP_HOME };
  const dir = await realpath(await mkdtemp(join(tmpdir(), "inkmap-fwd-")));
  process.env.INKMAP_HOME = join(dir, ".home");
  const file = join(dir, "doc.md");
  await writeFile(file, "# Doc\n");
  const served = await serve({ source: await fileSource(file), webRoot: WEB, port: 0, license });
  t.after(async () => {
    await served.close();
    if (prev.home === undefined) delete process.env.INKMAP_HOME;
    else process.env.INKMAP_HOME = prev.home;
    await rm(dir, { recursive: true, force: true });
  });
  const forwarded = "abc-4377.app.github.dev";
  assert.equal((await raw(served.url + "api/doc", { headers: { host: forwarded } })).status, 403);
  served.allowHost(forwarded);
  const doc = await raw(served.url + "api/doc", { headers: { host: forwarded } });
  assert.equal(doc.status, 200);
  const { version } = JSON.parse(doc.text);
  const put = await raw(served.url + "api/doc", {
    method: "PUT",
    headers: { host: forwarded, origin: `https://${forwarded}`, "content-type": "application/json" },
    body: JSON.stringify({ md: "# Doc\n\n- forwarded\n", baseVersion: version }),
  });
  assert.equal(put.status, 200);
  assert.equal(await readFile(file, "utf8"), "# Doc\n\n- forwarded\n");
});

test("PUT /api/doc and /api/view require a same-origin application/json request", async t => {
  const { url, origin, file, port } = await setup(t);
  const { version } = JSON.parse((await raw(url + "api/doc")).text);
  const put = (path, headers, body) => raw(url + path, { method: "PUT", headers, body });
  const doc = JSON.stringify({ md: "# Changed\n", baseVersion: version });
  for (const headers of [
    {},
    { "content-type": "application/json" },
    { origin: "https://evil.example", "content-type": "application/json" },
    { origin: "null", "content-type": "application/json" },
    { origin, "content-type": "text/plain" },
    { origin: `http://localhost:${port}`, "content-type": "application/json" },
    { host: `evil.example:${port}`, origin: `http://evil.example:${port}`, "content-type": "application/json" },
  ]) {
    assert.equal((await put("api/doc", headers, doc)).status, 403, JSON.stringify(headers));
  }
  assert.equal(await readFile(file, "utf8"), "# Notes\n\n- a\n");
  assert.equal((await put("api/doc", { origin, "content-type": "application/json" }, doc)).status, 200);
  assert.equal(await readFile(file, "utf8"), "# Changed\n");

  const view = JSON.stringify({ view: { scale: 2, dx: 1, dy: 1 } });
  assert.equal((await put("api/view", { origin: "https://evil.example", "content-type": "application/json" }, view)).status, 403);
  assert.equal((await put("api/view", { origin, "content-type": "text/plain" }, view)).status, 403);
  assert.equal(JSON.parse((await raw(url + "api/doc")).text).viewState, undefined);
  assert.equal((await put("api/view", { origin, "content-type": "application/json" }, view)).status, 200);
  assert.deepEqual(JSON.parse((await raw(url + "api/doc")).text).viewState, { view: { scale: 2, dx: 1, dy: 1 } });
});

test("malformed JSON bodies are rejected with 400", async t => {
  const { url, origin } = await setup(t);
  const response = await raw(url + "api/doc", {
    method: "PUT",
    headers: { origin, "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(response.status, 400);
});

test("/doc-assets is confined to the document folder and SVG is sandboxed", async t => {
  const { url, canSymlink } = await setup(t);
  assert.equal((await raw(url + "doc-assets/img.png")).status, 200);
  for (const path of [
    "..%2Foutside.png",
    "..%2f..%2fetc%2fpasswd",
    "%2e%2e%2Foutside.png",
    "..%5Coutside.png",
    ...(canSymlink ? ["link.png"] : []),
    "notes.md",
    "%E0%A4%A",
  ]) {
    assert.equal((await raw(url + "doc-assets/" + path)).status, 403, path);
  }
  const svg = await raw(url + "doc-assets/pic.svg");
  assert.equal(svg.status, 200);
  assert.equal(svg.headers["content-type"], "image/svg+xml");
  assert.match(svg.headers["content-security-policy"], /default-src 'none'/);
  assert.match(svg.headers["content-security-policy"], /\bsandbox\b/);
  assert.doesNotMatch(svg.headers["content-security-policy"], /script-src/);
});

test("a sidebar never serves SVG document assets", async t => {
  const { url } = await setup(t, { sidebar: true });
  assert.equal((await raw(url + "doc-assets/pic.svg")).status, 403);
  assert.equal((await raw(url + "doc-assets/img.png")).status, 200);
});

test("POST /api/open refuses hidden folders, outside files, symlinks and non-Markdown files", async t => {
  const { url, origin, ws, dir, canSymlink } = await setup(t);
  const open = (file, from = origin) =>
    raw(url + "api/open", {
      method: "POST",
      headers: { origin: from, "content-type": "application/json" },
      body: JSON.stringify({ file }),
    });

  const hidden = await open(join(ws, ".private", "secret.md"));
  assert.equal(hidden.status, 403);
  assert.match(JSON.parse(hidden.text).error, /隐藏目录|hidden folders/);
  const outside = await open(join(dir, "outside.md"));
  assert.equal(outside.status, 403);
  assert.match(JSON.parse(outside.text).error, /工作区|outside the current workspace/);
  if (canSymlink) {
    await symlink(join(dir, "outside.md"), join(ws, "alias.md"));
    assert.equal((await open(join(ws, "alias.md"))).status, 403);
  }
  assert.equal((await open(join(ws, "img.png"))).status, 400);
  assert.equal((await open(join(ws, "other.md"), "https://evil.example")).status, 403);

  const switched = await open(join(ws, "other.md"));
  assert.equal(switched.status, 200);
  assert.equal(JSON.parse(switched.text).doc.md, "# Other\n");
  const files = JSON.parse((await raw(url + "api/files")).text).files.map(f => f.path);
  assert.ok(files.includes(join(ws, "notes.md")));
  assert.ok(!files.some(p => p.includes(`${sep}.private${sep}`)));
});

test("confineToWorkspaceRoots keeps file switching inside the given roots", async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "inkmap-confine-")));
  const prev = { home: process.env.INKMAP_HOME, workspaces: process.env.INKMAP_WORKSPACES };
  process.env.INKMAP_HOME = join(dir, ".home");
  delete process.env.INKMAP_WORKSPACES;
  const repo = join(dir, "repo");
  const pkg = join(repo, "pkg");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(join(repo, "secrets"));
  await mkdir(pkg);
  await writeFile(join(pkg, "a.md"), "# A\n");
  await writeFile(join(pkg, "b.md"), "# B\n");
  await writeFile(join(repo, "secrets", "x.md"), "# X\n");
  const served = await serve({
    source: await fileSource(join(pkg, "a.md")),
    webRoot: WEB,
    port: 0,
    license,
    workspaceRoots: [pkg],
    confineToWorkspaceRoots: true,
  });
  t.after(async () => {
    await served.close();
    if (prev.home === undefined) delete process.env.INKMAP_HOME;
    else process.env.INKMAP_HOME = prev.home;
    if (prev.workspaces !== undefined) process.env.INKMAP_WORKSPACES = prev.workspaces;
    await rm(dir, { recursive: true, force: true });
  });
  const origin = new URL(served.url).origin;
  const open = file =>
    raw(served.url + "api/open", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ file }),
    });
  assert.equal((await open(join(repo, "secrets", "x.md"))).status, 403);
  assert.equal((await open(join(pkg, "b.md"))).status, 200);
  const files = JSON.parse((await raw(served.url + "api/files")).text).files.map(f => f.path);
  assert.ok(!files.some(p => p.startsWith(join(repo, "secrets"))));
});
