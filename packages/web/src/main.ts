import MindMapCtor from "simple-mind-map";
import Drag from "simple-mind-map/src/plugins/Drag.js";
import KeyboardNavigation from "simple-mind-map/src/plugins/KeyboardNavigation.js";
import Select from "simple-mind-map/src/plugins/Select.js";
import "simple-mind-map/dist/simpleMindMap.esm.css";
import { isRich, parse, serialize, serializeWithLines, type OutlineDoc, type OutlineNode } from "@inkmap/core";
import { collectExpand, markdownOf, nodeData, toMind, toOutlineDoc, type MindNode, type MindNodeData } from "./convert";
import { detectHost, HttpHost, type DocState, type Host } from "./host";
import { createRenderer } from "./render";
import "./style.css";

// simple-mind-map ships loose typings; the editor treats its instances as untyped.
const MindMap = MindMapCtor as any;
MindMap.usePlugin(Drag).usePlugin(Select).usePlugin(KeyboardNavigation);

const INITIAL_LEVELS = 3;
const SAVE_DELAY = 400;
const BLUE = "#5b7fd4";
const ROOT = "#4e83fd";
const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", sans-serif';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

export async function start(host: Host) {
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
  const showToast = (text: string) => {
    toast.textContent = text;
    toast.hidden = false;
    setTimeout(() => (toast.hidden = true), 4000);
  };

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

  const layoutOf = (md: string) =>
    /^\s*layout:\s*["']?(two-sided|mindMap)/m.test(md.split(/^---$/m)[1] ?? "") ? "mindMap" : "logicalStructure";

  const title = doc.md.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? doc.name;
  $("#doc-name").textContent = title;
  document.title = `${title} · Inkmap`;

  const mindMap = new MindMap({
    el: $("#map"),
    data: await buildData(doc.md, (_, depth) => depth < INITIAL_LEVELS),
    layout: layoutOf(doc.md),
    fit: true,
    enableShortcutOnlyWhenMouseInSvg: false,
    enableAutoEnterTextEditWhenKeydown: true,
    defaultInsertSecondLevelNodeText: "新主题",
    defaultInsertBelowSecondLevelNodeText: "新主题",
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
    themeConfig: {
      backgroundColor: "#f5f6f7",
      lineStyle: "straight",
      lineRadius: 6,
      lineWidth: 1.5,
      lineColor: BLUE,
      rootLineKeepSameInCurve: false,
      paddingX: 12,
      paddingY: 6,
      root: { fillColor: ROOT, color: "#fff", fontSize: 18, fontWeight: "bold", fontFamily: FONT, borderWidth: 0, borderRadius: 8, marginX: 80, marginY: 24 },
      second: { fillColor: "#fff", color: "#1f2329", fontSize: 15, fontWeight: "bold", fontFamily: FONT, borderColor: BLUE, borderWidth: 1.5, borderRadius: 6, marginX: 60, marginY: 16 },
      node: { fillColor: "#fff", color: "#1f2329", fontSize: 14, fontFamily: FONT, borderColor: "#dee0e3", borderWidth: 1, borderRadius: 6, marginX: 50, marginY: 10 },
    },
    expandBtnStyle: { color: BLUE, fill: "#fff", fontSize: 12, strokeColor: BLUE },
  });

  // ---- write back -------------------------------------------------------

  const currentMarkdown = () => serialize(toOutlineDoc(meta, mindMap.getData(false)));
  // In an editor the map edits the open document; saving to disk stays with the editor.
  const SYNCED = host instanceof HttpHost ? "已保存" : "已同步";

  function scheduleSave() {
    clearTimeout(saveTimer);
    if (currentMarkdown() === lastMd) return;
    setStatus("pending", "待保存");
    saveTimer = window.setTimeout(() => (saving = saving.then(save)), SAVE_DELAY);
  }

  async function save() {
    const md = currentMarkdown();
    if (md === lastMd) return setStatus("saved", SYNCED);
    setStatus("saving", "保存中…");
    try {
      const result = await host.save(md, doc.version);
      if (result.ok) {
        lastMd = md;
        doc = { ...doc, md, version: result.version };
        setStatus("saved", SYNCED);
      } else {
        await applyExternal(result.doc);
        showToast("文件已在别处修改，已载入最新内容；刚才这一步修改没有写入，请重做。");
      }
    } catch (err) {
      setStatus("error", "保存失败");
      showToast(String(err instanceof Error ? err.message : err));
    }
  }

  async function applyExternal(next: DocState) {
    if (next.md === lastMd) {
      doc = next;
      return;
    }
    const folds = collectExpand(mindMap.getData(false));
    const data = await buildData(next.md, (path, depth) => folds.get(path.join("\u0000")) ?? depth < INITIAL_LEVELS);
    doc = next;
    lastMd = next.md;
    closeSource();
    mindMap.updateData(data);
    setStatus("saved", "已同步");
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
    else showToast("先选中一个节点");
  };
  mindMap.keyCommand.addShortcut("Control+e", toggleSource);

  const expandSubtree = (nodes: any[] = mindMap.renderer.activeNodeList) => {
    if (!nodes.length) return showToast("先选中一个节点");
    nodes.forEach(n => mindMap.execCommand("EXPAND_ALL", n.getData("uid")));
  };
  mindMap.keyCommand.addShortcut("Shift+/", () => expandSubtree());

  const menu = $("#node-menu");
  let menuNodes: any[] = [];
  const hideMenu = () => {
    menu.hidden = true;
    menuNodes = [];
  };
  mindMap.on("node_contextmenu", (e: MouseEvent, node: any) => {
    e.preventDefault();
    const active = mindMap.renderer.activeNodeList;
    menuNodes = active.includes(node) ? [...active] : [node];
    menu.hidden = false;
    menu.style.left = `${Math.min(e.clientX, innerWidth - menu.offsetWidth - 8)}px`;
    menu.style.top = `${Math.min(e.clientY, innerHeight - menu.offsetHeight - 8)}px`;
  });
  window.addEventListener("pointerdown", e => !menu.contains(e.target as Node) && hideMenu(), true);
  window.addEventListener("keydown", e => e.key === "Escape" && hideMenu());
  mindMap.on("scale", hideMenu);
  mindMap.on("translate", hideMenu);

  // ---- toolbar ----------------------------------------------------------

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
    hideMenu();
    expandSubtree(nodes);
  });
  click("#toggle-source", toggleSource);
  click("#close-source", closeSource);
  document.querySelectorAll<HTMLElement>("#bar [data-level]").forEach(btn =>
    btn.addEventListener("click", () => {
      const level = btn.dataset.level!;
      if (level === "all") mindMap.execCommand("EXPAND_ALL");
      else mindMap.execCommand("UNEXPAND_TO_LEVEL", Number(level) + 1);
      btn.blur();
      setTimeout(() => mindMap.view.fit(), 300);
    }),
  );

  window.addEventListener("beforeunload", e => {
    if (status.dataset.state !== "saved") e.preventDefault();
  });

  return { mindMap, currentMarkdown };
}

start(detectHost()).then(api => {
  // Exposed for end-to-end tests and console debugging.
  (window as any).inkmap = api;
}).catch(err => {
  document.body.innerHTML = `<p style="padding:24px;font:14px ${FONT}">${String(err?.message ?? err)}</p>`;
});
