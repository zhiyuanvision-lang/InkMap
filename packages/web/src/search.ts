import { plainText } from "@inkmap/core";
import { markdownOf, type MindNode } from "./convert";
import { $ } from "./dom";
import { t } from "./i18n";
import type { Pro } from "./pro";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replaces every case-insensitive occurrence of `find` in the node's Markdown; returns null when there is none.
 * Matches that only exist in the rendered text (e.g. spanning `**bold**` or a link) are found by search but
 * left alone here, because rewriting them would flatten the node's links, images and formatting.
 */
export function replaceText(text: string, find: string, replacement: string): { next: string; hits: number } | null {
  let hits = 0;
  const next = text.replace(new RegExp(escapeRegExp(find), "gi"), () => {
    hits++;
    return replacement;
  });
  return hits > 0 ? { next, hits } : null;
}

/**
 * Where the cursor goes after "Replace" changed the match at `index`: to the next match when the node still
 * matches (the replacement contains the query), else to whatever slid into the same position.
 */
export function nextIndexAfterReplaceOne(index: number, prevCount: number, newCount: number): number {
  if (newCount === 0) return -1;
  if (newCount >= prevCount) return (index + 1) % newCount;
  return Math.min(Math.max(index, 0), newCount - 1);
}

interface SearchDeps {
  mindMap: any;
  pro: Pro;
  showToast(text: string): void;
  /** Rewrites the Markdown of matching nodes (all of them, or only `uid`) and returns how many changed. */
  rewrite(change: (md: string) => string | null, uid?: string): Promise<number>;
  onReplace?(): void;
}

export function createSearch({ mindMap, pro, showToast, rewrite, onReplace }: SearchDeps) {
  const bar = $("#search");
  const findInput = $<HTMLInputElement>("#find-input");
  const replaceInput = $<HTMLInputElement>("#replace-input");
  const count = $("#find-count");
  let matches: string[] = [];
  let index = -1;

  function collect(query: string): string[] {
    const q = query.toLowerCase();
    const out: string[] = [];
    const walk = (n: MindNode) => {
      if (plainText(markdownOf(n.data)).toLowerCase().includes(q) || markdownOf(n.data).toLowerCase().includes(q)) out.push(String(n.data.uid));
      (n.children ?? []).forEach(walk);
    };
    if (q) walk(mindMap.renderer.renderTree);
    return out;
  }

  function showCount() {
    count.textContent = !findInput.value ? "" : matches.length ? `${index + 1}/${matches.length}` : t("noResults");
  }

  function focusMatch() {
    const uid = matches[index];
    if (!uid) return showCount();
    mindMap.renderer.expandToNodeUid(uid, () => {
      const node = mindMap.renderer.findNodeByUid(uid);
      if (!node) return;
      mindMap.execCommand("CLEAR_ACTIVE_NODE");
      node.active();
      mindMap.renderer.moveNodeToCenter(node, false);
    });
    showCount();
  }

  function run(keepIndex = false) {
    matches = collect(findInput.value);
    index = matches.length ? (keepIndex ? Math.min(Math.max(index, 0), matches.length - 1) : 0) : -1;
    focusMatch();
  }

  function step(delta: number) {
    if (!matches.length) return run();
    index = (index + delta + matches.length) % matches.length;
    focusMatch();
  }

  function open() {
    bar.hidden = false;
    const active = mindMap.renderer.activeNodeList[0];
    if (!findInput.value && active) findInput.value = plainText(markdownOf(active.getData())).slice(0, 60);
    findInput.focus();
    findInput.select();
    run();
  }

  function close() {
    bar.hidden = true;
    findInput.blur();
    replaceInput.blur();
  }

  async function replace(all: boolean) {
    if (!pro.allow("replace")) return;
    const find = findInput.value;
    if (!find) return findInput.focus();
    const uid = all ? undefined : matches[index];
    if (!all && !uid) return;
    const prevCount = matches.length;
    let totalHits = 0;
    const changedNodes = await rewrite(md => {
      const r = replaceText(md, find, replaceInput.value);
      if (!r) return null;
      totalHits += r.hits;
      return r.next;
    }, uid);
    if (changedNodes > 0) onReplace?.();
    showToast(t("replaced", { n: totalHits || changedNodes }));
    if (!all && changedNodes > 0) {
      matches = collect(findInput.value);
      index = nextIndexAfterReplaceOne(index, prevCount, matches.length);
      focusMatch();
      return;
    }
    run(!all);
  }

  let timer = 0;
  findInput.addEventListener("input", () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => run(), 150);
  });
  findInput.addEventListener("keydown", e => {
    if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
    if (e.key === "Escape") close();
  });
  replaceInput.addEventListener("keydown", e => {
    if (e.key === "Enter") replace(e.metaKey || e.ctrlKey);
    if (e.key === "Escape") close();
  });
  $("#find-prev").addEventListener("click", () => step(-1));
  $("#find-next").addEventListener("click", () => step(1));
  $("#replace-one").addEventListener("click", () => replace(false));
  $("#replace-all").addEventListener("click", () => replace(true));
  $("#find-close").addEventListener("click", close);

  return { open, close, isOpen: () => !bar.hidden };
}
