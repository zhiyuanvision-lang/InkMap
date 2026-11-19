/** Source lines stay one visual row so the gutter, highlight, and scroll target match. */
export const MD_LINE_HEIGHT = 20.8;
export const MD_PAD_TOP = 12;

/** Move the Markdown caret to `startLine`–`endLine` and scroll that row into view without stealing focus from the canvas. */
export function revealMarkdownLines(textarea: HTMLTextAreaElement, startLine: number, endLine = startLine) {
  const lines = textarea.value.split("\n");
  const last = Math.max(0, lines.length - 1);
  const sLine = Math.max(0, Math.min(startLine, last));
  const eLine = Math.max(sLine, Math.min(endLine, last));
  let startOffset = 0;
  for (let i = 0; i < sLine; i++) startOffset += (lines[i]?.length ?? 0) + 1;
  let endOffset = startOffset;
  for (let i = sLine; i <= eLine; i++) endOffset += (lines[i]?.length ?? 0) + (i < eLine ? 1 : 0);
  const target = Math.max(0, MD_PAD_TOP + sLine * MD_LINE_HEIGHT - textarea.clientHeight * 0.35);
  if (document.activeElement === textarea) {
    try { textarea.setSelectionRange(startOffset, Math.max(startOffset, endOffset)); } catch {}
  }
  textarea.scrollTop = target;
  textarea.scrollLeft = 0;
  requestAnimationFrame(() => {
    if (!textarea.isConnected) return;
    textarea.scrollTop = target;
    textarea.scrollLeft = 0;
  });
}

/**
 * Character ranges of the Mermaid sources the renderer draws for `md`, in document order: ```mermaid fences at the top
 * level or inside up to two ```markdown fences (which the renderer expands), never ones inside other code blocks.
 * Each range runs from the line after the opening fence to the start of its closing fence (or the end of the text).
 */
export function mermaidSourceRanges(md: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const open: Array<{ char: string; len: number; lang: string; start: number; diagram: boolean }> = [];
  let offset = 0;
  for (const line of md.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    const char = m[1][0];
    const len = m[1].length;
    const info = m[2].trim();
    const top = open.at(-1);
    if (top && char === top.char && len >= top.len && info === "") {
      open.pop();
      if (top.diagram) ranges.push({ start: top.start, end: lineStart });
      continue;
    }
    // Inside a code block that is not Markdown, fence-like lines are just text.
    if (top && top.lang !== "markdown" && top.lang !== "md") continue;
    if (char === "`" && info.includes("`")) continue;
    const lang = info.split(/\s+/)[0].toLowerCase();
    open.push({ char, len, lang, start: Math.min(offset, md.length), diagram: lang === "mermaid" && open.length <= 2 });
  }
  for (const fence of open) if (fence.diagram) ranges.push({ start: fence.start, end: md.length });
  return ranges.sort((a, b) => a.start - b.start);
}
