import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PRODUCT, TRIAL_MS, billingFlowUrl, sanitizeAds, type Ad, type LicenseState, type PhoneSignInError, type PhoneSignInResult, type WechatOrderResult } from "@inkmap/core";

export type CheckoutMode = "buy" | "restore";

export interface SessionStorage {
  read(): Promise<string | undefined>;
  write(token: string | undefined): Promise<void>;
}

export interface LicenseService {
  state(): Promise<LicenseState>;
  connect(mode: CheckoutMode): Promise<string>;
  orderPro(): Promise<WechatOrderResult>;
  sendPhoneCode(phone: string): Promise<PhoneSignInResult>;
  signInByPhone(phone: string, code: string): Promise<PhoneSignInResult<LicenseState>>;
  deactivate(): Promise<void>;
  onChange(listener: (state: LicenseState) => void): () => void;
  dispose(): void;
}

export function billingOrigin(raw: string | undefined): string {
  if (!raw) throw new Error("Inkmap checkout is not configured.");
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.origin !== raw.replace(/\/$/, "")) {
    throw new Error("Inkmap checkout requires an HTTPS origin.");
  }
  return url.origin;
}

export function licenseService(storage: SessionStorage, getOrigin: () => string | undefined, { loginOnly = false } = {}): LicenseService {
  const listeners = new Set<(state: LicenseState) => void>();
  let current: LicenseState = { pro: false };
  let trial: Promise<void> | undefined;
  let trialTimer: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastCheck = 0;
  let disposed = false;
  let generation = 0;
  let connection: Promise<void> | undefined;
  let activeOrigin: string | undefined;
  let pendingWrite = Promise.resolve();
  let pendingCheckout: { origin: string; url: string; token: string; cookie?: string } | undefined;
  let cachedOrder: { at: number; origin: string; result: WechatOrderResult } | undefined;

  function mergeCookies(existing: string | undefined, response: Response): string | undefined {
    const map = new Map<string, string>();
    if (existing) {
      for (const pair of existing.split(/;\s*/)) {
        const eq = pair.indexOf("=");
        if (eq > 0) map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const rawList = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : response.headers.get("set-cookie") ? [response.headers.get("set-cookie")!] : [];
    for (const raw of rawList) {
      const first = raw.split(";")[0]?.trim() ?? "";
      const eq = first.indexOf("=");
      if (eq > 0) map.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
    return map.size ? [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ") : undefined;
  }

  function maskPhone(phone: string): string {
    const clean = phone.trim();
    const at = clean.indexOf("@");
    if (at > 0 && at < clean.length - 1) {
      const local = [...clean.slice(0, at)];
      const domain = clean.slice(at + 1);
      return `${local.length <= 1 ? "***" : local[0] + "***"}@${domain}`.slice(0, 64);
    }
    return /^1\d{10}$/.test(clean) ? `${clean.slice(0, 3)}****${clean.slice(7)}` : clean.slice(0, 32);
  }

  function clientLocale(): "zh" | "en" {
    const raw = (process.env.INKMAP_LOCALE || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "").trim();
    if (/^zh\b/i.test(raw)) return "zh";
    if (/^en\b/i.test(process.env.INKMAP_LOCALE || "")) return "en";
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      if (/^Asia\/(Shanghai|Chongqing|Harbin|Urumqi)$/i.test(tz)) return "zh";
    } catch {}
    return "en";
  }

  function writeSession<T>(operation: () => Promise<T>): Promise<T> {
    const next = pendingWrite.then(operation);
    pendingWrite = next.then(() => {}, () => {});
    return next;
  }

  async function createCheckoutFlow(origin: string, existingToken?: string, existingCookie?: string): Promise<{ origin: string; url: string; token: string; cookie?: string }> {
    const response = await fetch(origin + "/billing/v1/connections", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(existingToken && { authorization: "Bearer " + existingToken }),
        ...(existingCookie && { cookie: existingCookie }),
      },
      redirect: "error",
      body: JSON.stringify({ product: PRODUCT.id, mode: "buy" }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error("Unable to start the checkout flow.");
    const cookie = mergeCookies(existingCookie, response);
    const data = await response.json();
    const url = billingFlowUrl(data.url, origin, "buy", false);
    if (typeof data.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(data.token)) {
      throw new Error("Invalid Inkmap checkout response.");
    }
    return { origin, url, token: data.token, ...(cookie && { cookie }) };
  }

  function checkoutPost(checkoutUrl: string, action: "sms" | "login" | "email/send" | "email/verify" | "order", origin: string, body: object, token?: string, cookie?: string) {
    return fetch(checkoutUrl + "/" + action, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        ...(token && { authorization: "Bearer " + token }),
        ...(cookie && { cookie }),
      },
      redirect: "error",
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
  }

  function phoneRequest(origin: string, action: "send" | "verify", phone: string, code?: string) {
    const isEmail = phone.includes("@");
    const locale = clientLocale();
    return fetch(origin + "/billing/v1/phone-sign-in/" + action, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept-language": locale === "zh" ? "zh-CN,zh;q=0.9" : "en-US,en;q=0.9",
      },
      redirect: "error",
      body: JSON.stringify({ product: PRODUCT.id, phone, ...(isEmail && { email: phone, locale }), code }),
      signal: AbortSignal.timeout(12_000),
    });
  }

  function phoneFailure(status?: number): { ok: false; reason: PhoneSignInError } {
    if (status === 400 || status === 401) return { ok: false, reason: "invalid" };
    return { ok: false, reason: status === 429 ? "rateLimited" : "unavailable" };
  }

  function entitlement(origin: string, token: string) {
    return fetch(origin + "/billing/v1/entitlement", {
      headers: { authorization: "Bearer " + token }, redirect: "error", signal: AbortSignal.timeout(5000),
    });
  }

  function applyEntitlement(state: Record<string, unknown>) {
    lastCheck = Date.now();
    const connected = state.connected === true;
    const active = connected && state.active === true && state.entitlement === PRODUCT.entitlement;
    const account = typeof state.account === "string" ? state.account.trim().slice(0, 64) : "";
    if (!connected && state.pending === true && current.connected) return;
    update(active, connected, account);
  }

  function update(pro: boolean, connected = false, account?: string) {
    const cleanAccount = connected && account ? account : undefined;
    if (current.pro === pro && Boolean(current.connected) === connected && current.account === cleanAccount) return;
    current = {
      pro,
      ...(current.trialUntil !== undefined && { trialUntil: current.trialUntil }),
      ...(connected && { connected: true }),
      ...(cleanAccount && { account: cleanAccount }),
    };
    for (const listener of listeners) listener(current);
  }

  async function startTrial() {
    const trialUntil = await localTrialDeadline().catch(() => undefined);
    if (disposed || trialUntil === undefined) return;
    current = { ...current, trialUntil };
    const remaining = trialUntil - Date.now();
    if (remaining > 0) {
      trialTimer = setTimeout(() => {
        for (const listener of listeners) listener(current);
      }, remaining);
      trialTimer.unref();
    }
  }

  function schedule(delay: number) {
    clearTimeout(timer);
    if (disposed) return;
    timer = setTimeout(() => void refresh(), delay);
    timer.unref();
  }

  function refresh(): Promise<void> {
    if (connection) return connection;
    const version = generation;
    connection = (async () => {
      let token: string | undefined;
      let delay = 60_000;
      try {
        const origin = billingOrigin(getOrigin());
        if (origin !== activeOrigin) {
          lastCheck = 0;
          activeOrigin = origin;
          update(false);
        }
        const stored = await storage.read();
        if (version !== generation || disposed) return;
        if (!stored) return update(false);
        const record = JSON.parse(stored);
        if (record.origin !== origin || typeof record.token !== "string") return update(false);
        token = record.token;
        const response = await entitlement(origin, record.token);
        if (version !== generation || disposed) return;
        if (response.status === 401) {
          token = undefined;
          return await writeSession(async () => {
            if (version !== generation || disposed) return;
            await storage.write(undefined).catch(() => {});
            update(false);
          });
        }
        if (!response.ok) throw new Error("Unable to check Inkmap Pro.");
        const state = await response.json();
        if (version !== generation || disposed) return;
        applyEntitlement(state);
        delay = state.active !== true && state.pending === true ? 4000 : 60_000;
      } catch {
        if (version === generation && Date.now() - lastCheck > 15 * 60_000) update(false);
      } finally {
        if (version === generation && token) schedule(delay);
      }
    })().finally(() => { connection = undefined; });
    return connection;
  }

  return {
    async state() {
      await (trial ??= startTrial());
      if (Date.now() - lastCheck >= 4000) await refresh();
      return current;
    },
    async connect(mode) {
      if (loginOnly && mode !== "restore") throw new Error("Only Yunfan account sign-in is available.");
      const origin = billingOrigin(getOrigin());
      const version = generation;
      let existingToken: string | undefined;
      try {
        const stored = await storage.read();
        if (stored) {
          const record = JSON.parse(stored);
          if (record.origin === origin && typeof record.token === "string") existingToken = record.token;
        }
      } catch {}
      const create = (path: string, body: object) => fetch(origin + "/billing/v1/" + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(existingToken && { authorization: "Bearer " + existingToken }),
        },
        redirect: "error",
        body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
      });
      let legacy = false;
      let response = await (mode === "restore"
        ? create("restore-connections", { product: PRODUCT.id })
        : create("connections", { product: PRODUCT.id, mode }));
      if (mode === "restore" && !loginOnly && response.status === 404) {
        legacy = true;
        response = await create("connections", { product: PRODUCT.id, mode });
      }
      if (!response.ok) throw new Error("Unable to start the Yunfan account flow.");
      const data = await response.json();
      const url = billingFlowUrl(data.url, origin, mode, legacy);
      if (typeof data.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(data.token)) {
        throw new Error("Invalid Inkmap checkout response.");
      }
      await writeSession(async () => {
        if (version !== generation || disposed || origin !== billingOrigin(getOrigin())) {
          throw new Error("The Yunfan account session changed. Please try again.");
        }
        await storage.write(JSON.stringify({ origin, token: data.token, ...(mode === "buy" && { checkoutUrl: url }) }));
        ++generation;
        lastCheck = 0;
        if (mode !== "buy" || !current.connected) update(false);
        schedule(1000);
      });
      return url;
    },
    async orderPro() {
      if (loginOnly) throw new Error("Only Yunfan account sign-in is available.");
      const origin = billingOrigin(getOrigin());
      if (cachedOrder && cachedOrder.origin === origin && Date.now() - cachedOrder.at < 8000) {
        const hit = cachedOrder.result;
        cachedOrder = undefined;
        schedule(hit.status === "qr" || hit.status === "redirect" ? 4000 : 60_000);
        return hit;
      }
      const version = generation;
      let record: { origin?: string; token?: string; checkoutUrl?: string; cookie?: string } | undefined;
      try {
        const stored = await storage.read();
        if (stored) record = JSON.parse(stored);
      } catch {}

      const requestOrder = async (checkoutUrl: string, token: string, cookie: string | undefined, persist: boolean): Promise<WechatOrderResult | null> => {
        const res = await checkoutPost(checkoutUrl, "order", origin, {}, token, cookie);
        if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410) return null;
        if (!res.ok) throw new Error("Unable to load WeChat Pay QR code.");
        const nextCookie = mergeCookies(cookie, res);
        const data = await res.json();
        if (persist || nextCookie !== cookie) {
          await writeSession(async () => {
            if (version !== generation || disposed || origin !== billingOrigin(getOrigin())) return;
            await storage.write(JSON.stringify({ origin, token, checkoutUrl, ...(nextCookie && { cookie: nextCookie }) }));
            if (persist) {
              ++generation;
              lastCheck = 0;
            }
          });
        }
        if (data.active === true) {
          const rights = await entitlement(origin, token).catch(() => null);
          if (rights?.ok) applyEntitlement(await rights.json());
          else update(true, true, current.account);
          schedule(60_000);
          return { status: "active", state: current };
        }
        if (typeof data.qr === "string" && data.qr) {
          schedule(4000);
          const qr = data.qr.startsWith("data:image/") ? data.qr : "data:image/png;base64," + data.qr;
          return {
            status: "qr",
            qr,
            amountFen: typeof data.amountFen === "number" ? data.amountFen : 2990,
            ...(typeof data.expiresAt === "string" && { expiresAt: data.expiresAt }),
          };
        }
        if (typeof data.checkoutUrl === "string" && /^https:\/\//.test(data.checkoutUrl)) {
          schedule(4000);
          return { status: "redirect", url: data.checkoutUrl };
        }
        throw new Error("Invalid Inkmap checkout response.");
      };

      const existingCookie = record?.origin === origin && typeof record.cookie === "string" ? record.cookie : undefined;
      if (record?.origin === origin && typeof record.checkoutUrl === "string" && typeof record.token === "string") {
        const existing = await requestOrder(record.checkoutUrl, record.token, existingCookie, false);
        if (existing) return existing;
      }

      const existingToken = record?.origin === origin && typeof record.token === "string" ? record.token : undefined;
      const flow = await createCheckoutFlow(origin, existingToken, existingCookie);
      const ordered = await requestOrder(flow.url, flow.token, flow.cookie, true);
      if (ordered) return ordered;
      pendingCheckout = flow;
      return { status: "needsPhone" };
    },
    async sendPhoneCode(phone) {
      if (typeof phone !== "string" || !phone.trim() || phone.length > 254) return phoneFailure(400);
      const isEmail = phone.includes("@");
      const locale = clientLocale();
      try {
        const origin = billingOrigin(getOrigin());
        if (!loginOnly) {
          try {
            if (!pendingCheckout || pendingCheckout.origin !== origin) {
              pendingCheckout = await createCheckoutFlow(origin);
            }
            const sendAction = isEmail ? "email/send" : "sms";
            const sendBody = isEmail ? { email: phone, locale } : { phone };
            let smsRes = await checkoutPost(pendingCheckout.url, sendAction, origin, sendBody, pendingCheckout.token, pendingCheckout.cookie);
            if (smsRes.status === 410 || smsRes.status === 404) {
              pendingCheckout = await createCheckoutFlow(origin);
              smsRes = await checkoutPost(pendingCheckout.url, sendAction, origin, sendBody, pendingCheckout.token, pendingCheckout.cookie);
            }
            pendingCheckout.cookie = mergeCookies(pendingCheckout.cookie, smsRes);
            return smsRes.status === 204 ? { ok: true, value: undefined } : phoneFailure(smsRes.status);
          } catch {
            pendingCheckout = undefined;
          }
        }
        const response = await phoneRequest(origin, "send", phone);
        return response.status === 204 ? { ok: true, value: undefined } : phoneFailure(response.status);
      } catch {
        return phoneFailure();
      }
    },
    async signInByPhone(phone, code) {
      if (typeof phone !== "string" || !phone.trim() || phone.length > 254 ||
          typeof code !== "string" || !/^\d{6}$/.test(code)) return phoneFailure(400);
      const isEmail = phone.includes("@");
      const version = generation;
      try {
        const origin = billingOrigin(getOrigin());
        let token: string;
        let checkoutUrl: string | undefined;
        let cookie: string | undefined;
        if (pendingCheckout && pendingCheckout.origin === origin && !loginOnly) {
          const verifyAction = isEmail ? "email/verify" : "login";
          const verifyBody = isEmail ? { email: phone, code } : { phone, code };
          const loginRes = await checkoutPost(pendingCheckout.url, verifyAction, origin, verifyBody, pendingCheckout.token, pendingCheckout.cookie);
          if (!loginRes.ok) {
            if (loginRes.status === 410 || loginRes.status === 404) pendingCheckout = undefined;
            return phoneFailure(loginRes.status);
          }
          cookie = mergeCookies(pendingCheckout.cookie, loginRes);
          token = pendingCheckout.token;
          checkoutUrl = pendingCheckout.url;
          pendingCheckout = undefined;

          const orderRes = await checkoutPost(checkoutUrl, "order", origin, {}, token, cookie).catch(() => null);
          if (orderRes?.ok) {
            cookie = mergeCookies(cookie, orderRes);
            const orderData = await orderRes.json().catch(() => null);
            if (orderData && typeof orderData === "object") {
              if (orderData.active === true) {
                cachedOrder = { at: Date.now(), origin, result: { status: "active", state: current } };
              } else if (typeof orderData.qr === "string" && orderData.qr) {
                const qr = orderData.qr.startsWith("data:image/") ? orderData.qr : "data:image/png;base64," + orderData.qr;
                cachedOrder = {
                  at: Date.now(),
                  origin,
                  result: {
                    status: "qr",
                    qr,
                    amountFen: typeof orderData.amountFen === "number" ? orderData.amountFen : 2990,
                    ...(typeof orderData.expiresAt === "string" && { expiresAt: orderData.expiresAt }),
                  },
                };
              } else if (typeof orderData.checkoutUrl === "string" && /^https:\/\//.test(orderData.checkoutUrl)) {
                cachedOrder = { at: Date.now(), origin, result: { status: "redirect", url: orderData.checkoutUrl } };
              }
            }
          }
        } else {
          const response = await phoneRequest(origin, "verify", phone, code);
          if (response.status !== 201) return phoneFailure(response.status);
          cookie = mergeCookies(undefined, response);
          const body = await response.json();
          token = body.token;
        }
        if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return phoneFailure();
        let state: Record<string, unknown> = { entitlement: PRODUCT.entitlement, connected: true, account: maskPhone(phone) };
        const rights = await entitlement(origin, token).catch(() => null);
        if (rights?.ok) {
          state = await rights.json();
          if (state.entitlement !== PRODUCT.entitlement) return phoneFailure();
          if (state.connected !== true) {
            if (!checkoutUrl) return phoneFailure();
            state.connected = true;
          }
          if (checkoutUrl && (!state.account || typeof state.account !== "string" || !state.account.trim())) {
            state.account = maskPhone(phone);
          }
        } else if (!checkoutUrl) {
          return phoneFailure();
        }
        if (cachedOrder?.result.status === "active") state.active = true;
        return await writeSession(async () => {
          if (version !== generation || disposed || origin !== billingOrigin(getOrigin())) return phoneFailure();
          await storage.write(JSON.stringify({ origin, token, ...(checkoutUrl && { checkoutUrl }), ...(cookie && { cookie }) }));
          ++generation;
          activeOrigin = origin;
          applyEntitlement(state);
          if (cachedOrder?.result.status === "active") cachedOrder.result.state = current;
          schedule(cachedOrder?.result.status === "qr" ? 4000 : 60_000);
          return { ok: true, value: current } as const;
        });
      } catch {
        return phoneFailure();
      }
    },
    async deactivate() {
      pendingCheckout = undefined;
      cachedOrder = undefined;
      const saved = await writeSession(async () => {
        const previous = await storage.read();
        await storage.write(undefined);
        ++generation;
        clearTimeout(timer);
        lastCheck = 0;
        update(false);
        return previous;
      });
      if (!saved) return;
      try {
        const { origin, token } = JSON.parse(saved);
        if (origin !== billingOrigin(getOrigin())) return;
        await fetch(origin + "/billing/v1/entitlement", {
          method: "DELETE", headers: { authorization: "Bearer " + token }, redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // The local session was cleared even if the platform is unreachable.
      }
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      clearTimeout(trialTimer);
      clearTimeout(timer);
      listeners.clear();
    },
  };
}

export function fileSessionStorage(path = join(process.env.INKMAP_HOME ?? join(homedir(), ".inkmap"), "billing-session")): SessionStorage {
  return {
    read: () => readFile(path, "utf8").then(s => s.trim() || undefined, () => undefined),
    async write(token) {
      if (!token) return rm(path, { force: true });
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = path + "." + randomUUID();
      try {
        await writeFile(temporary, token, { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}

// Shared by the desktop extension and CLI for this operating-system account.
async function localTrialDeadline(): Promise<number | undefined> {
  const path = join(homedir(), ".inkmap", "trial-start");
  const now = Date.now();
  let value: string;
  try {
    value = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = path + "." + randomUUID();
    try {
      await writeFile(temporary, String(now), { mode: 0o600, flag: "wx" });
      await link(temporary, path).catch(error => {
        if (error.code !== "EEXIST") throw error;
      });
    } finally {
      await rm(temporary, { force: true });
    }
    value = await readFile(path, "utf8");
  }
  const started = Number(value);
  return Number.isSafeInteger(started) && started > 0 && started <= Date.now()
    ? started + TRIAL_MS
    : undefined;
}

const AD_TTL = 6 * 60 * 60 * 1000;

/** Fetches the sponsor ad feed at most every few hours; any failure just means no sponsor ads. */
export function adFeed(url: string | undefined): () => Promise<Ad[]> {
  let cache: { at: number; ads: Ad[] } | undefined;
  return async () => {
    if (!url) return [];
    if (cache && Date.now() - cache.at < AD_TTL) return cache.ads;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
      const ads = res.ok ? sanitizeAds(await res.json()) : [];
      cache = { at: Date.now(), ads };
      return ads;
    } catch {
      cache = { at: Date.now(), ads: [] };
      return [];
    }
  };
}
