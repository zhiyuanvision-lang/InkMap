// Drives the built editor the way the extension does: same HTML rewrite and CSP, with a fake
// `acquireVsCodeApi` standing in for the extension side of the message protocol.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { webviewHtml } from "../src/html.ts";

const WEB_ROOT = fileURLToPath(new URL("../dist/web/", import.meta.url));
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const DOC = `---
title: Demo
---

## Root

- alpha
  - alpha child
- ![dot](img/dot.png "40")
- omega
`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(check, label, timeout = 5000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

describe("inkmap webview", { skip: !existsSync(CHROME) && "Chrome not found" }, () => {
  let server, origin, browser;

  before(async () => {
    server = createServer(async (req, res) => {
      const path = new URL(req.url, "http://x").pathname;
      try {
        if (path === "/") {
          const html = webviewHtml(await readFile(join(WEB_ROOT, "index.html"), "utf8"), {
            webBase: `${origin}/web`,
            assetBase: `${origin}/doc/`,
            cspSource: origin,
            nonce: "test-nonce",
          });
          return res.writeHead(200, { "content-type": "text/html" }).end(html);
        }
        if (path === "/favicon.ico") return res.writeHead(204).end();
        if (path === "/doc/img/dot.png") return res.writeHead(200, { "content-type": "image/png" }).end(PNG);
        if (path.startsWith("/web/")) {
          const body = await readFile(join(WEB_ROOT, path.slice(5)));
          return res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }).end(body);
        }
      } catch {}
      res.writeHead(404).end();
    });
    await new Promise(ok => server.listen(0, "127.0.0.1", ok));
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  });
  after(async () => {
    await browser?.close();
    server?.close();
  });

  /** Opens the editor with a fake extension that keeps the document text and version. */
  async function open() {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("console", m => m.type() === "error" && errors.push(m.text()));
    const ext = { md: DOC, version: 1, sent: [] };
    const reply = msg => page.evaluate(m => window.postMessage(m, "*"), msg);
    ext.state = () => ({ name: "demo", md: ext.md, version: String(ext.version) });
    ext.reply = reply;
    await page.exposeFunction("__toExtension", async msg => {
      ext.sent.push(msg);
      if (msg.type === "ready") await reply({ type: "doc", doc: ext.state() });
      if (msg.type === "save") {
        if (msg.baseVersion !== String(ext.version)) return reply({ type: "conflict", id: msg.id, doc: ext.state() });
        ext.md = msg.md;
        ext.version++;
        await reply({ type: "saved", id: msg.id, version: String(ext.version) });
      }
    });
    await page.evaluateOnNewDocument(() => {
      window.acquireVsCodeApi = () => ({ postMessage: m => window.__toExtension(m) });
    });
    await page.goto(origin);
    await page.waitForFunction(() => window.inkmap?.mindMap);
    return { page, ext, errors };
  }

  const find = (page, text) =>
    page.evaluateHandle(text => {
      let hit;
      const walk = n => {
        if (!hit && String(n.getData("md") ?? n.getData("text")).startsWith(text)) hit = n;
        (n.children ?? []).forEach(walk);
      };
      walk(window.inkmap.mindMap.renderer.root);
      return hit;
    }, text);

  const activeText = page => page.evaluate(() => window.inkmap.mindMap.renderer.activeNodeList.map(n => n.getData("md") ?? n.getData("text")));

  it("loads under the webview CSP and resolves document images", async () => {
    const { page, errors } = await open();
    await waitFor(() => page.evaluate(() => [...document.querySelectorAll("#map img")].some(i => i.complete && i.naturalWidth > 0)), "image loaded");
    assert.deepEqual(errors, []);
    await page.close();
  });

  it("saves edits with the document version and follows external changes", async () => {
    const { page, ext, errors } = await open();
    const node = await find(page, "alpha child");
    await node.evaluate(n => n.active());
    await page.keyboard.press("Enter");
    await waitFor(() => page.evaluate(() => document.activeElement?.classList.contains("smm-node-edit-wrap")), "text editor");
    await page.keyboard.type("beta");
    await page.keyboard.press("Enter");
    await waitFor(() => ext.md.includes("  - alpha child\n  - beta\n"), "save message");
    assert.equal(ext.sent.find(m => m.type === "save").baseVersion, "1");

    ext.md = ext.md.replace("- omega\n", "- omega\n- from editor\n");
    ext.version++;
    const saves = ext.sent.filter(m => m.type === "save").length;
    await ext.reply({ type: "change", doc: ext.state() });
    await waitFor(() => page.evaluate(() => window.inkmap.currentMarkdown().includes("- from editor")), "change shown");
    await sleep(600);
    assert.equal(ext.sent.filter(m => m.type === "save").length, saves, "external change is not echoed back");
    assert.deepEqual(errors, []);
    await page.close();
  });

  it("links the text cursor and the selected node both ways", async () => {
    const { page, ext, errors } = await open();
    await ext.reply({ type: "reveal", line: 7 });
    await waitFor(async () => (await activeText(page))[0] === "alpha child", "node revealed");
    assert.notEqual(await page.evaluate(() => document.activeElement?.id), "source-text", "reveal does not steal focus");

    const node = await find(page, "omega");
    const box = await node.evaluate(n => {
      const r = n.group.node.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.click(box.x, box.y);
    await waitFor(() => ext.sent.some(m => m.type === "select" && m.line === 9), "select message");
    assert.deepEqual(errors, []);
    await page.close();
  });

  it("leaves undo to the editor's document history", async () => {
    const { page, ext, errors } = await open();
    const node = await find(page, "omega");
    await node.evaluate(n => n.active());
    await page.keyboard.press("Tab");
    await waitFor(() => page.evaluate(() => document.activeElement?.classList.contains("smm-node-edit-wrap")), "text editor");
    await page.keyboard.type("child");
    await page.keyboard.press("Enter");
    await waitFor(() => ext.md.includes("- omega\n  - child\n"), "child saved");

    await page.keyboard.down("Meta");
    await page.keyboard.press("z");
    await page.keyboard.up("Meta");
    await sleep(700);
    assert.ok(ext.md.includes("  - child\n"), "Cmd+Z is not handled by the map itself");

    await page.click("#undo");
    await waitFor(() => ext.sent.some(m => m.type === "undo"), "undo message");
    assert.deepEqual(errors, []);
    await page.close();
  });
});
