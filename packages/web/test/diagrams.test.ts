import { describe, expect, it } from "vitest";
import { normalizeFlowchartShapes } from "../src/diagrams";
import { mermaidSourceRanges } from "../src/md-lines";

const sources = (md: string) => mermaidSourceRanges(md).map(r => md.slice(r.start, r.end));

describe("mermaidSourceRanges", () => {
  it("finds top-level diagrams in order", () => {
    const md = "Intro\n```mermaid\ngraph TD\n  A-->B\n```\ntext\n~~~mermaid\nflowchart LR\n  C-->D\n~~~\n";
    expect(sources(md)).toEqual(["graph TD\n  A-->B\n", "flowchart LR\n  C-->D\n"]);
  });

  it("skips Mermaid samples inside other code blocks", () => {
    const md = "~~~text\n```mermaid\nnot drawn\n```\n~~~\n```mermaid\ngraph TD\n  A-->B\n```\n";
    expect(sources(md)).toEqual(["graph TD\n  A-->B\n"]);
  });

  it("includes diagrams inside up to two ```markdown fences, like the renderer", () => {
    const md = [
      "````markdown", "```mermaid", "graph TD", "  A-->B", "```", "````",
      "`````md", "````markdown", "```mermaid", "graph LR", "  C-->D", "```", "````", "`````",
      "``````md", "`````md", "````md", "```mermaid", "graph TB", "  E-->F", "```", "````", "`````", "``````",
    ].join("\n");
    expect(sources(md)).toEqual(["graph TD\n  A-->B\n", "graph LR\n  C-->D\n"]);
  });

  it("runs an unclosed diagram to the end of the text", () => {
    expect(sources("```mermaid\ngraph TD\n  A-->B")).toEqual(["graph TD\n  A-->B"]);
  });
});

describe("normalizeFlowchartShapes", () => {
  it("turns decision diamonds into hexagons", () => {
    expect(normalizeFlowchartShapes('flowchart TD\n  A --> B{"Ready?"}\n  C{Go}')).toBe('flowchart TD\n  A --> B{{"Ready?"}}\n  C{{Go}}');
  });

  it("leaves braces inside quoted and edge labels alone", () => {
    const src = 'graph TD\n  A["x{y}"] -->|a{b}| C';
    expect(normalizeFlowchartShapes(src)).toBe(src);
  });

  it("ignores diagrams that are not flowcharts", () => {
    expect(normalizeFlowchartShapes("sequenceDiagram\n  A->>B: x{y}")).toBe("sequenceDiagram\n  A->>B: x{y}");
  });
});
