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
  requestAnimationFrame(() => {
    if (!textarea.isConnected) return;
    textarea.scrollTop = target;
  });
}
