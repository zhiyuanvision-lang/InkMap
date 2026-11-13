// Mermaid renders into a temporary DOM to measure labels. Use the result as
// an image so the SVG has its own IDs and cannot add interactive page content.
export interface DiagramImage {
  src: string;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
}

const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", sans-serif';
const MAX_NODE_DIAGRAM_WIDTH = 920;
const MIN_READABLE_SCALE = 0.78;
const TARGET_INLINE_HEIGHT = 1200;

const cache = new Map<string, Promise<DiagramImage | undefined>>();
let mermaid: Promise<typeof import("mermaid").default> | undefined;
let serial = 0;

/**
 * Replaces single-brace `{...}` decision diamonds in flowcharts with `{{...}}` hexagons
 * for visual rendering only (Markdown source stays untouched). Mermaid sizes diamonds as
 * `w + h`, which blows up vertically on CJK sentences and shrinks the whole diagram.
 */
function normalizeFlowchartShapes(source: string): string {
  const header = /^\s*(?:---\s*\n[\s\S]*?\n---\s*\n\s*)?(?:%%\{[\s\S]*?\}%%\s*)*(?:flowchart|graph)\b/m;
  if (!header.test(source)) return source;
  return source
    .split("\n")
    .map(line => {
      if (/^\s*%%/.test(line)) return line;
      return line.replace(/(\b[A-Za-z0-9_]+)\{(?!\{)((?:"[^"\n]*"|[^}\n])+)\}(?!\})/g, "$1{{$2}}");
    })
    .join("\n");
}

async function initEngine() {
  mermaid ??= import("mermaid").then(({ default: engine }) => {
    engine.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      htmlLabels: false,
      suppressErrorRendering: true,
      maxTextSize: 50_000,
      maxEdges: 500,
      layout: "elk",
      look: "classic",
      theme: "base",
      fontFamily: FONT_FAMILY,
      fontSize: 13,
      flowchart: {
        htmlLabels: false,
        wrappingWidth: 210,
        minNodeWidth: 88,
        padding: 11,
        diagramPadding: 12,
        subGraphTitleMargin: { top: 8, bottom: 10 },
      },
      elk: {
        mergeEdges: false,
        layeringStrategy: "COFFMAN_GRAHAM",
        layeringLayerBound: 3,
        nodePlacementStrategy: "BRANDES_KOEPF",
        cycleBreakingStrategy: "DEPTH_FIRST",
      },
      state: {
        padding: 10,
      },
      themeVariables: {
        background: "#ffffff",
        fontFamily: FONT_FAMILY,
        fontSize: "13px",
        primaryColor: "#eef4ff",
        primaryTextColor: "#1f2329",
        primaryBorderColor: "#638ef2",
        secondaryColor: "#eefaf6",
        secondaryTextColor: "#1f2329",
        secondaryBorderColor: "#45b892",
        tertiaryColor: "#f8fafc",
        tertiaryTextColor: "#334155",
        tertiaryBorderColor: "#cbd5e1",
        lineColor: "#64748b",
        textColor: "#1f2329",
        mainBkg: "#eef4ff",
        nodeBorder: "#638ef2",
        clusterBkg: "#f8fafc",
        clusterBorder: "#cbd5e1",
        titleColor: "#334155",
        edgeLabelBackground: "#ffffff",
        stateBkg: "#eef4ff",
        stateLabelColor: "#1f2329",
        transitionColor: "#64748b",
        noteBkgColor: "#fff8e6",
        noteBorderColor: "#e2a336",
        noteTextColor: "#1f2329",
      },
      themeCSS: `
        .node rect, .node circle, .node ellipse, .statediagram-state rect.basic { rx: 8px; ry: 8px; stroke-width: 1.5px; }
        .node polygon { fill: #fff7e8 !important; stroke: #dc8b28 !important; stroke-width: 1.5px !important; stroke-linejoin: round; }
        .cluster rect { fill: #f8fafc !important; stroke: #cbd5e1 !important; stroke-width: 1.2px !important; stroke-dasharray: 5 3; rx: 10px; ry: 10px; }
        .cluster-label text, .cluster text { font-weight: 600 !important; fill: #334155 !important; }
        .edgePaths path, .transition { stroke: #64748b !important; stroke-width: 1.5px !important; }
        .arrowheadPath, marker path { fill: #64748b !important; stroke: #64748b !important; }
        .edgeLabel rect, .labelBkg { fill: #ffffff !important; stroke: #e2e8f0 !important; stroke-width: 0.8px !important; opacity: 0.96 !important; rx: 4px; ry: 4px; }
        .edgeLabel text, .edgeLabel tspan { fill: #475569 !important; font-size: 11.5px !important; }
      `,
    });
    return engine;
  });
  return mermaid;
}

function hasVisibleViewport(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if (window.innerWidth <= 0 || window.innerHeight <= 0) return false;
  const rect = document.body?.getBoundingClientRect();
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

async function render(source: string): Promise<DiagramImage> {
  if (!hasVisibleViewport()) throw new Error("Mermaid viewport hidden");
  const engine = await initEngine();
  const normalized = normalizeFlowchartShapes(source);
  let svg: string;
  try {
    ({ svg } = await engine.render("inkmap-mermaid-" + ++serial, normalized));
  } catch {
    if (normalized === source) throw new Error("Mermaid render failed");
    ({ svg } = await engine.render("inkmap-mermaid-" + ++serial, source));
  }
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = document.documentElement;
  const bounds = root.getAttribute("viewBox")?.trim().split(/\s+/).map(Number);
  if (
    root.localName !== "svg" ||
    !bounds ||
    bounds.length !== 4 ||
    !bounds.every(Number.isFinite) ||
    bounds[2] <= 0 ||
    bounds[3] <= 0
  ) {
    throw new Error("Invalid Mermaid viewBox");
  }
  const naturalWidth = Math.max(1, Math.round(bounds[2]));
  const naturalHeight = Math.max(1, Math.round(bounds[3]));
  if (naturalWidth <= 36 || naturalHeight <= 36 || !hasVisibleViewport()) {
    throw new Error("Mermaid measured zero-size bounds in hidden viewport");
  }
  // Keep text readable instead of shrinking tall flowcharts down to an illegible 18% strip.
  const fitWidthScale = Math.min(1, MAX_NODE_DIAGRAM_WIDTH / naturalWidth);
  const scale = Math.min(fitWidthScale, Math.max(MIN_READABLE_SCALE, TARGET_INLINE_HEIGHT / naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  root.style.removeProperty("max-width");
  const xml = new XMLSerializer().serializeToString(root);
  try {
    window.postMessage({
      type: "__inkmap_debug",
      event: "diagram.rendered",
      width,
      height,
      naturalWidth,
      naturalHeight,
      bounds,
    }, "*");
  } catch {}
  return {
    src: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml),
    width,
    height,
    naturalWidth,
    naturalHeight,
  };
}

export function preloadDiagram(source: string): Promise<DiagramImage | undefined> {
  if (!hasVisibleViewport()) return Promise.resolve(undefined);
  const cached = cache.get(source);
  if (cached) return cached;
  const result = render(source).catch(err => {
    try {
      window.postMessage({
        type: "__inkmap_debug",
        event: "diagram.error",
        error: String(err instanceof Error ? err.message : err),
        innerW: window.innerWidth,
        innerH: window.innerHeight,
      }, "*");
    } catch {}
    cache.delete(source);
    return undefined;
  });
  cache.set(source, result);
  return result;
}
