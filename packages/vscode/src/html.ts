export interface WebviewHtmlOptions {
  /** URI of the built web editor directory, as the webview sees it. */
  webBase: string;
  /** Prefix for relative image paths in the document; empty when the document has no directory. */
  assetBase: string;
  cspSource: string;
  nonce: string;
  /** Editor display language, e.g. `zh-cn` or `en`. */
  locale: string;
}

/** Adapts the built `index.html` to a webview: absolute asset URIs, a CSP, and editor settings. */
export function webviewHtml(html: string, { webBase, assetBase, cspSource, nonce, locale }: WebviewHtmlOptions): string {
  const osLoc = locale === "auto" ? "" : /^zh(?:[-_.]|$)/i.test(locale) ? "zh" : "en";
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} https: data: blob:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource} data:`,
    `script-src 'nonce-${nonce}' ${cspSource}`,
    "form-action 'none'",
  ].join("; ");
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}">
  <script nonce="${nonce}">window.INKMAP_ASSET_BASE = ${JSON.stringify(assetBase)}; window.INKMAP_LOCALE = ${JSON.stringify(osLoc || locale)};</script>`;
  return html
    .replace(/<html\b([^>]*)>/i, (_m, attrs) => osLoc ? `<html lang="${osLoc === "zh" ? "zh-CN" : "en"}" data-os-locale="${osLoc}">` : `<html${attrs}>`)
    .replace(/ crossorigin/g, "")
    .replace(/(src|href)="\.\/assets\//g, (_m, attr) => `${attr}="${webBase}/assets/`)
    .replace(/(src|href)="\.\/(app\.(?:js|css))"/g, (_m, attr, file) => `${attr}="${webBase}/${file}"`)
    .replace(/<script /g, () => `<script nonce="${nonce}" `)
    .replace("<head>", () => `<head>\n  ${head}`);
}
