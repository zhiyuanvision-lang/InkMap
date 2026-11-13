import type { Ad, LicenseState, PhoneSignInResult, ViewState, WechatOrderResult } from "@inkmap/core";
import { t, type Locale } from "./i18n";

export interface DocState {
  name: string;
  md: string;
  version: string;
  viewState?: ViewState;
  /** False when the host cannot safely write this resource. */
  writable?: boolean;
}

export interface ChatTarget {
  startLine: number;
  endLine: number;
  text?: string;
}

export type SaveResult = { ok: true; version: string } | { ok: false; doc: DocState };

export interface HostCapabilities {
  /** The destination of a successful save. Individual documents can still be read-only. */
  readonly saveTarget: "editor" | "file" | "copy";
  /** The account actions the host and its distribution channel can offer. */
  readonly account: "purchase" | "restore" | "none";
  /** Fit tools into a narrow panel. */
  readonly compact?: boolean;
  /** Render without loading remote or ungranted document assets. */
  readonly restrictAssets?: boolean;
}

/** Where the document lives. The CLI serves it over HTTP; the editor extension posts messages. */
export interface Host {
  /** Prefix for resolving relative image paths in the document. */
  assetBase: string;
  locale: Locale;
  /** Read after load(), which may discover the host's capabilities. */
  readonly capabilities: HostCapabilities;
  load(): Promise<DocState>;
  save(md: string, baseVersion: string): Promise<SaveResult>;
  onExternalChange(listener: (doc: DocState) => void): void;
  /** The text editor's cursor moved to `line` (zero-based). */
  onReveal?(listener: (line: number) => void): void;
  /** The user picked the node starting at `line` (zero-based). */
  select?(line: number): void;
  /** Set when the host can hand Markdown lines to an AI chat; resolves false where there is none. */
  canAddToChat?(): Promise<boolean>;
  /** Sends document lines `startLine`..`endLine` (zero-based, inclusive) to the chat; `text` narrows that to part of them. Without a target it only opens the chat. */
  addToChat?(target?: ChatTarget): void;
  /** The user pressed the chat shortcut (the host owns the keybinding). */
  onChatRequest?(listener: () => void): void;
  /** Persists the current fold and viewport state for this document, without touching the Markdown file. */
  saveView?(state: ViewState): void;
  /** Set when the host owns the undo history (the editor undoes the document itself on Cmd+Z). */
  history?: { undo(): void; redo(): void };

  license(): Promise<LicenseState>;
  checkout(mode: "buy" | "restore"): Promise<void>;
  orderPro?(): Promise<WechatOrderResult>;
  phoneSignIn?: {
    send(phone: string): Promise<PhoneSignInResult>;
    verify(phone: string, code: string): Promise<PhoneSignInResult<LicenseState>>;
  };
  signOut(): Promise<void>;
  onLicenseChange(listener: (state: LicenseState) => void): void;
  ads(): Promise<Ad[]>;
  /** Saves an exported file given as a data URL; resolves false when the user cancels. */
  saveFile(name: string, dataUrl: string): Promise<boolean>;
}

export const browserLocale = (): Locale => (/^zh\b/i.test(navigator.language) ? "zh" : "en");

export class HttpHost implements Host {
  private base = /^\/s\/[a-f0-9]{48}\/$/.test(location.pathname) ? location.pathname : "/";
  private sidebar = this.base !== "/";
  private account: HostCapabilities["account"] = this.sidebar ? "restore" : "purchase";
  private hostAccountNavigation = false;
  get capabilities(): HostCapabilities {
    return { saveTarget: "file", account: this.account, compact: this.sidebar, restrictAssets: this.sidebar };
  }
  assetBase = this.base + "doc-assets/";
  locale = browserLocale();
  private events = new EventSource(this.base + "api/events");

  async load(): Promise<DocState> {
    const [res, capabilities] = await Promise.all([
      fetch(this.base + "api/doc"),
      this.sidebar ? fetch(this.base + "api/capabilities").then(res => res.ok ? res.json() : null).catch(() => null) : null,
    ]);
    if (!res.ok) throw new Error(`读取文档失败：${res.status}`);
    if (this.sidebar) this.account = capabilities?.purchase === true ? "purchase" : "restore";
    this.hostAccountNavigation = capabilities?.accountNavigation === "host" &&
      new URLSearchParams(location.search).get("account-navigation") === "host" && window.parent !== window;
    if (this.hostAccountNavigation) this.phoneSignIn = undefined;
    return res.json();
  }

