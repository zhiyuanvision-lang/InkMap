export const packageName = "dsh-inkmap";
export const kind = "inkmap-markdown";
export const actionSlot = "sidebar.right.tab.document.actions";
export const bodySlot = "sidebar.right.pane.tab";
export const route = "/inkmap-harness/session";
const prefix = "dsh-resource://file/session/";

export function fileAddress(sessionId, absolutePath) {
  const path = /^(?:[A-Z]:[\\/]|\\\\)/i.test(absolutePath) ? absolutePath.replaceAll("\\", "/") : absolutePath;
  return prefix + encodeURIComponent(sessionId) + "/" + path.split("/").map(encodeURIComponent).join("/");
}

export function selectedFile(address) {
  if (typeof address !== "string" || !address.startsWith(prefix)) return;
  try {
    const [session, ...segments] = address.slice(prefix.length).split("/");
    const sessionId = decodeURIComponent(session);
    const path = segments.map(decodeURIComponent).join("/");
    if (sessionId && /\.md$/i.test(path)) return { sessionId, path };
  } catch { /* Malformed resource address. */ }
}
