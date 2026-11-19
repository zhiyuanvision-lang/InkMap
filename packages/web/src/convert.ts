import { isRich, plainText, type DividerLine, type OutlineDoc, type OutlineNode } from "@inkmap/core";

/** Node data as stored in simple-mind-map. Outline fields ride along so they survive moves and undo. */
export interface MindNodeData {
  text: string;
  md: string;
  rich: boolean;
  kind?: OutlineNode["kind"];
  level?: number;
  marker?: string;
  blankBefore?: number;
  unindentedBlock?: boolean;
  dividersBefore?: DividerLine[];
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
      unindentedBlock: node.unindentedBlock,
      dividersBefore: node.dividersBefore,
      expand: node.children.length ? expand(here, depth) : true,
    },
    children: node.children.map(c => toMind(c, expand, here, depth + 1)),
  };
}

/** Read the saved Markdown of a node, keeping the source of rendered content intact. */
export const markdownOf = (data: MindNodeData) => (data.rich ? data.md : String(data.text ?? "")).replace(/\r\n?/g, "\n");

function fromMind(node: MindNode, uids?: Map<OutlineNode, string>): OutlineNode {
  const { data } = node;
  const children = (node.children ?? []).map(c => fromMind(c, uids));
  const inferredKind = data.kind ?? (children.some(c => c.kind === "heading") ? "heading" : "item");
  const out: OutlineNode = {
    md: markdownOf(data),
    kind: inferredKind,
    level: data.level,
    marker: data.marker,
    blankBefore: data.blankBefore,
    ...(data.unindentedBlock && { unindentedBlock: true }),
    ...(data.dividersBefore?.length && { dividersBefore: data.dividersBefore }),
    children,
  };
  if (uids && data.uid) uids.set(out, data.uid);
  return out;
}

export function toOutlineDoc(meta: Omit<OutlineDoc, "root">, root: MindNode, uids?: Map<OutlineNode, string>): OutlineDoc {
  return { ...meta, root: fromMind(root, uids) };
}

/** Expanded state keyed by the Markdown path from the root, used to keep folds across reloads. */
export function collectExpand(node: MindNode, out = new Map<string, boolean>(), path: string[] = []) {
  const here = [...path, markdownOf(node.data)];
  out.set(here.join("\u0000"), node.data.expand !== false);
  (node.children ?? []).forEach(c => collectExpand(c, out, here));
  return out;
}

/** Serializable expand map containing only nodes that actually have children. */
export function collectBranchFolds(node: MindNode, out: Record<string, boolean> = {}, path: string[] = []) {
  const here = [...path, markdownOf(node.data)];
  if (node.children?.length) {
    out[here.join("\u0000")] = node.data.expand !== false;
    node.children.forEach(c => collectBranchFolds(c, out, here));
  }
  return out;
}
