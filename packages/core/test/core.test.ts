import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isRich, parse, plainText, serialize } from "../src/index";

const roundTrip = (md: string) => serialize(parse(md));

describe("round trip", () => {
  it("keeps a real markmap document byte for byte", () => {
    const md = readFileSync(new URL("./fixtures/logic-design.md", import.meta.url), "utf8");
    expect(roundTrip(md)).toBe(md);
  });

  it.each([
    ["front matter and heading root", "---\ntitle: T\n---\n\n## Root\n\n- a\n  - b\n- c\n"],
    ["synthetic root", "- a\n- b\n  - c\n"],
    ["multiple headings", "# A\n\n- x\n\n# B\n\n- y\n"],
    ["nested headings", "# A\n\n## B\n\n- x\n\n## C\n"],
    ["continuation and table", "# R\n\n- intro \\\n  ![img](a.png \"400\")\n- | a | b |\n  | --- | --- |\n  | 1 | 2 |\n"],
    ["blank line before child", "# R\n\n- parent\n\n  - | a |\n    | --- |\n\n  - next\n"],
    ["fenced code in item", "# R\n\n- code\n  ```js\n  - not an item\n  ```\n- after\n"],
    ["ordered markers", "# R\n\n1. one\n2. two\n   - inner\n"],
    ["paragraph block", "# R\n\nSome text\nmore text\n\n- item\n"],
    ["no trailing newline", "# R\n\n- a"],
  ])("%s", (_, md) => {
    expect(roundTrip(md)).toBe(md);
  });
});

describe("structure", () => {
  it("uses the single top heading as root", () => {
    const doc = parse("---\ntitle: T\n---\n\n## Root\n\n- a\n  - b\n");
    expect(doc.syntheticRoot).toBe(false);
    expect(doc.root.md).toBe("Root");
    expect(doc.root.children[0].md).toBe("a");
    expect(doc.root.children[0].children[0].md).toBe("b");
  });

  it("takes the synthetic root title from front matter", () => {
    const doc = parse("---\ntitle: My Map\n---\n- a\n- b\n");
    expect(doc.syntheticRoot).toBe(true);
    expect(doc.root.md).toBe("My Map");
    expect(doc.root.children.map(c => c.md)).toEqual(["a", "b"]);
  });

  it("keeps continuation lines in the item markdown", () => {
    const doc = parse("# R\n\n- | a | b |\n  | --- | --- |\n- next\n");
    expect(doc.root.children[0].md).toBe("| a | b |\n| --- | --- |");
  });

  it("writes moved and new nodes with normalized indentation", () => {
    const doc = parse("# R\n\n- a\n  - b\n");
    const b = doc.root.children[0].children.pop()!;
    doc.root.children.push(b, { md: "new\nsecond line", kind: "item", children: [{ md: "child", kind: "item", children: [] }] });
    expect(serialize(doc)).toBe("# R\n\n- a\n- b\n- new\n  second line\n  - child\n");
  });

  it("turns a heading moved under an item into an item", () => {
    const doc = parse("# R\n\n## H\n\n- a\n");
    const h = doc.root.children.shift()!;
    const a = h.children[0];
    a.children.push({ ...h, children: [] });
    doc.root.children.push(a);
    expect(serialize(doc)).toBe("# R\n\n- a\n  - H\n");
  });
});

describe("helpers", () => {
  it("detects rich markdown", () => {
    expect(isRich("plain 文本")).toBe(false);
    expect(isRich("has `code`")).toBe(true);
    expect(isRich("1\\. escaped")).toBe(true);
    expect(isRich("two\nlines")).toBe(true);
  });

  it("extracts plain text", () => {
    expect(plainText("**b** `c` ![alt](x.png) \\- d")).toBe("b c alt - d");
  });
});
