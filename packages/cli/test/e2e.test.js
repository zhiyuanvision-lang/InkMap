import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { generateLicenseKeys, issueLicense } from "@inkmap/core";
import { licenseService } from "../dist/license.js";
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

  async function open(name, content, options = {}) {
    const file = join(dir, name);
    await writeFile(file, content);
    const served = await serve({ source: await fileSource(file), webRoot: WEB_ROOT, port: 0, ...options });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(served.url);
    await page.waitForFunction(() => window.inkmap?.mindMap);
    return { file, page, errors, close: async () => (await page.close(), await served.close()) };
  }

  async function withDoc(name, content, fn, options) {
    const t = await open(name, content, options);
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

  it("expands every descendant of the selected node", async () => {
    const DEEP = "## Root\n\n- a\n  - b\n    - c\n      - d\n        - e\n- x\n  - y\n    - z\n      - w\n";
    await withDoc("deep.md", DEEP, async t => {
      const shown = text =>
        t.page.evaluate(text => {
          let hit = false;
          const walk = n => ((hit ||= n.getData("text") === text), (n.children ?? []).forEach(walk));
          walk(window.inkmap.mindMap.renderer.root);
          return hit;
        }, text);
      assert.equal(await shown("d"), false, "deep levels start folded");

      assert.ok(await activate(t.page, "a"));
      await t.page.keyboard.down("Shift");
      await t.page.keyboard.press("Slash");
      await t.page.keyboard.up("Shift");
      await waitFor(() => shown("e"), "subtree expanded by ⇧/");
      assert.equal(await shown("w"), false, "other branches stay folded");
      assert.equal(await t.page.evaluate(() => !!document.querySelector(".smm-node-edit-wrap:focus")), false, "⇧/ does not start text editing");

      const box = await t.page.evaluate(() => {
        let x;
        const walk = n => (n.getData("text") === "x" && (x = n), (n.children ?? []).forEach(walk));
        walk(window.inkmap.mindMap.renderer.root);
        const r = x.group.node.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await t.page.mouse.click(box.x, box.y, { button: "right" });
      await t.page.waitForSelector("#node-menu:not([hidden])");
      await t.page.click("#menu-expand-subtree");
      await waitFor(() => shown("w"), "subtree expanded from the context menu");
      assert.ok(await t.page.$("#node-menu[hidden]"));

      await sleep(600);
      assert.equal(await readFile(t.file, "utf8"), DEEP, "expanding does not touch the file");
      assert.deepEqual(t.errors, []);
    });
  });

  it("shows ads and keeps Pro features locked in the free edition", async () => {
    await withDoc("free.md", SIMPLE, async t => {
      await t.page.waitForSelector("#ad:not([hidden])", { timeout: 5000 });
      assert.equal(await t.page.$eval("html", el => el.classList.contains("pro")), false);

      await t.page.click("#export");
      await t.page.waitForSelector("#upgrade:not([hidden])");
      assert.ok((await t.page.$eval(".upgrade-locked", el => el.textContent)).length > 0);
      await t.page.keyboard.press("Escape");
      await t.page.waitForSelector("#upgrade[hidden]");

      await t.page.select("#layout-select", "organizationStructure");
      await t.page.waitForSelector("#upgrade:not([hidden])");
      assert.equal(await t.page.$eval("#layout-select", el => el.value), "logicalStructure", "locked layout is not applied");
      await t.page.keyboard.press("Escape");
      await sleep(600);
      assert.equal(await readFile(t.file, "utf8"), SIMPLE);

      await t.page.select("#layout-select", "mindMap");
      await waitFor(async () => (await readFile(t.file, "utf8")).startsWith("---\ntitle: Demo\ninkmap:\n  layout: mindMap\n---\n"), "free layout saved");
      assert.deepEqual(t.errors, []);
    });
  });

  it("unlocks Pro with a license code", async () => {
    const keys = await generateLicenseKeys();
    let stored;
    const license = licenseService({ read: async () => stored, write: async c => void (stored = c) }, keys.publicKey);
    const code = await issueLicense(keys.privateKey);
    await withDoc(
      "pro.md",
      SIMPLE,
      async t => {
        const read = () => readFile(t.file, "utf8");
        await t.page.click("#pro");
        await t.page.waitForSelector("#upgrade:not([hidden])");
        await t.page.type("#code-input", "INK1-wrong");
        await t.page.click("#activate-form button[type=submit]");
        await waitFor(() => t.page.$eval("#activate-msg", el => el.dataset.state === "error"), "rejects a bad code");
        await t.page.$eval("#code-input", el => (el.value = ""));
        await t.page.type("#code-input", code);
        await t.page.click("#activate-form button[type=submit]");
        await waitFor(() => t.page.$eval("html", el => el.classList.contains("pro")), "pro unlocked");
        assert.equal(stored, code);
        assert.ok(await t.page.$("#ad[hidden]"), "ads are hidden");
        await t.page.keyboard.press("Escape");

        await t.page.select("#layout-select", "timeline");
        await waitFor(async () => (await read()).includes("inkmap:\n  layout: timeline\n"), "layout saved");
        await t.page.select("#theme-select", "dusk");
        await waitFor(async () => (await read()).includes("  layout: timeline\n  theme: dusk\n"), "theme saved");
        assert.ok(await t.page.$eval("html", el => el.classList.contains("dark")));

        const png = await t.page.evaluate(() => window.inkmap.mindMap.export("png", false, "x"));
        assert.match(png, /^data:image\/png;base64,/);
        assert.ok(png.length > 5000);
        const svg = await t.page.evaluate(async () => atob((await window.inkmap.mindMap.export("svg", false, "x")).split(",")[1]));
        assert.match(svg, /\.ink-node/);
        assert.match(svg, /<table/);

        await t.page.click("#find");
        await t.page.waitForSelector("#search:not([hidden])");
        await t.page.$eval("#find-input", el => (el.value = ""));
        await t.page.type("#find-input", "alpha");
        await waitFor(() => t.page.$eval("#find-count", el => el.textContent === "1/2"), "two matches");
        await t.page.type("#replace-input", "Beta");
        await t.page.click("#replace-all");
        await waitFor(async () => (await read()).includes("- Beta\n  - Beta child\n"), "replace all saved");
        await t.page.keyboard.press("Escape");

        const before = await read();
        await t.page.click("#present");
        await waitFor(() => t.page.$eval("html", el => el.classList.contains("presenting")), "presentation started");
        await sleep(800);
        await t.page.keyboard.press("ArrowRight");
        await sleep(300);
        await t.page.keyboard.press("Escape");
        await waitFor(() => t.page.$eval("html", el => !el.classList.contains("presenting")), "presentation ended");
        await sleep(600);
        assert.equal(await read(), before, "presenting does not change the file");
        assert.deepEqual(t.errors, []);
      },
      { license },
    );
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
