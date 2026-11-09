import { isRich, plainText, type OutlineDoc, type OutlineNode } from "@inkmap/core";

/** Node data as stored in simple-mind-map. Outline fields ride along so they survive moves and undo. */
export interface MindNodeData {
  text: string;
  md: string;
  rich: boolean;
  kind?: OutlineNode["kind"];
  level?: number;
  marker?: string;
  blankBefore?: number;
  expand?: boolean;
  uid?: string;
  [key: string]: unknown;
}

export interface MindNode {
  data: MindNodeData;
  children: MindNode[];
}

export function nodeData(md: string): Pick<MindNodeData, "text" | "md" | "rich"> {
  const rich = isRich(md);
  return { md, rich, text: rich ? plainText(md) || " " : md };
}

export function toMind(node: OutlineNode, expand: (path: string[], depth: number) => boolean, path: string[] = [], depth = 0): MindNode {
  const here = [...path, node.md];
  return {
    data: {
      ...nodeData(node.md),
      kind: node.kind,
      level: node.level,
      marker: node.marker,
      blankBefore: node.blankBefore,
      expand: node.children.length ? expand(here, depth) : true,
    },
    children: node.children.map(c => toMind(c, expand, here, depth + 1)),
  };
}

/** Markdown of a node: plain nodes are edited as text on the canvas, rich nodes through their source. */
export const markdownOf = (data: MindNodeData) => (data.rich ? data.md : String(data.text ?? "")).replace(/\r\n?/g, "\n");

export function fromMind(node: MindNode): OutlineNode {
  const { data } = node;
  return {
    md: markdownOf(data),
    kind: data.kind ?? "item",
    level: data.level,
    marker: data.marker,
    blankBefore: data.blankBefore,
    children: (node.children ?? []).map(fromMind),
  };
}

export function toOutlineDoc(meta: Omit<OutlineDoc, "root">, root: MindNode): OutlineDoc {
  return { ...meta, root: fromMind(root) };
}

/** Expanded state keyed by the Markdown path from the root, used to keep folds across reloads. */
export function collectExpand(node: MindNode, out = new Map<string, boolean>(), path: string[] = []) {
  const here = [...path, markdownOf(node.data)];
  out.set(here.join("\u0000"), node.data.expand !== false);
  (node.children ?? []).forEach(c => collectExpand(c, out, here));
  return out;
}
