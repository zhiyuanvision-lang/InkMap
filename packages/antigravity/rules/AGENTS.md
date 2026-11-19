# Inkmap Mind Map Auto-Entrypoint Rule

Whenever you create, update, or link to a local Markdown deliverable, outline, plan, specification, or draft (`.md` or `.markmap.md` — excluding internal config files like `AGENTS.md`, `GEMINI.md`, `SKILL.md`, `LICENSE.md`, or `CHANGELOG.md`):

1. **Sync Active Document**: Call `inkmap_open` on MCP server `inkmap_inkmap` (`call_mcp_tool` with `ServerName: "inkmap_inkmap"`, `ToolName: "inkmap_open"`, `Arguments: {"path": "/absolute/path/to/file.md"}`) so any open Inkmap panel switches to that document automatically.
2. **Append a One-Click Mind Map Pill**: Immediately after the `[filename.md](file:///absolute/path/to/file.md)` link in your response, append a clickable Inkmap sidecar pill on the same line with the URL-encoded absolute file path:
   `[filename.md](file:///absolute/path/to/file.md) · [Inkmap](sidecar://inkmap/inkmap/?file=%2Fabsolute%2Fpath%2Fto%2Ffile.md)`
   (Emit at most one `[Inkmap](sidecar://inkmap/inkmap/...)` pill per message, pointing to the primary `.md` deliverable so clicking `Inkmap` opens the interactive mind map directly in the right-hand auxiliary pane.)
