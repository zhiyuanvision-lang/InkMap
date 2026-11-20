import MindMapCtor from "simple-mind-map";
import Demonstrate from "simple-mind-map/src/plugins/Demonstrate.js";
import Drag from "simple-mind-map/src/plugins/Drag.js";
import Export from "simple-mind-map/src/plugins/Export.js";
import KeyboardNavigation from "simple-mind-map/src/plugins/KeyboardNavigation.js";
import Select from "simple-mind-map/src/plugins/Select.js";
import "simple-mind-map/dist/simpleMindMap.esm.css";
import "katex/dist/katex.min.css";
import katexCss from "katex/dist/katex.min.css?inline";
import {
  documentSetting,
  frontMatterTitle,
  isRich,
  parse,
  serialize,
  serializeWithLines,
  withDocumentSetting,
  withFrontMatterTitle,
  type OutlineDoc,
  type OutlineNode,
} from "@inkmap/core";
import { collectBranchFolds, collectExpand, markdownOf, nodeData, toMind, toOutlineDoc, type MindNode, type MindNodeData } from "./convert";
import type { DocState, Host } from "./host";
import { applyI18n, detectDefaultLocale, setLocale, t } from "./i18n";
import nodesCss from "./nodes.css?inline";
import { createPro } from "./pro";
import { createRenderer } from "./render";
import { $ } from "./dom";
import { createDiagramModal } from "./diagram-modal";
import { interactiveExportHtml } from "./export-html";
import { MD_LINE_HEIGHT, mermaidSourceRanges } from "./md-lines";
import { createSearch } from "./search";
import { applyThemeCss, FONT, LAYOUTS, layoutName, themeConfig, themeName, THEMES, type ThemeOption } from "./themes";
import "./style.css";

// simple-mind-map ships loose typings; the editor treats its instances as untyped.
const MindMap = MindMapCtor as any;
MindMap.usePlugin(Drag).usePlugin(Select).usePlugin(KeyboardNavigation).usePlugin(Export).usePlugin(Demonstrate);

const INITIAL_LEVELS = 3;
const SAVE_DELAY = 400;
const EXPORT_PADDING = 40;


const nodeStyle = document.createElement("style");
nodeStyle.textContent = nodesCss;
document.head.append(nodeStyle);

