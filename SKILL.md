---
name: inkmap
description: Open and edit local Markdown (.md, .markmap.md) files as interactive two-way mind maps (Markmap), XMind-style outlines, and Mermaid flowcharts with live file write-back. Use whenever the user asks to view, organize, brainstorm, or edit a mind map, outline, diagram, flowchart, 思维导图, 脑图, 大纲, 流程图, or 架构图.
---

# Inkmap — Interactive Markdown Mind Map & Mermaid Editor

Use the `inkmap` MCP server (`inkmap_open_markdown`) whenever the user wants to visualize or interactively edit a Markdown document, outline, mind map (`markmap`), or Mermaid diagram.

## Workflow
1. Call `inkmap_open_markdown` with the absolute `path` of the `.md` or `.markmap.md` file (if the user asks to create a new mind map from scratch or from notes, write a clean structured Markdown heading/list file in the workspace first, then call `inkmap_open_markdown` on it).
2. Edits made by the user on the interactive Inkmap canvas (adding/moving/editing nodes, switching layouts/themes, editing Mermaid flowcharts or LaTeX math) are automatically written back to the underlying `.md` file in real time while preserving unmodified Markdown lines byte-for-byte.
