import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const unpacked = new URL("../dist/sidebars/inkmap-antigravity/", import.meta.url);
const { createAntigravitySidecar } = await import(new URL("inkmap/sidecars/inkmap/main.mjs", unpacked));
const { selectTargetFile } = await import(new URL("inkmap/sidecars/inkmap/select.mjs", unpacked));

class MockSidecarApp {
  pages = new Map();
  apis = new Map();
  config = { projectId: "test-proj", conversationId: "test-conv" };
  page(path, handler) {
    this.pages.set(path, handler);
  }
  api(path, handler, method = "POST") {
    if (!this.apis.has(path)) this.apis.set(path, new Map());
    this.apis.get(path).set(method.toUpperCase(), handler);
  }
  async call(method, path, data = {}) {
    const handler = this.apis.get(path)?.get(method.toUpperCase());
    assert.ok(handler, `Missing API handler for ${method} ${path}`);
    return await handler(data);
  }
}

test("the packaged Antigravity bundle includes plugin manifest, skill, and sidecar assets", async () => {
  const pluginManifest = JSON.parse(await readFile(new URL("inkmap/plugin.json", unpacked), "utf8"));
  assert.equal(pluginManifest.name, "inkmap");
  assert.equal(pluginManifest.logo, "assets/logo.svg");

  const sidecarManifest = JSON.parse(await readFile(new URL("inkmap/sidecars/inkmap/sidecar.json", unpacked), "utf8"));
  assert.equal(sidecarManifest.has_web_ui, true);
  assert.equal(sidecarManifest.ui_config?.views?.[0]?.entrypoint, "SIDECAR_UI_ENTRYPOINT_AUX_PANE");
  assert.equal(sidecarManifest.ui_config?.views?.[0]?.path, "/");

  const skill = await readFile(new URL("inkmap/skills/inkmap/SKILL.md", unpacked), "utf8");
  assert.match(skill, /sidecar:\/\/inkmap\/inkmap\//);
});

test("the Antigravity sidecar lists workspace Markdown files, writes edits back, and blocks outside paths", async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "inkmap-antigravity-")));
  const prevHome = process.env.INKMAP_HOME;
  const prevConfig = process.env.ANTIGRAVITY_CONFIG_DIR;
  process.env.INKMAP_HOME = join(dir, "inkmap-home");
  process.env.ANTIGRAVITY_CONFIG_DIR = join(dir, "gemini-config");

  const workspace = join(dir, "workspace");
  const inside = join(workspace, "design.markmap.md");
  const outside = join(dir, "outside.md");
  const link = join(workspace, "link.md");
  const initialMd = "# SetSail\n\n- Course\n";

  await mkdir(workspace, { recursive: true });
  await writeFile(inside, initialMd, "utf8");
  await writeFile(outside, initialMd, "utf8");
  await symlink(outside, link);

  const mockApp = new MockSidecarApp();
  const { license } = createAntigravitySidecar({ app: mockApp });

  t.after(async () => {
    license.dispose();
    if (prevHome === undefined) delete process.env.INKMAP_HOME;
    else process.env.INKMAP_HOME = prevHome;
    if (prevConfig === undefined) delete process.env.ANTIGRAVITY_CONFIG_DIR;
    else process.env.ANTIGRAVITY_CONFIG_DIR = prevConfig;
    await rm(dir, { recursive: true, force: true });
  });

  const html = await mockApp.pages.get("/")();
  assert.match(html, /\/preload\.js/);
  assert.match(html, /\/bridge\.js/);

  const workspaceUris = [pathToFileURL(workspace).href];
  const init = await mockApp.call("POST", "/api/init", { workspaceUris });
  assert.equal(init.currentFile, inside);
  assert.equal(init.doc.md, initialMd);
  assert.ok(init.files.some(f => f.path === inside));
  assert.ok(!init.files.some(f => f.path === outside || f.path === link));

  await assert.rejects(mockApp.call("POST", "/api/open", { workspaceUris, file: outside }));
  await assert.rejects(mockApp.call("POST", "/api/open", { workspaceUris, file: link }));

  const editedMd = "# SetSail\n\n- Course\n  - Vocabulary\n";
  const saved = await mockApp.call("POST", "/api/save", {
    workspaceUris,
    file: inside,
    md: editedMd,
    baseVersion: init.doc.version,
  });
  assert.equal(saved.ok, true);
  assert.equal(await readFile(inside, "utf8"), editedMd);

  // Conflict detection when baseVersion is stale
  const conflict = await mockApp.call("POST", "/api/save", {
    workspaceUris,
    file: inside,
    md: "# Stale\n",
    baseVersion: init.doc.version,
  });
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.doc.md, editedMd);

  // Target selection via select.mjs switches the active file on poll
  const second = join(workspace, "second.md");
  await writeFile(second, "# Second\n\n- Item\n", "utf8");
  await selectTargetFile(second, workspace);
  const polled = await mockApp.call("GET", "/api/poll", {
    file: inside,
    version: saved.version,
    targetSeq: String(init.targetSeq),
  });
  assert.equal(polled.switchedFile, second);
  assert.equal(polled.doc.md, "# Second\n\n- Item\n");
});
