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
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };
const DOC = `---
title: Demo
---

## Root

- alpha
  - alpha child
- ![dot](img/dot.png "40")
- omega
- 进入候选：$t_{\\text{due}} \\le t_{\\text{now}}$；其余 $a + b$
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
            locale: new URL(req.url, "http://x").searchParams.get("lang") ?? "zh-cn",
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
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ["--no-first-run", "--lang=en-US"],
      env: { ...process.env, TZ: "UTC", LANG: "en_US.UTF-8" },
    });
  });
  after(async () => {
    await browser?.close();
    server?.close();
  });

  /** Opens the editor with a fake extension that keeps the document text and version. */
  async function open({ lang, timezone, ads = [], chat = false, expired = false, viewState, beforeLoad, markdown = DOC, paidOnSignIn = true } = {}) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    if (timezone) {
      await page.emulateTimezone(timezone);
    } else if (lang === "en") {
      await page.emulateTimezone("UTC");
    }
    if (lang === "en") {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "language", { get: () => "en-US" });
        Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      });
    }
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("console", m => m.type() === "error" && errors.push(m.text()));
    const ext = { md: markdown, version: 1, viewState, sent: [], license: { pro: false, trialUntil: expired ? 1 : Date.now() + 60_000 }, files: [] };
    const reply = msg => page.evaluate(m => window.postMessage(m, "*"), msg);
    ext.state = () => ({ name: "demo", md: ext.md, version: String(ext.version), ...(ext.viewState && { viewState: ext.viewState }) });
    ext.reply = reply;
    await page.exposeFunction("__toExtension", async msg => {
      ext.sent.push(msg);
      if (msg.type === "ready") await reply({ type: "doc", doc: ext.state(), license: ext.license, ads, chat });
      if (msg.type === "viewState") ext.viewState = msg.state;
      if (msg.type === "checkout") {
        await reply({ type: "checkout", id: msg.id });
        ext.license = { ...ext.license, pro: paidOnSignIn, connected: true, account: "u***@example.com" };
        await reply({ type: "license", state: ext.license });
      }
      if (msg.type === "orderPro") {
        const isEn = msg.locale === "en";
        await reply({
          type: "proOrder",
          id: msg.id,
          result: isEn
            ? { status: "redirect", url: "https://checkout.example.com/card-15" }
            : {
                status: "qr",
                qr: "data:image/png;base64," + PNG.toString("base64"),
                amountFen: 2990,
                expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
              },
        });
      }
      if (msg.type === "sendPhoneCode") {
        await reply({ type: "phoneCodeSent", id: msg.id, result: { ok: true } });
      }
      if (msg.type === "signInByPhone") {
        if (msg.code !== "123456") return reply({ type: "phoneSignIn", id: msg.id, result: { ok: false, reason: "invalid" } });
        ext.license = { ...ext.license, pro: paidOnSignIn, connected: true, account: "138****8000" };
        await reply({ type: "phoneSignIn", id: msg.id, result: { ok: true, value: ext.license } });
      }
      if (msg.type === "signOut") {
        ext.license = { pro: false, trialUntil: ext.license.trialUntil ?? 1 };
        await reply({ type: "license", state: ext.license });
        await reply({ type: "signedOut", id: msg.id });
      }
      if (msg.type === "saveFile") {
        ext.files.push(msg);
        await reply({ type: "fileSaved", id: msg.id, saved: true });
      }
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
    if (beforeLoad) await page.evaluateOnNewDocument(beforeLoad);
    await page.goto(lang ? `${origin}/?lang=${lang}` : origin);
    await page.waitForFunction(() => window.inkmap?.mindMap?.renderer?.root);
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

  it("loads under the webview CSP and resolves document images and LaTeX math", async () => {
    const { page, errors } = await open();
    await waitFor(() => page.evaluate(() => [...document.querySelectorAll("#map img")].some(i => i.complete && i.naturalWidth > 0)), "image loaded");
    assert.equal(await page.evaluate(() => document.querySelectorAll("#map .ink-node .katex").length), 2, "renders inline formulas with KaTeX");
    assert.equal(await page.$("#ad"), null, "ad popup is gone");
    assert.deepEqual(errors, []);
    await page.close();
  });

  it("restores expanded nodes and canvas zoom/pan when reopened", async () => {
    const DEEP = "## Root\n\n- branch\n  - l2\n    - l3\n      - l4\n";
    const first = await open({ markdown: DEEP });
    const hasLeaf = page =>
      page.evaluate(() => {
        let hit = false;
        const walk = n => { if (n) { hit ||= n.getData("text") === "l4"; (n.children ?? []).forEach(walk); } };
        walk(window.inkmap.mindMap.renderer.root);
        return hit;
      });
    assert.equal(await hasLeaf(first.page), false, "deep leaf starts collapsed");

    const branch = await find(first.page, "branch");
    await branch.evaluate(n => n.active());
    await first.page.keyboard.down("Shift");
    await first.page.keyboard.press("Slash");
    await first.page.keyboard.up("Shift");
    await waitFor(() => hasLeaf(first.page), "deep leaf expanded");
    await first.page.evaluate(() => {
      window.inkmap.mindMap.view.setScale(1.4);
      window.inkmap.mindMap.view.translateXY(90, -45);
    });
    await waitFor(() => first.ext.viewState?.view?.scale === 1.4, "view state saved to host");
    const savedOffset = await first.page.evaluate(() => {
      const m = window.inkmap.mindMap;
      const r = m.renderer.root;
      return {
        scale: m.view.scale,
        dx: m.view.x + (r.left + r.width / 2) * m.view.scale - m.width / 2,
        dy: m.view.y + (r.top + r.height / 2) * m.view.scale - m.height / 2,
      };
    });
    assert.deepEqual(first.errors, []);
    await first.page.close();

    const second = await open({ markdown: DEEP, viewState: first.ext.viewState });
    await waitFor(() => hasLeaf(second.page), "reopened with deep leaf still expanded");
    const restoredOffset = await second.page.evaluate(() => {
      const m = window.inkmap.mindMap;
      const r = m.renderer.root;
      return {
        scale: m.view.scale,
        dx: m.view.x + (r.left + r.width / 2) * m.view.scale - m.width / 2,
        dy: m.view.y + (r.top + r.height / 2) * m.view.scale - m.height / 2,
      };
    });
    assert.equal(restoredOffset.scale, 1.4);
    assert.ok(Math.abs(restoredOffset.dx - savedOffset.dx) < 1 && Math.abs(restoredOffset.dy - savedOffset.dy) < 1, "root screen offset restored");
    assert.deepEqual(second.errors, []);
    await second.page.close();
  });

  it("grows the map when the panel is widened", async () => {
    const { page, errors } = await open();
    const svgWidth = () => page.evaluate(() => document.querySelector("#map svg").getBoundingClientRect().width);
    await page.setViewport({ width: 400, height: 700 });
    await waitFor(async () => (await svgWidth()) === 400, "narrow map");
    await page.setViewport({ width: 1300, height: 900 });
    await waitFor(async () => (await svgWidth()) === 1300, "map fills the wider panel");
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

  it("sends the selected node's lines to the chat from a button and the context menu", async () => {
    const { page, ext, errors } = await open({ lang: "en", chat: true });
    const centerOf = node => node.evaluate(n => {
      const r = n.group.node.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    const chatMessages = () => ext.sent.filter(m => m.type === "addToChat");

    const alpha = await find(page, "alpha child");
    const box = await centerOf(alpha);
    await page.mouse.click(box.x, box.y);
    await waitFor(() => page.evaluate(() => !document.querySelector("#chat-add").hidden), "chat button");
    const [button, node] = await page.evaluate(() => [
      document.querySelector("#chat-add").getBoundingClientRect().toJSON(),
      window.inkmap.mindMap.renderer.activeNodeList[0].group.node.getBoundingClientRect().toJSON(),
    ]);
    assert.ok(button.bottom <= node.top && Math.abs(button.right - node.right) < 2, "button sits at the node's top-right corner");
    await page.click("#chat-add");
    await waitFor(() => chatMessages().length === 1, "chat message");
    assert.deepEqual(chatMessages()[0], { type: "addToChat", startLine: 7, endLine: 7 });

    const omega = await centerOf(await find(page, "omega"));
    await page.mouse.click(omega.x, omega.y, { button: "right" });
    await waitFor(() => page.evaluate(() => !document.querySelector("#node-menu").hidden), "node menu");
    await page.click("#menu-add-to-chat");
    await waitFor(() => chatMessages().length === 2, "second chat message");
    assert.deepEqual(chatMessages()[1], { type: "addToChat", startLine: 9, endLine: 9 });
    assert.deepEqual(errors, []);
    await page.close();
  });

  it("sends only the selected part of a node's text, and answers the chat shortcut", async () => {
    const { page, ext, errors } = await open({ lang: "en", chat: true });
    const chatMessages = () => ext.sent.filter(m => m.type === "addToChat");

    // The dot image node is rich Markdown: its text is edited in the source panel.
    const dot = await find(page, "![dot]");
    await dot.evaluate(n => n.active());
    await page.keyboard.down("Control");
    await page.keyboard.press("e");
    await page.keyboard.up("Control");
    await waitFor(() => page.evaluate(() => document.activeElement?.id === "source-text"), "source panel focused");
    await page.evaluate(() => document.querySelector("#source-text").setSelectionRange(2, 5));
    await waitFor(() => page.evaluate(() => !document.querySelector("#chat-add").hidden), "chat button for the selection");
    assert.equal(await page.evaluate(() => document.querySelector("#chat-add kbd").textContent.length > 0), true, "shows the shortcut");
    await page.click("#chat-add");
    await waitFor(() => chatMessages().length === 1, "partial chat message");
    assert.deepEqual(chatMessages()[0], { type: "addToChat", startLine: 8, endLine: 8, text: "dot" });

    // The editor forwards its keybinding as a request; it is answered with the current selection.
    await ext.reply({ type: "requestChat" });
    await waitFor(() => chatMessages().length === 2, "answer to the shortcut");
    assert.deepEqual(chatMessages()[1], { type: "addToChat", startLine: 8, endLine: 8, text: "dot" });

    await page.evaluate(() => {
      document.querySelector("#source-text").setSelectionRange(0, 0);
      window.inkmap.mindMap.execCommand("CLEAR_ACTIVE_NODE");
    });
    await ext.reply({ type: "requestChat" });
    await waitFor(() => chatMessages().length === 3, "answer without a selection");
    assert.deepEqual(chatMessages()[2], { type: "addToChat" }, "nothing selected only opens the chat");
    assert.deepEqual(errors, []);
    await page.close();
  });

  it("offers Add to Chat for text selected while editing a node on the canvas", async () => {
    const { page, ext, errors } = await open({ lang: "en", chat: true });
    const node = await find(page, "omega");
    await node.evaluate(n => n.active());
    await page.keyboard.press("F2");
    await waitFor(() => page.evaluate(() => document.activeElement?.classList.contains("smm-node-edit-wrap")), "text editor");
    await page.evaluate(() => document.execCommand("selectAll"));
    await page.keyboard.press("Home");
    for (let i = 0; i < 3; i++) await page.keyboard.down("Shift"), await page.keyboard.press("ArrowRight"), await page.keyboard.up("Shift");
    await waitFor(
      () =>
        page.evaluate(() => {
          const button = document.querySelector("#chat-add");
          const edit = document.querySelector(".smm-node-edit-wrap");
          const sel = getSelection();
          if (button.hidden || !edit || sel.toString() !== "ome") return false;
          const b = button.getBoundingClientRect();
          const onTop = Number(getComputedStyle(button).zIndex) > Number(getComputedStyle(edit).zIndex);
          const overlaps = r => Math.min(b.right, r.right) > Math.max(b.left, r.left) && Math.min(b.bottom, r.bottom) > Math.max(b.top, r.top);
          const allNodes = [];
          const walk = n => (allNodes.push(n.group.node.getBoundingClientRect()), (n.children ?? []).forEach(walk));
          walk(window.inkmap.mindMap.renderer.root);
          return onTop && !overlaps(edit.getBoundingClientRect()) && allNodes.every(r => !overlaps(r));
        }),
      "chat button placed without covering the edit box or any neighbor node",
    );
    await page.click("#chat-add");
    await waitFor(() => ext.sent.some(m => m.type === "addToChat"), "chat message");
    assert.deepEqual(ext.sent.find(m => m.type === "addToChat"), { type: "addToChat", startLine: 9, endLine: 9, text: "ome" });
    assert.deepEqual(errors, []);
    await page.close();
  });

  it("offers no chat entry points where there is no chat", async () => {
    const { page, errors } = await open({ lang: "en" });
    const alpha = await find(page, "alpha child");
    await alpha.evaluate(n => n.active());
    await sleep(200);
    assert.equal(await page.evaluate(() => document.querySelector("#chat-add").hidden), true);
    assert.equal(await page.evaluate(() => document.querySelector("#menu-add-to-chat").hidden), true);
    assert.equal(await page.$eval("#menu-add-to-chat", button => getComputedStyle(button).display), "none");
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

  it("renders a Mermaid source block under the webview CSP and keeps tall flowcharts readable", async () => {
    const markdown = await readFile(new URL("../../core/test/fixtures/diagrams.md", import.meta.url), "utf8");
    const tall = "\n- Tall flow\n  ```mermaid\n  flowchart TD\n" +
      Array.from({ length: 18 }, (_, i) => `    N${i}{判断步骤 ${i}：是否满足当前课程复习条件？} -->|是| N${i + 1}[执行下一步处理 ${i + 1}]`).join("\n") +
      "\n  ```\n";
    const { page, errors } = await open({ markdown: markdown + tall });
    await page.waitForFunction(() => [...document.querySelectorAll(".ink-diagram-image")].filter(image => image.complete && image.naturalWidth > 0).length === 3);
    const tallInfo = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll(".ink-diagram-image")];
      const img = imgs[2];
      const viewport = img.closest(".ink-diagram-viewport");
      return {
        imgWidth: img.width,
        imgHeight: img.height,
        viewportHeight: viewport.getBoundingClientRect().height,
      };
    });
    assert.ok(tallInfo.imgWidth >= 180, `tall flowchart stays readable instead of shrinking to a thin strip (${tallInfo.imgWidth}px)`);
    assert.ok(tallInfo.viewportHeight <= 640 && tallInfo.imgHeight > tallInfo.viewportHeight, "tall flowchart scrolls inside bounded card");
    await page.click(".ink-diagram-zoom");
    await waitFor(() => page.evaluate(() => !document.querySelector("#diagram-modal").hidden), "diagram zoom modal opened");
    const before = await page.evaluate(() => {
      const world = document.querySelector("#diagram-modal-world");
      return { transform: world.style.transform, zoom: document.querySelector("#diagram-zoom-level").textContent };
    });
    await page.$eval("#diagram-modal-stage", (stage) => {
      stage.dispatchEvent(new WheelEvent("wheel", { deltaY: -80, ctrlKey: true, clientX: 400, clientY: 300, bubbles: true, cancelable: true }));
    });
    const afterZoom = await page.evaluate(() => ({
      transform: document.querySelector("#diagram-modal-world").style.transform,
      zoom: document.querySelector("#diagram-zoom-level").textContent,
    }));
    assert.notEqual(afterZoom.zoom, before.zoom, "pinch/ctrl-wheel zooms the diagram viewer");
    assert.notEqual(afterZoom.transform, before.transform, "zoom updates the canvas transform");
    await page.$eval("#diagram-modal-stage", (stage) => {
      stage.dispatchEvent(new WheelEvent("wheel", { deltaX: 40, deltaY: 60, bubbles: true, cancelable: true }));
    });
    const afterPan = await page.evaluate(() => document.querySelector("#diagram-modal-world").style.transform);
    assert.notEqual(afterPan, afterZoom.transform, "two-finger scroll pans the diagram viewer");
    await page.keyboard.press("Escape");
    await waitFor(() => page.evaluate(() => document.querySelector("#diagram-modal").hidden), "diagram zoom modal closed");
    assert.deepEqual(errors, []);
    await page.close();
  });

  it("unlocks an expired trial on sign-in to a paid account, then exports and presents", async () => {
    const { page, ext, errors } = await open({
      lang: "en",
      expired: true,
      // Webviews refuse fullscreen, so presentation has to run inside the panel.
      beforeLoad: () => (Element.prototype.requestFullscreen = () => Promise.reject(new Error("denied"))),
    });
    await page.waitForSelector("#trial-expired-message:not([hidden])");
    assert.equal(await page.$eval("#map", el => el.inert), true);
    await page.click("#pro");
    await page.waitForSelector("#account-panel", { visible: true });
    assert.equal(await page.$eval("#account-badge", el => el.textContent), "Trial ended");
    assert.equal(await page.$eval("#account-text", el => el.textContent), "Signed out");
    assert.equal(ext.files.length, 0);
    await page.click("#account-sign-in");
    await page.type("#sign-in-phone", "+86 13800008000");
    await page.click("#send-phone-code");
    await page.waitForSelector("#phone-sign-in-status:not([hidden])");
    assert.equal(await page.$eval("#send-phone-code", el => el.disabled), true);
    assert.equal(ext.sent.find(msg => msg.type === "sendPhoneCode").phone, "13800008000");
    await page.type("#sign-in-code", "000000");
    await page.waitForSelector("#phone-sign-in-status[data-state=error]:not([hidden])");
    await page.type("#sign-in-code", "123456");
    await waitFor(() => page.$eval("html", el => el.classList.contains("pro-member")), "pro unlocked automatically on 6th digit");
    assert.equal(await page.$eval("#upgrade", el => el.hidden), true, "the editor unlocks without a second action");
    assert.equal(await page.$eval("#account-badge", el => el.textContent), "PRO");
    assert.equal(await page.$eval("#account-text", el => el.textContent), "138****8000");
    assert.equal(await page.$eval("#account-buy", el => el.hidden), true);
    assert.equal(ext.sent.some(msg => msg.type === "checkout"), false);
    assert.equal(await page.$(".phone-sign-in"), null);
    assert.equal(await page.$("#ad"), null);
    await page.keyboard.press("Escape");

    await page.click("#export");
    await page.click('[data-export="png"]');
    await waitFor(() => ext.files.length === 1, "file saved");
    assert.equal(ext.files[0].name, "Demo.png", "named after the document title");
    assert.match(ext.files[0].dataUrl, /^data:image\/png;base64,/);

    await page.click("#present");
    await waitFor(() => page.evaluate(() => window.inkmap.mindMap.demonstrate.isInDemonstrate), "presenting in panel");
    await sleep(600);
    await page.keyboard.press("Escape");
    await waitFor(() => page.$eval("html", el => !el.classList.contains("presenting")), "presentation ended");
    assert.equal(ext.sent.filter(m => m.type === "save").length, 0, "presenting does not save");

    await page.click("#pro");
    await page.waitForSelector("#account-panel", { visible: true });
    await page.click("#sign-out");
    await waitFor(() => page.$eval("html", el => el.classList.contains("trial-expired")), "re-locked after signing out on expired trial");
    assert.ok(ext.sent.some(m => m.type === "signOut"));
    assert.deepEqual(errors, []);
    await page.close();
  });

  it("strictly separates Domestic (zh, ¥29.9 QR) and Overseas (en, $15 Card) editions by timezone or language", async () => {
    // 1. English language + Asia/Shanghai timezone => Domestic edition (zh-CN, ¥29.9, WeChat QR, zero $15)
    const dom = await open({ lang: "en", timezone: "Asia/Shanghai", paidOnSignIn: false });
    assert.equal(await dom.page.$eval("html", el => el.lang), "zh-CN");
    assert.equal(await dom.page.$(".language-select"), null, "manual language switcher removed");
    await dom.page.click("#pro");
    await dom.page.waitForSelector("#account-panel", { visible: true });
    assert.equal(await dom.page.$eval("#account-buy", el => el.textContent), "立即开通 Pro（¥29.9）");
    assert.equal(await dom.page.$eval("#account-sign-in", el => el.textContent), "已购买？登录同步");
    assert.equal(await dom.page.$("#account-web-links"), null, "no redundant browser links in Category 1");
    const domText = await dom.page.evaluate(() => document.body.innerText);
    assert.doesNotMatch(domText, /\$15|US\$15|29\.90/, "domestic UI never exposes overseas $15 or 29.90");
    await dom.page.click("#account-buy");
    await dom.page.waitForSelector("#account-panel .wechat-pay", { visible: true });
    assert.equal(await dom.page.$eval("#wechat-pay-amount", el => el.textContent), "¥29.9");
    assert.equal(await dom.page.$eval("#wechat-pay-stage", el => el.hidden), false);
    assert.equal(await dom.page.$eval("#card-pay-stage", el => el.hidden), true);
    assert.deepEqual(dom.errors, []);
    await dom.page.close();

    // 2. English language + UTC timezone => Overseas edition (en, $15, Card Checkout, zero ¥29.9)
    const intl = await open({ lang: "en", timezone: "UTC", paidOnSignIn: false });
    assert.equal(await intl.page.$eval("html", el => el.lang), "en");
    await intl.page.click("#pro");
    await intl.page.waitForSelector("#account-panel", { visible: true });
    assert.equal(await intl.page.$eval("#account-buy", el => el.textContent), "Buy Pro ($15)");
    assert.equal(await intl.page.$eval("#account-sign-in", el => el.textContent), "Already bought? Sign in");
    const intlText = await intl.page.evaluate(() => document.body.innerText);
    assert.doesNotMatch(intlText, /¥|29\.9|WeChat/i, "overseas UI never exposes RMB or WeChat Pay");
    await intl.page.click("#account-buy");
    await intl.page.waitForSelector("#account-panel .wechat-pay", { visible: true });
    assert.equal(await intl.page.$eval("#wechat-pay-amount", el => el.textContent), "$15");
    assert.equal(await intl.page.$eval("#wechat-pay-stage", el => el.hidden), true);
    assert.equal(await intl.page.$eval("#card-pay-stage", el => el.hidden), false);
    assert.deepEqual(intl.errors, []);
    await intl.page.close();
  });

  it("lets a trial user sign in without enabling Pro and view inline Domestic QR payment", async () => {
    const { page, ext, errors } = await open({ paidOnSignIn: false });
    await page.setViewport({ width: 360, height: 620 });
    await page.focus("#pro");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#account-panel", { visible: true });
    assert.ok(await page.$eval("#account-panel", el => {
      const { left, right } = el.getBoundingClientRect();
      return left >= 0 && right <= innerWidth;
    }), "the account panel fits a narrow sidebar");
    await page.keyboard.press("Escape");
    assert.equal(await page.$eval("#pro", el => el.getAttribute("aria-expanded")), "false");
    assert.equal(await page.evaluate(() => document.activeElement.id), "pro");
    await page.click("#pro");
    assert.equal(await page.$eval("#account-sign-in", el => el.textContent), "已购买？登录同步");
    await page.click("#account-sign-in");
    await page.type("#sign-in-phone", "13800008000");
    await page.type("#sign-in-code", "123456");
    await waitFor(() => page.$eval("#account-sign-in", el => el.hidden), "connected trial user");
    assert.equal(ext.sent.some(msg => msg.type === "checkout"), false);
    assert.equal(await page.$eval("#account-text", el => el.textContent), "138****8000");
    assert.equal(await page.$eval("#account-heading", el => el.textContent), "已登录");
    assert.equal(await page.$eval("html", el => el.classList.contains("pro-member")), false);
    assert.equal(await page.$eval("#account-plan-status", el => el.hidden), false, "shows current trial status card inside account panel");
    assert.equal(await page.$eval("#account-perks", el => el.hidden), false, "shows Pro perks directly in the account panel");
    assert.equal(await page.$$eval("#account-perks .account-perks-list li", els => els.length), 7, "displays 7 rich Pro perks");
    const perksText = await page.$eval("#account-perks", el => el.textContent);
    for (const platform of ["Cursor", "VS Code", "DeepSeek", "Qoder", "WorkBuddy", "Claude", "Codex", "Antigravity", "Trae"]) {
      assert.ok(perksText.includes(platform), `perks list includes ${platform}`);
    }
    assert.equal(await page.$eval("#switch-account", el => el.hidden), false, "shows switch account button when signed in");
    await page.click("#account-buy");
    await page.waitForSelector("#account-panel .wechat-pay", { visible: true });
    assert.equal(await page.$eval("#wechat-pay-amount", el => el.textContent), "¥29.9");
    assert.match(await page.$eval("#wechat-pay-account", el => el.textContent), /138\*\*\*\*8000/);
    assert.match(await page.$eval("#wechat-pay-qr", el => el.getAttribute("src")), /^data:image\/png;base64,/);
    assert.deepEqual(errors, []);
    await page.close();
  });
});