async function start(host: Host) {
  setLocale(detectDefaultLocale(host.locale));
  applyI18n();
  const status = $("#status");
  const toast = $("#toast");
  const source = $("#source");
  const sourceText = $<HTMLTextAreaElement>("#source-text");
  const inlineEdit = $<HTMLTextAreaElement>("#node-inline-edit");
  const diagramModal = createDiagramModal();

  let doc: DocState = await host.load();
  const { saveTarget, compact, restrictAssets } = host.capabilities;
  const renderer = createRenderer(host.assetBase, restrictAssets);
  document.documentElement.classList.toggle("ink-sidebar", !!compact);
  status.setAttribute("role", "status");
  let meta: Omit<OutlineDoc, "root">;
  let lastMd = doc.md;
  let saving: Promise<void> = Promise.resolve();
  let saveTimer = 0;
  let sourceNode: any = null;
  const readOnly = () => doc.writable === false;

  const setStatus = (state: "saved" | "pending" | "saving" | "error", text: string) => {
    status.dataset.state = state;
    status.textContent = text;
  };
  let toastTimer = 0;
  const showToast = (text: string) => {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toast.hidden = true), 4000);
  };

  const pro = await createPro(host, showToast);
  pro.onChange(() => {
    if (!pro.isPro() && diagramModal.isOpen()) diagramModal.close();
  });

  let syntheticRootTitle = "";
  /** Parses `md` and preloads its diagrams/images; the caller commits `meta` once it knows the result is current. */
  async function buildData(md: string, expandOf: (path: string[], depth: number) => boolean) {
    const outline = parse(md, doc.name);
    const { root, ...rest } = outline;
    const mds: string[] = [];
    const walk = (n: typeof root) => (mds.push(n.md), n.children.forEach(walk));
    walk(root);
    await renderer.preload(mds);
    return { data: toMind(root, expandOf), meta: rest, syntheticTitle: outline.syntheticRoot ? root.md : "" };
  }

  // ---- per-document look: layout and theme live in the front matter ------

  // Same front matter detection as the parser, cached because layout, theme and title each read it.
  let frontMatterCache = { md: "", fm: "" };
  const frontMatterOf = (md: string) => {
    if (frontMatterCache.md !== md) frontMatterCache = { md, fm: parse(md).frontMatter };
    return frontMatterCache.fm;
  };
  function layoutOf(md: string) {
    const fm = frontMatterOf(md);
    const chosen = LAYOUTS.find(l => l.id === documentSetting(fm, "layout"));
    if (chosen && (!chosen.pro || pro.isPro())) return chosen.id;
    return /^\s*layout:\s*["']?(two-sided|mindMap)/m.test(fm) ? "mindMap" : "logicalStructure";
  }
  function themeOf(md: string): ThemeOption {
    const chosen = THEMES.find(th => th.id === documentSetting(frontMatterOf(md), "theme"));
    return chosen && (!chosen.pro || pro.isPro()) ? chosen : THEMES[0];
  }

  const titleOf = (md: string) => frontMatterTitle(frontMatterOf(md)) ?? doc.name;
  let title = titleOf(doc.md);
  document.title = `${title} · Inkmap`;

  let theme = themeOf(doc.md);
  applyThemeCss(theme);
  const initialFolds = doc.viewState?.folds;
  let pendingInitialView = doc.viewState?.view;
  let viewReady = false;
  let pendingExternalDoc: DocState | undefined;
  let mindMapReady = false;
  host.onExternalChange(next => {
    if (!mindMapReady) {
      pendingExternalDoc = next;
      return;
    }
    const switchedDoc = next.name !== doc.name;
    if (switchedDoc) {
      clearTimeout(saveTimer);
      saveTimer = 0;
    }
    saving = saving.then(async () => {
      const unsaved = currentMarkdown() !== savedMap;
      const localChanges = !switchedDoc && unsaved && next.md !== lastMd;
      await applyExternal(next);
      // The host already moved to the other file, so edits still waiting for their save cannot be written any more.
      if (localChanges) showToast(t("conflict"));
      else if (switchedDoc && (unsaved || next.discardedEdits) && !readOnly()) showToast(t("unsavedDiscarded"));
    }).catch(err => showToast(String(err instanceof Error ? err.message : err)));
  });

  const mapEl = $("#map");
  const retriedVisibleDiagrams = new Set<string>();
  const origGetMapRect = mapEl.getBoundingClientRect.bind(mapEl);
  let hadRealMapRect = false;
  {
    const initialRect = origGetMapRect();
    hadRealMapRect = initialRect.width >= 160 && initialRect.height >= 160;
  }
  mapEl.getBoundingClientRect = () => {
    const r = origGetMapRect();
    if (r.width >= 160 && r.height >= 160) return r;
    const w = window.innerWidth >= 160 ? window.innerWidth : 960;
    const h = window.innerHeight >= 160 ? window.innerHeight : 720;
    return new DOMRect(0, 0, w, h);
  };

  const initialBuild = await buildData(doc.md, (path, depth) =>
    depth === 0 ? true : (initialFolds?.[path.join("\u0000")] ?? depth < INITIAL_LEVELS),
  );
  meta = initialBuild.meta;
  syntheticRootTitle = initialBuild.syntheticTitle;
  const initialData = initialBuild.data;
  {
    const r = origGetMapRect();
    if (r.width >= 160 && r.height >= 160) hadRealMapRect = true;
  }

  document.body.tabIndex = -1;
  document.body.style.outline = "none";
  const nodeMenu = $("#node-menu");
  const exportMenu = $("#export-menu");
  let menuNodes: any[] = [];
  const hideMenus = () => {
    nodeMenu.hidden = true;
    exportMenu.hidden = true;
    menuNodes = [];
  };
  const isExternalTextInput = (el: EventTarget | Element | null): boolean => {
    if (!(el instanceof Element)) return false;
    if (el.classList.contains("smm-node-edit-wrap")) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || tag === "A") return true;
    return (el as HTMLElement).isContentEditable === true;
  };

  const mindMap = new MindMap({
    el: mapEl,
    readonly: readOnly(),
    data: initialData,
    layout: layoutOf(doc.md),
    fit: !pendingInitialView,
    nodeTextEditZIndex: 5,
    enableShortcutOnlyWhenMouseInSvg: false,
    enableAutoEnterTextEditWhenKeydown: true,
    customCheckEnableShortcut: (e: KeyboardEvent) => {
      if (diagramModal.isOpen() || document.documentElement.classList.contains("presenting")) return false;
      const upgradeEl = document.getElementById("upgrade");
      if (upgradeEl && !upgradeEl.hidden) return false;
      const accountPanel = document.getElementById("account-panel");
      if (accountPanel && !accountPanel.hidden) return false;
      if (isExternalTextInput(e.target) || isExternalTextInput(document.activeElement)) return false;
      return true;
    },
    beforeShortcutRun: () => {
      hideMenus();
      return false;
    },
    defaultInsertSecondLevelNodeText: t("newTopic"),
    defaultInsertBelowSecondLevelNodeText: t("newTopic"),
    isShowCreateChildBtnIcon: false,
    isUseCustomNodeContent: true,
    customCreateNodeContent(node: any) {
      const data: MindNodeData = node.getData();
      if (!data.rich) return null;
      const el = document.createElement("div");
      el.className = `ink-node depth-${Math.min(node.layerIndex, 2)}`;
      el.innerHTML = renderer.render(data.md);
      el.querySelectorAll<HTMLElement>(".ink-diagram-viewport").forEach(viewport => {
        viewport.addEventListener("wheel", event => {
          if (event.ctrlKey || event.metaKey) return;
          const canY = viewport.scrollHeight > viewport.clientHeight + 1;
          const canX = viewport.scrollWidth > viewport.clientWidth + 1;
          if (!canY && !canX) return;
          const atTop = viewport.scrollTop <= 0 && event.deltaY < 0;
          const atBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 1 && event.deltaY > 0;
          const atLeft = viewport.scrollLeft <= 0 && event.deltaX < 0;
          const atRight = viewport.scrollLeft + viewport.clientWidth >= viewport.scrollWidth - 1 && event.deltaX > 0;
          if ((canY && !(atTop || atBottom)) || (canX && !(atLeft || atRight))) event.stopPropagation();
        }, { passive: true });
      });
      el.querySelectorAll<HTMLImageElement>(".ink-diagram-image").forEach(img => {
        if (!img.dataset.trackedRender) {
          img.dataset.trackedRender = "1";
          host.track?.("diagram_render");
        }
        img.addEventListener("pointerdown", event => event.stopPropagation());
        img.addEventListener("click", event => {
          event.stopPropagation();
          diagramModal.open(img);
        });
      });
      el.querySelectorAll<HTMLButtonElement>(".ink-diagram-zoom").forEach(button => {
        button.textContent = t("zoomDiagram");
        button.addEventListener("pointerdown", event => event.stopPropagation());
        button.addEventListener("click", event => {
          event.stopPropagation();
          const img = button.closest(".ink-diagram")?.querySelector<HTMLImageElement>(".ink-diagram-image");
          if (img) diagramModal.open(img);
        });
      });
      el.querySelectorAll<HTMLButtonElement>(".ink-diagram-edit").forEach((button, index) => {
        const hasError = Boolean(button.parentElement?.parentElement?.querySelector(".ink-diagram-error"));
        if (hasError && origGetMapRect().width > 0 && !retriedVisibleDiagrams.has(data.md)) {
          retriedVisibleDiagrams.add(data.md);
          void renderer.preload([data.md]).then(() => {
            mindMap.reRender();
          });
        }
        button.hidden = readOnly();
        button.textContent = hasError ? t("diagramInvalid") : t("editDiagram");
        button.addEventListener("pointerdown", event => event.stopPropagation());
        button.addEventListener("click", event => {
          event.stopPropagation();
          openSource(node);
          // Buttons follow the order of the diagrams the renderer drew, which skips fences inside other code blocks.
          const range = mermaidSourceRanges(sourceText.value)[index];
          if (range) {
            sourceText.setSelectionRange(range.start, range.end);
            const linesBefore = sourceText.value.slice(0, range.start).split("\n").length - 1;
            sourceText.scrollTop = Math.max(0, (linesBefore - 2) * MD_LINE_HEIGHT);
          }
        });
      });
      return el;
    },
    themeConfig: themeConfig(theme),
    expandBtnStyle: { color: theme.palette.line, fill: theme.palette.card, fontSize: 12, strokeColor: theme.palette.line },
    exportPaddingX: EXPORT_PADDING,
    exportPaddingY: EXPORT_PADDING,
    handleBeingExportSvg: (svg: any) => {
      svg.node.querySelectorAll(".ink-diagram-bar, .ink-diagram-edit").forEach((el: HTMLElement) => el.remove());
      svg.node.querySelectorAll(".ink-diagram-viewport").forEach((el: HTMLElement) => {
        el.style.maxHeight = "none";
        el.style.maxWidth = "none";
        el.style.overflow = "visible";
      });
      svg.node.insertAdjacentHTML("afterbegin", `<style>${resolvedNodeCss()}</style>`);
      if (!pro.isPaidPro()) {
        const w = Number(svg.node.getAttribute("width")) || svg.node.viewBox?.baseVal?.width || 800;
        const h = Number(svg.node.getAttribute("height")) || svg.node.viewBox?.baseVal?.height || 600;
        const x = Math.max(140, w - 16);
        const y = Math.max(24, h - 12);
        svg.node.insertAdjacentHTML(
          "beforeend",
          `<text class="inkmap-export-watermark" x="${x}" y="${y}" text-anchor="end" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif" font-size="12" fill="${theme.palette.text}" fill-opacity="0.45">Made with Inkmap · Editable Markdown Mind Map (zhiyuanv.com)</text>`,
        );
      }
      return svg;
    },
    demonstrateConfig: { boxShadowColor: "rgba(0, 0, 0, 0.75)", padding: 24, margin: 60, zIndex: 42 },
  });

  // ---- write back -------------------------------------------------------

  function currentOutline(tree: MindNode = mindMap.getData(false), uids?: Map<OutlineNode, string>): OutlineDoc {
    let effectiveMeta = meta;
    const rootMd = markdownOf(tree.data);
    if (meta.syntheticRoot && rootMd !== syntheticRootTitle && rootMd.trim()) {
      const hasTitleKey = /^title:/m.test(meta.frontMatter);
      const hasTopH1 = (tree.children ?? []).some(c => c.data.kind === "heading" && (c.data.level ?? 1) === 1);
      if (!hasTitleKey && !hasTopH1) {
        effectiveMeta = { ...meta, syntheticRoot: false };
      } else {
        // Keep the title in the front matter: promoting the root to an H1 would demote the existing H1s.
        effectiveMeta = { ...meta, frontMatter: withFrontMatterTitle(meta.frontMatter, rootMd, meta.eol) };
      }
    }
    return toOutlineDoc(effectiveMeta, tree, uids);
  }

  const currentMarkdown = () => serialize(currentOutline());
  let savedMap = currentMarkdown();
  // In an editor the map edits the open document; saving to disk stays with the editor.
  const synced = () => {
    if (readOnly()) return t("readOnly");
    switch (saveTarget) {
      case "copy": return t("savedInCopy");
      case "file": return t("saved");
      case "editor": return t("synced");
    }
  };
  setStatus("saved", synced());

  /** Saves after a short pause; pass `md` when the caller already serialized the map. */
  function scheduleSave(md = currentMarkdown()) {
    clearTimeout(saveTimer);
    if (readOnly()) return;
    if (md === savedMap) return;
    setStatus("pending", t("pending"));
    saveTimer = window.setTimeout(() => (saving = saving.then(save)), SAVE_DELAY);
  }

  async function save() {
    if (readOnly()) return;
    const md = currentMarkdown();
    if (md === savedMap) return setStatus("saved", synced());
    setStatus("saving", t("saving"));
    try {
      const result = await host.save(md, doc.version);
      if (result.ok) {
        lastMd = md;
        savedMap = md;
        doc = { ...doc, md, version: result.version };
        if (currentMarkdown() === savedMap) setStatus("saved", synced());
        else scheduleSave();
      } else {
        await applyExternal(result.doc);
        showToast(t("conflict"));
      }
    } catch (err) {
      setStatus("error", t("saveFailed"));
      showToast(String(err instanceof Error ? err.message : err));
    }
  }

  async function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    await (saving = saving.then(save));
  }

  /** Line positions computed by nodeLines(); load() and every map change invalidate them. */
  let nodeLinesCache: Map<string, number> | undefined;

  /** Removes any orphan SVG `<g>` left in `nodeDraw` if an async render chunk was interrupted by `setData()`. */
  function sweepOrphanSvgNodes() {
    try {
      const container: Element | undefined = mindMap.nodeDraw?.node;
      const cache = mindMap.renderer?.nodeCache;
      if (!container || !cache) return;
      const liveGroups = new Set<Element>();
      for (const n of Object.values<any>(cache)) {
        if (n?.group?.node) liveGroups.add(n.group.node);
      }
      for (const child of [...container.children]) {
        if (!liveGroups.has(child)) child.remove();
      }
    } catch {}
  }

  /** Replaces the map with `md`, keeping folds; `local` edits are then saved like any other edit. */
  let loadGeneration = 0;
  async function load(md: string, local: boolean, resetHistory = false) {
    const generation = ++loadGeneration;
    finishInlineEdit(false);
    cancelSourceEdit();
    const folds = resetHistory ? new Map<string, boolean>() : collectExpand(mindMap.getData(false));
    const built = await buildData(md, (path, depth) => folds.get(path.join("\u0000")) ?? depth < INITIAL_LEVELS);
    if (generation !== loadGeneration) return;
    // Wait out any in-flight chunked `root.render()` before calling `setData()`, otherwise `simple-mind-map`'s
    // `reRender()` clears `nodeCache` while the old rAF loop still appends orphan `<g>` nodes onto `nodeDraw`.
    if (mindMap.renderer?.isRendering) {
      await new Promise<void>(done => {
        const timer = window.setTimeout(done, 250);
        const onEnd = () => {
          clearTimeout(timer);
          mindMap.off("node_tree_render_end", onEnd);
          done();
        };
        mindMap.on("node_tree_render_end", onEnd);
      });
      if (generation !== loadGeneration) return;
    }
    const data = built.data;
    meta = built.meta;
    nodeLinesCache = undefined;
    syntheticRootTitle = built.syntheticTitle;
    title = titleOf(md);
    document.title = `${title} · Inkmap`;
    closeSource();
    mindMap.execCommand("CLEAR_ACTIVE_NODE");
    if (resetHistory) {
      mindMap.setData(data);
      requestAnimationFrame(() => {
        try {
          sweepOrphanSvgNodes();
          mindMap.resize();
          mindMap.view.fit();
        } catch {}
      });
    } else {
      mindMap.updateData(data);
    }
    applyLook(md);
    if (local) {
      const current = currentMarkdown();
      host.onMapMarkdownChange?.(current);
      scheduleSave(current);
    }
  }

  async function applyExternal(next: DocState) {
    const switchedDoc = next.name !== doc.name;
    if (!switchedDoc && next.md === lastMd && next.writable === doc.writable) {
      doc = next;
      return;
    }
    doc = next;
    lastMd = next.md;
    mindMap.setMode(readOnly() ? "readonly" : "edit");
    await load(next.md, false, switchedDoc);
    savedMap = currentMarkdown();
    clearTimeout(saveTimer);
    saveTimer = 0;
    setStatus("saved", synced());
  }

  mindMapReady = true;
  if (pendingExternalDoc) {
    const next = pendingExternalDoc;
    pendingExternalDoc = undefined;
    saving = saving.then(() => applyExternal(next)).catch(err => showToast(String(err instanceof Error ? err.message : err)));
  }
  mindMap.on("data_change", () => {
    const md = currentMarkdown();
    host.onMapMarkdownChange?.(md);
    scheduleSave(md);
  });

  // ---- editing ----------------------------------------------------------

  const revisions = new WeakMap<object, object>();
  let pendingNodeEdit: Promise<void> = Promise.resolve();
  let beforeCanvasEditText: string | undefined;
  async function setMarkdown(node: any, md: string) {
    const revision = {};
    revisions.set(node, revision);
    await renderer.preload([md]);
    if (revisions.get(node) !== revision) return;
    mindMap.renderer.setNodeDataRender(node, nodeData(md));
  }

  mindMap.on("before_show_text_edit", () => {
    const active = mindMap.renderer?.activeNodeList?.[0];
    beforeCanvasEditText = active ? String(active.getData("text") ?? "") : undefined;
  });

  // Text typed on the canvas becomes rendered Markdown once it uses Markdown syntax.
  mindMap.on("hide_text_edit", (_el: unknown, _list: unknown, node: any) => {
    beforeCanvasEditText = undefined;
    const text = String(node?.getData("text") ?? "");
    if (node && isRich(text)) pendingNodeEdit = setMarkdown(node, text);
    blurExternalInput();
  });

  function openSource(node: any, focus = true) {
    if (sourceNode !== node) flushSourceEdit();
    sourceNode = node;
    source.hidden = false;
    sourceText.value = markdownOf(node.getData());
    sourceText.readOnly = readOnly();
    if (focus) sourceText.focus();
  }
  function closeSource() {
    flushSourceEdit();
    sourceNode = null;
    source.hidden = true;
    sourceText.blur();
    blurExternalInput();
  }

  // At most one debounced source-panel edit is pending; it targets the node that was open when typed.
  let sourceTimer = 0;
  let pendingSourceEdit: (() => void) | null = null;
  function flushSourceEdit() {
    clearTimeout(sourceTimer);
    sourceTimer = 0;
    const run = pendingSourceEdit;
    pendingSourceEdit = null;
    run?.();
  }
  function cancelSourceEdit() {
    clearTimeout(sourceTimer);
    sourceTimer = 0;
    pendingSourceEdit = null;
  }
  sourceText.addEventListener("input", () => {
    const node = sourceNode;
    if (!node) return;
    cancelSourceEdit();
    revisions.delete(node);
    const markdown = sourceText.value.replace(/\n+$/, "");
    pendingSourceEdit = () => {
      if (node.group?.node?.isConnected === false) return;
      pendingNodeEdit = setMarkdown(node, markdown);
    };
    sourceTimer = window.setTimeout(flushSourceEdit, 250);
  });
  sourceText.addEventListener("keydown", e => {
    if (e.key === "Escape") closeSource();
  });

  let inlineNode: any = null;
  let inlineOriginal = "";
  let inlineNumberedLabel = false;

  function placeInlineEdit() {
    if (!inlineNode) return;
    const anchor: SVGElement = inlineNode.group.node;
    if (!anchor.isConnected) return finishInlineEdit(false);
    const rect = anchor.getBoundingClientRect();
    const availableWidth = Math.max(1, innerWidth - 16);
    const availableHeight = Math.max(36, innerHeight - 24);
    const width = Math.min(availableWidth, Math.max(rect.width, 180));
    const multiline = inlineOriginal.includes("\n") || inlineEdit.value.includes("\n");
    inlineEdit.style.width = `${width}px`;
    inlineEdit.style.height = "auto";
    const desiredHeight = Math.max(rect.height, inlineEdit.scrollHeight + 2, multiline ? 88 : 34);
    const height = Math.min(availableHeight, desiredHeight);
    inlineEdit.style.height = `${height}px`;
    inlineEdit.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
    inlineEdit.style.top = `${Math.max(8, Math.min(rect.top, innerHeight - height - 8))}px`;
  }

  function openInlineEdit(node: any) {
    if (!node || readOnly()) return;
    finishInlineEdit(true);
    const draft = sourceNode === node ? sourceText.value : markdownOf(node.getData());
    closeSource();
    inlineNode = node;
    inlineOriginal = markdownOf(node.getData());
    inlineNumberedLabel = /^\d+\\[.)]\s/.test(draft);
    inlineEdit.value = inlineNumberedLabel ? draft.replace(/^(\d+)\\([.)])/, "$1$2") : draft;
    inlineEdit.setAttribute("aria-label", t("editNode"));
    inlineEdit.hidden = false;
    placeInlineEdit();
    inlineEdit.focus({ preventScroll: true });
    if (inlineOriginal.includes("\n") || inlineEdit.value.length > 80) {
      const end = inlineEdit.value.length;
      inlineEdit.setSelectionRange(end, end);
    } else {
      inlineEdit.select();
    }
  }

  function finishInlineEdit(commit: boolean) {
    const node = inlineNode;
    if (!node) return;
    inlineNode = null;
    inlineEdit.hidden = true;
    const value = inlineEdit.value.replace(/\n+$/, "");
    const markdown = inlineNumberedLabel ? value.replace(/^(\d+)([.)])(?=\s)/, "$1\\$2") : value;
    if (commit && !readOnly() && markdown !== inlineOriginal) {
      cancelSourceEdit();
      pendingNodeEdit = setMarkdown(node, markdown);
    }
    blurExternalInput();
  }

  inlineEdit.addEventListener("blur", () => finishInlineEdit(true));
  inlineEdit.addEventListener("input", placeInlineEdit);
  inlineEdit.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.isComposing) return;
    const multiline = inlineOriginal.includes("\n") || inlineEdit.value.includes("\n");
    const submit =
      (event.key === "Enter" && (event.metaKey || event.ctrlKey || (!event.shiftKey && !multiline))) ||
      (event.key === "Tab" && !multiline);
    if (submit || event.key === "Escape") {
      event.preventDefault();
      finishInlineEdit(submit);
    }
  });
  for (const event of ["scale", "translate", "node_tree_render_end"]) mindMap.on(event, placeInlineEdit);
  window.addEventListener("resize", placeInlineEdit);

  mindMap.on("node_dblclick", (node: any) => {
    if (!node.getData("rich") || readOnly()) return;
    openInlineEdit(node);
  });
  mindMap.on("node_active", (_node: any, list: any[]) => {
    if (source.hidden) return;
    if (list.length === 1) return openSource(list[0], false);
    // No single node is selected: detach the panel so typing cannot overwrite the previously open node.
    flushSourceEdit();
    sourceNode = null;
    sourceText.value = "";
    sourceText.readOnly = true;
  });

  /** Rewrites node Markdown in place (every node, or the one with `uid`) and saves the result. */
  async function rewrite(change: (md: string) => string | null, uid?: string): Promise<number> {
    if (readOnly()) return 0;
    const tree: MindNode = mindMap.getData(false);
    let n = 0;
    const walk = (node: MindNode) => {
      if (!uid || node.data.uid === uid) {
        const next = change(markdownOf(node.data));
        if (next !== null && next !== markdownOf(node.data)) {
          Object.assign(node.data, nodeData(next));
          n++;
        }
      }
      (node.children ?? []).forEach(walk);
    };
    walk(tree);
    if (n) await load(serialize(currentOutline(tree)), true);
    return n;
  }

  // ---- link with the text editor ------------------------------------------

  /** Start line of every node in the current document, keyed by node uid; cached until the map changes. */
  mindMap.on("data_change", () => (nodeLinesCache = undefined));
  function nodeLines(): Map<string, number> {
    if (nodeLinesCache) return nodeLinesCache;
    const uids = new Map<OutlineNode, string>();
    const { lines } = serializeWithLines(currentOutline(mindMap.getData(false), uids));
    const out = new Map<string, number>();
    for (const [node, line] of lines) {
      const uid = uids.get(node);
      if (uid) out.set(uid, line);
    }
    return (nodeLinesCache = out);
  }

  let revealing = false;
  const blurExternalInput = () => {
    const activeEl = document.activeElement;
    if (
      activeEl &&
      activeEl !== document.body &&
      !activeEl.classList.contains("smm-node-edit-wrap") &&
      activeEl !== inlineEdit
    ) {
      if (typeof (activeEl as HTMLElement).blur === "function") {
        (activeEl as HTMLElement).blur();
      }
    }
    if (document.activeElement !== inlineEdit && !document.activeElement?.classList.contains("smm-node-edit-wrap")) {
      try {
        window.focus();
        document.body.focus({ preventScroll: true });
      } catch {}
    }
  };
  mindMap.on("node_mousedown", blurExternalInput);
  mindMap.on("svg_mousedown", blurExternalInput);
  if (host.select) {
    mindMap.on("node_click", (node: any) => {
      blurExternalInput();
      if (revealing) return;
      const range = chatRange([node]);
      if (range) host.select!(range.startLine, range.endLine);
    });
  }
  host.onReveal?.(line => {
    let best: string | undefined;
    let bestLine = -1;
    for (const [uid, start] of nodeLines()) {
      if (start <= line && start >= bestLine) [best, bestLine] = [uid, start];
    }
    if (!best) return;
    const uid = best;
    mindMap.renderer.expandToNodeUid(uid, () => {
      const node = mindMap.renderer.findNodeByUid(uid);
      if (!node) return;
      revealing = true;
      if (mindMap.renderer.activeNodeList[0]?.getData("uid") !== uid) {
        mindMap.renderer.clearActiveNodeList();
        node.active();
      }
      revealing = false;
      mindMap.resize();
      mindMap.renderer.moveNodeToCenter(node, false);
    });
  });
  const toggleSource = () => {
    const active = mindMap.renderer.activeNodeList;
    if (!source.hidden) closeSource();
    else if (active.length === 1) openSource(active[0]);
    else showToast(t("selectNode"));
  };
  mindMap.keyCommand.addShortcut("Control+e", toggleSource);
  mindMap.keyCommand.addShortcut("F2", () => {
    const active = mindMap.renderer.activeNodeList;
    if (active.length === 1 && active[0].getData("rich")) openInlineEdit(active[0]);
  });
  mindMap.keyCommand.addShortcut("Enter", () => {
    const active = mindMap.renderer.activeNodeList;
    if (!mindMap.renderer.textEdit?.isShowTextEdit?.() && active.length === 1 && active[0].isRoot) {
      mindMap.execCommand("INSERT_CHILD_NODE");
    }
  });
  mindMap.keyCommand.addShortcut("Alt+Up", () => mindMap.execCommand("UP_NODE"));
  mindMap.keyCommand.addShortcut("Alt+Down", () => mindMap.execCommand("DOWN_NODE"));

  const expandSubtree = (nodes: any[] = mindMap.renderer.activeNodeList) => {
    if (!nodes.length) return showToast(t("selectNode"));
    nodes.forEach(n => mindMap.execCommand("EXPAND_ALL", n.getData("uid")));
  };
  mindMap.keyCommand.addShortcut("Shift+/", () => expandSubtree());

  // Run mind-map shortcuts in window capture phase so embedded browser preloads (e.g. Cursor BrowserView)
  // on document capture phase do not hijack Enter, Tab, Cmd+Z/Y/F/E, or Cmd+Up/Down before simple-mind-map.
  mindMap.keyCommand.unBindEvent();
  const onCaptureKeydown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      e.stopImmediatePropagation();
      void (async () => {
        await flushLocalEdits();
        await host.flushPendingEdits?.();
        await flushSave();
        showToast(doc.name ? `${synced()} · ${doc.name}` : synced());
      })();
      return;
    }
    if (e.isComposing) return;
    if (!inlineEdit.hidden && (e.target === inlineEdit || document.activeElement === inlineEdit)) {
      const multiline = inlineOriginal.includes("\n") || inlineEdit.value.includes("\n");
      const submit =
        (e.key === "Enter" && (e.metaKey || e.ctrlKey || (!e.shiftKey && !multiline))) ||
        (e.key === "Tab" && !multiline);
      if (submit || e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        finishInlineEdit(submit);
      }
      return;
    }
    if (mindMap.renderer?.textEdit?.isShowTextEdit?.() && e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      const wrap = document.querySelector<HTMLElement>(".smm-node-edit-wrap");
      if (wrap && beforeCanvasEditText !== undefined) wrap.textContent = beforeCanvasEditText;
      mindMap.renderer.textEdit.hideEditTextBox();
      blurExternalInput();
      return;
    }
    mindMap.keyCommand.onKeydown(e);
    if (!e.defaultPrevented && mindMap.opt.customCheckEnableShortcut?.(e)) {
      const active = mindMap.renderer.activeNodeList;
      if (active.length === 1 && active[0].getData("rich") && mindMap.renderer.textEdit?.checkIsAutoEnterTextEditKey?.(e)) {
        e.preventDefault();
        e.stopPropagation();
        openInlineEdit(active[0]);
      }
    }
  };
  window.addEventListener("keydown", onCaptureKeydown, true);
  mindMap.on("beforeDestroy", () => window.removeEventListener("keydown", onCaptureKeydown, true));

  /** Commits the inline editor, the canvas text box and the source panel so the map holds every typed character. */
  async function flushLocalEdits() {
    if (!inlineEdit.hidden) finishInlineEdit(true);
    if (mindMap.renderer?.textEdit?.isShowTextEdit?.()) mindMap.renderer.textEdit.hideEditTextBox();
    flushSourceEdit();
    await pendingNodeEdit;
  }

  // ---- menus ------------------------------------------------------------

  mindMap.on("node_contextmenu", (e: MouseEvent, node: any) => {
    e.preventDefault();
    blurExternalInput();
    const active = mindMap.renderer.activeNodeList;
    menuNodes = active.includes(node) ? [...active] : [node];
    const isRootOnly = menuNodes.every((n: any) => n?.isRoot);
    const ro = readOnly();
    $("#menu-insert-child").hidden = ro;
    $("#menu-insert-sibling").hidden = ro || isRootOnly;
    $("#menu-insert-parent").hidden = ro || isRootOnly;
    $("#menu-move-up").hidden = ro || isRootOnly;
    $("#menu-move-down").hidden = ro || isRootOnly;
    $("#menu-remove-node").hidden = ro || isRootOnly;
    nodeMenu.hidden = false;
    nodeMenu.style.left = `${Math.min(e.clientX, innerWidth - nodeMenu.offsetWidth - 8)}px`;
    nodeMenu.style.top = `${Math.min(e.clientY, innerHeight - nodeMenu.offsetHeight - 8)}px`;
  });
  window.addEventListener("pointerdown", e => {
    const target = e.target as Node;
    if (!nodeMenu.contains(target) && !exportMenu.parentElement!.contains(target)) hideMenus();
  }, true);
  window.addEventListener("keydown", e => e.key === "Escape" && hideMenus());
  mindMap.on("scale", hideMenus);
  mindMap.on("translate", hideMenus);

  // ---- add to chat --------------------------------------------------------

  const chatAdd = $("#chat-add");
  const chatMenuItem = $("#menu-add-to-chat");
  const chatEnabled = (await host.canAddToChat?.()) === true;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const chatKey = isMac ? "⌘L" : "Ctrl+L";
  $("#menu-source-kbd").textContent = isMac ? "⌘E" : "Ctrl+E";
  $("#menu-up-kbd").textContent = isMac ? "⌘↑" : "Ctrl+↑";
  $("#menu-down-kbd").textContent = isMac ? "⌘↓" : "Ctrl+↓";
  chatAdd.innerHTML = `<span>${t("addToChat")}</span><kbd>${chatKey}</kbd>`;
  chatAdd.title = t("addToChatTitle");
  chatMenuItem.innerHTML = `<span>${t("addToChat")}</span><kbd>${chatKey}</kbd>`;

  /** Document lines (zero-based, inclusive) that hold `nodes`; several nodes span from the first to the last. */
  function chatRange(nodes: any[]): { startLine: number; endLine: number } | null {
    const wanted = new Set(nodes.map(n => n.getData("uid")));
    const uids = new Map<OutlineNode, string>();
    const outlineDoc = currentOutline(mindMap.getData(false), uids);
    const { md, lines } = serializeWithLines(outlineDoc);
    const last = md.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").length - 1;
    let startLine = Infinity;
    let endLine = -1;
    for (const [node, line] of lines) {
      if (!wanted.has(uids.get(node))) continue;
      // A map built from several top-level blocks gets a made-up root, which stands for the whole document.
      const whole = outlineDoc.syntheticRoot && node === lines.keys().next().value;
      startLine = Math.min(startLine, whole ? 0 : line);
      endLine = Math.max(endLine, whole ? last : line + node.md.replace(/\r\n?/g, "\n").split("\n").length - 1);
    }
    return endLine < 0 ? null : { startLine, endLine: Math.min(endLine, last) };
  }

  /** Text the user has selected inside a node: in the Markdown source panel, or while editing the node on the canvas. */
  function selectedPart(): {
    node: any;
    text: string;
    anchorRight: number;
    anchorY: number;
    outer: { left: number; right: number; top: number; bottom: number };
    inHeader?: boolean;
  } | null {
    const field = document.activeElement;
    if (!source.hidden && sourceNode && field === sourceText && sourceText.selectionStart !== sourceText.selectionEnd) {
      const text = sourceText.value.slice(sourceText.selectionStart, sourceText.selectionEnd);
      const close = $(".source-head button").getBoundingClientRect();
      return text.trim()
        ? {
            node: sourceNode,
            text,
            anchorRight: close.left - 6,
            anchorY: (close.top + close.bottom) / 2,
            outer: { left: close.left - 6, right: close.left - 6, top: close.top, bottom: close.bottom },
            inHeader: true,
          }
        : null;
    }
    if (field?.classList.contains("smm-node-edit-wrap")) {
      const sel = getSelection();
      const node = mindMap.renderer.activeNodeList[0];
      const text = sel && !sel.isCollapsed ? sel.toString() : "";
      if (node && text.trim()) {
        const rangeRect = sel!.getRangeAt(0).getBoundingClientRect();
        const editRect = field.getBoundingClientRect();
        const nodeRect: DOMRect | undefined = node.group?.node.getBoundingClientRect();
        const outer = {
          left: nodeRect ? Math.min(nodeRect.left, editRect.left) : editRect.left,
          right: nodeRect ? Math.max(nodeRect.right, editRect.right) : editRect.right,
          top: nodeRect ? Math.min(nodeRect.top, editRect.top) : editRect.top,
          bottom: nodeRect ? Math.max(nodeRect.bottom, editRect.bottom) : editRect.bottom,
        };
        return {
          node,
          text,
          anchorRight: rangeRect.width > 0 ? rangeRect.right : outer.right,
          anchorY: rangeRect.height > 0 ? (rangeRect.top + rangeRect.bottom) / 2 : (outer.top + outer.bottom) / 2,
          outer,
        };
      }
    }
    return null;
  }

  /** Sends what is selected: part of a node's text, else the selected nodes' lines. */
  async function addToChat(nodes?: any[]) {
    hideMenus();
    const part = nodes ? null : selectedPart();
    nodes ??= part ? [part.node] : [...mindMap.renderer.activeNodeList];
    if (!nodes.length) return host.addToChat!();
    // The editor reads the lines from the document, so pending edits have to land there first.
    if (!part) await flushLocalEdits();
    else {
      // Text selected in the source panel may still be waiting for its debounced write to the node.
      if (part.inHeader) flushSourceEdit();
      await pendingNodeEdit;
    }
    await flushSave();
    if (status.dataset.state !== "saved") return showToast(t("saveFailed"));
    const range = chatRange(nodes);
    if (range) host.addToChat!({ ...range, ...(part && { text: part.text }) });
  }

  /** Collects bounding boxes of all rendered nodes except `skip`, so the floating chip can avoid covering neighbor text. */
  function otherNodeRects(skip: Set<any>): { left: number; right: number; top: number; bottom: number }[] {
    const out: { left: number; right: number; top: number; bottom: number }[] = [];
    const mapRect = origGetMapRect();
    const minX = mapRect.width >= 160 ? mapRect.left : 0;
    const maxX = mapRect.width >= 160 ? mapRect.right : innerWidth;
    const minY = mapRect.height >= 160 ? mapRect.top : 0;
    const maxY = mapRect.height >= 160 ? mapRect.bottom : innerHeight;
    const walk = (n: any) => {
      if (!n) return;
      if (!skip.has(n)) {
        const r: DOMRect | undefined = n.group?.node.getBoundingClientRect();
        if (r && r.width > 0 && r.bottom > minY && r.top < maxY && r.right > minX && r.left < maxX) out.push(r);
      }
      if (n.getData?.("expand") !== false) (n.children ?? []).forEach(walk);
    };
    walk(mindMap.renderer.root);
    return out;
  }

  const overlapArea = (a: { left: number; right: number; top: number; bottom: number }, b: { left: number; right: number; top: number; bottom: number }) =>
    Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

  /** Places the "Add to Chat" chip at the first unobstructed spot around the selection (preferring top-right). */
  const presenting = () => document.documentElement.classList.contains("presenting");
  let chatFrame = 0;
  function placeChatButton() {
    cancelAnimationFrame(chatFrame);
    chatFrame = requestAnimationFrame(() => {
      const hide = () => void (chatAdd.hidden = true);
      if (presenting()) return hide();
      const barRect = $("#bar").getBoundingClientRect();
      const minY = barRect.bottom + 6;
      chatAdd.hidden = false;
      const { offsetWidth: w, offsetHeight: h } = chatAdd;
      const clampX = (x: number) => Math.max(8, Math.min(x, innerWidth - w - 8));
      const clampY = (y: number) => Math.max(minY, Math.min(y, innerHeight - h - 8));

      const placeBest = (
        outer: { left: number; right: number; top: number; bottom: number },
        anchorRight: number,
        anchorY: number,
        skip: Set<any>,
      ) => {
        const obstacles = otherNodeRects(skip);
        if (!source.hidden) obstacles.push(source.getBoundingClientRect());
        if (!$("#search").hidden) obstacles.push($("#search").getBoundingClientRect());
        const candidates: [number, number][] = [
          [anchorRight - w, outer.top - h - 5],
          [outer.right - w, outer.top - h - 5],
          [anchorRight - w, outer.bottom + 5],
          [outer.right - w, outer.bottom + 5],
          [outer.right + 8, anchorY - h / 2],
          [outer.left - w - 8, anchorY - h / 2],
        ];
        let best: [number, number] | null = null;
        let bestCost = Infinity;
        for (const [rawX, rawY] of candidates) {
          const x = clampX(rawX);
          const y = clampY(rawY);
          const box = { left: x, right: x + w, top: y, bottom: y + h };
          // Never cover the active/edited node itself unless the node fills the whole viewport.
          const selfOverlap = overlapArea(box, outer);
          const neighborOverlap = obstacles.reduce((sum, r) => sum + overlapArea(box, r), 0);
          const cost = selfOverlap * 100 + neighborOverlap;
          if (cost < bestCost) {
            best = [x, y];
            bestCost = cost;
            if (cost === 0) break;
          }
        }
        const [x, y] = best ?? [clampX(outer.right - w), clampY(outer.top - h - 5)];
        chatAdd.style.left = `${x}px`;
        chatAdd.style.top = `${y}px`;
      };

      const part = selectedPart();
      if (part) {
        if (part.inHeader) {
          chatAdd.style.left = `${clampX(part.anchorRight - w)}px`;
          chatAdd.style.top = `${Math.max(8, part.outer.top + (part.outer.bottom - part.outer.top - h) / 2)}px`;
          return;
        }
        return placeBest(part.outer, part.anchorRight, part.anchorY, new Set([part.node]));
      }
      if (document.activeElement?.classList.contains("smm-node-edit-wrap")) return hide();
      const active: any[] = mindMap.renderer.activeNodeList;
      const rects: DOMRect[] = active.map((n: any) => n.group?.node.getBoundingClientRect());
      const shown = rects.filter(r => r && r.width > 0);
      const left = Math.min(...shown.map(r => r.left));
      const right = Math.max(...shown.map(r => r.right));
      const top = Math.min(...shown.map(r => r.top));
      const bottom = Math.max(...shown.map(r => r.bottom));
      if (!shown.length || bottom < barRect.bottom || top > innerHeight || right < 0 || left > innerWidth) return hide();
      placeBest({ left, right, top, bottom }, right, (top + bottom) / 2, new Set(active));
    });
  }
  mindMap.keyCommand.removeShortcut("Control+l");
  if (chatEnabled) {
    mindMap.keyCommand.addShortcut("Control+l", () => void addToChat());
    chatMenuItem.hidden = false;
    for (const event of ["node_active", "node_tree_render_end", "scale", "translate", "expand_btn_click", "node_dragend", "exit_demonstrate", "before_show_text_edit", "hide_text_edit"]) mindMap.on(event, placeChatButton);
    mindMap.on("node_dragging", () => (chatAdd.hidden = true));
    window.addEventListener("resize", placeChatButton);
    document.addEventListener("selectionchange", placeChatButton);
    for (const event of ["select", "keyup", "mouseup", "blur"]) sourceText.addEventListener(event, placeChatButton);
    // The button lives outside the canvas, so pressing it must not reach the map's own handlers or move the selection.
    chatAdd.addEventListener("mousedown", e => (e.stopPropagation(), e.preventDefault()));
    chatAdd.addEventListener("click", e => {
      e.stopPropagation();
      addToChat();
    });
    chatMenuItem.addEventListener("click", () => addToChat(menuNodes));
    // The editor's keybinding for the shortcut asks for whatever is selected right now.
    host.onChatRequest?.(() => addToChat());
  }

  // ---- layout and theme -------------------------------------------------

  const layoutSelect = $<HTMLSelectElement>("#layout-select");
  const themeSelect = $<HTMLSelectElement>("#theme-select");
  const fillPickers = () => {
    layoutSelect.innerHTML = LAYOUTS.map(l => `<option value="${l.id}">${t(layoutName(l.id))}</option>`).join("");
    themeSelect.innerHTML = THEMES.map(th => `<option value="${th.id}">${t(themeName(th.id))}</option>`).join("");
    layoutSelect.value = mindMap.getLayout();
    themeSelect.value = theme.id;
  };

  function setTheme(next: ThemeOption) {
    theme = next;
    applyThemeCss(theme);
    mindMap.updateConfig({ expandBtnStyle: { color: theme.palette.line, fill: theme.palette.card, fontSize: 12, strokeColor: theme.palette.line } });
    mindMap.setThemeConfig(themeConfig(theme));
  }

  /** Applies the document's layout and theme, e.g. after it changed elsewhere or Pro was activated. */
  function applyLook(md: string) {
    const layout = layoutOf(md);
    if (layout !== mindMap.getLayout()) mindMap.setLayout(layout);
    const next = themeOf(md);
    if (next.id !== theme.id) setTheme(next);
    fillPickers();
  }

  function remember(key: "layout" | "theme", value: string) {
    if (readOnly()) return;
    meta = { ...meta, frontMatter: withDocumentSetting(meta.frontMatter, key, value) };
    host.onMapMarkdownChange?.(currentMarkdown());
    scheduleSave();
  }

  layoutSelect.addEventListener("change", () => {
    const choice = LAYOUTS.find(l => l.id === layoutSelect.value)!;
    if (choice.pro && !pro.allow("layouts")) return fillPickers();
    host.track?.("feature_layouts");
    mindMap.setLayout(choice.id);
    remember("layout", choice.id);
    setTimeout(() => mindMap.view.fit(), 200);
  });
  themeSelect.addEventListener("change", () => {
    const choice = THEMES.find(th => th.id === themeSelect.value)!;
    if (choice.pro && !pro.allow("themes")) return fillPickers();
    host.track?.("feature_themes");
    setTheme(choice);
    remember("theme", choice.id);
  });
  pro.onChange(() => applyLook(currentMarkdown()));
  fillPickers();

  // ---- export -----------------------------------------------------------

  const exportKatexCss = katexCss.replace(/@font-face\{[^}]*\}/g, "");

  /** The node stylesheet with theme variables resolved, for SVG files viewed outside the editor. */
  function resolvedNodeCss() {
    const style = getComputedStyle(document.documentElement);
    const resolved = nodesCss.replace(/var\((--[\w-]+),\s*([^()]+)\)/g, (_, name, fallback) => style.getPropertyValue(name).trim() || fallback);
    return `${exportKatexCss}\n${resolved}`;
  }

  async function exportAs(type: "png" | "svg" | "html") {
    hideMenus();
    if (!pro.allow("export")) return;
    host.track?.("feature_export");
    const name = title.replace(/[\\/:*?"<>|]+/g, "_");
    try {
      mindMap.execCommand("CLEAR_ACTIVE_NODE");
      if (type === "html") {
        const svgData: string = await mindMap.export("svg", false, name);
        const htmlDoc = interactiveExportHtml({
          title,
          svgDataUrl: svgData,
          markdown: currentMarkdown(),
          palette: theme.palette,
          showBadge: !pro.isPaidPro(),
        });
        const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(htmlDoc)}`;
        const file = `${name}.html`;
        if (await host.saveFile(file, dataUrl)) showToast(t("exported", { name: file }));
        return;
      }
      const data: string = await mindMap.export(type, false, name);
      const file = `${name}.${type}`;
      if (await host.saveFile(file, data)) showToast(t("exported", { name: file }));
    } catch (err) {
      showToast(t("exportFailed", { error: String(err instanceof Error ? err.message : err) }));
    }
  }

  // ---- presentation -----------------------------------------------------

  const presentBar = $("#present-bar");
  const presentStep = $("#present-step");
  const presentPrev = $<HTMLButtonElement>("#present-prev");
  const presentNext = $<HTMLButtonElement>("#present-next");
  const presentExit = $<HTMLButtonElement>("#present-exit");

  async function present() {
    if (mindMap.demonstrate?.isInDemonstrate) return;
    if (!pro.allow("present")) return;
    host.track?.("feature_present");
    hideMenus();
    closeSource();
    search.close();
    document.documentElement.classList.add("presenting");
    if (presentBar) presentBar.hidden = false;
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      // Editor webviews may not allow fullscreen; present inside the panel instead.
      mindMap.demonstrate._enter();
    }
  }
  presentPrev?.addEventListener("click", () => mindMap.demonstrate?.prev());
  presentNext?.addEventListener("click", () => mindMap.demonstrate?.next());
  presentExit?.addEventListener("click", () => mindMap.demonstrate?.exit());
  mindMap.on("demonstrate_jump", (cur: number, total: number) => {
    if (presentStep) presentStep.textContent = `${cur + 1} / ${total}`;
    if (presentPrev) presentPrev.disabled = cur <= 0;
    if (presentNext) presentNext.disabled = cur >= total - 1;
  });
  // The plugin listens for a vendor-prefixed event that current Chromium no longer fires.
  document.addEventListener("fullscreenchange", () => {
    const demo = mindMap.demonstrate;
    if (document.fullscreenElement === document.documentElement && !demo.isInDemonstrate) demo._enter();
    else if (!document.fullscreenElement && demo.isInDemonstrate) demo.exit();
  });
  mindMap.on("exit_demonstrate", () => {
    document.documentElement.classList.remove("presenting");
    if (presentBar) presentBar.hidden = true;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  });

  // The map sizes its SVG only on creation; editor panels change size whenever splits are dragged or closed.
  let resizeFrame = 0;
  const syncViewportResize = () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      const { width, height } = origGetMapRect();
      if (width < 160 || height < 160) return;
      if (!hadRealMapRect) {
        hadRealMapRect = true;
        retriedVisibleDiagrams.clear();
        mindMap.resize();
        void load(currentMarkdown(), false).then(() => {
          mindMap.resize();
          mindMap.reRender(() => {
            mindMap.view.fit();
          });
        });
        return;
      }
      mindMap.resize();
      if (otherNodeRects(new Set()).length === 0) {
        mindMap.view.fit();
      }
    });
  };
  new ResizeObserver(syncViewportResize).observe(mindMap.el);
  window.addEventListener("resize", syncViewportResize);
  document.addEventListener("visibilitychange", syncViewportResize);

  // ---- toolbar ----------------------------------------------------------

  const search = createSearch({ mindMap, pro, showToast, rewrite, onReplace: () => host.track?.("feature_replace") });
  const bar = $("#bar");
  new ResizeObserver(() => {
    const height = bar.offsetHeight;
    if (height) document.documentElement.style.setProperty("--toolbar-height", `${height}px`);
  }).observe(bar);
  mindMap.keyCommand.addShortcut("Control+f", () => search.open());

  const click = (sel: string, fn: () => void) =>
    $(sel).addEventListener("click", e => {
      fn();
      (e.currentTarget as HTMLElement).blur();
    });
  const runHostHistory = (fn: () => void) => {
    if (saveTimer || currentMarkdown() !== savedMap) {
      void flushSave().then(fn);
    } else {
      fn();
    }
  };
  if (host.history) {
    mindMap.keyCommand.removeShortcut("Control+z");
    mindMap.keyCommand.removeShortcut("Control+y");
    mindMap.keyCommand.addShortcut("Control+z", () => runHostHistory(() => host.history!.undo()));
    mindMap.keyCommand.addShortcut("Control+y|Control+Shift+z", () => runHostHistory(() => host.history!.redo()));
  } else {
    mindMap.keyCommand.addShortcut("Control+Shift+z", () => mindMap.execCommand("FORWARD"));
  }
  click("#undo", () => (host.history ? runHostHistory(() => host.history!.undo()) : mindMap.execCommand("BACK")));
  click("#redo", () => (host.history ? runHostHistory(() => host.history!.redo()) : mindMap.execCommand("FORWARD")));
  click("#fit", () => {
    mindMap.resize();
    mindMap.view.fit();
  });
  click("#menu-insert-child", () => {
    const nodes = menuNodes;
    hideMenus();
    if (nodes.length) mindMap.execCommand("INSERT_CHILD_NODE", true, nodes);
  });
  click("#menu-insert-sibling", () => {
    const nodes = menuNodes;
    hideMenus();
    if (nodes.length) mindMap.execCommand("INSERT_NODE", true, nodes);
  });
  click("#menu-insert-parent", () => {
    const nodes = menuNodes;
    hideMenus();
    if (nodes.length) mindMap.execCommand("INSERT_PARENT_NODE", true, nodes);
  });
  click("#menu-move-up", () => {
    const node = menuNodes[0];
    hideMenus();
    if (node) mindMap.execCommand("UP_NODE", node);
  });
  click("#menu-move-down", () => {
    const node = menuNodes[0];
    hideMenus();
    if (node) mindMap.execCommand("DOWN_NODE", node);
  });
  click("#menu-remove-node", () => {
    const nodes = menuNodes;
    hideMenus();
    if (nodes.length) mindMap.execCommand("REMOVE_NODE", nodes);
  });
  click("#menu-source", () => {
    const node = menuNodes[0];
    hideMenus();
    if (node) openSource(node);
  });
  click("#menu-expand-subtree", () => {
    const nodes = menuNodes;
    hideMenus();
    expandSubtree(nodes);
  });
  click("#close-source", closeSource);
  click("#find", () => (search.isOpen() ? search.close() : search.open()));
  click("#export", () => {
    if (!pro.allow("export")) return;
    exportMenu.hidden = !exportMenu.hidden;
  });
  document.querySelectorAll<HTMLElement>("[data-export]").forEach(btn => btn.addEventListener("click", () => exportAs(btn.dataset.export as "png" | "svg" | "html")));
  click("#present", present);
  const openBrowserBtn = $<HTMLButtonElement>("#open-browser");
  openBrowserBtn.hidden = !host.openInBrowser;
  click("#open-browser", () => {
    if (!pro.allow("browser")) return;
    void Promise.resolve(host.openInBrowser?.()).catch(err => {
      showToast(String(err instanceof Error ? err.message : err));
    });
  });
  const levelSelect = $<HTMLSelectElement>("#level-select");
  levelSelect.addEventListener("change", () => {
    const level = levelSelect.value;
    if (level === "all") mindMap.execCommand("EXPAND_ALL");
    else if (level) mindMap.execCommand("UNEXPAND_TO_LEVEL", Number(level));
    levelSelect.value = "";
    levelSelect.blur();
    setTimeout(() => mindMap.view.fit(), 300);
  });

  // ---- view state (folds + zoom/pan) ------------------------------------

  function captureViewState() {
    const root = mindMap.renderer.root;
    const scale: number = mindMap.view.scale;
    const view = root && Number.isFinite(root.left)
      ? {
          scale,
          dx: mindMap.view.x + (root.left + root.width / 2) * scale - mindMap.width / 2,
          dy: mindMap.view.y + (root.top + root.height / 2) * scale - mindMap.height / 2,
        }
      : undefined;
    return { folds: collectBranchFolds(mindMap.getData(false)), ...(view && { view }) };
  }

  let viewTimer = 0;
  function flushViewState() {
    if (!viewReady || !host.saveView || presenting()) return;
    clearTimeout(viewTimer);
    viewTimer = 0;
    host.saveView(captureViewState());
  }
  function scheduleViewState() {
    if (!viewReady || !host.saveView || presenting()) return;
    clearTimeout(viewTimer);
    viewTimer = window.setTimeout(flushViewState, 250);
  }

  mindMap.on("node_tree_render_end", () => {
    sweepOrphanSvgNodes();
    if (pendingInitialView) {
      const saved = pendingInitialView;
      pendingInitialView = undefined;
      const root = mindMap.renderer.root;
      if (root && mindMap.width > 0 && mindMap.height > 0) {
        mindMap.view.scale = saved.scale;
        mindMap.view.x = mindMap.width / 2 + saved.dx - (root.left + root.width / 2) * saved.scale;
        mindMap.view.y = mindMap.height / 2 + saved.dy - (root.top + root.height / 2) * saved.scale;
        mindMap.view.transform();
        if (otherNodeRects(new Set()).length === 0) {
          mindMap.view.fit();
        } else {
          mindMap.emit("scale", saved.scale);
          mindMap.emit("translate");
        }
      }
      viewReady = true;
      return;
    }
    if (!viewReady) {
      viewReady = true;
      return;
    }
    scheduleViewState();
  });
  mindMap.on("scale", scheduleViewState);
  mindMap.on("translate", scheduleViewState);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flushViewState());

  window.addEventListener("beforeunload", e => {
    flushViewState();
    if (status.dataset.state !== "saved") e.preventDefault();
  });

  return { mindMap, currentMarkdown, pro, load, flushSave };
}

export function mount(host: Host) {
  return start(host).then(api => {
    // Exposed for end-to-end tests, console debugging, and host workspace panes (see workspace-tree.ts `editorApi`).
    (window as unknown as { inkmap: typeof api }).inkmap = api;
    return api;
  });
}

export function showEditorError(err: unknown) {
  const message = document.createElement("p");
  message.style.cssText = `padding:24px;font:14px ${FONT}`;
  message.textContent = String(err instanceof Error ? err.message : err);
  document.body.replaceChildren(message);
}
