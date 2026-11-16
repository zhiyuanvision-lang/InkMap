import { App, applyDocumentTheme, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions, OpenAIFileEntrypointInputSchema } from "@openai/mcp-extensions/app";
import { CodexHost } from "./codex-host";
import { mount } from "./main";
import { McpAppHost, type McpWorkspaceSnapshot } from "./mcp-app-host";
import { sidebarGate, sidebarText } from "./sidebar-shell";

const gate = sidebarGate(sidebarText("正在连接 Inkmap 思维导图面板…", "Connecting to Inkmap mind map panel…"));
const app = new App({ name: "Inkmap", version: "0.2.0" }, {}, { autoResize: false });
const extensions = new OpenAIExtensions(app);

function syncHostContext(ctx?: McpUiHostContext) {
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

function startMcpWorkspaceHost(snapshot?: McpWorkspaceSnapshot) {
  if (opened) return mountedMcpHost;
  opened = true;
  const host = new McpAppHost(app, latestInput, snapshot);
  gate.close();
  mountedMcpHost = mount(host).then(() => host, error => {
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
    }, 150);
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
  syncHostContext(app.getHostContext());
  if (extensions.resources) {
    if (!opened) {
      gate.note.textContent = sidebarText("请在 Codex 文件面板中用 Inkmap 打开 Markdown 文件。", "Open a Markdown file with Inkmap from the Codex file panel.");
    }
    return;
  }
  // If opened directly by an MCP App host without a preceding toolinput notification, auto-mount workspace mode.
  window.setTimeout(() => {
    if (!opened) void startMcpWorkspaceHost();
  }, 350);
}, () => {
  gate.note.textContent = sidebarText("无法连接宿主思维导图面板。", "Could not connect to the host mind map panel.");
});
