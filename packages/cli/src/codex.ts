import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getUiCapability, registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { hasAccess, PRODUCT, YUNFAN_BILLING_ORIGIN } from "@inkmap/core";
import { adFeed, detectOsLocale, fileSessionStorage, licenseService } from "./license.js";
import { createMcpWorkspaceManager, writeTargetSelection } from "./mcp-files.js";
import { fileSource, serve, type Served } from "./server.js";

const UI = "ui://inkmap/markdown.html";
const HTML = new URL("./codex.html", import.meta.url);
const WEB_ROOT_CANDIDATES = [
  fileURLToPath(new URL("./web/", import.meta.url)),
  fileURLToPath(new URL("./sidecars/inkmap/web/", import.meta.url)),
  fileURLToPath(new URL("../web/", import.meta.url)),
];
function resolveWebRoot(): string | null {
  return WEB_ROOT_CANDIDATES.find(dir => existsSync(join(dir, "index.html"))) ?? null;
}
const INLINE_DOC_LIMIT = 256 * 1024;
const appOnly = { ui: { visibility: ["app" as const] } };

function openSystemBrowser(url: string) {
  if (process.env.INKMAP_NO_OPEN === "1") return;
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

export async function createInkmapMcpServer(options: { html?: string; billingOrigin?: () => string } = {}) {
  const loadHtml = async () => {
    const raw = options.html ?? await readFile(HTML, "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("MCP App editor assets are missing. Run npm run build:sidebars.");
      }
      throw error;
    });
    const osLoc = detectOsLocale();
    return raw.replace(/<html\b([^>]*)>/i, `<html lang="${osLoc === "zh" ? "zh-CN" : "en"}" data-os-locale="${osLoc}">`);
  };
  await loadHtml();
  const billingOrigin = options.billingOrigin ?? (() => process.env.INKMAP_BILLING_ORIGIN || YUNFAN_BILLING_ORIGIN);
  const billing = licenseService(fileSessionStorage(), billingOrigin, { loginOnly: true });
  let browserBilling: ReturnType<typeof licenseService> | undefined;
  const fallbackEditors = new Map<string, Promise<Served>>();
  const ads = adFeed(PRODUCT.adFeedUrl);
  const workspaces = createMcpWorkspaceManager();
  const server = new McpServer({ name: "inkmap", version: "0.3.9" });

  function isAntigravityHost(): boolean {
    const clientName = server.server.getClientVersion()?.name ?? "";
    if (/antigravity/i.test(clientName)) return true;
    if (/[/\\]plugins[/\\]inkmap[/\\]/.test(process.argv[1] ?? "")) return true;
    return false;
  }

  function isCursorHost(): boolean {
    const clientName = server.server.getClientVersion()?.name ?? "";
    return /cursor/i.test(clientName);
  }

  function detectMcpHost(): string {
    if (isAntigravityHost()) return "antigravity";
    const clientName = (server.server.getClientVersion()?.name ?? "").toLowerCase();
    if (clientName.includes("cursor")) return "cursor";
    if (clientName.includes("codex")) return "codex";
    if (clientName.includes("windsurf")) return "windsurf";
    if (clientName.includes("trae")) return "trae";
    if (clientName.includes("qoder")) return "qoder";
    if (clientName.includes("deepseek") || clientName.includes("dsh")) return "deepseek";
    return "mcp";
  }

  server.server.oninitialized = () => {
    billing.track?.("plugin_activate", 1, detectMcpHost());
  };

  function hasIdeEditorExtension(): boolean {
    const clientName = server.server.getClientVersion()?.name ?? "";
    let extDir: string | null = null;
    if (/cursor/i.test(clientName)) {
      extDir = join(process.env.INKMAP_CURSOR_CONFIG_DIR || join(homedir(), ".cursor"), "extensions");
    } else if (/visual studio code|vscode/i.test(clientName)) {
      extDir = join(homedir(), ".vscode", "extensions");
    }
    if (!extDir || !existsSync(extDir)) return false;
    try {
      return readdirSync(extDir).some(entry => entry.toLowerCase().startsWith("inkmap.inkmap-vscode"));
    } catch {
      return false;
    }
  }

  function hostSupportsEmbeddedUi(): boolean {
    if (getUiCapability(server.server.getClientCapabilities())) return true;
    if (isAntigravityHost()) return true;
    return false;
  }

  async function waitForEditorBridgeAck(seq: number, timeoutMs = 280): Promise<boolean> {
    if (!seq) return false;
    const inkmapDir = process.env.INKMAP_HOME || join(homedir(), ".inkmap");
    const ackPath = join(inkmapDir, "antigravity-target-ack.json");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const raw = JSON.parse(await readFile(ackPath, "utf8"));
        if (raw && raw.ok === true && Number(raw.seq) >= seq) {
          return true;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 45));
    }
    return false;
  }

  async function openFallbackBrowserEditor(filePath: string, launchSystemBrowser = true): Promise<string | undefined> {
    const webRoot = resolveWebRoot();
    if (!webRoot) return undefined;
    let pending = fallbackEditors.get("__workspace__");
    if (!pending) {
      pending = (async () => {
        const source = await fileSource(filePath);
        browserBilling ??= licenseService(fileSessionStorage(), billingOrigin);
        return serve({
          source,
          webRoot,
          port: 0,
          license: browserBilling,
          ads,
          sidebar: false,
          loginOnly: false,
          ideWorkspace: false,
        });
      })();
      fallbackEditors.set("__workspace__", pending);
      pending.catch(() => fallbackEditors.delete("__workspace__"));
    }
    const served = await pending;
    await served.switchToFile?.(filePath).catch(() => {});
    if (launchSystemBrowser) {
      openSystemBrowser(served.url);
    }
    return served.url;
  }

  async function disposeAll() {
    billing.dispose();
    browserBilling?.dispose();
    const editors = [...fallbackEditors.values()];
    fallbackEditors.clear();
    await Promise.allSettled(editors.map(async p => (await p).close()));
  }

  registerAppResource(server, "Inkmap Markdown editor", UI, {
    _meta: { ui: { prefersBorder: false } },
  }, async () => ({
    contents: [{ uri: UI, mimeType: RESOURCE_MIME_TYPE, text: await loadHtml() }],
  }));

  // OpenAI Codex Desktop file-viewer entrypoint
  registerAppTool(server, "inkmap_open_markdown", {
    title: "Inkmap Mind Map",
    description: "View the selected Markdown document as an Inkmap mind map.",
    inputSchema: { file: z.object({ name: z.string(), resourceUri: z.string() }) },
    annotations: { readOnlyHint: true },
    _meta: {
      ui: { resourceUri: UI, visibility: ["app"] },
      "openai/ui": { entrypoints: [{ type: "file", extensions: [".md"] }] },
    },
  }, async () => ({ content: [] }));

  // Universal / Google Antigravity MCP App entrypoint (with automatic right-pane tab support for Cursor / VS Code)
  registerAppTool(server, "inkmap_open", {
    title: "Inkmap",
    description: "Open and edit a local Markdown (.md, .markmap.md) outline as an interactive Inkmap mind map.",
    inputSchema: {
      path: z.string().optional().describe("Absolute or workspace-relative path to a .md or .markmap.md file. Omit to open the active or most recent Markdown outline."),
      workspace: z.string().optional().describe("Optional workspace root directory path."),
    },
    annotations: { readOnlyHint: true },
    _meta: {
      ui: { resourceUri: UI },
      "com.google.antigravity/ui": {
        entrypoints: [
          { type: "aux_pane", title: "Inkmap" },
          { type: "global", title: "Inkmap" },
        ],
      },
    },
  }, async ({ path, workspace }) => {
    billing.track?.("doc_open", 1, detectMcpHost());
    const cursorHost = isCursorHost();
    const openInRightEditor = hasIdeEditorExtension() || cursorHost;
    const [opened, license] = await Promise.all([
      workspaces.open({ path, workspace, fromModel: true, openInEditorPane: openInRightEditor }),
      billing.state(),
    ]);
    let ackedByExtension = false;
    if (openInRightEditor && opened.currentFile && opened.targetSeq) {
      ackedByExtension = await waitForEditorBridgeAck(opened.targetSeq, 260);
    }
    let editorUrl: string | undefined;
    if (opened.currentFile && (cursorHost || (!openInRightEditor && !hostSupportsEmbeddedUi()))) {
      const shouldLaunchSystemBrowser = !cursorHost && !openInRightEditor && !hostSupportsEmbeddedUi();
      editorUrl = await openFallbackBrowserEditor(opened.currentFile, shouldLaunchSystemBrowser).catch(() => undefined);
    }
    const includeDoc = Buffer.byteLength(opened.doc.md, "utf8") <= INLINE_DOC_LIMIT;
    const summary = ackedByExtension && opened.currentFile
      ? `Opened ${opened.currentFile} in the editor pane as an Inkmap mind map.`
      : cursorHost && editorUrl && opened.currentFile
        ? `Opened ${opened.currentFile} in Inkmap at ${editorUrl}. IMPORTANT: Immediately call browser_navigate (from cursor-ide-browser) with {"url": "${editorUrl}", "newTab": true, "position": "side"} so the mind map opens and activates visibly in the right-hand preview pane (fallback to open_resource with uri "${editorUrl}" only if browser_navigate is unavailable), and include the clickable link [在右侧预览区打开思维导图](${editorUrl}) in your reply.`
        : editorUrl
          ? `Opened ${opened.currentFile} in Inkmap interactive mind map at ${editorUrl} (live two-way synced with your Markdown file).`
          : opened.currentFile
            ? `Opened ${opened.currentFile} in Inkmap mind map.`
            : "Opened Inkmap mind map panel.";
    return {
      content: [{ type: "text", text: summary }],
      structuredContent: {
        mode: "mcp-workspace",
        files: opened.files,
        currentFile: opened.currentFile,
        currentFileUri: opened.currentFileUri,
        targetSeq: opened.targetSeq,
        license: { ...license },
        ...(openInRightEditor && { openedInEditorPane: true }),
        ...(ackedByExtension && { ackedByExtension: true }),
        ...(editorUrl && { editorUrl }),
        ...(includeDoc && { doc: opened.doc }),
      },
    };
  });

  // App-only workspace file tools
  server.registerTool("inkmap_doc_open", {
    title: "Open workspace Markdown document",
    inputSchema: {
      path: z.string().optional(),
      workspace: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
    _meta: appOnly,
  }, async ({ path, workspace }) => {
    billing.track?.("doc_open", 1, detectMcpHost());
    const [opened, license] = await Promise.all([
      workspaces.open({ path, workspace, fromModel: false }),
      billing.state(),
    ]);
    return {
      content: [],
      structuredContent: {
        files: opened.files,
        currentFile: opened.currentFile,
        currentFileUri: opened.currentFileUri,
        targetSeq: opened.targetSeq,
        license: { ...license },
        doc: opened.doc,
      },
    };
  });

  server.registerTool("inkmap_doc_poll", {
    title: "Poll Markdown document changes",
    inputSchema: {
      file: z.string().optional(),
      version: z.string().optional(),
      targetSeq: z.number().optional(),
    },
    annotations: { readOnlyHint: true },
    _meta: appOnly,
  }, async ({ file, version, targetSeq }) => {
    const polled = await workspaces.poll({ file, version, targetSeq });
    return { content: [], structuredContent: { ...polled } };
  });

  server.registerTool("inkmap_doc_save", {
    title: "Save Markdown document from Inkmap",
    inputSchema: {
      file: z.string().optional(),
      md: z.string(),
      baseVersion: z.string().optional(),
    },
    annotations: { destructiveHint: false },
    _meta: appOnly,
  }, async ({ file, md, baseVersion }) => {
    if (!hasAccess(await billing.state())) {
      throw new Error("Inkmap 免费试用已到期，请登录已购账号恢复 Pro 权益。");
    }
    const saved = await workspaces.save({ file, md, baseVersion });
    if (saved.ok) billing.track?.("doc_edit", 1, detectMcpHost());
    return { content: [], structuredContent: { ...saved } };
  });

  server.registerTool("inkmap_doc_view", {
    title: "Persist Inkmap fold and viewport state",
    inputSchema: {
      file: z.string().optional(),
      state: z.unknown(),
    },
    annotations: { destructiveHint: false },
    _meta: appOnly,
  }, async ({ file, state }) => {
    const saved = await workspaces.saveView({ file, state });
    return { content: [], structuredContent: { ...saved } };
  });

  server.registerTool("inkmap_open_browser", {
    title: "Open current Markdown mind map in standalone browser window",
    inputSchema: {
      file: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
    _meta: appOnly,
  }, async ({ file }) => {
    if (!hasAccess(await billing.state())) {
      throw new Error("Inkmap 免费试用已到期，请登录已购账号恢复 Pro 权益。");
    }
    const opened = await workspaces.open({ path: file, fromModel: false });
    if (!opened.currentFile) throw new Error("未选择 Markdown 文件。");
    billing.track?.("feature_browser", 1, detectMcpHost());
    const url = await openFallbackBrowserEditor(opened.currentFile);
    return { content: [], structuredContent: { url: url ?? "" } };
  });

  server.registerTool("inkmap_focus_editor", {
    title: "Focus or reopen Markdown mind map in IDE editor pane",
    inputSchema: {
      file: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
    _meta: appOnly,
  }, async ({ file }) => {
    const opened = await workspaces.open({ path: file, fromModel: false });
    if (!opened.currentFile) throw new Error("未选择 Markdown 文件。");
    const url = await openFallbackBrowserEditor(opened.currentFile, false);
    const payload = await writeTargetSelection(opened.currentFile, undefined, {
      openInEditorPane: true,
      ...(url && { editorUrl: url }),
    });
    const acked = await waitForEditorBridgeAck(payload.seq, 450);
    if (acked) {
      return { content: [], structuredContent: { ok: true, handledBy: "extension", url: url ?? "" } };
    }
    return { content: [], structuredContent: { ok: true, handledBy: "glass", url: url ?? "" } };
  });

  // App-only membership & sign-in tools
  server.registerTool("inkmap_access", {
    title: "Check Inkmap access", annotations: { readOnlyHint: true }, _meta: appOnly,
  }, async () => ({ content: [], structuredContent: { ...await billing.state() } }));

  server.registerTool("inkmap_restore_access", {
    title: "Sign in to Yunfan",
    inputSchema: { locale: z.string().optional() },
    annotations: { destructiveHint: false },
    _meta: appOnly,
  }, async ({ locale }) => ({ content: [], structuredContent: { url: await billing.connect("restore", locale) } }));

  server.registerTool("inkmap_phone_send", {
    title: "Send phone verification code",
    inputSchema: { phone: z.string(), locale: z.string().optional() },
    annotations: { destructiveHint: false },
    _meta: appOnly,
  }, async ({ phone, locale }) => ({ content: [], structuredContent: { result: await billing.sendPhoneCode(phone, locale) } }));

  server.registerTool("inkmap_phone_verify", {
    title: "Verify phone sign-in code",
    inputSchema: { phone: z.string(), code: z.string() },
    annotations: { destructiveHint: false },
    _meta: appOnly,
  }, async ({ phone, code }) => ({ content: [], structuredContent: { result: await billing.signInByPhone(phone, code) } }));

  server.registerTool("inkmap_disconnect_access", {
    title: "Disconnect Inkmap access", annotations: { destructiveHint: true }, _meta: appOnly,
  }, async () => {
    await billing.deactivate();
    return { content: [] };
  });

  return { server, billing, workspaces, dispose: disposeAll };
}

export async function serveCodex() {
  const { server, dispose } = await createInkmapMcpServer();
  const transport = new StdioServerTransport();
  server.server.onclose = () => {
    void dispose();
  };
  await server.connect(transport);
}
