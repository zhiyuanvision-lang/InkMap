import { browserLocale } from "./host";

export const sidebarText = (zh: string, en: string) => browserLocale() === "zh" ? zh : en;

export function sidebarGate(message: string) {
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
