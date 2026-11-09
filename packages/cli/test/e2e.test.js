import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { fileSource, serve } from "../dist/server.js";

const WEB_ROOT = fileURLToPath(new URL("../dist/web/", import.meta.url));

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FIXTURE = new URL("../../core/test/fixtures/logic-design.md", import.meta.url);
const SIMPLE = `---
title: Demo
---

## Root

- alpha
  - alpha child
- | a | b |
  | --- | --- |
  | 1 | 2 |
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

describe("inkmap editor", { skip: !existsSync(CHROME) && "Chrome not found" }, () => {
  let dir, browser;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "inkmap-e2e-"));
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  });
  after(async () => {
    await browser?.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function open(name, content) {
    const file = join(dir, name);
    await writeFile(file, content);
    const served = await serve({ source: await fileSource(file), webRoot: WEB_ROOT, port: 0 });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(served.url);
    await page.waitForFunction(() => window.inkmap?.mindMap);
    return { file, page, errors, close: async () => (await page.close(), await served.close()) };
  }

  async function withDoc(name, content, fn) {
    const t = await open(name, content);
    try {
      await fn(t);
    } finally {
      await t.close();
    }
  }

  const editorFocused = page =>
    waitFor(() => page.evaluate(() => document.activeElement?.classList.contains("smm-node-edit-wrap")), "text editor");

  const activate = (page, text) =>
    page.evaluate(text => {
      const { mindMap } = window.inkmap;
      let hit;
      const walk = n => {
        if (!hit && String(n.getData("md") ?? n.getData("text")).startsWith(text)) hit = n;
        (n.children ?? []).forEach(walk);
      };
      walk(mindMap.renderer.root);
      mindMap.execCommand("CLEAR_ACTIVE_NODE");
      hit.active();
      return !!hit;
    }, text);

  it("opens a real document without rewriting it", async () => {
    const original = await readFile(FIXTURE, "utf8");
    await withDoc("logic.md", original, async t => {
      await sleep(1200);
      assert.equal(await readFile(t.file, "utf8"), original);
      assert.equal(await t.page.evaluate(() => window.inkmap.currentMarkdown()), original);
      assert.deepEqual(t.errors, []);
    });
  });

  it("writes keyboard edits back and follows external changes", async () => {
    await withDoc("simple.md", SIMPLE, async t => {
      const read = () => readFile(t.file, "utf8");

      assert.ok(await activate(t.page, "alpha child"));
      await t.page.keyboard.press("Enter"); // sibling, opens the text editor
      await editorFocused(t.page);
      await t.page.keyboard.type("beta");
      await t.page.keyboard.press("Enter"); // finish editing
      await waitFor(async () => (await read()).includes("  - alpha child\n  - beta\n"), "sibling written");

      assert.ok(await activate(t.page, "omega"));
      await t.page.keyboard.press("Tab"); // child
      await editorFocused(t.page);
      await t.page.keyboard.type("**bold** idea");
      await t.page.keyboard.press("Enter");
      await waitFor(async () => (await read()).includes("- omega\n  - **bold** idea\n"), "child written");
      const rich = await t.page.evaluate(() => {
        let found;
        const walk = n => (n.getData("md") === "**bold** idea" && (found = n), (n.children ?? []).forEach(walk));
        walk(window.inkmap.mindMap.renderer.root);
        return found?.getData("rich") && !!found.group.node.querySelector(".ink-node strong");
    });
    assert.ok(rich, "markdown typed on the canvas is rendered");

    await t.page.evaluate(() => window.inkmap.mindMap.execCommand("BACK"));
    await waitFor(async () => !(await read()).includes("**bold** idea"), "undo written");

    const external = (await read()).replace("- omega\n", "- omega\n- from editor\n");
    await writeFile(t.file, external);
    await waitFor(() => t.page.evaluate(() => window.inkmap.currentMarkdown().includes("- from editor")), "external change shown");
    await sleep(600);
    assert.equal(await read(), external, "external change is not echoed back");
    assert.deepEqual(t.errors, []);
    });
  });

  it("edits rich nodes through the source panel", async () => {
    await withDoc("table.md", SIMPLE, async t => {
      assert.ok(await activate(t.page, "| a | b |"));
      await t.page.evaluate(() => window.inkmap.mindMap.keyCommand.shortcutMap["Control+e"].forEach(f => f()));
      await t.page.waitForSelector("#source:not([hidden])");
      assert.equal(await t.page.$eval("#source-text", el => el.value), "| a | b |\n| --- | --- |\n| 1 | 2 |");
      await t.page.focus("#source-text");
      await t.page.keyboard.press("End");
      await t.page.keyboard.type("\n| 3 | 4 |");
      await waitFor(async () => (await readFile(t.file, "utf8")).includes("  | 1 | 2 |\n  | 3 | 4 |\n- omega"), "table row written");
      assert.deepEqual(t.errors, []);
    });
  });
});
