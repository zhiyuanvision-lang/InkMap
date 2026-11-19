export type NodeKind = "heading" | "item" | "block";

export interface DividerLine {
  blankBefore: number;
  line: string;
}

/** One node of the outline. `md` is the node's own Markdown, without list marker or indentation. */
export interface OutlineNode {
  md: string;
  kind: NodeKind;
  /** Heading level for `heading` nodes. */
  level?: number;
  /** List marker for `item` nodes, e.g. "-" or "1.". */
  marker?: string;
  /** Blank lines written before this node. */
  blankBefore?: number;
  /** True when a top-column fenced block immediately follows a list item (`- label:\n```...`). */
  unindentedBlock?: boolean;
  /** Thematic break (`---`, `***`, `___`) lines appearing before this node. */
  dividersBefore?: DividerLine[];
  children: OutlineNode[];
}

export interface OutlineDoc {
  /** Raw front matter including the `---` fences and trailing newline, or "". */
  frontMatter: string;
  /** Blank lines between the front matter and the first node. */
  leadingBlank: number;
  root: OutlineNode;
  /** True when the root was synthesized because the document has no single top heading. */
  syntheticRoot: boolean;
  trailingNewline: boolean;
  /** Trailing thematic break (`---`, `***`, `___`) lines at the end of the document. */
  trailingDividers?: DividerLine[];
}

const THEMATIC_BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

const indentOf = (line: string) => line.length - line.trimStart().length;
const isBlank = (line: string) => line.trim() === "";

export function parse(markdown: string, title = "Untitled"): OutlineDoc {
  const text = markdown.replace(/\r\n?/g, "\n");
  const trailingNewline = text.endsWith("\n");
  const lines = (trailingNewline ? text.slice(0, -1) : text).split("\n");

  let frontMatter = "";
  let i = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      frontMatter = lines.slice(0, end + 1).join("\n") + "\n";
      i = end + 1;
      const t = frontMatter.match(/^title:\s*(.+)$/m);
      if (t) title = t[1].trim().replace(/^["']|["']$/g, "");
    }
  }

  const top: OutlineNode = { md: title, kind: "heading", level: 0, children: [] };
  // Stack of open containers. Items carry the column their content starts at.
  type Frame = { node: OutlineNode; indent: number; content: number; heading?: number };
  const stack: Frame[] = [{ node: top, indent: -1, content: 0, heading: 0 }];
  let blank = 0;
  let leadingBlank = -1;
  let inFence = false;
  let current: Frame | null = null; // item or block currently receiving continuation lines
  const pendingDividers: DividerLine[] = [];

  const attach = (node: OutlineNode) => {
    if (pendingDividers.length) {
      node.dividersBefore = pendingDividers.splice(0);
    }
    if (leadingBlank < 0) leadingBlank = blank;
    else if (blank) node.blankBefore = blank;
    blank = 0;
    stack[stack.length - 1].node.children.push(node);
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (inFence) {
      appendLine(current!, line);
      if (FENCE.test(line)) {
        inFence = false;
        if (current?.node.unindentedBlock) current = null;
      }
      continue;
    }
    if (isBlank(line)) {
      blank++;
      continue;
    }
    const indent = indentOf(line);
    const isThematic = THEMATIC_BREAK.test(line);
    if (isThematic && (!current || current.node.kind !== "item" || indent < current.content)) {
      while (stack.length > 1 && stack[stack.length - 1].heading === undefined) stack.pop();
      current = null;
      if (leadingBlank < 0) {
        leadingBlank = blank;
        pendingDividers.push({ blankBefore: 0, line });
      } else {
        pendingDividers.push({ blankBefore: blank, line });
      }
      blank = 0;
      continue;
    }
    const item = isThematic ? null : ITEM.exec(line);
    const heading = item ? null : HEADING.exec(line);

    if (current && !item && !heading && (indent >= current.content || (!blank && current.node.kind === "item" && indent > 0))) {
      flushBlank(current);
      appendLine(current, line);
      if (FENCE.test(line)) inFence = true;
      continue;
    }

    if (heading) {
      const level = heading[1].length;
      while (stack.length > 1 && (stack[stack.length - 1].heading === undefined || stack[stack.length - 1].heading! >= level)) stack.pop();
      const node: OutlineNode = { md: heading[2], kind: "heading", level, children: [] };
      attach(node);
      stack.push({ node, indent: -1, content: 0, heading: level });
      current = null;
      continue;
    }

    if (item) {
      while (stack.length > 1 && stack[stack.length - 1].heading === undefined && stack[stack.length - 1].indent >= indent) stack.pop();
      const node: OutlineNode = { md: item[4], kind: "item", marker: item[2], children: [] };
      attach(node);
      current = { node, indent, content: indent + item[2].length + item[3].length };
      stack.push(current);
      if (FENCE.test(item[4])) inFence = true;
      continue;
    }

    // An unindented fenced block on the very next line after a list item (e.g. `- 正文：\n```markdown`) attaches under that item.
    if (!blank && indent === 0 && FENCE.test(line) && current && current.node.kind === "item") {
      const node: OutlineNode = { md: line, kind: "block", unindentedBlock: true, children: [] };
      attach(node);
      current = { node, indent: 0, content: 0 };
      inFence = true;
      continue;
    }

    // A paragraph, table or other block outside any list item.
    while (stack.length > 1 && stack[stack.length - 1].heading === undefined) stack.pop();
    const node: OutlineNode = { md: line.slice(indent), kind: "block", children: [] };
    attach(node);
    current = { node, indent, content: indent };
    if (FENCE.test(line)) inFence = true;
  }

  function flushBlank(frame: Frame) {
    for (; blank > 0; blank--) frame.node.md += "\n";
  }
  function appendLine(frame: Frame, line: string) {
    frame.node.md += "\n" + (isBlank(line) ? "" : line.slice(Math.min(frame.content, indentOf(line))));
  }

  if (leadingBlank < 0) leadingBlank = 0;
  const trailingDividers = pendingDividers.length ? pendingDividers.splice(0) : undefined;
  // A document with exactly one top-level heading uses that heading as the root.
  const tops = top.children;
  if (tops.length === 1 && tops[0].kind === "heading") {
    return { frontMatter, leadingBlank, root: tops[0], syntheticRoot: false, trailingNewline, ...(trailingDividers && { trailingDividers }) };
  }
  return { frontMatter, leadingBlank, root: top, syntheticRoot: true, trailingNewline, ...(trailingDividers && { trailingDividers }) };
}

