import { App, applyDocumentTheme, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions, OpenAIFileEntrypointInputSchema } from "@openai/mcp-extensions/app";
import { CodexHost } from "./codex-host";
import { mount } from "./main";
import { McpAppHost, type McpWorkspaceSnapshot } from "./mcp-app-host";
import { sidebarGate, sidebarText } from "./sidebar-shell";

const gate = sidebarGate(sidebarText("正在连接 Inkmap 思维导图面板…", "Connecting to Inkmap mind map panel…"));
const app = new App({ name: "Inkmap", version: "0.3.10" }, {}, { autoResize: false });
const extensions = new OpenAIExtensions(app);

let compactBannerActive = false;

function requestComfortableInlineHeight(ctx?: McpUiHostContext) {
  if (extensions.resources || compactBannerActive) return;
  const hostName = app.getHostVersion()?.name ?? "";
  if (/antigravity/i.test(hostName)) return;
  if (ctx?.displayMode === "fullscreen") return;
  const maxH =
    ctx?.containerDimensions && "maxHeight" in ctx.containerDimensions && typeof ctx.containerDimensions.maxHeight === "number"
      ? ctx.containerDimensions.maxHeight
      : undefined;
  const height = maxH ? Math.min(Math.max(420, maxH), 640) : 560;
  document.documentElement.style.minHeight = `${height}px`;
  document.body.style.minHeight = `${height}px`;
  void app.sendSizeChanged({ height }).catch(() => {});
}

