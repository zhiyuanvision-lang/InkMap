/** The colors of the export page, taken from the map's theme. */
export interface ExportPalette {
  background: string;
  card: string;
  text: string;
}

/**
 * A standalone HTML page for an exported map: the map image with zoom and pan, and a drawer with its Markdown source.
 * `showBadge` adds the "Made with Inkmap" link that free and trial exports carry.
 */
export function interactiveExportHtml({ title, svgDataUrl, markdown, palette, showBadge }: {
  title: string;
  svgDataUrl: string;
  markdown: string;
  palette: ExportPalette;
  showBadge: boolean;
}): string {
  const safeTitle = title.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
  const safeMd = markdown.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] || c));
  const badgeHtml = !showBadge
    ? ""
    : `<a class="ink-viral-badge" href="https://zhiyuanv.com/software.html" target="_blank" rel="noopener noreferrer">✨ Made with <strong>Inkmap</strong> — Editable Markdown Mind Map &amp; Mermaid Editor for VS Code / Cursor / MCP ↗</a>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${safeTitle} · Inkmap</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: ${palette.background}; color: ${palette.text}; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; height: 100vh; overflow: hidden; display: flex; flex-direction: column; }
    header { height: 46px; padding: 0 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(128,128,128,0.18); background: ${palette.card}; z-index: 10; }
    .brand { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 600; }
    .actions { display: flex; align-items: center; gap: 8px; }
    button, .cta { padding: 5px 11px; border-radius: 7px; border: 1px solid rgba(128,128,128,0.28); background: transparent; color: inherit; font-size: 12px; cursor: pointer; text-decoration: none; }
    .cta { background: #2563eb; color: #fff; border-color: #2563eb; font-weight: 600; }
    #stage { flex: 1; position: relative; overflow: hidden; cursor: grab; display: flex; align-items: center; justify-content: center; }
    #stage:active { cursor: grabbing; }
    #map-img { max-width: 92vw; max-height: 84vh; transform-origin: center center; transition: transform 0.05s linear; user-select: none; -webkit-user-drag: none; }
    #md-drawer { position: fixed; right: 16px; top: 58px; bottom: 58px; width: min(440px, 90vw); background: ${palette.card}; border: 1px solid rgba(128,128,128,0.25); border-radius: 12px; padding: 14px; display: none; flex-direction: column; gap: 10px; box-shadow: 0 16px 40px rgba(0,0,0,0.22); z-index: 20; }
    #md-drawer.open { display: flex; }
    pre { flex: 1; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; padding: 10px; border-radius: 8px; background: rgba(128,128,128,0.08); }
    .ink-viral-badge { position: fixed; right: 16px; bottom: 14px; padding: 7px 13px; border-radius: 999px; background: rgba(15, 23, 42, 0.86); color: #f8fafc; font-size: 12px; text-decoration: none; box-shadow: 0 6px 20px rgba(0,0,0,0.22); z-index: 30; backdrop-filter: blur(8px); }
    .ink-viral-badge strong { color: #60a5fa; }
  </style>
</head>
<body>
  <header>
    <div class="brand"><span>${safeTitle}</span></div>
    <div class="actions">
      <button type="button" id="zoom-out">−</button>
      <button type="button" id="zoom-reset">100%</button>
      <button type="button" id="zoom-in">+</button>
      <button type="button" id="toggle-md">Markdown</button>
      <a class="cta" href="https://marketplace.visualstudio.com/items?itemName=inkmap.inkmap-vscode" target="_blank" rel="noopener noreferrer">Edit in VS Code / Cursor ↗</a>
    </div>
  </header>
  <div id="stage"><img id="map-img" src="${svgDataUrl.replace(/"/g, "%22")}" alt="${safeTitle}"></div>
  <aside id="md-drawer">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <strong style="font-size:13px">Markdown Source</strong>
      <button type="button" id="copy-md">Copy Markdown</button>
    </div>
    <pre id="md-raw">${safeMd}</pre>
  </aside>
  ${badgeHtml}
  <script>
    (() => {
      const stage = document.getElementById("stage");
      const img = document.getElementById("map-img");
      const drawer = document.getElementById("md-drawer");
      let scale = 1, tx = 0, ty = 0, dragging = false, sx = 0, sy = 0;
      const apply = () => { img.style.transform = \`translate(\${tx}px, \${ty}px) scale(\${scale})\`; };
      stage.addEventListener("wheel", e => {
        e.preventDefault();
        scale = Math.min(5, Math.max(0.25, scale * (e.deltaY < 0 ? 1.1 : 0.9)));
        apply();
      }, { passive: false });
      stage.addEventListener("pointerdown", e => { dragging = true; sx = e.clientX - tx; sy = e.clientY - ty; stage.setPointerCapture(e.pointerId); });
      stage.addEventListener("pointermove", e => { if (!dragging) return; tx = e.clientX - sx; ty = e.clientY - sy; apply(); });
      stage.addEventListener("pointerup", () => { dragging = false; });
      stage.addEventListener("pointercancel", () => { dragging = false; });
      document.getElementById("zoom-in").onclick = () => { scale = Math.min(5, scale * 1.2); apply(); };
      document.getElementById("zoom-out").onclick = () => { scale = Math.max(0.25, scale / 1.2); apply(); };
      document.getElementById("zoom-reset").onclick = () => { scale = 1; tx = 0; ty = 0; apply(); };
      document.getElementById("toggle-md").onclick = () => drawer.classList.toggle("open");
      document.getElementById("copy-md").onclick = e => {
        const raw = document.getElementById("md-raw").textContent || "";
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(raw).catch(() => {});
        } else {
          const ta = document.createElement("textarea");
          ta.value = raw;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); } catch {}
          ta.remove();
        }
        e.target.textContent = "Copied!";
        setTimeout(() => { e.target.textContent = "Copy Markdown"; }, 1500);
      };
    })();
  </script>
</body>
</html>`;
}