export function serialize(doc: OutlineDoc): string {
  return serializeWithLines(doc).md;
}

/** Serializes the document and reports the zero-based line where each node starts. */
export function serializeWithLines(doc: OutlineDoc): { md: string; lines: Map<OutlineNode, number> } {
  const out: string[] = [];
  const lines = new Map<OutlineNode, number>();
  const offset = doc.frontMatter ? doc.frontMatter.split("\n").length - 1 : 0;
  const blanks = (n = 0) => { for (let k = 0; k < n; k++) out.push(""); };
  const pushLines = (first: string, md: string, pad: string) => {
    const [head, ...rest] = md.split("\n");
    out.push(first + head);
    for (const l of rest) out.push(l === "" ? "" : pad + l);
  };

  const emitDividers = (divs?: DividerLine[], skipFirstBlank = false) => {
    if (!divs?.length) return false;
    divs.forEach((d, idx) => {
      if (!(skipFirstBlank && idx === 0)) blanks(d.blankBefore);
      out.push(d.line);
    });
    return true;
  };

  const write = (node: OutlineNode, parent: OutlineNode, indent: number, headingLevel: number, first = false) => {
    // Blank lines around headings and blocks do not carry over once they are written as list items.
    const keepSectionSpacing = parent.kind === "heading" || node.kind === "item";
    const hadDividers = parent.kind === "heading" ? emitDividers(node.dividersBefore, first) : false;
    if (!first || hadDividers) blanks(keepSectionSpacing ? node.blankBefore : 0);
    lines.set(node, offset + out.length);
    if (node.kind === "heading" && parent.kind === "heading") {
      const level = node.level && node.level > headingLevel ? node.level : headingLevel + 1;
      pushLines("#".repeat(Math.min(level, 6)) + " ", node.md, "");
      node.children.forEach(c => write(c, node, 0, level));
      return;
    }
    if (node.kind === "block" && (parent.kind === "heading" || node.unindentedBlock)) {
      pushLines("", node.md, "");
      node.children.forEach(c => write(c, node, 0, headingLevel));
      return;
    }
    const marker = node.kind === "item" && node.marker ? node.marker : "-";
    const pad = " ".repeat(indent);
    pushLines(pad + marker + " ", node.md, " ".repeat(indent + marker.length + 1));
    node.children.forEach(c => write(c, node, indent + marker.length + 1, headingLevel));
  };

  blanks(doc.leadingBlank);
  if (doc.syntheticRoot) {
    lines.set(doc.root, offset + out.length);
    doc.root.children.forEach((c, k) => write(c, doc.root, 0, 0, k === 0));
  } else {
    const level = doc.root.level || 1;
    if (emitDividers(doc.root.dividersBefore, true)) {
      blanks(doc.root.blankBefore);
    }
    lines.set(doc.root, offset + out.length);
    pushLines("#".repeat(level) + " ", doc.root.md, "");
    doc.root.children.forEach(c => write(c, doc.root, 0, level));
  }
  emitDividers(doc.trailingDividers, out.length === 0);
  const body = out.join("\n");
  return { md: doc.frontMatter + body + (doc.trailingNewline ? "\n" : ""), lines };
}