function syncHostContext(ctx?: McpUiHostContext) {
  requestComfortableInlineHeight(ctx);
  if (!ctx) return;
  if (ctx.theme === "light" || ctx.theme === "dark") {
    applyDocumentTheme(ctx.theme);
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
}

let opened = false;
let latestInput: { path?: string; workspace?: string } | undefined;
let initialResultResolver: ((snapshot?: McpWorkspaceSnapshot) => void) | undefined;
let mountedMcpHost: Promise<McpAppHost> | undefined;
let ready: Promise<void>;

function parseWorkspaceArgs(args?: Record<string, unknown>) {
  if (!args || typeof args !== "object") return undefined;
  return {
    ...(typeof args.path === "string" && { path: args.path }),
    ...(typeof args.workspace === "string" && { workspace: args.workspace }),
  };
}

function mountEditorPaneDelegatedBanner(snapshot: McpWorkspaceSnapshot & { editorUrl?: string }) {
  opened = true;
  compactBannerActive = true;
  gate.close();

  const fileName = snapshot.currentFile ? snapshot.currentFile.split(/[\\/]/).pop() || snapshot.currentFile : "Markdown";
  const banner = document.createElement("div");
  banner.id = "inkmap-delegated-banner";
  banner.innerHTML = `
    <style id="inkmap-delegated-style">
      :root.ink-banner-collapsed, :root.ink-banner-collapsed body {
        margin: 0 !important; padding: 0 !important;
        height: 46px !important; min-height: 46px !important; max-height: 46px !important;
        overflow: hidden !important; background: transparent !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      }
      :root.ink-banner-collapsed #bar,
      :root.ink-banner-collapsed #map,
      :root.ink-banner-collapsed #search,
      :root.ink-banner-collapsed #source,
      :root.ink-banner-collapsed #node-menu,
      :root.ink-banner-collapsed #chat-add,
      :root.ink-banner-collapsed #ag-md-pane,
      :root.ink-banner-collapsed #ag-file-tree-popover,
      :root.ink-banner-collapsed #present-bar,
      :root.ink-banner-collapsed .sidebar-gate {
        display: none !important;
      }
      :root.ink-banner-expanded {
        --banner-offset: 46px;
      }
      :root.ink-banner-expanded #bar {
        top: 52px !important;
      }
      :root.ink-banner-expanded.ag-split-active #bar {
        top: 46px !important;
      }
      :root.ink-banner-expanded #ag-file-tree-popover {
        top: calc(var(--toolbar-height, 40px) + 56px) !important;
      }
      #inkmap-delegated-banner {
        position: fixed; top: 0; left: 0; right: 0; z-index: 150;
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        height: 46px; padding: 0 12px; box-sizing: border-box;
        border-radius: 8px;
        background: var(--color-background-secondary, #1e222a);
        border: 1px solid var(--color-border-primary, rgba(255, 255, 255, 0.12));
        color: var(--color-text-primary, #e5e7eb);
        font-size: 12.5px;
      }
      :root[data-theme="light"] #inkmap-delegated-banner {
        color: var(--color-text-primary, #1f2329);
        background: var(--color-background-secondary, #f5f7fa);
        border-color: var(--color-border-primary, rgba(31, 35, 41, 0.14));
      }
      .ink-del-left { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
      .ink-del-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; flex: none; }
      .ink-del-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
      .ink-del-actions { display: flex; align-items: center; gap: 6px; flex: none; }
      .ink-del-btn {
        border: 1px solid var(--color-border-primary, rgba(255, 255, 255, 0.18));
        background: rgba(127, 127, 127, 0.16);
        color: inherit; border-radius: 6px; height: 26px; padding: 0 9px;
        font-size: 11.5px; font-weight: 500; cursor: pointer;
      }
      .ink-del-btn:hover { background: rgba(127, 127, 127, 0.28); }
      .ink-del-btn[data-active="true"] {
        background: #336df4; border-color: #336df4; color: #fff;
      }
    </style>
    <div class="ink-del-left">
      <span class="ink-del-dot"></span>
      <span class="ink-del-text"></span>
    </div>
    <div class="ink-del-actions">
      <button type="button" class="ink-del-btn" id="ink-del-editor">${sidebarText("右侧编辑区打开", "Open in Editor")}</button>
      <button type="button" class="ink-del-btn" id="ink-del-inline">${sidebarText("在对话中打开", "Open Inline")}</button>
      <button type="button" class="ink-del-btn" id="ink-del-browser">${sidebarText("使用浏览器打开", "Open in Browser")}</button>
    </div>
  `;
  banner.querySelector(".ink-del-text")!.textContent = sidebarText(
    `${fileName} 思维导图`,
    `${fileName} mind map`,
  );
  document.documentElement.classList.add("ink-banner-collapsed");
  document.body.appendChild(banner);
  void app.sendSizeChanged({ height: 46 }).catch(() => {});

  const inlineBtn = banner.querySelector<HTMLButtonElement>("#ink-del-inline")!;
  const editorBtn = banner.querySelector<HTMLButtonElement>("#ink-del-editor")!;
  const browserBtn = banner.querySelector<HTMLButtonElement>("#ink-del-browser")!;

  editorBtn.addEventListener("click", async () => {
    editorBtn.disabled = true;
    editorBtn.textContent = sidebarText("正在打开…", "Opening…");
    try {
      const res = await app.callServerTool({
        name: "inkmap_focus_editor",
        arguments: { ...(snapshot.currentFile && { file: snapshot.currentFile }) },
      });
      const data = (res.structuredContent ?? {}) as { handledBy?: string; url?: string };
      if (data.handledBy === "extension") {
        editorBtn.textContent = sidebarText("✓ 已在右侧打开", "✓ Opened in Editor");
      } else {
        if (compactBannerActive) {
          inlineBtn.click();
        }
        editorBtn.textContent = sidebarText("✓ 已展开导图", "✓ Expanded");
      }
    } catch {
      editorBtn.textContent = sidebarText("打开失败", "Failed");
    } finally {
      editorBtn.disabled = false;
      window.setTimeout(() => {
        editorBtn.textContent = sidebarText("右侧编辑区打开", "Open in Editor");
      }, 1800);
    }
  });

  browserBtn.addEventListener("click", () => {
    void app.callServerTool({
      name: "inkmap_open_browser",
      arguments: { ...(snapshot.currentFile && { file: snapshot.currentFile }) },
    }).catch(() => {});
  });

  let inlineMounted = false;
  inlineBtn.addEventListener("click", () => {
    if (compactBannerActive) {
      compactBannerActive = false;
      document.documentElement.classList.remove("ink-banner-collapsed");
      document.documentElement.classList.add("ink-banner-expanded");
      inlineBtn.dataset.active = "true";
      inlineBtn.textContent = sidebarText("收起对话内导图", "Collapse Inline");
      requestComfortableInlineHeight(app.getHostContext());
      if (!inlineMounted) {
        inlineMounted = true;
        opened = false;
        void startMcpWorkspaceHost({ ...snapshot, openedInEditorPane: false }, true)?.then(() => {
          for (const delay of [80, 220, 450]) {
            window.setTimeout(() => {
              try {
                const api = (window as any).inkmap;
                api?.mindMap?.resize();
                api?.mindMap?.view?.fit();
              } catch {}
            }, delay);
          }
        });
      } else {
        for (const delay of [60, 200]) {
          window.setTimeout(() => {
            try {
              const api = (window as any).inkmap;
              api?.mindMap?.resize();
              api?.mindMap?.view?.fit();
            } catch {}
          }, delay);
        }
      }
    } else {
      compactBannerActive = true;
      document.documentElement.classList.remove("ink-banner-expanded");
      document.documentElement.classList.add("ink-banner-collapsed");
      inlineBtn.dataset.active = "false";
      inlineBtn.textContent = sidebarText("在对话中打开", "Open Inline");
      void app.sendSizeChanged({ height: 46 }).catch(() => {});
    }
  });
}

function startMcpWorkspaceHost(snapshot?: McpWorkspaceSnapshot, forceInline = false) {
  if (opened) return mountedMcpHost;
  if (!forceInline && snapshot?.openedInEditorPane) {
    mountEditorPaneDelegatedBanner(snapshot);
    return undefined;
  }
  opened = true;
  const host = new McpAppHost(app, latestInput, snapshot);
  gate.close();
  mountedMcpHost = mount(host).then(() => {
    requestComfortableInlineHeight(app.getHostContext());
    return host;
  }, error => {
    if (!gate.panel.isConnected) sidebarGate(String(error instanceof Error ? error.message : error));
    else gate.note.textContent = String(error instanceof Error ? error.message : error);
    throw error;
  });
  return mountedMcpHost;
}

app.addEventListener("hostcontextchanged", ctx => {
  syncHostContext(ctx);
});

app.addEventListener("toolinput", async ({ arguments: args }) => {
  await ready;
  const fileInput = OpenAIFileEntrypointInputSchema.safeParse(args);
  if (extensions.resources && (!args || !("path" in args))) {
    if (opened) return;
    if (!fileInput.success || !/\.md$/i.test(fileInput.data.file.name)) {
      gate.note.textContent = sidebarText("请在 Codex 文件面板中用 Inkmap 打开 Markdown 文件。", "Open a Markdown file with Inkmap from the Codex file panel.");
      return;
    }
    opened = true;
    try {
      gate.close();
      await mount(new CodexHost(app, extensions.resources, fileInput.data.file));
    } catch (error) {
      if (!gate.panel.isConnected) sidebarGate(String(error instanceof Error ? error.message : error));
      else gate.note.textContent = String(error instanceof Error ? error.message : error);
    }
    return;
  }

  latestInput = parseWorkspaceArgs(args);
  if (opened) return;

  // Wait briefly for `toolresult` (which carries structuredContent) before mounting.
  const snapshot = await new Promise<McpWorkspaceSnapshot | undefined>(resolve => {
    initialResultResolver = resolve;
    window.setTimeout(() => {
      if (initialResultResolver === resolve) {
        initialResultResolver = undefined;
        resolve(undefined);
      }
    }, 250);
  });
  if (!opened) {
    void startMcpWorkspaceHost(snapshot);
  }
});

app.addEventListener("toolresult", async result => {
  await ready;
  const snapshot = result.structuredContent as McpWorkspaceSnapshot | undefined;
  if (initialResultResolver) {
    const resolve = initialResultResolver;
    initialResultResolver = undefined;
    resolve(snapshot);
    return;
  }
  if (!opened && !extensions.resources) {
    void startMcpWorkspaceHost(snapshot);
    return;
  }
  if (mountedMcpHost) {
    const host = await mountedMcpHost.catch(() => undefined);
    if (host) {
      await host.handleHostToolUpdate(latestInput, snapshot).catch(() => {});
    }
  }
});

ready = app.connect();
void ready.then(() => {
  if (extensions.resources) {
    syncHostContext(app.getHostContext());
    if (!opened) {
      gate.note.textContent = sidebarText("请在 Codex 文件面板中用 Inkmap 打开 Markdown 文件。", "Open a Markdown file with Inkmap from the Codex file panel.");
    }
    return;
  }
  // Apply theme immediately, deferring 560px expand until startMcpWorkspaceHost knows whether editor pane handled it
  const ctx = app.getHostContext();
  if (ctx?.theme === "light" || ctx?.theme === "dark") applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  window.setTimeout(() => {
    if (!opened) void startMcpWorkspaceHost();
  }, 400);
}, () => {
  gate.note.textContent = sidebarText("无法连接宿主思维导图面板。", "Could not connect to the host mind map panel.");
});
