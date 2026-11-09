export type NodeKind = "heading" | "item" | "block";

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
}

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

  const attach = (node: OutlineNode) => {
    if (leadingBlank < 0) leadingBlank = blank;
    else if (blank) node.blankBefore = blank;
    blank = 0;
    stack[stack.length - 1].node.children.push(node);
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (inFence) {
      if (FENCE.test(line)) inFence = false;
      appendLine(current!, line);
      continue;
    }
    if (isBlank(line)) {
      blank++;
      continue;
    }
    const item = ITEM.exec(line);
    const heading = item ? null : HEADING.exec(line);
    const indent = indentOf(line);

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
  // A document with exactly one top-level heading uses that heading as the root.
  const tops = top.children;
  if (tops.length === 1 && tops[0].kind === "heading") {
    return { frontMatter, leadingBlank, root: tops[0], syntheticRoot: false, trailingNewline };
  }
  return { frontMatter, leadingBlank, root: top, syntheticRoot: true, trailingNewline };
}

export function serialize(doc: OutlineDoc): string {
  const out: string[] = [];
  const blanks = (n = 0) => { for (let k = 0; k < n; k++) out.push(""); };
  const pushLines = (first: string, md: string, pad: string) => {
    const [head, ...rest] = md.split("\n");
    out.push(first + head);
    for (const l of rest) out.push(l === "" ? "" : pad + l);
  };

  const write = (node: OutlineNode, parent: OutlineNode, indent: number, headingLevel: number) => {
    // Blank lines around headings and blocks do not carry over once they are written as list items.
    blanks(parent.kind === "heading" || node.kind === "item" ? node.blankBefore : 0);
    if (node.kind === "heading" && parent.kind === "heading") {
      const level = node.level && node.level > headingLevel ? node.level : headingLevel + 1;
      pushLines("#".repeat(Math.min(level, 6)) + " ", node.md, "");
      node.children.forEach(c => write(c, node, 0, level));
      return;
    }
    if (node.kind === "block" && parent.kind === "heading") {
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
    doc.root.children.forEach((c, k) => write(k === 0 ? { ...c, blankBefore: 0 } : c, doc.root, 0, 0));
  } else {
    const level = doc.root.level || 1;
    pushLines("#".repeat(level) + " ", doc.root.md, "");
    doc.root.children.forEach(c => write(c, doc.root, 0, level));
  }
  const body = out.join("\n");
  return doc.frontMatter + body + (doc.trailingNewline ? "\n" : "");
}

/** True when the Markdown needs rendering rather than plain-text display. */
export function isRich(md: string): boolean {
  return /\n|[`*_\\|<>[\]!~]|^#|^\d+\.\s/.test(md);
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
