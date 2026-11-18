import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { actionSlot, bodySlot, fileAddress, kind, route } from "../packages/harness/src/shared.mjs";

const output = new URL("../dist/sidebars/dsh-inkmap/", import.meta.url);

test("the packaged Harness client opens beside the selected Markdown", async () => {
  const bundle = await readFile(new URL("client.js", output), "utf8");
  let plugin;
  const react = { createElement: (tag, props, ...children) => ({ tag, props, children }) };
  runInNewContext(bundle, {
    window: {
      addEventListener() {},
      __ModuleLoader__: { load: ({ factory }) => { plugin = factory(id => { assert.equal(id, "react"); return react; }); } },
    },
    document: { documentElement: { lang: "zh-CN" }, createElement: () => ({}), head: { append() {} } },
    location: { protocol: "dsh-app:", hostname: "app" },
  });
  const components = new Map();
  const opened = [];
  let tabType;
  plugin.apply({
    effect: register => register(),
    slots: {
      inject: (_, register) => register(),
      register: ({ name }, component) => components.set(name, component),
    },
    sidebarRightTabs: { register: value => { tabType = value; } },
    sidebarRight: {
      mounted: { getSnapshot: () => "test-session" },
      focusedTarget: element => element === button ? { host: "dock", paneId: "preview-pane" } : undefined,
      openResource: (address, { kind, paneId, preferNewPane }) => opened.push({ address, kind, paneId, preferNewPane }),
    },
  });
  assert.ok(components.get(bodySlot));
  const action = components.get(actionSlot);
  assert.equal(action({ absolutePath: "/tmp/note.txt" }), null);
  const button = action({ absolutePath: "/tmp/中文 note.md" });
  assert.equal(button.children.at(-1), "Inkmap");
  assert.equal(button.props["aria-label"], "用 Inkmap 打开");
  button.props.onClick({ currentTarget: button });
  assert.deepEqual(opened, [{ address: fileAddress("test-session", "/tmp/中文 note.md"), kind, paneId: "preview-pane", preferNewPane: true }]);
  assert.equal(tabType.canOpen(opened[0].address), true);
});

test("the packaged Harness host confines file access and releases shared editors after the last tab closes", async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "inkmap-harness-")));
  const workspace = join(dir, "workspace");
  const inside = join(workspace, "note.md");
  const outside = join(dir, "outside.md");
  const link = join(workspace, "link.md");
  const content = "# Test\n\n- Note\n";
  await mkdir(workspace);
  await writeFile(inside, content);
  await writeFile(outside, content);
  await symlink(outside, link);

  const plugin = await import(new URL("host.js", output));
  let handler;
  let dispose;
  plugin.apply({
    effect: register => { dispose = register(); },
    webServer: { host: "127.0.0.1", register: value => {
      assert.equal(value.path, route);
      handler = value.handler;
      return () => {};
    } },
    connection: { requestRejection: req => req.headers["x-test-auth"] === "yes" ? undefined : 401 },
    sessions: { get: id => id === "session" ? { header: { cwd: workspace } } : undefined },
    get: () => undefined,
    fs: {
      processPathFromHostPath: path => path,
      processPath: target => target.targetKey,
      resolve: async path => ({ targetKey: await realpath(path) }),
    },
  });
  const carrier = createServer(handler);
  t.after(async () => {
    dispose();
    await new Promise(resolve => carrier.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => carrier.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${carrier.address().port}${route}`;
  const request = (method, data, auth = "yes") => fetch(endpoint, {
    method, headers: { "content-type": "application/json", "x-test-auth": auth }, body: JSON.stringify(data),
  });
  assert.equal((await request("POST", { address: fileAddress("session", inside) }, "no")).status, 401);
  assert.equal((await request("POST", { action: "sign-in", lease: "unknown" })).status, 404);
  for (const path of [outside, link]) {
    assert.equal((await request("POST", { address: fileAddress("session", path) })).status, 404);
  }
  const open = () => request("POST", { address: fileAddress("session", inside) }).then(res => {
    assert.equal(res.status, 200);
    return res.json();
  });
  const [first, second] = await Promise.all([open(), open()]);
  assert.equal(first.url, second.url);
  assert.notEqual(first.lease, second.lease);
  assert.deepEqual(await (await fetch(first.url + "api/capabilities")).json(), { purchase: true, accountNavigation: "host" });
  assert.equal((await request("POST", { action: "sign-in", lease: first.lease }, "no")).status, 401);
  assert.equal((await (await fetch(first.url + "api/doc")).json()).md, content);
  const updated = content.replace("Note", "External");
  await writeFile(inside, updated);
  assert.equal((await (await fetch(first.url + "api/doc")).json()).md, updated);
  await request("DELETE", { lease: first.lease });
  assert.equal((await request("POST", { action: "sign-in", lease: first.lease })).status, 404);
  assert.equal((await fetch(first.url + "api/doc")).status, 200);
  await request("DELETE", { lease: second.lease });
  await assert.rejects(fetch(first.url + "api/doc"));
});
