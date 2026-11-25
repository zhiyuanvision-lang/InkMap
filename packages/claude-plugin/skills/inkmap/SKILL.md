---
name: inkmap
description: Author, structure, and interactively edit Markdown (.md, .markmap.md) mind maps (Markmap), XMind-style outlines, and Mermaid flowcharts with byte-preserving structure. Use whenever the user asks to create, organize, brainstorm, or visualize a mind map, outline, architecture diagram, flowchart, 思维导图, 脑图, 大纲, 流程图, or 架构图.
---

# Inkmap — Markdown Mind Map & Mermaid Flowchart Workflow

Use this skill whenever the user wants to organize ideas, technical architecture, project plans, study notes, or workflows into clean Markdown mind maps (`.md` / `.markmap.md`) and Mermaid diagrams compatible with **Inkmap**.

## 1. Opening in the Interactive Inkmap Editor

- If the `inkmap` MCP tool (`inkmap_open_markdown`) is connected in the current session, call `inkmap_open_markdown` with the workspace file's path after creating or updating the `.md` file so the interactive two-way mind map opens immediately beside the chat.
- If the `inkmap` MCP tool is not yet connected and the user asks to open the interactive visual mind map panel, point them to the official setup guide at https://zhiyuanv.com/software.html or https://github.com/zhiyuanvision-lang/InkMap.

## 2. Authoring Best Practices for Two-Way Mind Map Sync

Inkmap parses standard CommonMark headings and nested lists with **byte-preserving round-trip fidelity**:

1. **Single Root Title**: Start the document with a single `# Title` heading (or YAML front matter `title:` when using top-level lists) so the mind map has one clear central root node.
2. **Balanced Hierarchy**:
   - Use `##` / `###` headings for major branches and nested `- ` or `1. ` list items for deeper leaf nodes (3–5 levels deep, 3–7 sibling items per branch for optimal visual clarity).
   - Keep node labels concise (one clear phrase per bullet); attach rich details as indented continuation blocks (tables, KaTeX math `$...$` / `$$...$$`, or fenced code/Mermaid blocks) directly beneath the bullet item.
3. **Embedded Mermaid Diagrams**:
   - Place ` ```mermaid ` blocks (`flowchart TD/LR`, `sequenceDiagram`, `stateDiagram-v2`, `erDiagram`, `classDiagram`) as indented children of the relevant branch node so Inkmap renders interactive, zoomable diagrams inline inside the mind map node.
   - Always quote Mermaid node labels that contain parentheses, brackets, or punctuation (for example, `step1["Verify Token (JWT)"]`).
4. **Preserve Unmodified Content**: When updating an existing `.md` mind map, edit only the targeted branches so surrounding formatting, blank lines, and list markers remain intact.
