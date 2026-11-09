import MindMapCtor from "simple-mind-map";
import Demonstrate from "simple-mind-map/src/plugins/Demonstrate.js";
import Drag from "simple-mind-map/src/plugins/Drag.js";
import Export from "simple-mind-map/src/plugins/Export.js";
import KeyboardNavigation from "simple-mind-map/src/plugins/KeyboardNavigation.js";
import Select from "simple-mind-map/src/plugins/Select.js";
import "simple-mind-map/dist/simpleMindMap.esm.css";
import {
  documentSetting,
  isRich,
  parse,
  serialize,
  serializeWithLines,
  withDocumentSetting,
  type OutlineDoc,
  type OutlineNode,
} from "@inkmap/core";
import { collectExpand, markdownOf, nodeData, toMind, toOutlineDoc, type MindNode, type MindNodeData } from "./convert";
import { detectHost, HttpHost, type DocState, type Host } from "./host";
import { applyI18n, setLocale, t } from "./i18n";
import nodesCss from "./nodes.css?inline";
import { createPro } from "./pro";
import { createRenderer } from "./render";
import { createSearch } from "./search";
import { applyThemeCss, FONT, LAYOUTS, layoutName, themeConfig, themeName, THEMES, type ThemeOption } from "./themes";
import "./style.css";

// simple-mind-map ships loose typings; the editor treats its instances as untyped.
const MindMap = MindMapCtor as any;
MindMap.usePlugin(Drag).usePlugin(Select).usePlugin(KeyboardNavigation).usePlugin(Export).usePlugin(Demonstrate);

const INITIAL_LEVELS = 3;
const SAVE_DELAY = 400;
const EXPORT_PADDING = 40;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const nodeStyle = document.createElement("style");
nodeStyle.textContent = nodesCss;
document.head.append(nodeStyle);

