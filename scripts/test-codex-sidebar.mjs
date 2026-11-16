import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import puppeteer from "puppeteer-core";

test("packaged Codex app opens the host file, edits Mermaid Markdown, and handles a stale ETag", async t => {
  const dir = await mkdtemp(join(tmpdir(), "inkmap-codex-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync("unzip", ["-q", "dist/sidebars/inkmap-codex-desktop.zip", "-d", dir]);
  const file = join(dir, "notes.markmap.md");
  const initial = "# Notes\n\n- Before\n- Diagram\n\n  ```mermaid\n  graph TD\n    A[Start] --> B[End]\n  ```\n";
  await writeFile(file, initial);
  let etag = 1;
  let forceConflict = false;
  const uri = "host-resource://test-markdown";
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(dir, "inkmap-codex-desktop", "inkmap-codex", "server.cjs")], env: { ...process.env, INKMAP_HOME: dir } });
  const client = new Client({ name: "inkmap-test-host", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  const tools = (await client.listTools()).tools;
  const entry = tools.find(tool => tool.name === "inkmap_open_markdown");
  assert.deepEqual(entry._meta["openai/ui"].entrypoints, [{ type: "file", extensions: [".md"] }]);
  assert.ok(!tools.some(tool => /buy|checkout/i.test(tool.name)));
  const resource = await client.readResource({ uri: entry._meta.ui.resourceUri });
  const html = resource.contents[0].text;
  assert.ok(html?.startsWith("<!doctype html>"));
  const host = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html;charset=utf-8");
    res.end(req.url === "/app" ? html : "<!doctype html><body></body>");
  });
  await new Promise(ok => host.listen(0, "127.0.0.1", ok));
  t.after(() => new Promise(ok => host.close(ok)));
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--no-first-run", "--lang=en-US"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${host.address().port}/`);
  await page.exposeFunction("fileRequest", async (method, params) => {
    if (method === "tools/call") return client.callTool(params);
    assert.equal(params.uri, uri);
    if (method === "resources/read") return {
      contents: [{ uri, text: await readFile(file, "utf8"), _meta: { "openai/resource": { writable: true, etag: String(etag) } } }],
    };
    if (method === "openai/resources/write") {
      if (forceConflict) {
        await writeFile(file, initial.replace("Before", "Changed outside"));
        etag++;
        forceConflict = false;
      }
      if (String(etag) !== params.ifMatch) return { outcome: "conflict", etag: String(etag) };
      await writeFile(file, params.text);
      return { outcome: "saved", etag: String(++etag) };
    }
    assert.ok(["resources/subscribe", "resources/unsubscribe"].includes(method));
    return {};
  });
  await page.evaluate(uri => {
    const frame = document.createElement("iframe");
    frame.src = "/app";
    frame.width = "540";
    frame.height = "720";
    window.addEventListener("message", async event => {
      if (event.source !== frame.contentWindow || event.data?.jsonrpc !== "2.0") return;
      const { id, method, params } = event.data;
      const send = message => frame.contentWindow.postMessage({ jsonrpc: "2.0", ...message }, location.origin);
      if (method === "ui/initialize") {
        send({ id, result: { protocolVersion: params.protocolVersion, hostInfo: { name: "test", version: "1" }, hostCapabilities: { experimental: { "openai/resource": {} } }, hostContext: {} } });
      } else if (method === "ui/notifications/initialized") {
        send({ method: "ui/notifications/tool-input", params: { arguments: { file: { name: "notes.markmap.md", resourceUri: uri } } } });
      } else if (id !== undefined) {
        try { send({ id, result: await window.fileRequest(method, params) }); }
        catch (e) { send({ id, error: { code: -32603, message: String(e) } }); }
      }
    });
    document.body.append(frame);
  }, uri);
  const frame = await (await page.waitForSelector("iframe")).contentFrame();
  await frame.waitForFunction(() => window.inkmap?.mindMap.renderer.root);
  await frame.click("#pro");
  await frame.waitForSelector("#account-panel", { visible: true });
  assert.equal(await frame.$eval("#account-buy", button => button.hidden), true);
  assert.match(await frame.$eval("#account-sign-in", button => button.textContent), /^(Sign in|登录)$/);
  await frame.click("#pro");
  await frame.waitForSelector(".ink-diagram-image");
  const rename = label => frame.evaluate(label => {
    const { mindMap } = window.inkmap;
    mindMap.renderer.setNodeDataRender(mindMap.renderer.root.children[0], { md: label, text: label, rich: false });
  }, label);
  await rename("Saved from map");
  await frame.waitForFunction(async () => (await parent.fileRequest("resources/read", { uri: "host-resource://test-markdown" })).contents[0].text.includes("Saved from map"));
  const saved = await readFile(file, "utf8");
  assert.match(saved, /Saved from map/);
  assert.match(saved, /A\[Start\] --> B\[End\]/);
  await frame.click(".ink-diagram-edit");
  await frame.$eval("#source-text", input => {
    input.value = input.value.replace("B[End]", "B[Saved Mermaid]");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await frame.waitForFunction(async uri => {
    const { contents } = await parent.fileRequest("resources/read", { uri });
    return contents[0].text.includes("B[Saved Mermaid]");
  }, {}, uri);
  forceConflict = true;
  await rename("Conflicting edit");
  await frame.waitForFunction(() => window.inkmap.currentMarkdown().includes("Changed outside") && !document.querySelector("#toast").hidden);
  assert.doesNotMatch(await readFile(file, "utf8"), /Conflicting edit/);
  assert.deepEqual(errors, []);
  await page.close();
});