/** True when the Markdown needs rendering rather than plain-text display. */
export function isRich(md: string): boolean {
  return /\n|[`*_\\|<>[\]!~]|\$[^\s$][\s\S]*\$|\$\$[\s\S]+\$\$|^#|^\d+\.\s/.test(md);
}

/** Plain-text summary of a node's Markdown, used for search and fallback display. */
export function plainText(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]|\\(?=.)/g, "")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

// ---- per-document settings: an `inkmap:` section in the front matter ----

const SETTINGS_SECTION = /^inkmap:[ \t]*\n((?:[ \t]+.*\n)*)/m;

export function documentSetting(frontMatter: string, key: string): string | undefined {
  const section = frontMatter.match(SETTINGS_SECTION)?.[1] ?? "";
  const value = section.match(new RegExp(`^[ \\t]+${key}:[ \\t]*(.*)$`, "m"))?.[1].trim();
  return value ? value.replace(/^["']|["']$/g, "") : undefined;
}

/** Returns `frontMatter` with `inkmap.<key>` set, creating the front matter or section if needed. */
export function withDocumentSetting(frontMatter: string, key: string, value: string): string {
  const line = `  ${key}: ${value}\n`;
  if (!frontMatter) return `---\ninkmap:\n${line}---\n`;
  const section = frontMatter.match(SETTINGS_SECTION);
  if (!section) return frontMatter.replace(/---\n$/, `inkmap:\n${line}---\n`);
  const keyLine = new RegExp(`^[ \\t]+${key}:.*\\n`, "m");
  const body = keyLine.test(section[1]) ? section[1].replace(keyLine, line) : section[1] + line;
  return frontMatter.replace(SETTINGS_SECTION, `inkmap:\n${body}`);
}

export interface ViewState {
  /** Expanded state of branch nodes, keyed by `\u0000`-joined Markdown path from the root. */
  folds?: Record<string, boolean>;
  /** Canvas zoom and screen-space offset of the root node from the viewport center. */
  view?: { scale: number; dx: number; dy: number };
}

export function sanitizeViewState(raw: unknown): ViewState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  let folds: Record<string, boolean> | undefined;
  if (r.folds && typeof r.folds === "object" && !Array.isArray(r.folds)) {
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(r.folds as Record<string, unknown>).slice(0, 5000)) {
      if (typeof v === "boolean") out[k] = v;
    }
    if (Object.keys(out).length) folds = out;
  }
  let view: { scale: number; dx: number; dy: number } | undefined;
  if (r.view && typeof r.view === "object") {
    const v = r.view as Record<string, unknown>;
    if (
      typeof v.scale === "number" && Number.isFinite(v.scale) && v.scale >= 0.05 && v.scale <= 20 &&
      typeof v.dx === "number" && Number.isFinite(v.dx) && Math.abs(v.dx) < 1e6 &&
      typeof v.dy === "number" && Number.isFinite(v.dy) && Math.abs(v.dy) < 1e6
    ) {
      view = { scale: v.scale, dx: v.dx, dy: v.dy };
    }
  }
  return folds || view ? { ...(folds && { folds }), ...(view && { view }) } : undefined;
}

export * from "./product.js";
