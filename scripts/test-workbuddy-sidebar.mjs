import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import puppeteer from "puppeteer-core";

test("WorkBuddy page imports a Markdown copy and exports the edited Markdown", async t => {
  const root = resolve("dist/sidebars/workbuddy");
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.pages[0].id, "inkmap");
  const dir = await mkdtemp(join(tmpdir(), "inkmap-workbuddy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "notes.markmap.md");
  const original = "# Notes\n\n- Before\n";
  await writeFile(file, original);
  const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/") {
        res.setHeader("Content-Type", "text/html");
        return res.end('<!doctype html><iframe src="/index.html" sandbox="allow-scripts allow-same-origin allow-downloads" width="520" height="740"></iframe>');
      }
      const path = resolve(root, "." + url.pathname);
      if (!path.startsWith(root + sep)) throw Error("outside package");
      res.setHeader("Content-Type", mime[extname(path)] ?? "application/octet-stream");
      res.end(await readFile(path));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(ok => server.listen(0, "127.0.0.1", ok));
  t.after(() => new Promise(ok => server.close(ok)));
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true, args: ["--no-first-run"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const downloads = join(dir, "downloads");
  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const frame = await (await page.waitForSelector("iframe")).contentFrame();
  await frame.waitForSelector('input[type="file"]', { hidden: true });
  const input = await frame.$('input[type="file"]');
  assert.ok(input);
  await input.uploadFile(file);
  await frame.waitForSelector("#buddy-download-markdown");
  await frame.evaluate(() => {
    const { mindMap } = window.inkmap;
    mindMap.renderer.setNodeDataRender(mindMap.renderer.root.children[0], { md: "Edited copy", text: "Edited copy", rich: false });
  });
  await frame.waitForFunction(() => window.inkmap.currentMarkdown().includes("Edited copy"));
  await frame.click("#buddy-download-markdown");
  let md;
  for (let i = 0; i < 30 && md === undefined; i++) {
    md = await readFile(join(downloads, "notes.markmap.md"), "utf8").catch(() => undefined);
    if (md === undefined) await new Promise(ok => setTimeout(ok, 75));
  }
  assert.match(md ?? "", /Edited copy/);
  assert.equal(await readFile(file, "utf8"), original);
  await page.close();
});
