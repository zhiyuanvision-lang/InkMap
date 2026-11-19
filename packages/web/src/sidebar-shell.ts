import { locale } from "./i18n";

export const sidebarText = (zh: string, en: string) => locale() === "zh" ? zh : en;

export function sidebarGate(message: string) {
  if (!document.getElementById("sidebar-opening-hide-style")) {
    const st = document.createElement("style");
    st.id = "sidebar-opening-hide-style";
    st.textContent = `.sidebar-opening #bar, .sidebar-opening #map { display: none !important; }`;
    document.head.appendChild(st);
  }
  const panel = document.createElement("section");
  panel.className = "sidebar-gate";
  const title = document.createElement("h1");
  title.textContent = "Inkmap";
  const note = document.createElement("p");
  note.textContent = message;
  panel.append(title, note);
  document.body.append(panel);
  document.documentElement.classList.add("sidebar-opening");
  return {
    panel,
    note,
    close() {
      panel.remove();
      document.documentElement.classList.remove("sidebar-opening");
    },
  };
}

export function downloadFile(name: string, url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  return Promise.resolve(true);
}

export function parseExportDataUrl(dataUrl: string): { mimeType: string; blob: string } | null {
  const base64Match = /^data:(image\/(?:png|svg\+xml)|text\/html);base64,([\s\S]+)$/i.exec(dataUrl);
  if (base64Match) return { mimeType: base64Match[1]!.toLowerCase(), blob: base64Match[2]! };
  const utf8Match = /^data:(text\/html|image\/svg\+xml);charset=utf-8,([\s\S]+)$/i.exec(dataUrl);
  if (!utf8Match) return null;
  try {
    const bytes = new TextEncoder().encode(decodeURIComponent(utf8Match[2]!));
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return { mimeType: utf8Match[1]!.toLowerCase(), blob: btoa(bin) };
  } catch {
    return null;
  }
}
