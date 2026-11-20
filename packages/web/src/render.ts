import katex from "katex";
import { cachedDiagram, preloadDiagram } from "./diagrams";
import { Marked, type TokenizerAndRendererExtension, type Tokens } from "marked";
import DOMPurify from "dompurify";

const sizes = new Map<string, { width: number; height: number }>();
const IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const HAS_MATH = /\$|\\[([]/;
const MAX_IMAGE_WIDTH = 600;

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const renderMath = (tex: string, displayMode: boolean) =>
  katex.renderToString(tex.trim(), { displayMode, output: "html", throwOnError: false, strict: false });

interface MathToken extends Tokens.Generic {
  tex: string;
  display: boolean;
}

const blockMath: TokenizerAndRendererExtension = {
  name: "blockMath",
  level: "block",
  start: src => src.search(/\$\$|\\\[/),
  tokenizer(src) {
    const m = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src) ?? /^\\\[([\s\S]+?)\\\][ \t]*(?:\n|$)/.exec(src);
    if (!m || !m[1].trim()) return undefined;
    return { type: "blockMath", raw: m[0], tex: m[1], display: true };
  },
  renderer: token => renderMath((token as MathToken).tex, true),
};

const inlineMath: TokenizerAndRendererExtension = {
  name: "inlineMath",
  level: "inline",
  start: src => src.search(/\$|\\[([]/),
  tokenizer(src) {
    const display = /^\$\$(?!\$)([\s\S]+?)\$\$/.exec(src) ?? /^\\\[([\s\S]+?)\\\]/.exec(src);
    if (display && display[1].trim()) return { type: "inlineMath", raw: display[0], tex: display[1], display: true };
    const paren = /^\\\(([\s\S]+?)\\\)/.exec(src);
    if (paren && paren[1].trim()) return { type: "inlineMath", raw: paren[0], tex: paren[1], display: false };
    if (src[0] === "$" && src[1] && !/[\s$]/.test(src[1])) {
      for (let i = 1; i < src.length; i++) {
        const ch = src[i];
        if (ch === "\\") {
          i++;
          continue;
        }
        if (ch === "\n" && src[i + 1] === "\n") break;
        if (ch === "$") {
          const prev = src[i - 1];
          const next = src[i + 1] ?? "";
          if (!/\s/.test(prev) && next !== "$" && !/[0-9]/.test(next)) {
            return { type: "inlineMath", raw: src.slice(0, i + 1), tex: src.slice(1, i), display: false };
          }
          break;
        }
      }
    }
    return undefined;
  },
  renderer: token => renderMath((token as MathToken).tex, (token as MathToken).display),
};

const cjkStrong: TokenizerAndRendererExtension = {
  name: "cjkStrong",
  level: "inline",
  start: src => src.indexOf("**"),
  tokenizer(src) {
    const m = /^\*\*(?!\s)([^\n*]+?(?:\*[^\n*]+?)*?)(?<!\s)\*\*(?!\*)/.exec(src);
    if (!m || !/[\u2014-\u201f\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]/.test(m[0])) return undefined;
    return {
      type: "cjkStrong",
      raw: m[0],
      tokens: this.lexer.inlineTokens(m[1]),
    };
  },
  renderer(token) {
    return `<strong>${this.parser.parseInline(token.tokens!)}</strong>`;
  },
};

export function createRenderer(assetBase: string, privateDocument = false) {
  const resolve = (href: string) => {
    let cleaned = href.trim();
    if (/^file:\/\//i.test(cleaned)) {
      try {
        const u = new URL(cleaned);
        cleaned = decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:\/)/, "$1");
      } catch {}
    }
    const isWebScheme = /^(?:https?:|data:|blob:|vscode-resource:|vscode-webview-resource:)/i.test(cleaned);
    const isLocalAbsolute = !isWebScheme && /^(?:[\\/]|[A-Za-z]:[\\/])/.test(cleaned);
    const hasOtherScheme = !isWebScheme && !isLocalAbsolute && /^[a-z][a-z0-9+.-]*:/i.test(cleaned);
    if (hasOtherScheme) return "";

    if (privateDocument) {
      if (/^data:image\/(?:png|jpeg|gif|webp);base64,[\w+/=]+$/i.test(cleaned)) return cleaned;
      if (isWebScheme || !assetBase) return "";
      if (isLocalAbsolute) {
        return assetBase.endsWith("=") || assetBase.endsWith("/")
          ? assetBase + encodeURIComponent(cleaned)
          : "";
      }
      const target = new URL(cleaned, location.origin + assetBase);
      return target.origin === location.origin && target.pathname.startsWith(assetBase) ? target.href : "";
    }

    if (isWebScheme) return cleaned;
    if (!assetBase) return "";
    if (isLocalAbsolute) {
      if (assetBase.endsWith("=")) return assetBase + encodeURIComponent(cleaned);
      // VS Code webview `assetBase` ends with the document directory path (e.g. `https://...vscode-cdn.net/Users/.../dir/`).
      try {
        const baseUrl = new URL(assetBase, typeof location !== "undefined" ? location.href : "http://127.0.0.1/");
        const basePath = decodeURIComponent(baseUrl.pathname).replace(/^\/([A-Za-z]:\/)/, "$1");
        if (basePath.length > 1 && cleaned.replace(/\\/g, "/").startsWith(basePath)) {
          const sub = cleaned.replace(/\\/g, "/").slice(basePath.length);
          return assetBase + sub.split("/").map(encodeURIComponent).join("/");
        }
      } catch {}
      if (assetBase.endsWith("/")) return assetBase + encodeURIComponent(cleaned);
      return "";
    }

    const rel = cleaned.replace(/^\.\//, "");
    if (!assetBase.endsWith("=")) return assetBase + rel;
    // A query-string base needs one encoding; decode first so `my%20pic.png` is not sent as `my%2520pic.png`.
    let path = rel;
    try {
      path = decodeURIComponent(rel);
    } catch {}
    return assetBase + encodeURIComponent(path);
  };

  const ALERT_LABELS: Record<string, string> = {
    note: "NOTE",
    tip: "TIP",
    important: "IMPORTANT",
    warning: "WARNING",
    caution: "CAUTION",
  };

  let nestedMarkdownDepth = 0;
  const marked = new Marked({
    gfm: true,
    extensions: [blockMath, inlineMath, cjkStrong],
    renderer: {
      html({ raw }: Tokens.HTML | Tokens.Tag) {
        return privateDocument ? escapeAttr(raw) : false;
      },
      blockquote({ tokens }: Tokens.Blockquote) {
        const body = this.parser.parse(tokens);
        const m = /^<p>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]*<br\s*\/?>|[ \t]*\n|[ \t]+)?/i.exec(body);
        if (!m) return `<blockquote>${body}</blockquote>`;
        const kind = m[1].toLowerCase();
        const rest = body.slice(m[0].length);
        const content = rest.startsWith("</p>") ? rest.slice(4) : `<p>${rest}`;
        return `<div class="ink-alert ink-alert-${kind}"><div class="ink-alert-title">${ALERT_LABELS[kind]}</div>${content}</div>`;
      },
      link({ href, tokens }: Tokens.Link) {
        const label = this.parser.parseInline(tokens);
        if (/^\s*(?:javascript|vbscript|data):/i.test(href)) return label;
        if (!privateDocument) return false;
        if (!/^(https?:\/\/|mailto:)/i.test(href)) return label;
        return `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      },
      code({ lang, text }: Tokens.Code) {
        const cleanLang = lang?.trim().toLowerCase() ?? "";
        if ((cleanLang === "markdown" || cleanLang === "md") && nestedMarkdownDepth < 2) {
          nestedMarkdownDepth++;
          try {
            const inner = marked.parse(text, { async: false }) as string;
            return `<div class="ink-embedded-md">${inner}</div>`;
          } finally {
            nestedMarkdownDepth--;
          }
        }
        if (cleanLang !== "mermaid") return false;
        const image = cachedDiagram(text);
        const content = image
          ? `<div class="ink-diagram-viewport"><img class="ink-diagram-image" src="${image.src}" width="${image.width}" height="${image.height}" data-natural-width="${image.naturalWidth}" data-natural-height="${image.naturalHeight}" alt="Mermaid"></div>`
          : `<pre class="ink-diagram-error"><code>${escapeAttr(text)}</code></pre>`;
        const zoomBtn = image ? `<button type="button" class="ink-diagram-zoom"></button>` : "";
        return `<div class="ink-diagram">${content}<div class="ink-diagram-bar">${zoomBtn}<button type="button" class="ink-diagram-edit"></button></div></div>`;
      },
      // Image widths follow the markmap convention of putting the display width in the title.
      image({ href, title, text }: Tokens.Image) {
        const src = resolve(href);
        if (!src) return `<span>${escapeAttr(text || href)}</span>`;
        const natural = sizes.get(src);
        const width = Number(title) || Math.min(natural?.width ?? MAX_IMAGE_WIDTH, MAX_IMAGE_WIDTH);
        const height = natural ? Math.round((natural.height * width) / natural.width) : undefined;
        return `<img src="${escapeAttr(src)}" alt="${escapeAttr(text)}" width="${width}"${height ? ` height="${height}"` : ""}>`;
      },
    },
  });

  /** Mermaid sources in `md`, including those inside ```markdown fences, which the code renderer expands. */
  function collectDiagrams(md: string, out: Set<string>, depth = 0) {
    marked.walkTokens(marked.lexer(md), token => {
      if (token.type !== "code") return;
      const lang = token.lang?.trim().toLowerCase();
      if (lang === "mermaid") out.add(token.text);
      else if ((lang === "markdown" || lang === "md") && depth < 2 && /mermaid/i.test(token.text)) {
        collectDiagrams(token.text, out, depth + 1);
      }
    });
  }

  let mathFontsReady: Promise<unknown> | undefined;

  return {
    render(md: string): string {
      const html = marked.parse(md, { async: false }) as string;
      return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
    },

    /** Loads image sizes and math fonts before layout so node boxes are measured accurately. */
    async preload(mds: string[]): Promise<void> {
      const srcs = new Set<string>();
      const diagramSources = new Set<string>();
      let needsMath = false;
      for (const md of mds) {
        if (!needsMath && HAS_MATH.test(md)) needsMath = true;
        for (const m of md.matchAll(IMAGE)) {
          const src = resolve(m[1]);
          if (src) srcs.add(src);
        }
        if (/mermaid/i.test(md)) collectDiagrams(md, diagramSources);
      }
      if (needsMath && typeof document !== "undefined" && document.fonts) {
        mathFontsReady ??= Promise.all(
          ["1em KaTeX_Main", "italic 1em KaTeX_Math", "1em KaTeX_Size1", "1em KaTeX_AMS"].map(f =>
            document.fonts.load(f).catch(() => {}),
          ),
        );
      }
      await Promise.all([
        mathFontsReady,
        ...[...diagramSources].map(source => preloadDiagram(source)),
        ...[...srcs].filter(src => !sizes.has(src)).map(
          src =>
            new Promise<void>(done => {
              const img = new Image();
              img.onload = () => {
                sizes.set(src, { width: img.naturalWidth, height: img.naturalHeight });
                done();
              };
              img.onerror = () => done();
              img.src = src;
            }),
        ),
      ]);
    },
  };
}
