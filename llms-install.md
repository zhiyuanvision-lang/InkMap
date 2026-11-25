# Inkmap MCP Server — One-Click Installation Guide (`llms-install.md`)

Inkmap (`inkmap-mcp`) is a zero-dependency Node.js (>= 20) MCP server and interactive two-way Markdown mind map (Markmap) & Mermaid flowchart editor. **No API key, cloning, or local build is required.**

## MCP Configuration (`cline_mcp_settings.json`)

Add the following entry under `"mcpServers"` in Cline's MCP settings JSON:

```json
{
  "mcpServers": {
    "inkmap": {
      "command": "npx",
      "args": ["-y", "inkmap-mcp@latest", "mcp"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

## Verification

1. Ensure Node.js 20+ (`node -v`) and `npx` are available on the user's `PATH`.
2. Once added to `cline_mcp_settings.json`, Cline automatically connects over `stdio` and exposes `inkmap_open_markdown` (plus live document sync tools) to open any local `.md` or `.markmap.md` file as a two-way interactive mind map and Mermaid diagram editor.
