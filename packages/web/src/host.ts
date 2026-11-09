export interface DocState {
  name: string;
  md: string;
  version: string;
}

export type SaveResult = { ok: true; version: string } | { ok: false; doc: DocState };

/** Where the document lives. The CLI serves it over HTTP; an editor extension can post messages instead. */
export interface Host {
  /** Prefix for resolving relative image paths in the document. */
  assetBase: string;
  load(): Promise<DocState>;
  save(md: string, baseVersion: string): Promise<SaveResult>;
  onExternalChange(listener: (doc: DocState) => void): void;
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
