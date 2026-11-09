import type { ActivateResult, Ad, LicenseState } from "@inkmap/core";
import type { Locale } from "./i18n";

export interface DocState {
  name: string;
  md: string;
  version: string;
}

export type SaveResult = { ok: true; version: string } | { ok: false; doc: DocState };

/** Where the document lives. The CLI serves it over HTTP; the editor extension posts messages. */
export interface Host {
  /** Prefix for resolving relative image paths in the document. */
  assetBase: string;
  locale: Locale;
  load(): Promise<DocState>;
  save(md: string, baseVersion: string): Promise<SaveResult>;
  onExternalChange(listener: (doc: DocState) => void): void;
  /** The text editor's cursor moved to `line` (zero-based). */
  onReveal?(listener: (line: number) => void): void;
  /** The user picked the node starting at `line` (zero-based). */
  select?(line: number): void;
  /** Set when the host owns the undo history (the editor undoes the document itself on Cmd+Z). */
  history?: { undo(): void; redo(): void };

  license(): Promise<LicenseState>;
  activate(code: string): Promise<ActivateResult>;
  onLicenseChange(listener: (state: LicenseState) => void): void;
  ads(): Promise<Ad[]>;
  /** Saves an exported file given as a data URL; resolves false when the user cancels. */
  saveFile(name: string, dataUrl: string): Promise<boolean>;
}

const browserLocale = (): Locale => (/^zh\b/i.test(navigator.language) ? "zh" : "en");

export class HttpHost implements Host {
  assetBase = "/doc-assets/";
  locale = browserLocale();
  private events = new EventSource("/api/events");

  async load(): Promise<DocState> {
    const res = await fetch("/api/doc");
    if (!res.ok) throw new Error(`读取文档失败：${res.status}`);
    return res.json();
  }

  async save(md: string, baseVersion: string): Promise<SaveResult> {
    const res = await fetch("/api/doc", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ md, baseVersion }),
    });
    if (res.status === 409) return { ok: false, doc: await res.json() };
    if (!res.ok) throw new Error(`保存失败：${res.status}`);
    return { ok: true, ...(await res.json()) };
  }

  onExternalChange(listener: (doc: DocState) => void) {
    this.events.addEventListener("change", e => listener(JSON.parse((e as MessageEvent).data)));
  }

  async license(): Promise<LicenseState> {
    const res = await fetch("/api/license");
    return res.ok ? res.json() : { pro: false };
  }

  async activate(code: string): Promise<ActivateResult> {
    const res = await fetch("/api/license", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    return body;
  }

  onLicenseChange(listener: (state: LicenseState) => void) {
    this.events.addEventListener("license", e => listener(JSON.parse((e as MessageEvent).data)));
  }

  async ads(): Promise<Ad[]> {
    const res = await fetch("/api/ads").catch(() => null);
    return res?.ok ? res.json() : [];
  }

  async saveFile(name: string, dataUrl: string) {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = name;
    a.click();
    return true;
  }
}

interface VsCodeApi {
  postMessage(message: unknown): void;
}

/** Messages exchanged with the editor extension. */
export type ToExtension =
  | { type: "ready" }
  | { type: "save"; id: number; md: string; baseVersion: string }
  | { type: "select"; line: number }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "activate"; id: number; code: string }
  | { type: "saveFile"; id: number; name: string; dataUrl: string };

export type FromExtension =
  | { type: "doc"; doc: DocState; license: LicenseState; ads: Ad[] }
  | { type: "change"; doc: DocState }
  | { type: "saved"; id: number; version: string }
  | { type: "conflict"; id: number; doc: DocState }
  | { type: "error"; id: number; message: string }
  | { type: "reveal"; line: number }
  | { type: "license"; state: LicenseState }
  | { type: "activated"; id: number; result: ActivateResult }
  | { type: "fileSaved"; id: number; saved: boolean };

export class VsCodeHost implements Host {
  private nextId = 1;
  private waiting = new Map<number, (msg: FromExtension) => void>();
  private listeners: Partial<Record<FromExtension["type"], ((msg: any) => void)[]>> = {};
  private first?: Promise<Extract<FromExtension, { type: "doc" }>>;
  private currentLicense?: LicenseState;

  constructor(
    private api: VsCodeApi,
    public assetBase: string,
    public locale: Locale,
  ) {
    window.addEventListener("message", e => {
      const msg = e.data as FromExtension;
      if ("id" in msg && this.waiting.has(msg.id)) {
        this.waiting.get(msg.id)!(msg);
        this.waiting.delete(msg.id);
      }
      if (msg.type === "license") this.currentLicense = msg.state;
      this.listeners[msg.type]?.forEach(fn => fn(msg));
    });
  }

  private on<T extends FromExtension["type"]>(type: T, fn: (msg: Extract<FromExtension, { type: T }>) => void) {
    const key: FromExtension["type"] = type;
    this.listeners[key] = [...(this.listeners[key] ?? []), fn as (msg: any) => void];
  }

  private post(msg: ToExtension) {
    this.api.postMessage(msg);
  }

  private request<T>(build: (id: number) => ToExtension, read: (msg: FromExtension) => T): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, msg => {
        if (msg.type === "error") reject(new Error(msg.message));
        else resolve(read(msg));
      });
      this.post(build(id));
    });
  }

  private hello() {
    return (this.first ??= new Promise(resolve => {
      this.on("doc", msg => resolve(msg));
      this.post({ type: "ready" });
    }));
  }

  async load(): Promise<DocState> {
    return (await this.hello()).doc;
  }

  save(md: string, baseVersion: string): Promise<SaveResult> {
    return this.request(
      id => ({ type: "save", id, md, baseVersion }),
      msg => (msg.type === "saved" ? { ok: true, version: msg.version } : { ok: false, doc: (msg as Extract<FromExtension, { type: "conflict" }>).doc }),
    );
  }

  onExternalChange(listener: (doc: DocState) => void) {
    this.on("change", msg => listener(msg.doc));
  }

  onReveal(listener: (line: number) => void) {
    this.on("reveal", msg => listener(msg.line));
  }

  select(line: number) {
    this.post({ type: "select", line });
  }

  history = {
    undo: () => this.post({ type: "undo" }),
    redo: () => this.post({ type: "redo" }),
  };

  async license(): Promise<LicenseState> {
    return this.currentLicense ?? (await this.hello()).license;
  }

  activate(code: string): Promise<ActivateResult> {
    return this.request(
      id => ({ type: "activate", id, code }),
      msg => (msg as Extract<FromExtension, { type: "activated" }>).result,
    );
  }

  onLicenseChange(listener: (state: LicenseState) => void) {
    this.on("license", msg => listener(msg.state));
  }

  async ads(): Promise<Ad[]> {
    return (await this.hello()).ads;
  }

  saveFile(name: string, dataUrl: string): Promise<boolean> {
    return this.request(
      id => ({ type: "saveFile", id, name, dataUrl }),
      msg => (msg as Extract<FromExtension, { type: "fileSaved" }>).saved,
    );
  }
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
    /** Set by the extension before the editor script runs. */
    INKMAP_ASSET_BASE?: string;
    INKMAP_LOCALE?: string;
  }
}

export function detectHost(): Host {
  if (window.acquireVsCodeApi) {
    const locale: Locale = /^zh\b/i.test(window.INKMAP_LOCALE ?? navigator.language) ? "zh" : "en";
    return new VsCodeHost(window.acquireVsCodeApi(), window.INKMAP_ASSET_BASE ?? "", locale);
  }
  return new HttpHost();
}
