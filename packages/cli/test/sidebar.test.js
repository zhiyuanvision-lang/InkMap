import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { fileSource, serve } from "../dist/server.js";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WEB = fileURLToPath(new URL("../dist/web/", import.meta.url));
const original = "# Notes\n\n- Before\n";
const license = { state: async () => ({ pro: true }), onChange: () => () => {} };

async function setup(t, markdown = original, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "inkmap-sidebar-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "notes.markmap.md");
  await writeFile(file, markdown);
  const editor = await serve({ source: await fileSource(file), webRoot: WEB, port: 0, sidebar: true, license, ...options });
  t.after(() => editor.close());
  return { file, url: editor.url };
}

test("loopback sidebar isolates its URL and rejects stale writes before the watcher fires", async t => {
  const { file, url } = await setup(t);
  const origin = new URL(url).origin;
  const api = url + "api/doc";
  const initial = await (await fetch(api)).json();
  assert.equal((await fetch(origin + "/api/doc")).status, 404);
  const save = (body, requestOrigin = origin) => fetch(api, {
    method: "PUT", headers: { origin: requestOrigin, "content-type": "application/json" },
    body: JSON.stringify({ md: body, baseVersion: initial.version }),
  });
  assert.equal((await save("intruder", "https://example.com")).status, 403);
  const external = original.replace("Before", "External");
  await writeFile(file, external);
  const conflict = await save("stale");
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).md, external);
  assert.equal(await readFile(file, "utf8"), external);
  assert.equal((await fetch(url + "api/checkout", {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: '{"mode":"buy"}',
  })).status, 403);
});

test("a purchase-enabled sidebar uses the shared checkout", async t => {
  const checkout = "https://billing.example.com/billing/checkout/" + "0".repeat(32);
  const { url } = await setup(t, original, {
    sidebarPurchase: true,
    license: { ...license, connect: async mode => {
      assert.equal(mode, "buy");
      return checkout;
    } },
  });
  const capabilities = await fetch(url + "api/capabilities");
  assert.deepEqual(await capabilities.json(), { purchase: true });
  const response = await fetch(url + "api/checkout", {
    method: "POST",
    headers: { origin: new URL(url).origin, "content-type": "application/json" },
    body: '{"mode":"buy"}',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: checkout });
});

test("an embedded loopback sidebar can edit and update the original Markdown", { skip: !existsSync(CHROME) }, async t => {
  const { file, url } = await setup(t);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<iframe sandbox="allow-scripts allow-forms allow-same-origin" src="${url}" width="530" height="700"></iframe>`);
  const frame = await (await page.$("iframe")).contentFrame();
  await frame.waitForFunction(() => window.inkmap?.mindMap.renderer.root);
  assert.equal(await frame.$eval("#buy-pro", el => el.hidden), true);
  await frame.evaluate(() => {
    const { mindMap } = window.inkmap;
    mindMap.renderer.setNodeDataRender(mindMap.renderer.root.children[0], { md: "From sidebar", text: "From sidebar", rich: false });
  });
  await frame.waitForFunction(async () => (await (await fetch("./api/doc")).json()).md.includes("From sidebar"));
  assert.match(await readFile(file, "utf8"), /From sidebar/);
});
