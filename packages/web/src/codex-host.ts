import type { App } from "@modelcontextprotocol/ext-apps";
import type { OpenAIResources } from "@openai/mcp-extensions/app";
import { hasAccess, type LicenseState, type PhoneSignInResult } from "@inkmap/core";
import { browserLocale, type DocState, type Host, type HostCapabilities, type SaveResult } from "./host";
import { sidebarText } from "./sidebar-shell";

type FileInput = { name: string; resourceUri: string };

export class CodexHost implements Host {
  readonly assetBase = "";
  readonly locale = browserLocale();
  readonly capabilities = {
    saveTarget: "file", account: "restore", compact: true, restrictAssets: true,
  } satisfies HostCapabilities;
  private licenseCheck?: Promise<LicenseState>;

  constructor(private app: App, private resources: OpenAIResources, private file: FileInput) {}

  async load(): Promise<DocState> {
    const uri = this.file.resourceUri;
    const { contents } = await this.resources.read({ uri, representation: "text" });
    const content = contents.find(item => item.uri === uri);
    if (!content) throw new Error(sidebarText("文件无法读取。", "Unable to read this file."));
    const md = "text" in content ? content.text : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(Uint8Array.from(atob(content.blob), ch => ch.charCodeAt(0)));
    const version = content.openaiMetadata?.etag ?? "";
    return { name: this.file.name.replace(/(?:\.markmap)?\.md$/i, ""), md, version, writable: !!version && content.openaiMetadata?.writable === true };
  }

  async save(md: string, baseVersion: string): Promise<SaveResult> {
    if (!baseVersion) throw new Error("A file version is required to save.");
    if (!hasAccess(await this.license())) throw new Error("Inkmap access is inactive.");
    const result = await this.resources.write(this.file.resourceUri, { text: md, ifMatch: baseVersion });
    if (result.outcome === "too-large") throw new Error(sidebarText(`超出文件大小限制（${result.maxBytes} 字节）。`, `File exceeds the ${result.maxBytes}-byte limit.`));
    return result.outcome === "saved" ? { ok: true, version: result.etag } : { ok: false, doc: await this.load() };
  }

  onExternalChange(listener: (doc: DocState) => void) {
    const uri = this.file.resourceUri;
    let revision = 0;
    let closed = false;
    const refresh = async () => {
      const request = ++revision;
      const doc = await this.load().catch(() => undefined);
      if (!closed && request === revision && doc) listener(doc);
    };
    const dispose = this.resources.addUpdateHandler(({ params }) => {
      if (params.uri === uri) void refresh();
    });
    const subscribed = this.resources.subscribe({ uri }).then(() => true, () => false);
    // A file can change between the first read and subscribing.
    void subscribed.then(() => { if (!closed) void refresh(); });
    window.addEventListener("pagehide", () => {
      closed = true;
      dispose();
      void subscribed.then(async active => { if (active) await this.resources.unsubscribe({ uri }); }).catch(() => {});
    }, { once: true });
  }

  private async tool(name: string, args: Record<string, unknown> = {}) {
    const result = await this.app.callServerTool({ name, arguments: args });
    if (result.isError) {
      const error = result.content.find(item => item.type === "text");
      throw new Error(error?.text ?? "Inkmap account is unavailable.");
    }
    return (result.structuredContent as Record<string, any>) ?? {};
  }

  license() {
    return this.licenseCheck ??= this.tool("inkmap_access").then(raw => ({
      pro: raw.pro === true,
      ...(typeof raw.trialUntil === "number" && { trialUntil: raw.trialUntil }),
      ...(raw.connected === true && { connected: true }),
      ...(typeof raw.account === "string" && { account: raw.account }),
    })).finally(() => { this.licenseCheck = undefined; });
  }

  async checkout(mode: "buy" | "restore") {
    if (mode !== "restore") throw new Error("Only account restoration is supported.");
    const { url } = await this.tool("inkmap_restore_access", { locale: this.locale });
    if (typeof url !== "string" || new URL(url).protocol !== "https:") throw new Error("Invalid account link.");
    const opened = await this.app.openLink({ url });
    if (opened.isError) throw new Error("Unable to open account login.");
  }

  phoneSignIn = {
    send: async (phone: string): Promise<PhoneSignInResult> => {
      const { result } = await this.tool("inkmap_phone_send", { phone, locale: this.locale });
      return result as PhoneSignInResult;
    },
    verify: async (phone: string, code: string): Promise<PhoneSignInResult<LicenseState>> => {
      const { result } = await this.tool("inkmap_phone_verify", { phone, code });
      return result as PhoneSignInResult<LicenseState>;
    },
  };

  async signOut() { await this.tool("inkmap_disconnect_access"); }

  onLicenseChange(listener: (state: LicenseState) => void) {
    const check = () => void this.license().then(listener).catch(() => {});
    const interval = window.setInterval(check, 2000);
    window.addEventListener("focus", check);
    window.addEventListener("pagehide", () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", check);
    }, { once: true });
  }

  async ads() { return []; }
  async saveFile(name: string, dataUrl: string) {
    const data = /^data:(image\/(?:png|svg\+xml));base64,([\s\S]+)$/.exec(dataUrl);
    if (!data) throw new Error("Unsupported export format.");
    const { isError } = await this.app.downloadFile({ contents: [{
      type: "resource",
      resource: { uri: "file:///" + encodeURIComponent(name), mimeType: data[1], blob: data[2] },
    }] });
    return !isError;
  }
}
