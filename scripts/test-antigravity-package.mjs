import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import puppeteer from "puppeteer-core";
import { CHROME, manifestVersion, NEEDS_CHROME, SIDEBARS } from "./lib/test-env.mjs";

test("packaged Antigravity MCP App opens workspace Markdown, writes edits back, switches files on AI tool calls, and attaches chat context", NEEDS_CHROME, async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "inkmap-antigravity-mcp-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const savedEnv = { INKMAP_NO_OPEN: process.env.INKMAP_NO_OPEN, INKMAP_HOME: process.env.INKMAP_HOME };
  t.after(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const version = manifestVersion("packages/antigravity/plugin.json");
  execFileSync("unzip", ["-q", join(SIDEBARS, `inkmap-antigravity-${version}.zip`), "-d", dir]);
  const pluginRoot = join(dir, `inkmap-antigravity-${version}`, "inkmap");

  const pluginManifest = JSON.parse(await readFile(join(pluginRoot, "plugin.json"), "utf8"));
  assert.equal(pluginManifest.name, "inkmap");
  assert.equal(pluginManifest.version, version);
  assert.equal(pluginManifest.logo, "assets/logo.svg");

  const mcpConfig = JSON.parse(await readFile(join(pluginRoot, "mcp_config.json"), "utf8"));
  assert.deepEqual(mcpConfig.mcpServers.inkmap, {
    command: "node",
    args: ["${PLUGIN_ROOT}/server.cjs"],
  });

  const skill = await readFile(join(pluginRoot, "skills", "inkmap", "SKILL.md"), "utf8");
  assert.match(skill, /inkmap_open/);
  const rule = await readFile(join(pluginRoot, "rules", "AGENTS.md"), "utf8");
  assert.match(rule, /sidecar:\/\/inkmap\/inkmap\//);

  const workspace = join(dir, "workspace");
  const firstFile = join(workspace, "design.markmap.md");
  const secondFile = join(workspace, "roadmap.md");
  const outsideFile = join(dir, "outside.md");
  const symlinkFile = join(workspace, "link.md");

  await mkdir(workspace, { recursive: true });
  await writeFile(firstFile, "# Architecture\n\n- Core Engine\n- Flow\n\n  ```mermaid\n  graph TD\n    A[Input] --> B[Output]\n  ```\n", "utf8");
  await writeFile(secondFile, "# Roadmap\n\n- Milestone 1\n", "utf8");
  await writeFile(outsideFile, "# Secret\n", "utf8");
  await symlink(outsideFile, symlinkFile);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(pluginRoot, "server.cjs")],
    env: {
      ...process.env,
      INKMAP_HOME: join(dir, "inkmap-home"),
      ANTIGRAVITY_CONFIG_DIR: join(dir, "gemini-config"),
      INKMAP_WORKSPACES: workspace,
      INKMAP_NO_OPEN: "1",
    },
  });
  const client = new Client({ name: "antigravity-test-host", version: "2.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const { tools } = await client.listTools();
  const openTool = tools.find(tool => tool.name === "inkmap_open");
  assert.ok(openTool, "Missing inkmap_open MCP App tool");
  assert.equal(openTool._meta?.ui?.resourceUri, "ui://inkmap/markdown.html");
  assert.deepEqual(openTool._meta?.["com.google.antigravity/ui"]?.entrypoints, [
    { type: "aux_pane", title: "Inkmap" },
    { type: "global", title: "Inkmap" },
  ]);
  assert.ok(!tools.some(tool => /buy|checkout/i.test(tool.name)));

  // Security: app-only open rejects outside files and symlinks
  const blockedOutside = await client.callTool({ name: "inkmap_doc_open", arguments: { path: outsideFile } });
  assert.equal(blockedOutside.isError, true);
  const blockedSymlink = await client.callTool({ name: "inkmap_doc_open", arguments: { path: symlinkFile } });
  assert.equal(blockedSymlink.isError, true);

  const openResult = await client.callTool({ name: "inkmap_open", arguments: { path: firstFile, workspace } });
  assert.equal(openResult.isError, undefined);
  assert.equal(openResult.structuredContent.currentFile, firstFile);

  const resource = await client.readResource({ uri: "ui://inkmap/markdown.html" });
  assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
  const html = resource.contents[0].text;
  assert.ok(html?.startsWith("<!doctype html>"));

  const hostServer = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html;charset=utf-8");
    res.end(req.url === "/app" ? html : "<!doctype html><body></body>");
  });
  await new Promise(ok => hostServer.listen(0, "127.0.0.1", ok));
  t.after(() => new Promise(ok => hostServer.close(ok)));

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-first-run"],
  });
  t.after(() => browser.close());

  const page = await browser.newPage();
  const errors = [];
  const contextUpdates = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${hostServer.address().port}/`);

  await page.exposeFunction("mcpHostCall", async (method, params) => {
    if (method === "tools/call") return client.callTool(params);
    if (method === "ui/update-model-context") {
      contextUpdates.push(params);
      return {};
    }
    if (method === "com.google.antigravity/toggle-aux-pane") {
      return { isError: false };
    }
    return {};
  });

  await page.evaluate(({ initialInput, initialResult }) => {
    const frame = document.createElement("iframe");
    frame.src = "/app";
    frame.width = "720";
    frame.height = "680";
    window.__pushToolResult = (args, result) => {
      frame.contentWindow.postMessage({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: args },
      }, location.origin);
      frame.contentWindow.postMessage({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: result,
      }, location.origin);
    };
    window.addEventListener("message", async event => {
      if (event.source !== frame.contentWindow || event.data?.jsonrpc !== "2.0") return;
      const { id, method, params } = event.data;
      const send = msg => frame.contentWindow.postMessage({ jsonrpc: "2.0", ...msg }, location.origin);
      if (method === "ui/initialize") {
        send({
          id,
          result: {
            protocolVersion: params.protocolVersion,
            hostInfo: { name: "antigravity", version: "2.0.0" },
            hostCapabilities: { serverTools: {}, updateModelContext: {}, openLinks: {} },
            hostContext: { theme: "dark", platform: "web", displayMode: "inline" },
          },
        });
      } else if (method === "ui/notifications/initialized") {
        window.__pushToolResult(initialInput, initialResult);
      } else if (id !== undefined) {
        try {
          send({ id, result: await window.mcpHostCall(method, params) });
        } catch (err) {
          send({ id, error: { code: -32603, message: String(err) } });
        }
      }
    });
    document.body.append(frame);
  }, { initialInput: { path: firstFile, workspace }, initialResult: openResult });

  const frame = await (await page.waitForSelector("iframe")).contentFrame();
  await frame.waitForFunction(() => window.inkmap?.mindMap?.renderer?.root);
  await frame.waitForSelector("#ag-file-trigger");
  await frame.waitForSelector("#ag-split-md");
  await frame.waitForSelector("#open-browser:not([hidden])");
  await frame.waitForSelector(".ink-diagram-image");

  // Verify `inkmap_open_browser` launches a live two-way synced standalone browser server
  const browserRes = await client.callTool({ name: "inkmap_open_browser", arguments: { file: firstFile } });
  assert.match(browserRes.structuredContent.url, /^http:\/\/127\.0\.0\.1:\d+\//);

  // Edit a node in the mind map and verify live write-back to disk
  await frame.evaluate(() => {
    const { mindMap } = window.inkmap;
    mindMap.renderer.setNodeDataRender(mindMap.renderer.root.children[0], {
      md: "Updated Engine",
      text: "Updated Engine",
      rich: false,
    });
  });
  await frame.waitForFunction(async () => {
    const res = await parent.mcpHostCall("tools/call", { name: "inkmap_doc_open", arguments: {} });
    return res.structuredContent.doc.md.includes("Updated Engine");
  });
  assert.match(await readFile(firstFile, "utf8"), /Updated Engine/);

  // Select a node the way a user does, then press "Add to chat" and check the model context it sends.
  const nodeEl = await frame.evaluateHandle(() => window.inkmap.mindMap.renderer.root.children[0].group.node);
  await nodeEl.click();
  const chatBtn = await frame.waitForSelector("#chat-add:not([hidden])");
  await chatBtn.click();
  for (let i = 0; i < 100 && !contextUpdates.length; i++) await new Promise(ok => setTimeout(ok, 50));
  assert.ok(contextUpdates.length > 0, "Add to chat did not send ui/update-model-context");
  assert.match(JSON.stringify(contextUpdates.at(-1)), /Updated Engine/);

  // Simulate AI calling `inkmap_open` again for a second file while pane is open
  const secondResult = await client.callTool({ name: "inkmap_open", arguments: { path: secondFile, workspace } });
  await page.evaluate(({ args, result }) => {
    window.__pushToolResult(args, result);
  }, { args: { path: secondFile, workspace }, result: secondResult });

  await frame.waitForFunction(() => window.inkmap?.currentMarkdown().includes("Milestone 1"));

  // Verify packaged Antigravity Sidecar (`sidecars/inkmap/main.mjs`) `/api/open-browser` launches standalone two-way synced browser editor
  process.env.INKMAP_NO_OPEN = "1";
  process.env.INKMAP_HOME = join(dir, "inkmap-sidecar-home");
  const { pathToFileURL } = await import("node:url");
  const { createAntigravitySidecar } = await import(pathToFileURL(join(pluginRoot, "sidecars", "inkmap", "main.mjs")).href);
  const routes = new Map();
  const mockApp = {
    page: () => {},
    api: (route, handler, method = "POST") => routes.set(`${method} ${route}`, handler),
  };
  const sidecar = createAntigravitySidecar({ app: mockApp });
  t.after(() => sidecar.close());

  const openBrowserRes = await routes.get("POST /api/open-browser")({
    file: firstFile,
    workspaceUris: [pathToFileURL(workspace).href],
  });
  assert.equal(openBrowserRes.ok, true);
  assert.match(openBrowserRes.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  const sidecarBrowserPage = await browser.newPage();
  await sidecarBrowserPage.goto(openBrowserRes.url);
  await sidecarBrowserPage.waitForFunction(() => window.inkmap?.mindMap?.renderer?.root);
  assert.equal(await sidecarBrowserPage.$eval("#open-browser", el => el.hidden), true);
  await sidecarBrowserPage.close();

  assert.deepEqual(errors, []);
  await page.close();
});
