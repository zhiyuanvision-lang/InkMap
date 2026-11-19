import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DAY_MS, documentSetting, frontMatterTitle, hasAccess, isRich, parse, plainText, serialize, serializeWithLines, trialDaysLeft, withDocumentSetting, withFrontMatterTitle } from "../src/index";

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
    ["thematic breaks between sections", "# Title\n\n---\n\n## Section 1\n\n- a\n\n---\n\n## Section 2\n\n- b\n\n---\n"],
    ["no trailing newline", "# R\n\n- a"],
    ["headings ending in hash like C# and F#", "# Learn C#\n\n## Functional F#\n\n- Issue #1#\n"],
    ["nested 4-backtick markdown fence", "# R\n\n- outer\n  ````markdown\n  ```mermaid\n  flowchart LR\n    A --> B\n  ```\n  ## Not a live heading\n  ````\n- sibling\n"],
    ["inline triple-backtick code span in bullet", "# R\n\n- ```inline``` code\n- next item\n"],
    ["leading horizontal rule not misparsed as YAML frontmatter", "---\n\n# Real Heading\n\n- item\n\n---\n"],
    ["Windows CRLF line endings preserved", "---\r\ntitle: Win\r\n---\r\n\r\n# Root\r\n\r\n- item\r\n"],
  ])("%s", (_, md) => {
    expect(roundTrip(md)).toBe(md);
  });

  it("serializes children added under H6 as list items so hierarchy survives reload", () => {
    const doc = parse("# H1\n\n###### H6\n");
    doc.root.children[0].children.push({ md: "Under H6", kind: "heading", children: [] });
    const saved = serialize(doc);
    const reloaded = parse(saved);
    expect(reloaded.root.children[0].md).toBe("H6");
    expect(reloaded.root.children[0].children.map(c => c.md)).toEqual(["Under H6"]);
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

  it("omits horizontal rule dividers (---) from mind map nodes while keeping round-trip intact", () => {
    const md = "# Title\n\n---\n\n## Part 1\n\n- item 1\n\n---\n\n## Part 2\n\n- item 2\n";
    const doc = parse(md);
    expect(doc.root.children.map(c => c.md)).toEqual(["Part 1", "Part 2"]);
    expect(doc.root.children[0].children.map(c => c.md)).toEqual(["item 1"]);
    expect(serialize(doc)).toBe(md);
  });

  it("attaches an unindented fenced block right under its preceding list item and round-trips byte for byte", () => {
    const md = "# Draft\n\n---\n\n## Section\n\n- **Body**:\n```markdown\n### Subheading\n- bullet\n```\n";
    const doc = parse(md);
    const bodyItem = doc.root.children[0].children[0];
    expect(bodyItem.md).toBe("**Body**:");
    expect(bodyItem.children).toHaveLength(1);
    expect(bodyItem.children[0].md).toContain("### Subheading");
    expect(serialize(doc)).toBe(md);
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

  it("keeps typed node text that looks like a divider or a fence from breaking the outline", () => {
    const doc = parse("# R\n\n- a\n- b\n");
    doc.root.children[0].md = "--";
    doc.root.children[1].md = "```";
    doc.root.children.push({ md: "c", kind: "item", children: [] });
    const reloaded = parse(serialize(doc));
    expect(reloaded.root.children.map(n => n.md)).toEqual(["\\--", "\\```", "c"]);
  });

  it("round-trips empty list items", () => {
    const md = "# R\n\n- a\n-\n- b\n";
    const doc = parse(md);
    expect(doc.root.children.map(n => [n.kind, n.md])).toEqual([["item", "a"], ["item", ""], ["item", "b"]]);
    expect(serialize(doc)).toBe(md);
  });

  it("recognizes front matter with compact YAML sequences and quoted keys", () => {
    const doc = parse("---\ntitle: T\ntags:\n- a\n- b\n\"x-key\": 1\n---\n- one\n- two\n");
    expect(doc.frontMatter).toBe("---\ntitle: T\ntags:\n- a\n- b\n\"x-key\": 1\n---\n");
    expect(doc.root.md).toBe("T");
  });

  it("ignores empty and block-scalar front matter titles", () => {
    expect(frontMatterTitle("---\ntitle:\nauthor: bob\n---\n")).toBeUndefined();
    expect(frontMatterTitle("---\ntitle: >\n  folded\n---\n")).toBeUndefined();
    expect(frontMatterTitle("---\r\ntitle: \"Plan\"\r\n---\r\n")).toBe("Plan");
  });

  it("strips trailing YAML comments from inkmap settings", () => {
    expect(documentSetting("---\ninkmap:\n  theme: dark # night\n---\n", "theme")).toBe("dark");
    expect(documentSetting("---\ninkmap:\n  theme: \"a # b\"\n---\n", "theme")).toBe("a # b");
  });
});

describe("front matter keys and titles", () => {
  it.each([
    ["Chinese keys", "---\n标题: 测试\n作者: 张三\n---\n- a\n", "测试"],
    ["keys with spaces", "---\nLast Modified: 2024-01-01\ntitle: Notes\n---\n- a\n", "Notes"],
    ["keys with an inner colon", "---\nog:image: /a.png\ntitle: T\n---\n- a\n", "T"],
  ])("recognizes front matter with %s", (_, md, title) => {
    const doc = parse(md);
    expect(doc.frontMatter).not.toBe("");
    expect(doc.root.children.map(n => n.md)).toEqual(["a"]);
    if (title !== "测试") expect(doc.root.md).toBe(title);
    expect(serialize(doc)).toBe(md);
  });

  it("still treats a leading thematic break before a heading as content", () => {
    expect(parse("---\n# Real Heading\n- item\n---\n").frontMatter).toBe("");
  });

  it("reads quoted titles the way YAML does", () => {
    expect(frontMatterTitle('---\ntitle: "My \\"Doc\\""\n---\n')).toBe('My "Doc"');
    expect(frontMatterTitle("---\ntitle: 'It''s here'\n---\n")).toBe("It's here");
    expect(frontMatterTitle('---\ntitle: "Plan" # draft\n---\n')).toBe("Plan");
    expect(frontMatterTitle("---\ntitle: Learn C#\n---\n")).toBe("Learn C#");
  });

  it("writes titles that read back unchanged", () => {
    for (const title of ['My "Doc"', "a \\ b", "$& price", "中文 标题"]) {
      expect(frontMatterTitle(withFrontMatterTitle("---\nauthor: x\n---\n", title))).toBe(title);
    }
  });

  it("replaces an empty or block-scalar title instead of adding a second one", () => {
    expect(withFrontMatterTitle("---\ntitle:\nauthor: x\n---\n", "New")).toBe('---\ntitle: "New"\nauthor: x\n---\n');
    expect(withFrontMatterTitle("---\ntitle: >\n  folded\n  text\nauthor: x\n---\n", "New")).toBe('---\ntitle: "New"\nauthor: x\n---\n');
    expect(withFrontMatterTitle("", "New", "\r\n")).toBe('---\r\ntitle: "New"\r\n---\r\n');
    expect(withFrontMatterTitle("---\r\nauthor: x\r\n---\r\n", "New")).toBe('---\r\nauthor: x\r\ntitle: "New"\r\n---\r\n');
  });

  it("drops a comment after a quoted inkmap setting", () => {
    expect(documentSetting('---\ninkmap:\n  theme: "dark" # night\n---\n', "theme")).toBe("dark");
  });
});

describe("paragraphs, fences and empty items", () => {
  it("does not let a lone list marker split a paragraph", () => {
    for (const md of ["# R\n\n$$\na\n-\nb\n$$\n", "# R\n\nThe report was published in\n2024.\n"]) {
      const doc = parse(md);
      expect(doc.root.children).toHaveLength(1);
      expect(serialize(doc)).toBe(md);
    }
  });

  it("keeps an empty item that follows a paragraph", () => {
    const doc = parse("# R\n\npara\n");
    doc.root.children.push({ md: "", kind: "item", children: [] });
    const reloaded = parse(serialize(doc));
    expect(reloaded.root.children.map(n => [n.kind, n.md])).toEqual([["block", "para"], ["item", ""]]);
  });

  it("closes a code fence left open in node text so it cannot swallow later nodes", () => {
    const doc = parse("# R\n\n- a\n- b\n");
    doc.root.children[0].md = "intro\n```js\nconst x = 1;";
    const reloaded = parse(serialize(doc));
    expect(reloaded.root.children.map(n => n.md)).toEqual(["intro\n```js\nconst x = 1;\n```", "b"]);
  });

  it("keeps a paragraph typed as a divider", () => {
    const doc = parse("# R\n\npara\n\n- b\n");
    doc.root.children[0].md = "---";
    expect(parse(serialize(doc)).root.children.map(n => n.md)).toEqual(["\\---", "b"]);
  });

  it("leaves an unclosed fence at the end of the file byte for byte", () => {
    for (const md of ["# R\n\n- a\n- ```", "# R\n\n- a\n  ```js\n  code\n", "# R\n\n```js\ncode\n"]) {
      expect(roundTrip(md)).toBe(md);
    }
  });
});

describe("CRLF / BOM / front matter edge cases", () => {
  const roundTrip = (md: string) => serialize(parse(md));
  it.each([
    ["front matter only LF", "---\ntitle: T\n---\n"],
    ["front matter only CRLF", "---\r\ntitle: T\r\n---\r\n"],
    ["BOM + heading", "\uFEFF# R\n\n- a\n"],
    ["BOM + CRLF front matter", "\uFEFF---\r\ntitle: Bom\r\n---\r\n\r\n- a\r\n"],
    ["CRLF fm, no trailing newline", "---\r\ntitle: T\r\n---\r\n\r\n# Root\r\n\r\n- a"],
    ["CRLF fenced code in item", "# R\r\n\r\n- code\r\n  ```js\r\n  x\r\n  ```\r\n"],
    ["CRLF fm + 2 blank lines", "---\r\ntitle: T\r\n---\r\n\r\n\r\n- a\r\n  - b\r\n"],
    ["CRLF unclosed fm", "---\r\ntitle: T\r\n\r\n# R\r\n"],
  ])("round-trips %s", (_, md) => expect(roundTrip(md)).toBe(md));

  it("normalizes mixed line endings to CRLF when the file uses any CRLF", () => {
    expect(serialize(parse("# R\r\n\n- a\n- b\r\n"))).toBe("# R\r\n\r\n- a\r\n- b\r\n");
  });

  it("keeps CRLF when inkmap settings are written into front matter", () => {
    const fm = withDocumentSetting("---\r\ntitle: T\r\n---\r\n", "layout", "x");
    expect(fm).toBe("---\r\ntitle: T\r\ninkmap:\r\n  layout: x\r\n---\r\n");
    expect(documentSetting(fm, "layout")).toBe("x");
    expect(withDocumentSetting(fm, "layout", "y")).toBe("---\r\ntitle: T\r\ninkmap:\r\n  layout: y\r\n---\r\n");
  });

  it("reads the title behind a BOM", () => {
    expect(parse("\uFEFF---\r\ntitle: Bom\r\n---\r\n\r\n- a\r\n").root.md).toBe("Bom");
  });

  it("keeps CRLF for newly added multi-line nodes", () => {
    const doc = parse("---\r\ntitle: T\r\n---\r\n\r\n# Root\r\n\r\n- a\r\n");
    doc.root.children.push({ md: "new\nline", kind: "item", children: [] });
    expect(serialize(doc)).toBe("---\r\ntitle: T\r\n---\r\n\r\n# Root\r\n\r\n- a\r\n- new\r\n  line\r\n");
  });
});

describe("line positions", () => {
  it("reports where each node starts", () => {
    const doc = parse("---\ntitle: T\n---\n\n## Root\n\n- a\n  more\n  - b\n\n- c\n");
    const { md, lines } = serializeWithLines(doc);
    const lineOf = (n: { md: string }) => md.split("\n")[lines.get(n as never)!];
    const [a, c] = doc.root.children;
    expect(lines.get(doc.root)).toBe(4);
    expect(lineOf(a)).toBe("- a");
    expect(lineOf(a.children[0])).toBe("  - b");
    expect(lineOf(c)).toBe("- c");
  });

  it("starts a synthetic root at its first child", () => {
    const doc = parse("\n- a\n- b\n");
    const { lines } = serializeWithLines(doc);
    expect(lines.get(doc.root.children[0])).toBe(1);
    expect(lines.get(doc.root.children[1])).toBe(2);
  });
});

describe("helpers", () => {
  it("detects rich markdown", () => {
    expect(isRich("plain 文本")).toBe(false);
    expect(isRich("Price: $100")).toBe(false);
    expect(isRich("has `code`")).toBe(true);
    expect(isRich("math $a + b$")).toBe(true);
    expect(isRich("1\\. escaped")).toBe(true);
    expect(isRich("two\nlines")).toBe(true);
  });

  it("extracts plain text", () => {
    expect(plainText("**b** `c` ![alt](x.png) \\- d")).toBe("b c alt - d");
  });

  it("computes trial access and remaining days", () => {
    const now = 1_000_000;
    expect(hasAccess({ pro: false }, now)).toBe(false);
    expect(hasAccess({ pro: false, trialUntil: now }, now)).toBe(false);
    expect(hasAccess({ pro: false, trialUntil: now + 1 }, now)).toBe(true);
    expect(hasAccess({ pro: true, trialUntil: 1 }, now)).toBe(true);
    expect(trialDaysLeft({ pro: false, trialUntil: now - 1 }, now)).toBe(0);
    expect(trialDaysLeft({ pro: false, trialUntil: now + 1 }, now)).toBe(1);
    expect(trialDaysLeft({ pro: false, trialUntil: now + 6.2 * DAY_MS }, now)).toBe(7);
  });
});
