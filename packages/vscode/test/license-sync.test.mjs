import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

function event() {
  const listeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fire(value) {
      for (const listener of listeners) listener(value);
    },
  };
}

test("resends revoked Pro access when the editor tab or window returns", async () => {
  const windowState = event();
  const viewState = event();
  const disposed = event();
  const vscode = {
    Uri: {
      joinPath: (uri, ...parts) => ({ fsPath: join(uri.fsPath, ...parts) }),
    },
    env: { language: "en" },
    window: { onDidChangeWindowState: windowState.subscribe, onDidChangeTextEditorSelection: event().subscribe },
    workspace: { onDidChangeTextDocument: event().subscribe },
  };
  const { outputFiles } = buildSync({
    entryPoints: [fileURLToPath(new URL("../src/mindmapEditor.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    external: ["vscode"],
    write: false,
  });
  const bundled = { exports: {} };
  const require = createRequire(import.meta.url);
  new Function("require", "module", "exports", outputFiles[0].text)(
    id => id === "vscode" ? vscode : require(id), bundled, bundled.exports,
  );

  const paid = { pro: true, connected: true };
  const refunded = { pro: false, connected: true };
  let license = paid;
  const messages = [];
  let nextMessage;
  const panel = {
    visible: true,
    onDidChangeViewState: viewState.subscribe,
    onDidDispose: disposed.subscribe,
    webview: {
      cspSource: "https://example.test",
      asWebviewUri: uri => uri.fsPath,
      onDidReceiveMessage: event().subscribe,
      async postMessage(message) {
        messages.push(message);
        nextMessage?.(message);
        return true;
      },
    },
  };
  const { MindmapEditorProvider } = bundled.exports;
  const editor = new MindmapEditorProvider(
    { extensionUri: { fsPath: fileURLToPath(new URL("../", import.meta.url)) } },
    { state: async () => license, onChange: () => () => {} },
    async () => [],
  );
  await editor.resolveCustomTextEditor({ uri: { scheme: "untitled", path: "test.md" } }, panel);

  panel.visible = false;
  viewState.fire({ webviewPanel: panel });
  await Promise.resolve();
  assert.deepEqual(messages, []);

  // The panel missed the original notification while hidden.
  license = refunded;
  panel.visible = true;
  const tabMessage = new Promise(resolve => { nextMessage = resolve; });
  viewState.fire({ webviewPanel: panel });
  assert.deepEqual(await tabMessage, { type: "license", state: refunded });

  const windowMessage = new Promise(resolve => { nextMessage = resolve; });
  windowState.fire({ focused: true });
  assert.deepEqual(await windowMessage, { type: "license", state: refunded });

  disposed.fire();
  windowState.fire({ focused: true });
  await Promise.resolve();
  assert.equal(messages.length, 2);
});

test("records plugin_activate on startup, shows status bar on Markdown, and offers one-time onboarding", async () => {
  const activeEditorChanged = event();
  const executedCommands = [];
  const infoPrompts = [];
  const statusBarItem = {
    text: "",
    tooltip: "",
    command: "",
    visible: false,
    show() { this.visible = true; },
    hide() { this.visible = false; },
    dispose() {},
  };
  let pickAction = true;
  class FakeUri {
    constructor(scheme, fsPath) {
      this.scheme = scheme;
      this.fsPath = fsPath;
      this.path = fsPath;
    }
    toString() { return this.fsPath; }
    static joinPath(uri, ...parts) { return new FakeUri("file", join(uri.fsPath, ...parts)); }
    static file(p) { return new FakeUri("file", p); }
    static parse(u) { return new FakeUri("https", u); }
  }
  const vscode = {
    Uri: FakeUri,
    ViewColumn: { Beside: 2, Active: 1 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    env: { appName: "Trae", language: "zh-cn" },
    commands: {
      getCommands: async () => [],
      registerCommand: () => ({ dispose() {} }),
      executeCommand: async (...args) => { executedCommands.push(args); },
    },
    window: {
      activeTextEditor: undefined,
      state: { focused: true },
      tabGroups: { all: [] },
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createStatusBarItem: () => statusBarItem,
      registerUriHandler: () => ({ dispose() {} }),
      registerCustomEditorProvider: () => ({ dispose() {} }),
      onDidChangeActiveTextEditor: activeEditorChanged.subscribe,
      onDidChangeWindowState: event().subscribe,
      onDidChangeTextEditorSelection: event().subscribe,
      showInformationMessage: async (msg, action) => {
        infoPrompts.push({ msg, action });
        return pickAction ? action : undefined;
      },
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
    },
    workspace: {
      workspaceFolders: [],
      getConfiguration: () => ({ get: () => "https://billing.example.com" }),
      onDidChangeWorkspaceFolders: event().subscribe,
      onDidChangeTextDocument: event().subscribe,
    },
  };
  const { outputFiles } = buildSync({
    entryPoints: [fileURLToPath(new URL("../src/extension.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    external: ["vscode"],
    write: false,
  });
  const bundled = { exports: {} };
  const require = createRequire(import.meta.url);
  new Function("require", "module", "exports", outputFiles[0].text)(
    id => id === "vscode" ? vscode : require(id), bundled, bundled.exports,
  );

  const globalStore = new Map();
  const subscriptions = [];
  const mdUri = FakeUri.file("/tmp/demo.md");
  // Keep the DeepSeek Harness check away from this computer's real ~/.dsh.
  const savedDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(fileURLToPath(new URL("../", import.meta.url)), "no-such-dsh-home");
  vscode.window.activeTextEditor = { document: { languageId: "markdown", uri: mdUri } };

  try {
    bundled.exports.activate({
      extensionUri: { fsPath: fileURLToPath(new URL("../", import.meta.url)) },
      subscriptions,
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
      globalState: {
        get: k => globalStore.get(k),
        update: async (k, v) => { globalStore.set(k, v); },
      },
      workspaceState: { get: () => undefined, update: async () => {} },
    });

    await new Promise(r => setTimeout(r, 20));
    assert.equal(statusBarItem.visible, true);
    assert.equal(statusBarItem.command, "inkmap.openToSide");
    assert.equal(infoPrompts.length, 1);
    assert.equal(globalStore.get("inkmap.onboardingPrompted"), true);
    assert.ok(executedCommands.some(args => args[0] === "vscode.openWith" && args[2] === "inkmap.mindmap"));

    // Switching to a non-Markdown file hides the status bar button
    activeEditorChanged.fire({ document: { languageId: "typescript", uri: FakeUri.file("/tmp/app.ts") } });
    assert.equal(statusBarItem.visible, false);

    // Opening another Markdown file restores the status bar button and never nags a second time
    activeEditorChanged.fire({ document: { languageId: "markdown", uri: mdUri } });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(statusBarItem.visible, true);
    assert.equal(infoPrompts.length, 1);
  } finally {
    for (const sub of subscriptions) sub?.dispose?.();
    if (savedDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedDshHome;
  }
});

test("offers one-time welcome demo mind map on first install when no Markdown file is open", async () => {
  const executedCommands = [];
  const infoPrompts = [];
  class FakeUri {
    constructor(scheme, fsPath) {
      this.scheme = scheme;
      this.fsPath = fsPath;
      this.path = fsPath;
    }
    toString() { return this.fsPath; }
    static joinPath(uri, ...parts) { return new FakeUri("file", join(uri.fsPath, ...parts)); }
    static file(p) { return new FakeUri("file", p); }
    static parse(u) { return new FakeUri("https", u); }
  }
  const vscode = {
    Uri: FakeUri,
    ViewColumn: { Beside: 2, Active: 1 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    env: { appName: "VS Code", language: "en" },
    commands: {
      getCommands: async () => [],
      registerCommand: () => ({ dispose() {} }),
      executeCommand: async (...args) => { executedCommands.push(args); },
    },
    window: {
      activeTextEditor: undefined,
      state: { focused: true },
      tabGroups: { all: [] },
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createStatusBarItem: () => ({ text: "", tooltip: "", command: "", show() {}, hide() {}, dispose() {} }),
      registerUriHandler: () => ({ dispose() {} }),
      registerCustomEditorProvider: () => ({ dispose() {} }),
      onDidChangeActiveTextEditor: event().subscribe,
      onDidChangeWindowState: event().subscribe,
      onDidChangeTextEditorSelection: event().subscribe,
      showInformationMessage: async (msg, action) => {
        infoPrompts.push({ msg, action });
        return action;
      },
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
    },
    workspace: {
      workspaceFolders: [],
      getConfiguration: () => ({ get: () => "https://billing.example.com" }),
      onDidChangeWorkspaceFolders: event().subscribe,
      onDidChangeTextDocument: event().subscribe,
    },
  };
  const { outputFiles } = buildSync({
    entryPoints: [fileURLToPath(new URL("../src/extension.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    external: ["vscode"],
    write: false,
  });
  const bundled = { exports: {} };
  const require = createRequire(import.meta.url);
  new Function("require", "module", "exports", outputFiles[0].text)(
    id => id === "vscode" ? vscode : require(id), bundled, bundled.exports,
  );

  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const storageDir = await mkdtemp(join(tmpdir(), "inkmap-welcome-test-"));
  const globalStore = new Map();
  const subscriptions = [];
  const savedDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(fileURLToPath(new URL("../", import.meta.url)), "no-such-dsh-home");

  try {
    bundled.exports.activate({
      extensionUri: { fsPath: fileURLToPath(new URL("../", import.meta.url)) },
      globalStorageUri: FakeUri.file(storageDir),
      subscriptions,
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
      globalState: {
        get: k => globalStore.get(k),
        update: async (k, v) => { globalStore.set(k, v); },
      },
      workspaceState: { get: () => undefined, update: async () => {} },
    });

    await new Promise(r => setTimeout(r, 40));
    assert.equal(infoPrompts.length, 1);
    assert.equal(globalStore.get("inkmap.welcomePrompted"), true);
    const openCall = executedCommands.find(args => args[0] === "vscode.openWith" && args[2] === "inkmap.mindmap");
    assert.ok(openCall, "Expected welcome demo to open in Inkmap Mind Map");
    assert.match(openCall[1].fsPath, /Inkmap-Welcome\.md$/);
    const content = await readFile(openCall[1].fsPath, "utf8");
    assert.match(content, /mermaid/);
  } finally {
    for (const sub of subscriptions) sub?.dispose?.();
    if (savedDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedDshHome;
    await rm(storageDir, { recursive: true, force: true });
  }
});
