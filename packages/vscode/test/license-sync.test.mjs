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