export async function start(host: Host) {
  setLocale(host.locale);
  applyI18n();
  const renderer = createRenderer(host.assetBase);
  const status = $("#status");
  const toast = $("#toast");
  const source = $("#source");
  const sourceText = $<HTMLTextAreaElement>("#source-text");

  let doc: DocState = await host.load();
  let meta: Omit<OutlineDoc, "root">;
  let lastMd = doc.md;
  let saving: Promise<void> = Promise.resolve();
  let saveTimer = 0;
  let sourceNode: any = null;

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

  async function buildData(md: string, expandOf: (path: string[], depth: number) => boolean): Promise<MindNode> {
    const outline = parse(md, doc.name);
    const { root, ...rest } = outline;
    meta = rest;
    const mds: string[] = [];
    const walk = (n: typeof root) => (mds.push(n.md), n.children.forEach(walk));
    walk(root);
    await renderer.preload(mds);
    return toMind(root, expandOf);
  }

  // ---- per-document look: layout and theme live in the front matter ------

  const frontMatterOf = (md: string) => (md.startsWith("---\n") ? (md.match(/^---\n[\s\S]*?\n---\n/)?.[0] ?? "") : "");
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

  const title = doc.md.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? doc.name;
  $("#doc-name").textContent = title;
  document.title = `${title} · Inkmap`;

  let theme = themeOf(doc.md);
  applyThemeCss(theme);

  const mindMap = new MindMap({
    el: $("#map"),
    data: await buildData(doc.md, (_, depth) => depth < INITIAL_LEVELS),
    layout: layoutOf(doc.md),
    fit: true,
    enableShortcutOnlyWhenMouseInSvg: false,
    enableAutoEnterTextEditWhenKeydown: true,
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
      return el;
    },
    themeConfig: themeConfig(theme),
    expandBtnStyle: { color: theme.palette.line, fill: theme.palette.card, fontSize: 12, strokeColor: theme.palette.line },
    exportPaddingX: EXPORT_PADDING,
    exportPaddingY: EXPORT_PADDING,
    handleBeingExportSvg: (svg: any) => {
      svg.node.insertAdjacentHTML("afterbegin", `<style>${resolvedNodeCss()}</style>`);
      return svg;
    },
    demonstrateConfig: { boxShadowColor: "rgba(0, 0, 0, 0.75)", borderColor: theme.palette.line, padding: 24, margin: 60 },
  });

  // ---- write back -------------------------------------------------------

  const currentMarkdown = () => serialize(toOutlineDoc(meta, mindMap.getData(false)));
  // In an editor the map edits the open document; saving to disk stays with the editor.
  const SYNCED = host instanceof HttpHost ? t("saved") : t("synced");
  setStatus("saved", SYNCED);

  function scheduleSave() {
    clearTimeout(saveTimer);
    if (currentMarkdown() === lastMd) return;
    setStatus("pending", t("pending"));
    saveTimer = window.setTimeout(() => (saving = saving.then(save)), SAVE_DELAY);
  }

  async function save() {
    const md = currentMarkdown();
    if (md === lastMd) return setStatus("saved", SYNCED);
    setStatus("saving", t("saving"));
    try {
      const result = await host.save(md, doc.version);
      if (result.ok) {
        lastMd = md;
        doc = { ...doc, md, version: result.version };
        setStatus("saved", SYNCED);
      } else {
        await applyExternal(result.doc);
        showToast(t("conflict"));
      }
    } catch (err) {
      setStatus("error", t("saveFailed"));
      showToast(String(err instanceof Error ? err.message : err));
    }
  }

  /** Replaces the map with `md`, keeping folds; `local` edits are then saved like any other edit. */
  async function load(md: string, local: boolean) {
    const folds = collectExpand(mindMap.getData(false));
    const data = await buildData(md, (path, depth) => folds.get(path.join("\u0000")) ?? depth < INITIAL_LEVELS);
    closeSource();
    mindMap.updateData(data);
    applyLook(md);
    if (local) scheduleSave();
  }

  async function applyExternal(next: DocState) {
    if (next.md === lastMd) {
      doc = next;
      return;
    }
    doc = next;
    lastMd = next.md;
    await load(next.md, false);
    setStatus("saved", t("synced"));
  }

  mindMap.on("data_change", scheduleSave);
  host.onExternalChange(next => {
    saving = saving.then(() => applyExternal(next));
  });

  // ---- editing ----------------------------------------------------------

  async function setMarkdown(node: any, md: string) {
    await renderer.preload([md]);
    mindMap.renderer.setNodeDataRender(node, nodeData(md));
  }

  // Text typed on the canvas becomes rendered Markdown once it uses Markdown syntax.
  mindMap.on("hide_text_edit", (_el: unknown, _list: unknown, node: any) => {
    const text = String(node?.getData("text") ?? "");
    if (node && isRich(text)) setMarkdown(node, text);
  });

  function openSource(node: any, focus = true) {
    sourceNode = node;
    source.hidden = false;
    sourceText.value = markdownOf(node.getData());
    if (focus) sourceText.focus();
  }
  function closeSource() {
    sourceNode = null;
    source.hidden = true;
    sourceText.blur();
  }

  let sourceTimer = 0;
  sourceText.addEventListener("input", () => {
    const node = sourceNode;
    clearTimeout(sourceTimer);
    sourceTimer = window.setTimeout(() => node && setMarkdown(node, sourceText.value.replace(/\n+$/, "")), 250);
  });
  sourceText.addEventListener("keydown", e => {
    if (e.key === "Escape") closeSource();
  });

  mindMap.on("node_dblclick", (node: any) => {
    if (node.getData("rich")) openSource(node);
  });
  mindMap.on("node_active", (node: any, list: any[]) => {
    if (source.hidden) return;
    if (list.length === 1) openSource(list[0], !revealing);
    else sourceText.value = "";
  });

  /** Rewrites node Markdown in place (every node, or the one with `uid`) and saves the result. */
  async function rewrite(change: (md: string) => string | null, uid?: string): Promise<number> {
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
    if (n) await load(serialize(toOutlineDoc(meta, tree)), true);
    return n;
  }

  // ---- link with the text editor ------------------------------------------

  /** Start line of every node in the current document, keyed by node uid. */
  function nodeLines(): Map<string, number> {
    const uids = new Map<OutlineNode, string>();
    const { lines } = serializeWithLines(toOutlineDoc(meta, mindMap.getData(false), uids));
    const out = new Map<string, number>();
    for (const [node, line] of lines) {
      const uid = uids.get(node);
      if (uid) out.set(uid, line);
    }
    return out;
  }

  let revealing = false;
  if (host.select) {
    mindMap.on("node_click", (node: any) => {
      const line = nodeLines().get(node.getData("uid"));
      if (line !== undefined) host.select!(line);
    });
  }
  host.onReveal?.(line => {
    let best: string | undefined;
    let bestLine = -1;
    for (const [uid, start] of nodeLines()) {
      if (start <= line && start > bestLine) [best, bestLine] = [uid, start];
    }
    if (!best || mindMap.renderer.activeNodeList[0]?.getData("uid") === best) return;
    const uid = best;
    mindMap.renderer.expandToNodeUid(uid, () => {
      const node = mindMap.renderer.findNodeByUid(uid);
      if (!node) return;
      revealing = true;
      mindMap.execCommand("CLEAR_ACTIVE_NODE");
      node.active();
      revealing = false;
      if (!node.checkIsInClient?.(40)) mindMap.renderer.moveNodeToCenter(node, false);
    });
  });
  const toggleSource = () => {
    const active = mindMap.renderer.activeNodeList;
    if (!source.hidden) closeSource();
    else if (active.length === 1) openSource(active[0]);
    else showToast(t("selectNode"));
  };
  mindMap.keyCommand.addShortcut("Control+e", toggleSource);

  const expandSubtree = (nodes: any[] = mindMap.renderer.activeNodeList) => {
    if (!nodes.length) return showToast(t("selectNode"));
    nodes.forEach(n => mindMap.execCommand("EXPAND_ALL", n.getData("uid")));
  };
  mindMap.keyCommand.addShortcut("Shift+/", () => expandSubtree());

  // ---- menus ------------------------------------------------------------

  const nodeMenu = $("#node-menu");
  const exportMenu = $("#export-menu");
  let menuNodes: any[] = [];
  const hideMenus = () => {
    nodeMenu.hidden = true;
    exportMenu.hidden = true;
    menuNodes = [];
  };
  mindMap.on("node_contextmenu", (e: MouseEvent, node: any) => {
    e.preventDefault();
    const active = mindMap.renderer.activeNodeList;
    menuNodes = active.includes(node) ? [...active] : [node];
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

  // ---- layout and theme -------------------------------------------------

  const layoutSelect = $<HTMLSelectElement>("#layout-select");
  const themeSelect = $<HTMLSelectElement>("#theme-select");
  const fillPickers = () => {
    const mark = (isPro: boolean) => (isPro && !pro.isPro() ? " · Pro" : "");
    layoutSelect.innerHTML = LAYOUTS.map(l => `<option value="${l.id}">${t(layoutName(l.id))}${mark(l.pro)}</option>`).join("");
    themeSelect.innerHTML = THEMES.map(th => `<option value="${th.id}">${t(themeName(th.id))}${mark(th.pro)}</option>`).join("");
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
    meta = { ...meta, frontMatter: withDocumentSetting(meta.frontMatter, key, value) };
    scheduleSave();
  }

  layoutSelect.addEventListener("change", () => {
    const choice = LAYOUTS.find(l => l.id === layoutSelect.value)!;
    if (choice.pro && !pro.allow("layouts")) return fillPickers();
    mindMap.setLayout(choice.id);
    remember("layout", choice.id);
    setTimeout(() => mindMap.view.fit(), 200);
  });
  themeSelect.addEventListener("change", () => {
    const choice = THEMES.find(th => th.id === themeSelect.value)!;
    if (choice.pro && !pro.allow("themes")) return fillPickers();
    setTheme(choice);
    remember("theme", choice.id);
  });
  pro.onChange(() => applyLook(currentMarkdown()));
  fillPickers();

  // ---- export -----------------------------------------------------------

  /** The node stylesheet with theme variables resolved, for SVG files viewed outside the editor. */
  function resolvedNodeCss() {
    const style = getComputedStyle(document.documentElement);
    return nodesCss.replace(/var\((--[\w-]+),\s*([^()]+)\)/g, (_, name, fallback) => style.getPropertyValue(name).trim() || fallback);
  }

  async function exportAs(type: "png" | "svg") {
    hideMenus();
    if (!pro.allow("export")) return;
    const name = title.replace(/[\\/:*?"<>|]+/g, "_");
    try {
      mindMap.execCommand("CLEAR_ACTIVE_NODE");
      const data: string = await mindMap.export(type, false, name);
      const file = `${name}.${type}`;
      if (await host.saveFile(file, data)) showToast(t("exported", { name: file }));
    } catch (err) {
      showToast(t("exportFailed", { error: String(err instanceof Error ? err.message : err) }));
    }
  }

  // ---- presentation -----------------------------------------------------

  async function present() {
    if (!pro.allow("present")) return;
    hideMenus();
    closeSource();
    search.close();
    pro.setAdsSuspended(true);
    document.documentElement.classList.add("presenting");
    try {
      await mindMap.el.requestFullscreen();
    } catch {
      // Editor webviews may not allow fullscreen; present inside the panel instead.
      mindMap.demonstrate._enter();
    }
  }
  // The plugin listens for a vendor-prefixed event that current Chromium no longer fires.
  document.addEventListener("fullscreenchange", () => {
    const demo = mindMap.demonstrate;
    if (document.fullscreenElement === mindMap.el && !demo.isInDemonstrate) demo._enter();
    else if (!document.fullscreenElement && demo.isInDemonstrate) demo.exit();
  });
  mindMap.on("exit_demonstrate", () => {
    document.documentElement.classList.remove("presenting");
    pro.setAdsSuspended(false);
  });

  // ---- toolbar ----------------------------------------------------------

  const search = createSearch({ mindMap, pro, showToast, rewrite });
  mindMap.keyCommand.addShortcut("Control+f", () => search.open());

  const click = (sel: string, fn: () => void) =>
    $(sel).addEventListener("click", e => {
      fn();
      (e.currentTarget as HTMLElement).blur();
    });
  if (host.history) {
    mindMap.keyCommand.removeShortcut("Control+z");
    mindMap.keyCommand.removeShortcut("Control+y");
  }
  click("#undo", () => (host.history ? host.history.undo() : mindMap.execCommand("BACK")));
  click("#redo", () => (host.history ? host.history.redo() : mindMap.execCommand("FORWARD")));
  click("#fit", () => mindMap.view.fit());
  click("#expand-subtree", () => expandSubtree());
  click("#menu-expand-subtree", () => {
    const nodes = menuNodes;
    hideMenus();
    expandSubtree(nodes);
  });
  click("#toggle-source", toggleSource);
  click("#close-source", closeSource);
  click("#find", () => (search.isOpen() ? search.close() : search.open()));
  click("#export", () => {
    if (!pro.allow("export")) return;
    exportMenu.hidden = !exportMenu.hidden;
  });
  document.querySelectorAll<HTMLElement>("[data-export]").forEach(btn => btn.addEventListener("click", () => exportAs(btn.dataset.export as "png" | "svg")));
  click("#present", present);
  const levelSelect = $<HTMLSelectElement>("#level-select");
  levelSelect.addEventListener("change", () => {
    const level = levelSelect.value;
    if (level === "all") mindMap.execCommand("EXPAND_ALL");
    else if (level) mindMap.execCommand("UNEXPAND_TO_LEVEL", Number(level) + 1);
    levelSelect.value = "";
    levelSelect.blur();
    setTimeout(() => mindMap.view.fit(), 300);
  });

  window.addEventListener("beforeunload", e => {
    if (status.dataset.state !== "saved") e.preventDefault();
  });

  return { mindMap, currentMarkdown, pro };
}

start(detectHost()).then(api => {
  // Exposed for end-to-end tests and console debugging.
  (window as any).inkmap = api;
}).catch(err => {
  document.body.innerHTML = `<p style="padding:24px;font:14px ${FONT}">${String(err?.message ?? err)}</p>`;
});
