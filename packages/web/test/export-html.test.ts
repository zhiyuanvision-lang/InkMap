import { describe, expect, it } from "vitest";
import { interactiveExportHtml } from "../src/export-html";

const palette = { background: "#fff", card: "#f8f8f8", text: "#111" };

describe("interactiveExportHtml", () => {
  it("escapes the title and the Markdown source", () => {
    const html = interactiveExportHtml({
      title: `<script>alert("x")</script>`,
      svgDataUrl: "data:image/svg+xml;base64,AAAA",
      markdown: "# A </pre><script>alert(1)</script>",
      palette,
      showBadge: false,
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; · Inkmap");
    expect(html).toContain("# A &lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("keeps the image URL inside its attribute", () => {
    const html = interactiveExportHtml({ title: "T", svgDataUrl: 'data:x" onerror="alert(1)', markdown: "", palette, showBadge: false });
    expect(html).toContain('src="data:x%22 onerror=%22alert(1)"');
  });

  it("adds the Inkmap badge only when asked", () => {
    const base = { title: "T", svgDataUrl: "data:,", markdown: "", palette };
    expect(interactiveExportHtml({ ...base, showBadge: true })).toContain("ink-viral-badge\" href=");
    expect(interactiveExportHtml({ ...base, showBadge: false })).not.toContain("ink-viral-badge\" href=");
  });
});
