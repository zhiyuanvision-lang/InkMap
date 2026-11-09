// Product facts shared by the editor, the extension and the store pages.

export const PRODUCT = {
  priceCN: "¥19.9",
  priceIntl: "$9.9",
  /** 爱发电 product page (mainland China, WeChat Pay / Alipay). Empty until the shop is set up. */
  buyUrlCN: "",
  /** Creem checkout link (international cards). Empty until the shop is set up. */
  buyUrlIntl: "",
  /** JSON list of sponsor ads shown in the free edition; empty means house ads only. */
  adFeedUrl: "",
};

export type ProFeature = "noAds" | "browser" | "export" | "layouts" | "themes" | "replace" | "present";

export interface LicenseState {
  pro: boolean;
  id?: string;
  issued?: string;
}

export type ActivateResult = { ok: true; state: LicenseState } | { ok: false; reason: "format" | "signature" | "revoked" };

/** A sponsor ad from the ad feed. */
export interface Ad {
  id: string;
  title: string;
  text: string;
  url: string;
  cta?: string;
  /** Only show to this UI language; both when omitted. */
  locale?: "zh" | "en";
}

/** Keeps only well-formed ads with https links, so a bad feed cannot inject arbitrary content. */
export function sanitizeAds(input: unknown): Ad[] {
  if (!Array.isArray(input)) return [];
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const out: Ad[] = [];
  for (const raw of input.slice(0, 20)) {
    const r = raw as Record<string, unknown>;
    const id = str(r?.id, 64);
    const title = str(r?.title, 60);
    const text = str(r?.text, 140);
    const url = str(r?.url, 500);
    if (!id || !title || !text || !url || !/^https:\/\//.test(url)) continue;
    const locale = r.locale === "zh" || r.locale === "en" ? r.locale : undefined;
    out.push({ id, title, text, url, cta: str(r.cta, 20), locale });
  }
  return out;
}
