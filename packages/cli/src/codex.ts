import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getUiCapability, registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { hasAccess, PRODUCT, YUNFAN_BILLING_ORIGIN } from "@inkmap/core";
import { adFeed, fileSessionStorage, licenseService } from "./license.js";
import { createMcpWorkspaceManager } from "./mcp-files.js";
import { fileSource, serve, type Served } from "./server.js";

const UI = "ui://inkmap/markdown.html";
const HTML = new URL("./codex.html", import.meta.url);
const WEB_ROOT = fileURLToPath(new URL("./web/", import.meta.url));
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
  const html = options.html ?? await readFile(HTML, "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("MCP App editor assets are missing. Run npm run build:sidebars.");
    }
    throw error;
  });
  const billingOrigin = options.billingOrigin ?? (() => process.env.INKMAP_BILLING_ORIGIN || YUNFAN_BILLING_ORIGIN);
  const billing = licenseService(fileSessionStorage(), billingOrigin, { loginOnly: true });
  let browserBilling: ReturnType<typeof licenseService> | undefined;
  const fallbackEditors = new Map<string, Promise<Served>>();
  const ads = adFeed(PRODUCT.adFeedUrl);
  const workspaces = createMcpWorkspaceManager();
  const server = new McpServer({ name: "inkmap", version: "0.2.6" });

  function isAntigravityHost(): boolean {
    const clientName = server.server.getClientVersion()?.name ?? "";
    if (/antigravity/i.test(clientName)) return true;
    if (/[/\\]plugins[/\\]inkmap[/\\]/.test(process.argv[1] ?? "")) return true;
    return false;
  }

  function hostSupportsEmbeddedUi(): boolean {
    if (getUiCapability(server.server.getClientCapabilities())) return true;
    if (isAntigravityHost()) return true;
    return false;
  }

  async function openFallbackBrowserEditor(filePath: string): Promise<string | undefined> {
    if (!existsSync(WEB_ROOT)) return undefined;
    let pending = fallbackEditors.get(filePath);
    if (!pending) {
      browserBilling ??= licenseService(fileSessionStorage(), billingOrigin);
      pending = (async () => {
        const source = await fileSource(filePath);
        return serve({
          source,
          webRoot: WEB_ROOT,
          port: 0,
          license: browserBilling,
          ads,
          sidebar: false,
        });
      })();
      fallbackEditors.set(filePath, pending);
      pending.catch(() => fallbackEditors.delete(filePath));
    }
    const served = await pending;
    openSystemBrowser(served.url);
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
    contents: [{ uri: UI, mimeType: RESOURCE_MIME_TYPE, text: html }],
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

  // Universal / Google Antigravity MCP App entrypoint (with automatic local browser fallback for Cursor / Claude Code)
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
    const [opened, license] = await Promise.all([
      workspaces.open({ path, workspace, fromModel: true }),
      billing.state(),
    ]);
    let editorUrl: string | undefined;
    if (opened.currentFile && !hostSupportsEmbeddedUi()) {
      editorUrl = await openFallbackBrowserEditor(opened.currentFile).catch(() => undefined);
    }
    const includeDoc = Buffer.byteLength(opened.doc.md, "utf8") <= INLINE_DOC_LIMIT;
    const summary = editorUrl
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

  // App-only membership & sign-in tools
  server.registerTool("inkmap_access", {
    title: "Check Inkmap access", annotations: { readOnlyHint: true }, _meta: appOnly,
  }, async () => ({ content: [], structuredContent: { ...await billing.state() } }));

  server.registerTool("inkmap_restore_access", {
    title: "Sign in to Yunfan", annotations: { destructiveHint: false }, _meta: appOnly,
  }, async () => ({ content: [], structuredContent: { url: await billing.connect("restore") } }));

  server.registerTool("inkmap_phone_send", {
    title: "Send phone verification code",
    inputSchema: { phone: z.string() },
    annotations: { destructiveHint: false },
    _meta: appOnly,
  }, async ({ phone }) => ({ content: [], structuredContent: { result: await billing.sendPhoneCode(phone) } }));

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
