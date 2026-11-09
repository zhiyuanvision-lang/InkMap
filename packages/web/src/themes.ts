import type { I18nKey } from "./i18n";

export const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", sans-serif';

export interface LayoutOption {
  id: string;
  pro: boolean;
}

export const LAYOUTS: LayoutOption[] = [
  { id: "logicalStructure", pro: false },
  { id: "mindMap", pro: false },
  { id: "logicalStructureLeft", pro: true },
  { id: "organizationStructure", pro: true },
  { id: "catalogOrganization", pro: true },
  { id: "timeline", pro: true },
  { id: "timeline2", pro: true },
  { id: "verticalTimeline", pro: true },
  { id: "fishbone", pro: true },
];

interface Palette {
  background: string;
  line: string;
  root: string;
  rootText: string;
  card: string;
  text: string;
  border: string;
  second: string;
}

export interface ThemeOption {
  id: string;
  pro: boolean;
  dark: boolean;
  palette: Palette;
}

export const THEMES: ThemeOption[] = [
  {
    id: "classic",
    pro: false,
    dark: false,
    palette: { background: "#f5f6f7", line: "#5b7fd4", root: "#4e83fd", rootText: "#fff", card: "#fff", text: "#1f2329", border: "#dee0e3", second: "#5b7fd4" },
  },
  {
    id: "mint",
    pro: true,
    dark: false,
    palette: { background: "#f3f8f6", line: "#2f9e7a", root: "#1f8a68", rootText: "#fff", card: "#fff", text: "#1d2b26", border: "#d5e6df", second: "#2f9e7a" },
  },
  {
    id: "sunset",
    pro: true,
    dark: false,
    palette: { background: "#fbf6f1", line: "#e07a3f", root: "#d9622b", rootText: "#fff", card: "#fff", text: "#2d221b", border: "#eedfd2", second: "#e07a3f" },
  },
  {
    id: "dusk",
    pro: true,
    dark: true,
    palette: { background: "#1b1e24", line: "#6f8fe8", root: "#4e83fd", rootText: "#fff", card: "#262a32", text: "#e6e8eb", border: "#3a3f49", second: "#6f8fe8" },
  },
];

export const layoutName = (id: string) => `layout.${id}` as I18nKey;
export const themeName = (id: string) => `theme.${id}` as I18nKey;

/** simple-mind-map theme for a palette; the page CSS reads the same colors through variables. */
export function themeConfig({ palette: p }: ThemeOption) {
  return {
    backgroundColor: p.background,
    lineStyle: "straight",
    lineRadius: 6,
    lineWidth: 1.5,
    lineColor: p.line,
    generalizationLineColor: p.line,
    rootLineKeepSameInCurve: false,
    paddingX: 12,
    paddingY: 6,
    root: { fillColor: p.root, color: p.rootText, fontSize: 18, fontWeight: "bold", fontFamily: FONT, borderWidth: 0, borderRadius: 8, marginX: 80, marginY: 24 },
    second: { fillColor: p.card, color: p.text, fontSize: 15, fontWeight: "bold", fontFamily: FONT, borderColor: p.second, borderWidth: 1.5, borderRadius: 6, marginX: 60, marginY: 16 },
    node: { fillColor: p.card, color: p.text, fontSize: 14, fontFamily: FONT, borderColor: p.border, borderWidth: 1, borderRadius: 6, marginX: 50, marginY: 10 },
  };
}

export function applyThemeCss(theme: ThemeOption) {
  const s = document.documentElement.style;
  const p = theme.palette;
  s.setProperty("--ink-bg", p.background);
  s.setProperty("--ink-text", p.text);
  s.setProperty("--ink-card", p.card);
  s.setProperty("--ink-border", p.border);
  s.setProperty("--ink-accent", p.line);
  document.documentElement.dataset.theme = theme.id;
  document.documentElement.classList.toggle("dark", theme.dark);
}
