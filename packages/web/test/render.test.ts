import { describe, expect, it, vi } from "vitest";
vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));
import { createRenderer } from "../src/render";

describe("createRenderer", () => {
  it("resolves local absolute and file:// image paths through query-based and webview asset bases", () => {
    const sidecarRenderer = createRenderer("/api/doc-asset?panel=p1&path=");
    const html1 = sidecarRenderer.render("![icon](/Users/demo/project/icon.png)");
    expect(html1).toContain('src="/api/doc-asset?panel=p1&amp;path=%2FUsers%2Fdemo%2Fproject%2Ficon.png"');

    const fileUrlHtml = sidecarRenderer.render("![icon](file:///Users/demo/project/my%20icon.png)");
    expect(fileUrlHtml).toContain('src="/api/doc-asset?panel=p1&amp;path=%2FUsers%2Fdemo%2Fproject%2Fmy%20icon.png"');

    const vscodeRenderer = createRenderer("https://file+.vscode-resource.vscode-cdn.net/Users/demo/project/");
    const html2 = vscodeRenderer.render("![icon](/Users/demo/project/sub/icon.png)");
    expect(html2).toContain('src="https://file+.vscode-resource.vscode-cdn.net/Users/demo/project/sub/icon.png"');
  });

  it("renders GitHub-flavored Markdown alerts cleanly without raw [!TIP] brackets", () => {
    const renderer = createRenderer("/doc-assets/");
    const html = renderer.render("> [!TIP]\n> Fast two-way sync");
    expect(html).toContain('class="ink-alert ink-alert-tip"');
    expect(html).toContain('<div class="ink-alert-title">TIP</div>');
    expect(html).toContain("Fast two-way sync");
    expect(html).not.toContain("[!TIP]");
  });
});