  async save(md: string, baseVersion: string): Promise<SaveResult> {
    const res = await fetch(this.base + "api/doc", {
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

  saveView(state: ViewState) {
    void fetch(this.base + "api/view", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(state),
      keepalive: true,
    }).catch(() => {});
  }

  async license(): Promise<LicenseState> {
    const res = await fetch(this.base + "api/license");
    return res.ok ? res.json() : { pro: false };
  }

  async checkout(mode: "buy" | "restore"): Promise<void> {
    if (mode === "restore" && this.hostAccountNavigation) {
      await new Promise<void>((resolve, reject) => {
        const id = crypto.randomUUID();
        const type = "inkmap:open-account";
        function done(ok: boolean) {
          window.clearTimeout(timer);
          window.removeEventListener("message", receive);
          if (ok) resolve();
          else reject(new Error(t("signInPageUnavailable")));
        }
        function receive(event: MessageEvent) {
          if (event.source === window.parent && event.data?.type === type && event.data.id === id) done(event.data.ok === true);
        }
        const timer = window.setTimeout(() => done(false), 12_000);
        window.addEventListener("message", receive);
        // The parent receives a request identifier only. It creates the account link using its own lease.
        window.parent.postMessage({ type, id }, "*");
      });
      return;
    }
    const tab = window.open("about:blank", "_blank");
    if (!tab) throw new Error(t("allowAccountPopups"));
    tab.opener = null;
    try {
      const res = await fetch(this.base + "api/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      tab.location.replace(body.url);
    } catch (error) {
      tab.close();
      throw error;
    }
  }

  async orderPro(): Promise<WechatOrderResult> {
    const res = await fetch(this.base + "api/order-pro", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (res.status === 501) {
      await this.checkout("buy");
      return { status: "redirect", url: "about:blank" };
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    const result = body.result as WechatOrderResult;
    if (result.status === "redirect") {
      const tab = window.open(result.url, "_blank", "noopener,noreferrer");
      if (!tab) throw new Error(t("allowAccountPopups"));
    }
    return result;
  }

  phoneSignIn?: Host["phoneSignIn"] = {
    send: async (phone: string): Promise<PhoneSignInResult> => {
      const res = await fetch(this.base + "api/phone-send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      if (!res.ok) return { ok: false, reason: "unavailable" };
      return (await res.json()).result;
    },
    verify: async (phone: string, code: string): Promise<PhoneSignInResult<LicenseState>> => {
      const res = await fetch(this.base + "api/phone-verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone, code }),
      });
      if (!res.ok) return { ok: false, reason: "unavailable" };
      return (await res.json()).result;
    },
  };

  async signOut(): Promise<void> {
    const res = await fetch(this.base + "api/signout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? res.statusText);
    }
  }

  onLicenseChange(listener: (state: LicenseState) => void) {
    this.events.addEventListener("license", e => listener(JSON.parse((e as MessageEvent).data)));
    const refresh = () => { void this.license().then(listener).catch(() => {}); };
    window.addEventListener("focus", refresh);
    window.addEventListener("pagehide", () => window.removeEventListener("focus", refresh), { once: true });
  }

  async ads(): Promise<Ad[]> {
    const res = await fetch(this.base + "api/ads").catch(() => null);
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
  | { type: "viewState"; state: ViewState }
  | ({ type: "addToChat" } & Partial<ChatTarget>)
  | { type: "undo" }
  | { type: "redo" }
  | { type: "checkout"; id: number; mode: "buy" | "restore" }
  | { type: "orderPro"; id: number }
  | { type: "sendPhoneCode"; id: number; phone: string }
  | { type: "signInByPhone"; id: number; phone: string; code: string }
  | { type: "signOut"; id: number }
  | { type: "saveFile"; id: number; name: string; dataUrl: string };

export type FromExtension =
  | { type: "doc"; doc: DocState; license: LicenseState; ads: Ad[]; chat?: boolean }
  | { type: "change"; doc: DocState }
  | { type: "saved"; id: number; version: string }
  | { type: "conflict"; id: number; doc: DocState }
  | { type: "error"; id: number; message: string }
  | { type: "reveal"; line: number }
  | { type: "requestChat" }
  | { type: "license"; state: LicenseState }
  | { type: "checkout"; id: number }
  | { type: "proOrder"; id: number; result: WechatOrderResult }
  | { type: "phoneCodeSent"; id: number; result: PhoneSignInResult }
  | { type: "phoneSignIn"; id: number; result: PhoneSignInResult<LicenseState> }
  | { type: "signedOut"; id: number }
  | { type: "fileSaved"; id: number; saved: boolean };

export class VsCodeHost implements Host {
  readonly capabilities = { saveTarget: "editor", account: "purchase" } satisfies HostCapabilities;
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
      if (!msg || typeof msg !== "object") return;
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

  saveView(state: ViewState) {
    this.post({ type: "viewState", state });
  }

  async canAddToChat() {
    return (await this.hello()).chat === true;
  }

  addToChat(target?: ChatTarget) {
    this.post({ type: "addToChat", ...target });
  }

  onChatRequest(listener: () => void) {
    this.on("requestChat", () => listener());
  }

  history = {
    undo: () => this.post({ type: "undo" }),
    redo: () => this.post({ type: "redo" }),
  };

  async license(): Promise<LicenseState> {
    return this.currentLicense ?? (await this.hello()).license;
  }

  checkout(mode: "buy" | "restore"): Promise<void> {
    return this.request(
      id => ({ type: "checkout", id, mode }),
      () => undefined,
    );
  }

  orderPro(): Promise<WechatOrderResult> {
    return this.request(
      id => ({ type: "orderPro", id }),
      msg => {
        const { result } = msg as Extract<FromExtension, { type: "proOrder" }>;
        if (result.status === "active") this.currentLicense = result.state;
        return result;
      },
    );
  }

  phoneSignIn = {
    send: (phone: string) => this.request(
      id => ({ type: "sendPhoneCode", id, phone }),
      msg => (msg as Extract<FromExtension, { type: "phoneCodeSent" }>).result,
    ),
    verify: (phone: string, code: string) => this.request(
      id => ({ type: "signInByPhone", id, phone, code }),
      msg => {
        const { result } = msg as Extract<FromExtension, { type: "phoneSignIn" }>;
        if (result.ok) this.currentLicense = result.value;
        return result;
      },
    ),
  };

  signOut(): Promise<void> {
    return this.request(
      id => ({ type: "signOut", id }),
      () => undefined,
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
