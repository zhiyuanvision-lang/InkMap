import { PRODUCT, billingFlowUrl, type LicenseState } from "@inkmap/core";

const KEY = "inkmap-browser-restore";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const browserRestoreOrigin = (() => {
  try {
    const raw = import.meta.env.VITE_INKMAP_BROWSER_RESTORE_ORIGIN;
    if (!raw) return;
    const url = new URL(raw);
    if (url.protocol === "https:" && url.origin === raw) return raw;
  } catch { /* The optional browser endpoint has not been configured. */ }
})();

/** A browser uses a scoped billing token, never the billing page's session cookie. */
export function browserAccess(origin: string | undefined, trialUntil: number | undefined) {
  let token: string | undefined;
  try {
    const record = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
    if (record?.origin === origin && typeof record.token === "string" && TOKEN.test(record.token)) token = record.token;
  } catch { /* Memory storage also works for the current panel. */ }
  let cached: LicenseState = { pro: false, trialUntil };
  let checked = 0;
  let generation = 0;
  let checking: Promise<LicenseState> | undefined;
  function remember(next: string | undefined) {
    ++generation;
    token = next;
    checked = 0;
    checking = undefined;
    cached = { pro: false, trialUntil };
    try {
      if (token) sessionStorage.setItem(KEY, JSON.stringify({ origin, token }));
      else sessionStorage.removeItem(KEY);
    } catch { /* Memory storage also works for the current panel. */ }
  }
  const request = (path: string, init: RequestInit) => fetch(origin + path, {
    ...init, credentials: "omit", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8000),
  });
  return {
    state() {
      if (!origin || !token || Date.now() - checked < 4000) return Promise.resolve(cached);
      const version = generation;
      return checking ??= request("/billing/v1/entitlement", { headers: { authorization: "Bearer " + token } }).then(async res => {
        if (version !== generation) return cached;
        if (res.status === 401) {
          remember(undefined);
          return cached;
        }
        if (!res.ok) throw new Error("Account access is temporarily unavailable.");
        const body = await res.json();
        if (version !== generation) return cached;
        checked = Date.now();
        return cached = {
          pro: body.active === true && body.connected === true && body.entitlement === PRODUCT.entitlement,
          connected: body.connected === true,
          ...(body.connected === true && typeof body.account === "string" && { account: body.account }),
          trialUntil,
        };
      }).catch(() => {
        if (version === generation && Date.now() - checked > 60_000) cached = { pro: false, trialUntil };
        return cached;
      }).finally(() => { if (version === generation) checking = undefined; });
    },
    async restore() {
      if (!origin) throw new Error("Account restoration is unavailable in this panel.");
      const res = await request("/billing/v1/restore-connections", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ product: PRODUCT.id }),
      });
      if (!res.ok) throw new Error("Unable to start account restoration.");
      const data = await res.json();
      const url = billingFlowUrl(data.url, origin, "restore");
      if (typeof data.token !== "string" || !TOKEN.test(data.token)) {
        throw new Error("Invalid account restoration link.");
      }
      remember(data.token);
      return url;
    },
    async signOut() {
      const previous = token;
      remember(undefined);
      if (origin && previous) {
        await request("/billing/v1/entitlement", {
          method: "DELETE", headers: { authorization: "Bearer " + previous },
        }).catch(() => {});
      }
    },
  };
}
