import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const INDEX_URL = "https://zhiyuanv.com/dsh-index.json";
const MARKET_BUNDLE = "@deepseek-ai/dsh-experimental-plugin-market-bundle";
const noop = () => ({ dispose() {} });
const subscribable = () => ({ subscribe: noop });

const { outputFiles } = buildSync({
  entryPoints: [fileURLToPath(new URL("../src/extension.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  external: ["vscode"],
  write: false,
});

/** Loads the extension against a fake VS Code whose notifications answer with `choose(buttons)`. */
function loadExtension(choose) {
  const prompts = [];
  const messages = [];
  class FakeUri {
    constructor(fsPath) { this.scheme = "file"; this.fsPath = fsPath; this.path = fsPath; }
    toString() { return this.fsPath; }
    static joinPath(uri, ...parts) { return new FakeUri(join(uri.fsPath, ...parts)); }
    static file(p) { return new FakeUri(p); }
    static parse(u) { return new FakeUri(u); }
  }
  const vscode = {
    Uri: FakeUri,
    ViewColumn: { Beside: 2, Active: 1 },
    ProgressLocation: { Notification: 15 },
    env: { appName: "Visual Studio Code", language: "en" },
    commands: { getCommands: async () => [], registerCommand: noop, executeCommand: async () => {} },
    window: {
      activeTextEditor: undefined,
      state: { focused: true },
      tabGroups: { all: [] },
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      registerUriHandler: noop,
      registerCustomEditorProvider: noop,
      onDidChangeActiveTextEditor: noop,
      onDidChangeWindowState: noop,
      onDidChangeTextEditorSelection: noop,
      withProgress: (_options, task) => task(),
      showInformationMessage: async (msg, ...buttons) => {
        if (buttons.length > 1) {
          prompts.push({ msg, buttons });
          return choose(buttons);
        }
        messages.push(msg);
        return undefined;
      },
      showWarningMessage: async msg => void messages.push(msg),
      showErrorMessage: async msg => void messages.push(msg),
    },
    workspace: {
      workspaceFolders: [],
      getConfiguration: () => ({ get: () => "https://billing.example.com" }),
      onDidChangeWorkspaceFolders: subscribable().subscribe,
      onDidChangeTextDocument: subscribable().subscribe,
    },
  };
  const bundled = { exports: {} };
  const require = createRequire(import.meta.url);
  new Function("require", "module", "exports", outputFiles[0].text)(id => (id === "vscode" ? vscode : require(id)), bundled, bundled.exports);
  return { extension: bundled.exports, prompts, messages };
}

function activate(extension, globalStore) {
  const subscriptions = [];
  extension.activate({
    extensionUri: { fsPath: fileURLToPath(new URL("../", import.meta.url)) },
    subscriptions,
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    globalState: { get: k => globalStore.get(k), update: async (k, v) => void globalStore.set(k, v) },
    workspaceState: { get: () => undefined, update: async () => {} },
  });
  return () => { for (const sub of subscriptions) sub?.dispose?.(); };
}

const settle = async (until, label) => {
  for (let i = 0; i < 100; i++) {
    if (until()) return;
    await new Promise(ok => setTimeout(ok, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
};

async function harnessHome(t, { pluginInstalled = true, patch = "[]\n" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "inkmap-dsh-"));
  const profile = join(dir, "profiles", "desktop");
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, "cordis.patch.yml"), patch);
  await writeFile(join(profile, "package.json"), JSON.stringify({
    dsh: { profile: { bundles: [] } },
    // With the plugin listed, accepting never runs the real `dsh` CLI in this test.
    dependencies: pluginInstalled ? { "dsh-inkmap": "0.3.10" } : {},
  }));
  const saved = { DSH_HOME: process.env.DSH_HOME, INKMAP_HOME: process.env.INKMAP_HOME };
  process.env.DSH_HOME = dir;
  process.env.INKMAP_HOME = join(dir, "inkmap-home");
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  return profile;
}

const profileFiles = async profile => ({
  patch: await readFile(join(profile, "cordis.patch.yml"), "utf8"),
  pkg: JSON.parse(await readFile(join(profile, "package.json"), "utf8")),
});

test("declining the DeepSeek Harness prompt leaves Harness untouched and is never asked again", async t => {
  const profile = await harnessHome(t, { pluginInstalled: false });
  const before = await profileFiles(profile);
  const store = new Map();
  const { extension, prompts } = loadExtension(buttons => buttons[1]);
  const dispose = activate(extension, store);
  await settle(() => prompts.length === 1, "the Harness prompt");
  assert.equal(prompts[0].buttons.length, 2);
  await new Promise(ok => setTimeout(ok, 30));
  dispose();
  assert.deepEqual(await profileFiles(profile), before);

  activate(extension, store)();
  await new Promise(ok => setTimeout(ok, 30));
  assert.equal(prompts.length, 1, "asked only once");
});

test("accepting the DeepSeek Harness prompt adds the Inkmap plugin index", async t => {
  const profile = await harnessHome(t, { pluginInstalled: true, patch: "- id: other\n  name: other\n" });
  const store = new Map();
  const { extension, prompts, messages } = loadExtension(buttons => buttons[0]);
  const dispose = activate(extension, store);
  await settle(() => prompts.length === 1 && messages.length === 1, "the install result");
  dispose();
  const { patch, pkg } = await profileFiles(profile);
  assert.ok(patch.startsWith("- id: other\n  name: other\n\n- id: plugin-market\n"), patch);
  assert.ok(patch.includes(INDEX_URL));
  assert.deepEqual(pkg.dsh.profile.bundles, [MARKET_BUNDLE]);
});

test("no prompt when DeepSeek Harness is missing or already set up", async t => {
  const profile = await harnessHome(t, { pluginInstalled: true, patch: `- id: plugin-market\n  config:\n    indexes:\n      - ${INDEX_URL}\n` });
  const pkg = JSON.parse(await readFile(join(profile, "package.json"), "utf8"));
  pkg.dsh.profile.bundles = [MARKET_BUNDLE];
  await writeFile(join(profile, "package.json"), JSON.stringify(pkg));
  const { extension, prompts } = loadExtension(buttons => buttons[0]);
  activate(extension, new Map())();
  process.env.DSH_HOME = join(profile, "missing");
  activate(extension, new Map())();
  await new Promise(ok => setTimeout(ok, 50));
  assert.equal(prompts.length, 0);
});
