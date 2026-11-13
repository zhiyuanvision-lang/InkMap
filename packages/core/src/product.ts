// Product facts shared by the editor, the extension and the store pages.

export const PRODUCT = {
  id: "inkmap-pro",
  entitlement: "inkmap.pro",
  /** JSON list of sponsor ads shown in the free edition; empty means house ads only. */
  adFeedUrl: "",
};

export const YUNFAN_BILLING_ORIGIN = "https://zhiyuanv.com";

/** A login-only client must never open a purchase URL. */
export function billingFlowUrl(raw: unknown, origin: string, mode: "buy" | "restore", legacy = false): string {
  if (typeof raw !== "string") throw new Error("Invalid Yunfan account link.");
  const url = new URL(raw);
  const base = mode === "restore" && !legacy ? "login" : "checkout";
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || url.search || url.hash ||
      !new RegExp(`^/billing/${base}/[0-9a-f]{32}$`).test(url.pathname)) {
    throw new Error("Invalid Yunfan account link.");
  }
  return url.href;
}

export type ProFeature = "noAds" | "browser" | "export" | "layouts" | "themes" | "replace" | "present";

export interface LicenseState {
  pro: boolean;
  trialUntil?: number;
  /** Whether a platform account session is currently connected on this client. */
  connected?: boolean;
  /** Display label of the connected account (e.g. masked phone or email), when available. */
  account?: string;
}

export type PhoneSignInError = "invalid" | "rateLimited" | "unavailable";

export type PhoneSignInResult<T = undefined> = { ok: true; value: T } | { ok: false; reason: PhoneSignInError };

export type WechatOrderResult =
  | { status: "qr"; qr: string; amountFen: number; expiresAt?: string }
  | { status: "active"; state: LicenseState }
  | { status: "needsPhone" }
  | { status: "redirect"; url: string };

export const DAY_MS = 24 * 60 * 60 * 1000;
export const TRIAL_MS = 7 * DAY_MS;

export function hasAccess(state: LicenseState, now = Date.now()): boolean {
  return state.pro || (state.trialUntil ?? 0) > now;
}

export function trialDaysLeft(state: LicenseState, now = Date.now()): number {
  const remaining = (state.trialUntil ?? 0) - now;
  return remaining > 0 ? Math.ceil(remaining / DAY_MS) : 0;
}

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
