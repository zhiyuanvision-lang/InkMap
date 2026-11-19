// Product facts shared by the editor, the extension and the store pages.

export const PRODUCT = {
  id: "inkmap-pro",
  entitlement: "inkmap.pro",
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

export type ProFeature = "browser" | "export" | "layouts" | "themes" | "replace" | "present";

export interface LicenseState {
  pro: boolean;
  trialUntil?: number;
  /** Whether a platform account session is currently connected on this client. */
  connected?: boolean;
  /** Display label of the connected account (e.g. masked phone or email), when available. */
  account?: string;
  /** The email or phone number last used to sign in on this computer, only to prefill the sign-in form. */
  lastSignIn?: string;
}

/** `notPro`: the code was right, but on a login-only host after the trial an account without Pro is not signed in. */
export type PhoneSignInError = "invalid" | "rateLimited" | "unavailable" | "notPro";

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
