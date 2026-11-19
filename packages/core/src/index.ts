type NodeKind = "heading" | "item" | "block";

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
  /** Original line ending (`"\r\n"` on CRLF documents, `"\n"` otherwise). */
  eol?: "\n" | "\r\n";
  /** Trailing thematic break (`---`, `***`, `___`) lines at the end of the document. */
  trailingDividers?: DividerLine[];
  /** True when the file starts with a UTF-8 byte order mark, which is written back unchanged. */
  bom?: true;
}

const THEMATIC_BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const ITEM = /^(\s*)([-*+]|\d+[.)])(?:([ \t]+)(.*))?$/;
// A top-level YAML key: quoted, or plain text (any language, spaces and inner colons allowed) ending in `: ` or `:`.
const YAML_KEY = /^(?:"[^"]*"|'[^']*'|[^\s#"'-].*?)[ \t]*:(?:[ \t]|$)/;
const TITLE_LINE = /^title:[ \t]*(\S.*)$/m;

type FenceState = { char: "`" | "~"; len: number };

const indentOf = (line: string) => line.length - line.trimStart().length;
const isBlank = (line: string) => line.trim() === "";

function parseHeading(line: string): { level: number; text: string } | null {
  const m = /^(#{1,6})(?:[ \t]+(.*))?$/.exec(line);
  if (!m) return null;
  const rest = (m[2] ?? "").replace(/[ \t]+$/, "");
  const text = /^#+$/.test(rest) ? "" : rest.replace(/[ \t]+#+$/, "").replace(/[ \t]+$/, "");
  return { level: m[1].length, text };
}

function openFence(line: string): FenceState | null {
  const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  const char = m[1][0] as "`" | "~";
  if (char === "`" && m[2].includes("`")) return null;
  return { char, len: m[1].length };
}

function closesFence(line: string, fence: FenceState): boolean {
  const m = /^\s*(`{3,}|~{3,})[ \t]*$/.exec(line);
  return Boolean(m && m[1][0] === fence.char && m[1].length >= fence.len);
}

function isFrontMatterBlock(lines: string[], end: number): boolean {
  if (end === 1) return true;
  if (isBlank(lines[1])) return false;
  let hasKey = false;
  for (let k = 1; k < end; k++) {
    const ln = lines[k];
    // Comments, indented continuation lines and compact sequences (`tags:\n- a`) belong to the previous key.
    if (isBlank(ln) || /^[ \t]*#/.test(ln) || /^[ \t]+/.test(ln) || /^-[ \t]/.test(ln)) continue;
    if (!YAML_KEY.test(ln)) return false;
    hasKey = true;
  }
  return hasKey;
}

/**
 * The value of a one-line YAML scalar: double quotes are unescaped, single quotes un-doubled, and a comment after a
 * quoted value is dropped. Plain values keep ` #` text unless `stripComment` is set (free text such as a title).
 */
function yamlScalar(raw: string, stripComment: boolean): string {
  const double = /^"((?:[^"\\]|\\.)*)"(?:[ \t]+#.*)?$/.exec(raw);
  if (double) {
    try {
      return JSON.parse(`"${double[1]}"`);
    } catch {
      return double[1];
    }
  }
  const single = /^'((?:[^']|'')*)'(?:[ \t]+#.*)?$/.exec(raw);
  if (single) return single[1].replace(/''/g, "'");
  return (stripComment ? raw.replace(/[ \t]+#.*$/, "") : raw).trim();
}

/** The `title:` value of a front matter block, ignoring empty values and YAML block scalars (`>` / `|`). */
export function frontMatterTitle(frontMatter: string): string | undefined {
  const value = frontMatter.replace(/\r\n?/g, "\n").match(TITLE_LINE)?.[1].trim();
  if (!value || /^[>|][-+]?$/.test(value)) return undefined;
  return yamlScalar(value, false) || undefined;
}

/**
 * Returns `frontMatter` with `title:` set to `title` (written as a double-quoted YAML string), replacing any existing
 * `title:` entry including the indented lines of a block scalar, or creating the front matter when there is none.
 */
export function withFrontMatterTitle(frontMatter: string, title: string, eol?: "\n" | "\r\n"): string {
  const nl = eol ?? (frontMatter.includes("\r\n") ? "\r\n" : "\n");
  const line = `title: ${JSON.stringify(title.replace(/\s*\r?\n\s*/g, " "))}`;
  const norm = frontMatter.replace(/\r\n?/g, "\n");
  let updated: string;
  if (!norm) updated = `---\n${line}\n---\n`;
  else if (/^title:/m.test(norm)) updated = norm.replace(/^title:.*(?:\n[ \t]+.*)*$/m, () => line);
  else updated = norm.replace(/---\n?$/, () => `${line}\n---\n`);
  return nl === "\r\n" ? updated.replace(/\n/g, "\r\n") : updated;
}

/** Appends the closing fence when `md` leaves a code fence open, so it cannot swallow the Markdown that follows. */
function closeOpenFence(md: string): string {
  let fence: FenceState | null = null;
  for (const line of md.split("\n")) {
    if (fence) {
      if (closesFence(line, fence)) fence = null;
    } else {
      fence = openFence(line);
    }
  }
  return fence ? `${md}\n${fence.char.repeat(fence.len)}` : md;
}

/**
 * Keeps typed node text from being re-read as something else on reload. `prefix` is what precedes the first line
 * (`"- "` for an item, `""` for a paragraph): `- --` would become a thematic break, and a `\`\`\`` line would open a
 * fence that swallows everything written after it. `followed` is false for the last node of the document, whose
 * unclosed fence is valid Markdown and is kept byte for byte.
 */
function protectText(prefix: string, md: string, followed: boolean): string {
  const [first] = md.split("\n", 1);
  if (THEMATIC_BREAK.test(prefix + first) || (followed && !md.includes("\n") && openFence(md))) md = "\\" + md;
  return followed ? closeOpenFence(md) : md;
}

export function parse(source: string, title = "Untitled"): OutlineDoc {
  const bom = source.startsWith("\uFEFF");
  const markdown = bom ? source.slice(1) : source;
  const eol: "\n" | "\r\n" = markdown.includes("\r\n") ? "\r\n" : "\n";
  const text = markdown.replace(/\r\n?/g, "\n");
  const trailingNewline = markdown === "" ? true : text.endsWith("\n");
  const lines = text === "" ? [""] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");

  let frontMatter = "";
  let i = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0 && isFrontMatterBlock(lines, end)) {
      frontMatter = lines.slice(0, end + 1).join("\n") + "\n";
      i = end + 1;
      title = frontMatterTitle(frontMatter) ?? title;
    }
  }

  const top: OutlineNode = { md: title, kind: "heading", level: 0, children: [] };
  // Stack of open containers. Items carry the column their content starts at.
  type Frame = { node: OutlineNode; indent: number; content: number; heading?: number };
  const stack: Frame[] = [{ node: top, indent: -1, content: 0, heading: 0 }];
  let blank = 0;
  let leadingBlank = -1;
  let fence: FenceState | null = null;
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
    if (fence) {
      appendLine(current!, line);
      if (closesFence(line, fence)) {
        fence = null;
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
    let item = isThematic ? null : ITEM.exec(line);
    // An empty list item cannot interrupt a paragraph, so a lone `-` or `2024.` line continues it (as in CommonMark).
    if (item && item[4] === undefined && !blank && current?.node.kind === "block") item = null;
    const heading = item ? null : parseHeading(line);

    if (current && !item && !heading && (indent >= current.content || (!blank && current.node.kind === "item" && indent > 0))) {
      flushBlank(current);
      appendLine(current, line);
      fence = openFence(line);
      continue;
    }

    if (heading) {
      const { level, text: headingText } = heading;
      while (stack.length > 1 && (stack[stack.length - 1].heading === undefined || stack[stack.length - 1].heading! >= level)) stack.pop();
      const node: OutlineNode = { md: headingText, kind: "heading", level, children: [] };
      attach(node);
      stack.push({ node, indent: -1, content: 0, heading: level });
      current = null;
      continue;
    }

    if (item) {
      while (stack.length > 1 && stack[stack.length - 1].heading === undefined && stack[stack.length - 1].indent >= indent) stack.pop();
      const itemText = item[4] ?? "";
      const node: OutlineNode = { md: itemText, kind: "item", marker: item[2], children: [] };
      attach(node);
      current = { node, indent, content: indent + item[2].length + (item[3]?.length ?? 1) };
      stack.push(current);
      fence = openFence(itemText);
      continue;
    }

    // An unindented fenced block on the very next line after a list item (e.g. `- 正文：\n```markdown`) attaches under that item.
    const startedFence = openFence(line);
    if (!blank && indent === 0 && startedFence && current && current.node.kind === "item") {
      const node: OutlineNode = { md: line, kind: "block", unindentedBlock: true, children: [] };
      attach(node);
      current = { node, indent: 0, content: 0 };
      fence = startedFence;
      continue;
    }

    // A paragraph, table or other block outside any list item.
    while (stack.length > 1 && stack[stack.length - 1].heading === undefined) stack.pop();
    const node: OutlineNode = { md: line.slice(indent), kind: "block", children: [] };
    attach(node);
    current = { node, indent, content: indent };
    fence = startedFence;
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
  const extras = { ...(trailingDividers && { trailingDividers }), ...(bom && { bom: true as const }) };
  if (tops.length === 1 && tops[0].kind === "heading") {
    return { frontMatter, leadingBlank, root: tops[0], syntheticRoot: false, trailingNewline, eol, ...extras };
  }
  return { frontMatter, leadingBlank, root: top, syntheticRoot: true, trailingNewline, eol, ...extras };
}

export function serialize(doc: OutlineDoc): string {
  return serializeWithLines(doc).md;
}

/** Serializes the document and reports the zero-based line where each node starts. */
export function serializeWithLines(doc: OutlineDoc): { md: string; lines: Map<OutlineNode, number> } {
  const out: string[] = [];
  const lines = new Map<OutlineNode, number>();
  const eol = doc.eol ?? "\n";
  const normFm = doc.frontMatter ? doc.frontMatter.replace(/\r\n?/g, "\n") : "";
  const offset = normFm ? normFm.split("\n").length - 1 : 0;
  const blanks = (n = 0) => { for (let k = 0; k < n; k++) out.push(""); };
  const pushLines = (first: string, md: string, pad: string) => {
    const [head, ...rest] = md.replace(/\r\n?/g, "\n").split("\n");
    out.push(head === "" ? first.trimEnd() : first + head);
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

  // The last node in document order; anything written before it is followed by more Markdown.
  let lastNode = doc.root;
  while (lastNode.children.length) lastNode = lastNode.children[lastNode.children.length - 1];
  const followed = (node: OutlineNode) => node !== lastNode || Boolean(doc.trailingDividers?.length);
  const writtenRaw = (node: OutlineNode, parent: OutlineNode) =>
    node.kind === "block" && node.children.length === 0 && (parent.kind === "heading" || Boolean(node.unindentedBlock));

  const write = (node: OutlineNode, parent: OutlineNode, indent: number, headingLevel: number, first = false) => {
    // Blank lines around headings and blocks do not carry over once they are written as list items.
    const keepSectionSpacing = parent.kind === "heading" || node.kind === "item";
    const hadDividers = parent.kind === "heading" ? emitDividers(node.dividersBefore, first) : false;
    if (!first || hadDividers) blanks(keepSectionSpacing ? node.blankBefore : 0);
    // An empty item right below a paragraph line would be read back as part of that paragraph.
    const prev = parent.children[parent.children.indexOf(node) - 1];
    if (node.kind === "item" && node.md.split("\n", 1)[0] === "" && prev && writtenRaw(prev, parent) && out.at(-1)) out.push("");
    lines.set(node, offset + out.length);
    if (node.kind === "heading" && parent.kind === "heading" && headingLevel < 6 && !/\r|\n/.test(node.md)) {
      const level = node.level && node.level > headingLevel && node.level <= 6 ? node.level : headingLevel + 1;
      pushLines("#".repeat(level) + " ", node.md, "");
      node.children.forEach(c => write(c, node, 0, level));
      return;
    }
    if (writtenRaw(node, parent)) {
      pushLines("", protectText("", node.md, followed(node)), "");
      return;
    }
    const marker = node.kind === "item" && node.marker ? node.marker : "-";
    const pad = " ".repeat(indent);
    pushLines(pad + marker + " ", protectText(marker + " ", node.md, followed(node)), " ".repeat(indent + marker.length + 1));
    node.children.forEach(c => write(c, node, indent + marker.length + 1, headingLevel));
  };

  blanks(doc.leadingBlank);
  if (doc.syntheticRoot) {
    lines.set(doc.root, offset + out.length);
    doc.root.children.forEach((c, k) => write(c, doc.root, 0, 0, k === 0));
  } else {
    const level = Math.min(doc.root.level || 1, 6);
    if (emitDividers(doc.root.dividersBefore, true)) {
      blanks(doc.root.blankBefore);
    }
    lines.set(doc.root, offset + out.length);
    pushLines("#".repeat(level) + " ", doc.root.md.replace(/\s*\r?\n\s*/g, " "), "");
    doc.root.children.forEach(c => write(c, doc.root, 0, level));
  }
  emitDividers(doc.trailingDividers, out.length === 0);
  const body = out.join(eol);
  const fmOut = eol === "\r\n" ? normFm.replace(/\n/g, "\r\n") : normFm;
  // Front matter already ends with a line break; only a non-empty body needs a trailing one.
  return { md: (doc.bom ? "\uFEFF" : "") + fmOut + body + (doc.trailingNewline && out.length > 0 ? eol : ""), lines };
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
  const norm = frontMatter.replace(/\r\n?/g, "\n");
  const section = norm.match(SETTINGS_SECTION)?.[1] ?? "";
  const raw = section.match(new RegExp(`^[ \\t]+${key}:[ \\t]*(.*)$`, "m"))?.[1].trim();
  return (raw && yamlScalar(raw, true)) || undefined;
}

/** Returns `frontMatter` with `inkmap.<key>` set, creating the front matter or section if needed. */
export function withDocumentSetting(frontMatter: string, key: string, value: string): string {
  const eol = frontMatter.includes("\r\n") ? "\r\n" : "\n";
  const norm = frontMatter.replace(/\r\n?/g, "\n");
  const line = `  ${key}: ${value}\n`;
  let updated: string;
  if (!norm) updated = `---\ninkmap:\n${line}---\n`;
  else {
    const section = norm.match(SETTINGS_SECTION);
    if (!section) updated = norm.replace(/---\n$/, `inkmap:\n${line}---\n`);
    else {
      const keyLine = new RegExp(`^[ \\t]+${key}:.*\\n`, "m");
      const body = keyLine.test(section[1]) ? section[1].replace(keyLine, line) : section[1] + line;
      updated = norm.replace(SETTINGS_SECTION, `inkmap:\n${body}`);
    }
  }
  return eol === "\r\n" ? updated.replace(/\n/g, "\r\n") : updated;
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
