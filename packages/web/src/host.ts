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
  load(): Promise<DocState>;
  save(md: string, baseVersion: string): Promise<SaveResult>;
  onExternalChange(listener: (doc: DocState) => void): void;
  /** The text editor's cursor moved to `line` (zero-based). */
  onReveal?(listener: (line: number) => void): void;
  /** The user picked the node starting at `line` (zero-based). */
  select?(line: number): void;
  /** Set when the host owns the undo history (the editor undoes the document itself on Cmd+Z). */
  history?: { undo(): void; redo(): void };
}

export class HttpHost implements Host {
  assetBase = "/doc-assets/";

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
    const events = new EventSource("/api/events");
    events.addEventListener("change", e => listener(JSON.parse((e as MessageEvent).data)));
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
  | { type: "redo" };

export type FromExtension =
  | { type: "doc"; doc: DocState }
  | { type: "change"; doc: DocState }
  | { type: "saved"; id: number; version: string }
  | { type: "conflict"; id: number; doc: DocState }
  | { type: "error"; id: number; message: string }
  | { type: "reveal"; line: number };

export class VsCodeHost implements Host {
  private nextId = 1;
  private waiting = new Map<number, (msg: FromExtension) => void>();
  private listeners: Partial<Record<FromExtension["type"], ((msg: any) => void)[]>> = {};

  constructor(
    private api: VsCodeApi,
    public assetBase: string,
  ) {
    window.addEventListener("message", e => {
      const msg = e.data as FromExtension;
      if ("id" in msg && this.waiting.has(msg.id)) {
        this.waiting.get(msg.id)!(msg);
        this.waiting.delete(msg.id);
      }
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

  load(): Promise<DocState> {
    return new Promise(resolve => {
      let done = false;
      this.on("doc", msg => {
        if (!done) resolve(msg.doc);
        done = true;
      });
      this.post({ type: "ready" });
    });
  }

  save(md: string, baseVersion: string): Promise<SaveResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, msg => {
        if (msg.type === "saved") resolve({ ok: true, version: msg.version });
        else if (msg.type === "conflict") resolve({ ok: false, doc: msg.doc });
        else if (msg.type === "error") reject(new Error(msg.message));
      });
      this.post({ type: "save", id, md, baseVersion });
    });
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
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
    /** Set by the extension before the editor script runs. */
    INKMAP_ASSET_BASE?: string;
  }
}

export function detectHost(): Host {
  if (window.acquireVsCodeApi) return new VsCodeHost(window.acquireVsCodeApi(), window.INKMAP_ASSET_BASE ?? "");
  return new HttpHost();
}
