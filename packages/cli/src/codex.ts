import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { YUNFAN_BILLING_ORIGIN } from "@inkmap/core";
import { fileSessionStorage, licenseService } from "./license.js";

const UI = "ui://inkmap/markdown.html";
const HTML = new URL("./codex.html", import.meta.url);
const appOnly = { ui: { visibility: ["app" as const] } };

export async function serveCodex() {
  const html = await readFile(HTML, "utf8").catch(error => {
    if (error.code === "ENOENT") throw new Error("Codex editor assets are missing. Run npm run build:sidebars.");
    throw error;
  });
  const billing = licenseService(fileSessionStorage(), () => process.env.INKMAP_BILLING_ORIGIN || YUNFAN_BILLING_ORIGIN, { loginOnly: true });
  const server = new McpServer({ name: "inkmap", version: "0.1.0" });
  registerAppResource(server, "Inkmap Markdown editor", UI, {}, async () => ({
    contents: [{ uri: UI, mimeType: RESOURCE_MIME_TYPE, text: html }],
  }));
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
  server.registerTool("inkmap_access", {
    title: "Check Inkmap access", annotations: { readOnlyHint: true }, _meta: appOnly,
  }, async () => ({ content: [], structuredContent: { ...await billing.state() } }));
  server.registerTool("inkmap_restore_access", {
    title: "Sign in to Yunfan", annotations: { destructiveHint: false }, _meta: appOnly,
  }, async () => ({ content: [], structuredContent: { url: await billing.connect("restore") } }));
  server.registerTool("inkmap_disconnect_access", {
    title: "Disconnect Inkmap access", annotations: { destructiveHint: true }, _meta: appOnly,
  }, async () => {
    await billing.deactivate();
    return { content: [] };
  });
  const transport = new StdioServerTransport();
  server.server.onclose = () => billing.dispose();
  await server.connect(transport);
}
