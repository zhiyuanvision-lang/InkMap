import { execFileSync } from "node:child_process";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { INKMAP_VERSION } from "./version.js";
import { PRODUCT, TRIAL_MS, billingFlowUrl, type LicenseState, type PhoneSignInError, type PhoneSignInResult, type WechatOrderResult } from "@inkmap/core";

const ZH_LOCALE_RE = /^zh(?:[-_.]|$)/i;
const EN_LOCALE_RE = /^en(?:[-_.]|$)/i;
let cachedOsLocale: "zh" | "en" | undefined;

interface WaitingToken {
  origin: string;
  token: string;
  /** The address the code was sent to ("" when unknown). */
  email: string;
  since: number;
  /** Polled every few seconds until then, every half minute afterwards. */
  fastUntil: number;
}
const WAIT_FAST_MS = 2500;
const WAIT_SLOW_MS = 30_000;
const WAIT_FAST_FOR_MS = 30 * 60_000;
/** A bound token is a 30-day session on the server; waiting on it for payment stops after three days. */
const WAIT_MAX_MS = 3 * 24 * 60 * 60_000;
const MAX_WAITING = 5;

function isWaitingToken(value: unknown): value is WaitingToken {
  const w = value as WaitingToken;
  return Boolean(w) && typeof w.origin === "string" && typeof w.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(w.token) &&
    typeof w.email === "string" && typeof w.since === "number" && typeof w.fastUntil === "number";
}

const DOMESTIC_TIME_ZONE = /^(Asia\/(Shanghai|Chongqing|Chungking|Harbin|Urumqi|Beijing)|PRC)$/i;

/** What the Domestic/Overseas decision reads from the computer, passed in so the rules can be tested on any OS. */
export interface LocaleProbe {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** The IANA time zone the OS reports (`Asia/Shanghai`). */
  timeZone: string;
  /** Intl's default locale, used on Windows when the registry cannot be read. */
  intlLocale: string;
  /** Runs a system command and returns its output; throws when the command fails. */
  run(command: string, args: string[]): string;
}

/** The first language of `defaults read -g AppleLanguages` output, quoted (`"zh-Hans-CN"`) or not (`en`). */
export function parseAppleLanguages(output: string): string {
  const match = /^\(\s*(?:"([^"]+)"|([^\s,)]+))/m.exec(output);
  return match?.[1] ?? match?.[2] ?? "";
}

const posixLocale = (env: NodeJS.ProcessEnv) => (env.LC_ALL || env.LC_MESSAGES || env.LANG || "").trim();

/**
 * Domestic ("zh") vs. Overseas ("en") from the computer's OS time zone OR its OS system language — never from an
 * IDE/plugin UI language. `INKMAP_LOCALE` overrides both (support and tests).
 */
export function resolveOsLocale(probe: LocaleProbe): "zh" | "en" {
  const explicit = (probe.env.INKMAP_LOCALE || "").trim();
  if (ZH_LOCALE_RE.test(explicit)) return "zh";
  if (EN_LOCALE_RE.test(explicit)) return "en";
  if (DOMESTIC_TIME_ZONE.test(probe.timeZone)) return "zh";
  let language = "";
  if (probe.platform === "darwin") {
    try {
      language = parseAppleLanguages(probe.run("defaults", ["read", "-g", "AppleLanguages"]));
    } catch {
      language = posixLocale(probe.env);
    }
  } else if (probe.platform === "win32") {
    try {
      const output = probe.run("reg", ["query", "HKCU\\Control Panel\\International", "/v", "LocaleName"]);
      language = /LocaleName\s+REG_\w+\s+(\S+)/i.exec(output)?.[1] ?? "";
    } catch {}
    if (!language) language = probe.intlLocale;
  } else {
    language = posixLocale(probe.env);
  }
  return ZH_LOCALE_RE.test(language) ? "zh" : "en";
}

function systemLocaleProbe(): LocaleProbe {
  let timeZone = "";
  let intlLocale = "";
  try {
    const options = Intl.DateTimeFormat().resolvedOptions();
    timeZone = options.timeZone || "";
    intlLocale = options.locale || "";
  } catch {}
  return {
    platform: process.platform,
    env: process.env,
    timeZone,
    intlLocale,
    run: (command, args) =>
      execFileSync(command, args, { encoding: "utf8", timeout: 800, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }),
  };
}

/**
 * Detects Domestic ("zh") vs. Overseas ("en") strictly from the computer's OS timezone
 * OR the computer's OS system language — never from an IDE/plugin UI language setting.
 */
export function detectOsLocale(): "zh" | "en" {
  const explicit = (process.env.INKMAP_LOCALE || "").trim();
  if (ZH_LOCALE_RE.test(explicit)) return "zh";
  if (EN_LOCALE_RE.test(explicit)) return "en";
  return (cachedOsLocale ??= resolveOsLocale(systemLocaleProbe()));
}

export type CheckoutMode = "buy" | "restore";

interface SessionStorage {
  read(): Promise<string | undefined>;
  write(token: string | undefined): Promise<void>;
}

export interface LicenseService {
  state(): Promise<LicenseState>;
  connect(mode: CheckoutMode, localeHint?: string): Promise<string>;
  orderPro(localeHint?: string): Promise<WechatOrderResult>;
  sendPhoneCode(phone: string, localeHint?: string): Promise<PhoneSignInResult>;
  signInByPhone(phone: string, code: string, localeHint?: string): Promise<PhoneSignInResult<LicenseState>>;
  deactivate(): Promise<void>;
  onChange(listener: (state: LicenseState) => void): () => void;
  track?(event: string, count?: number, hostHint?: string): void;
  flushTelemetry?(): Promise<void>;
  dispose(): void;
}

function billingOrigin(raw: string | undefined): string {
  if (!raw) throw new Error("Inkmap checkout is not configured.");
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.origin !== raw.replace(/\/$/, "")) {
    throw new Error("Inkmap checkout requires an HTTPS origin.");
  }
  return url.origin;
}

export function licenseService(
  storage: SessionStorage,
  getOrigin: () => string | undefined,
  { loginOnly = false, host: defaultHost = "", waitPollMs = WAIT_FAST_MS }: { loginOnly?: boolean; host?: string; waitPollMs?: number } = {},
): LicenseService {
  const listeners = new Set<(state: LicenseState) => void>();
  let current: LicenseState = { pro: false };
  let trial: Promise<void> | undefined;
  let trialTimer: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let telemetryTimer: ReturnType<typeof setTimeout> | undefined;
  let installIdPromise: Promise<string | undefined> | undefined;
  let sentAppOpen = false;
  let detectedHost = defaultHost;
  const pendingEvents = new Map<string, number>();
  let lastCheck = 0;
  /** Until then a signed-in free user is checked every few seconds, because a sign-in or purchase may be completing. */
  let fastPollUntil = 0;
  const expectPurchase = () => void (fastPollUntil = Date.now() + 15 * 60_000);
  /** A checkout flow being created; concurrent requests share it instead of racing to replace each other's flow. */
  let flowCreation: ReturnType<typeof createCheckoutFlow> | undefined;
  let disposed = false;
  let generation = 0;
  let connection: Promise<void> | undefined;
  let activeOrigin: string | undefined;
  let pendingWrite = Promise.resolve();
  let pendingCheckout: { origin: string; url: string; token: string; cookie?: string; locale: "zh" | "en" } | undefined;
  let cachedOrder: { at: number; origin: string; locale: "zh" | "en"; result: WechatOrderResult } | undefined;
  /**
   * Sign-in tokens this computer is waiting on, while no account is signed in. A token from an email send waits for
   * the email's button (the server binds it to the account when clicked). On a login-only host after the trial, a
   * verified account without Pro is not signed in; its token waits instead. Pro belongs to the account, so paying by
   * any route makes such a token active, and the first token that is active signs in without the code.
   */
  let waiting: WaitingToken[] = [];
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  let waitRound = 0;
  /** The email (or phone number) last used to sign in here; kept after sign-out so the form can be prefilled. */
  let lastSignIn: string | undefined;
  /** A session record for storage; it carries the remembered sign-in so it survives the session. */
  const sessionRecord = (fields: Record<string, unknown>) => JSON.stringify({ ...fields, ...(lastSignIn && { lastSignIn }) });
  /** What storage holds while signed out: the remembered sign-in and the tokens still waited on, if any. */
  const signedOutRecord = () =>
    lastSignIn || waiting.length ? JSON.stringify({ ...(lastSignIn && { lastSignIn }), ...(waiting.length && { waiting }) }) : undefined;

  /** Remembers `id` for prefilling and stores it next to the current session (or alone when signed out). */
  async function rememberSignIn(id: string) {
    const clean = id.trim().slice(0, 254);
    if (!clean || clean === lastSignIn) return;
    lastSignIn = clean;
    current = { ...current, lastSignIn };
    await writeSession(async () => {
      let record: Record<string, unknown> = {};
      try {
        record = JSON.parse((await storage.read()) || "{}");
      } catch {}
      await storage.write(JSON.stringify({ ...record, lastSignIn }));
    }).catch(() => {});
  }

  /** Stops waiting on every token (a session was stored, or the user signed out). */
  function clearWaiting() {
    waiting = [];
    ++waitRound;
    clearTimeout(waitTimer);
    waitTimer = undefined;
  }

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

  /**
   * Domestic (¥29.9 WeChat Pay) vs. Overseas ($15 card) follows the computer's OS timezone/language only.
   * Clients still send their UI language as a hint, but a zh-CN IDE on an Overseas machine (or the reverse)
   * must not switch editions, so the hint is deliberately ignored here.
   */
  function clientLocale(_uiLocaleHint?: string): "zh" | "en" {
    return detectOsLocale();
  }

  function writeSession<T>(operation: () => Promise<T>): Promise<T> {
    const next = pendingWrite.then(operation);
    pendingWrite = next.then(() => {}, () => {});
    return next;
  }

  async function createCheckoutFlow(origin: string, existingToken?: string, existingCookie?: string, localeHint?: string): Promise<{ origin: string; url: string; token: string; cookie?: string; locale: "zh" | "en" }> {
    const loc = clientLocale(localeHint);
    const response = await fetch(origin + "/billing/v1/connections", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-inkmap-locale": loc,
        ...(existingToken && { authorization: "Bearer " + existingToken }),
        ...(existingCookie && { cookie: existingCookie }),
      },
      redirect: "error",
      body: JSON.stringify({ product: PRODUCT.id, mode: "buy", locale: loc }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error("Unable to start the checkout flow.");
    const cookie = mergeCookies(existingCookie, response);
    const data = await response.json();
    const url = billingFlowUrl(data.url, origin, "buy", false);
    if (typeof data.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(data.token)) {
      throw new Error("Invalid Inkmap checkout response.");
    }
    return { origin, url, token: data.token, locale: loc, ...(cookie && { cookie }) };
  }

  function checkoutPost(checkoutUrl: string, action: "sms" | "login" | "email/send" | "email/verify" | "order", origin: string, body: object, token?: string, cookie?: string, localeHint?: string) {
    const loc = clientLocale(localeHint);
    return fetch(checkoutUrl + "/" + action, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-inkmap-locale": loc,
        origin,
        ...(token && { authorization: "Bearer " + token }),
        ...(cookie && { cookie }),
      },
      redirect: "error",
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
  }

  function phoneRequest(origin: string, action: "send" | "verify", phone: string, code?: string, localeHint?: string) {
    const isEmail = phone.includes("@");
    const locale = clientLocale(localeHint);
    return fetch(origin + "/billing/v1/phone-sign-in/" + action, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-inkmap-locale": locale,
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
      ...(lastSignIn && { lastSignIn }),
    };
    for (const listener of listeners) listener(current);
  }

  async function startTrial() {
    try {
      const record = JSON.parse((await storage.read()) || "{}");
      const remembered = record.lastSignIn;
      if (typeof remembered === "string" && remembered.trim() && !lastSignIn) {
        lastSignIn = remembered.trim().slice(0, 254);
        current = { ...current, lastSignIn };
      }
      // Tokens waited on before a restart (an unpaid sign-in, an email not yet clicked) are picked up again.
      if (typeof record.token !== "string" && Array.isArray(record.waiting) && !waiting.length) {
        waiting = record.waiting.filter(isWaitingToken).slice(-MAX_WAITING);
        scheduleWait(waitPollMs);
      }
    } catch {}
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
            await storage.write(signedOutRecord()).catch(() => {});
            update(false);
          });
        }
        if (!response.ok) throw new Error("Unable to check Inkmap Pro.");
        const state = await response.json();
        if (version !== generation || disposed) return;
        applyEntitlement(state);
        delay = state.active !== true && state.pending === true ? 2500 : 60_000;
      } catch {
        if (version === generation && Date.now() - lastCheck > 15 * 60_000) update(false);
      } finally {
        if (version === generation && token) schedule(delay);
      }
    })().finally(() => { connection = undefined; });
    return connection;
  }

  /** True on a login-only host once the trial is over: an account must have Pro to stay signed in there. */
  async function mustPayFirst() {
    if (!loginOnly) return false;
    await (trial ??= startTrial());
    return current.trialUntil !== undefined && current.trialUntil <= Date.now();
  }

  /**
   * Starts (or renews) waiting on `token` and saves the list before returning, so a restart keeps it; a code sent to
   * a different address ends the waits for the previous one.
   */
  async function waitFor(origin: string, token: string, email: string) {
    const now = Date.now();
    const same = (other: string) => !other || !email || other.toLowerCase() === email.toLowerCase();
    waiting = waiting
      .filter(w => w.token !== token && same(w.email))
      .map(w => ({ ...w, fastUntil: now + WAIT_FAST_FOR_MS }));
    waiting.push({ origin, token, email, since: now, fastUntil: now + WAIT_FAST_FOR_MS });
    waiting = waiting.slice(-MAX_WAITING);
    scheduleWait(waitPollMs);
    await writeSession(async () => {
      let record: Record<string, unknown> = {};
      try {
        record = JSON.parse((await storage.read()) || "{}");
      } catch {}
      if (typeof record.token !== "string") await storage.write(signedOutRecord());
    }).catch(() => {});
  }

  function scheduleWait(delay: number) {
    clearTimeout(waitTimer);
    if (disposed || !waiting.length) return;
    waitTimer = setTimeout(() => void checkWaiting(), delay);
    waitTimer.unref();
  }

  async function checkWaiting() {
    const round = ++waitRound;
    const now = Date.now();
    const before = waiting.length;
    let origin: string;
    try {
      origin = billingOrigin(getOrigin());
    } catch {
      return scheduleWait(WAIT_SLOW_MS);
    }
    waiting = waiting.filter(w => w.origin === origin && now - w.since < WAIT_MAX_MS);
    for (const w of [...waiting]) {
      let response: Response;
      try {
        response = await entitlement(w.origin, w.token);
      } catch {
        continue;
      }
      if (disposed || round !== waitRound) return;
      // 401: the email was never clicked and the token expired (15 minutes), or the session was revoked.
      if (response.status === 401) {
        waiting = waiting.filter(other => other !== w);
        continue;
      }
      if (!response.ok) continue;
      const body = await response.json().catch(() => null);
      if (disposed || round !== waitRound) return;
      if (body?.connected !== true || body.entitlement !== PRODUCT.entitlement) continue;
      // Bound to an account. Without Pro, a login-only host past its trial keeps waiting for the payment.
      if (body.active !== true && (await mustPayFirst())) continue;
      if (disposed || round !== waitRound) return;
      await writeSession(async () => {
        if (disposed || round !== waitRound || w.origin !== billingOrigin(getOrigin())) return;
        clearWaiting();
        await storage.write(sessionRecord({ origin: w.origin, token: w.token }));
        ++generation;
        activeOrigin = w.origin;
        applyEntitlement(body);
        schedule(body.active === true ? 60_000 : 2500);
      });
      return;
    }
    if (disposed || round !== waitRound) return;
    if (waiting.length !== before) {
      await writeSession(async () => {
        let record: Record<string, unknown> = {};
        try {
          record = JSON.parse((await storage.read()) || "{}");
        } catch {}
        if (typeof record.token !== "string") await storage.write(signedOutRecord());
      }).catch(() => {});
    }
    scheduleWait(waiting.some(w => Date.now() < w.fastUntil) ? waitPollMs : WAIT_SLOW_MS);
  }

  /**
   * A login-only host after the trial does not keep an account without Pro signed in: the paywall offers the email
   * form instead. The account's token is kept and waited on, so paying from the email signs it back in by itself.
   */
  async function parkUnpaidSession() {
    if (current.pro || !current.connected || !(await mustPayFirst())) return;
    await writeSession(async () => {
      if (current.pro || !current.connected) return;
      let record: Record<string, unknown> = {};
      try {
        record = JSON.parse((await storage.read()) || "{}");
      } catch {}
      if (typeof record.token !== "string" || typeof record.origin !== "string") return;
      // Ask the server first: another editor sharing this session may just have unlocked Pro on it.
      const response = await entitlement(record.origin, record.token).catch(() => null);
      if (!response?.ok) return;
      const latest = await response.json().catch(() => null);
      if (!latest || latest.active === true || latest.connected !== true) {
        if (latest) applyEntitlement(latest);
        return;
      }
      ++generation;
      clearTimeout(timer);
      lastCheck = 0;
      const now = Date.now();
      waiting = [
        ...waiting.filter(w => w.token !== record.token),
        { origin: record.origin, token: record.token, email: lastSignIn ?? "", since: now, fastUntil: now + WAIT_FAST_FOR_MS },
      ].slice(-MAX_WAITING);
      await storage.write(signedOutRecord());
      update(false);
    });
    scheduleWait(waitPollMs);
  }

  async function sendPendingTelemetry() {
    if (disposed || !pendingEvents.size) return;
    let origin: string;
    try {
      origin = billingOrigin(getOrigin());
    } catch {
      return;
    }
    if (process.env.INKMAP_ALLOW_TEST_TELEMETRY !== "1") {
      if (origin === "https://billing.example.com" || process.env.INKMAP_DISABLE_TELEMETRY === "1" || process.env.NODE_TEST_CONTEXT) return;
      const customHome = process.env.INKMAP_HOME || "";
      const sysTmp = tmpdir();
      if (
        customHome &&
        (customHome === sysTmp ||
          customHome.startsWith(sysTmp + sep) ||
          customHome.startsWith("/tmp/") ||
          customHome.startsWith("/private/tmp/") ||
          customHome.includes("/var/folders/") ||
          customHome.includes("inkmap-npm-isolated-") ||
          customHome.includes("inkmap-antigravity-mcp-") ||
          customHome.includes("inkmap-local-editor-") ||
          customHome.includes("inkmap-harness-"))
      ) {
        return;
      }
    }
    const id = await (installIdPromise ??= localInstallId().catch(() => undefined));
    if (disposed || !id || !pendingEvents.size) return;
    await (trial ??= startTrial());
    const events: Record<string, number> = {};
    for (const [k, v] of pendingEvents.entries()) events[k] = v;
    pendingEvents.clear();
    const tier = current.pro ? "pro" : (current.trialUntil ?? 0) > Date.now() ? "trial" : "expired";
    const os = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : process.platform === "linux" ? "linux" : "other";
    const hostName = detectedHost || inferNodeHost();
    await fetch(origin + "/billing/v1/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      redirect: "error",
      body: JSON.stringify({
        product: PRODUCT.id,
        installId: id,
        host: hostName,
        os,
        version: INKMAP_VERSION,
        locale: clientLocale(),
        tier,
        events,
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }

  return {
    async state() {
      await (trial ??= startTrial());
      // While a sign-in or purchase started here may be completing, a free user is checked every few seconds so Pro
      // unlocks promptly; otherwise the billing server is asked at most once a minute, however often the UI polls.
      const interval = !current.pro && Date.now() < fastPollUntil ? 4000 : 60_000;
      if (Date.now() - lastCheck >= interval) await refresh();
      await parkUnpaidSession();
      return current;
    },
    async connect(mode, localeHint) {
      if (loginOnly && mode !== "restore") throw new Error("Only Yunfan account sign-in is available.");
      expectPurchase();
      const origin = billingOrigin(getOrigin());
      const loc = clientLocale(localeHint);
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
          "x-inkmap-locale": loc,
          ...(existingToken && { authorization: "Bearer " + existingToken }),
        },
        redirect: "error",
        body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
      });
      let legacy = false;
      let response = await (mode === "restore"
        ? create("restore-connections", { product: PRODUCT.id })
        : create("connections", { product: PRODUCT.id, mode, locale: loc }));
      if (mode === "restore" && !loginOnly && response.status === 404) {
        legacy = true;
        response = await create("connections", { product: PRODUCT.id, mode, locale: loc });
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
        clearWaiting();
        await storage.write(sessionRecord({ origin, token: data.token, ...(mode === "buy" && { checkoutUrl: url }) }));
        ++generation;
        lastCheck = 0;
        if (mode !== "buy" || !current.connected) update(false);
        schedule(1000);
      });
      return url;
    },
    async orderPro(localeHint) {
      if (loginOnly) throw new Error("Only Yunfan account sign-in is available.");
      expectPurchase();
      const origin = billingOrigin(getOrigin());
      const loc = clientLocale(localeHint);
      if (cachedOrder && cachedOrder.origin === origin && cachedOrder.locale === loc && Date.now() - cachedOrder.at < 8000) {
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
        const res = await checkoutPost(checkoutUrl, "order", origin, {}, token, cookie, localeHint);
        if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410) return null;
        if (!res.ok) throw new Error("Unable to load WeChat Pay QR code.");
        const nextCookie = mergeCookies(cookie, res);
        const data = await res.json();
        if (persist || nextCookie !== cookie) {
          await writeSession(async () => {
            if (version !== generation || disposed || origin !== billingOrigin(getOrigin())) return;
            await storage.write(sessionRecord({ origin, token, checkoutUrl, ...(nextCookie && { cookie: nextCookie }) }));
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
      const flow = await createCheckoutFlow(origin, existingToken, existingCookie, localeHint);
      const ordered = await requestOrder(flow.url, flow.token, flow.cookie, true);
      if (ordered) return ordered;
      pendingCheckout = flow;
      return { status: "needsPhone" };
    },
    async sendPhoneCode(phone, localeHint) {
      if (typeof phone !== "string" || !phone.trim() || phone.length > 254) return phoneFailure(400);
      expectPurchase();
      const isEmail = phone.includes("@");
      const locale = clientLocale(localeHint);
      try {
        const origin = billingOrigin(getOrigin());
        if (!loginOnly) {
          try {
            const newFlow = () => (flowCreation ??= createCheckoutFlow(origin, undefined, undefined, locale)
              .finally(() => { flowCreation = undefined; }));
            let flow = pendingCheckout;
            if (!flow || flow.origin !== origin || flow.locale !== locale) {
              flow = await newFlow();
              pendingCheckout = flow;
            }
            const sendAction = isEmail ? "email/send" : "sms";
            const sendBody = isEmail ? { email: phone, locale } : { phone };
            let smsRes = await checkoutPost(flow.url, sendAction, origin, sendBody, flow.token, flow.cookie, locale);
            if (smsRes.status === 401 || smsRes.status === 403 || smsRes.status === 404 || smsRes.status === 410) {
              flow = await newFlow();
              pendingCheckout = flow;
              smsRes = await checkoutPost(flow.url, sendAction, origin, sendBody, flow.token, flow.cookie, locale);
            }
            flow.cookie = mergeCookies(flow.cookie, smsRes);
            if (smsRes.status !== 204) return phoneFailure(smsRes.status);
            await rememberSignIn(phone);
            return { ok: true, value: undefined };
          } catch {
            pendingCheckout = undefined;
          }
        }
        const response = await phoneRequest(origin, "send", phone, undefined, locale);
        if (response.status === 204) {
          await rememberSignIn(phone);
          // The email's button signs this computer in (and leads to payment), on purchase hosts too.
          const pendingToken = response.headers.get("x-inkmap-pending-token")?.trim();
          if (pendingToken && /^[A-Za-z0-9_-]{43}$/.test(pendingToken)) await waitFor(origin, pendingToken, phone);
          return { ok: true, value: undefined };
        }
        return phoneFailure(response.status);
      } catch {
        return phoneFailure();
      }
    },
    async signInByPhone(phone, code, localeHint) {
      if (typeof phone !== "string" || !phone.trim() || phone.length > 254 ||
          typeof code !== "string" || !/^\d{6}$/.test(code)) return phoneFailure(400);
      const isEmail = phone.includes("@");
      const locale = clientLocale(localeHint);
      const version = generation;
      try {
        const origin = billingOrigin(getOrigin());
        let token: string;
        let checkoutUrl: string | undefined;
        let cookie: string | undefined;
        const flow = pendingCheckout;
        if (!loginOnly && flow && flow.origin === origin) {
          const verifyAction = isEmail ? "email/verify" : "login";
          const verifyBody = isEmail ? { email: phone, code } : { phone, code };
          const loginRes = await checkoutPost(flow.url, verifyAction, origin, verifyBody, flow.token, flow.cookie, locale);
          if (!loginRes.ok) {
            if (loginRes.status === 401 || loginRes.status === 403 || loginRes.status === 404 || loginRes.status === 410) {
              if (pendingCheckout === flow) pendingCheckout = undefined;
            }
            return phoneFailure(loginRes.status);
          }
          cookie = mergeCookies(flow.cookie, loginRes);
          token = flow.token;
          checkoutUrl = flow.url;
          if (pendingCheckout === flow) pendingCheckout = undefined;

          const orderRes = await checkoutPost(checkoutUrl, "order", origin, {}, token, cookie, locale).catch(() => null);
          if (orderRes?.ok) {
            cookie = mergeCookies(cookie, orderRes);
            const orderData = await orderRes.json().catch(() => null);
            if (orderData && typeof orderData === "object") {
              if (orderData.active === true) {
                cachedOrder = { at: Date.now(), origin, locale, result: { status: "active", state: current } };
              } else if (typeof orderData.qr === "string" && orderData.qr) {
                const qr = orderData.qr.startsWith("data:image/") ? orderData.qr : "data:image/png;base64," + orderData.qr;
                cachedOrder = {
                  at: Date.now(),
                  origin,
                  locale,
                  result: {
                    status: "qr",
                    qr,
                    amountFen: typeof orderData.amountFen === "number" ? orderData.amountFen : 2990,
                    ...(typeof orderData.expiresAt === "string" && { expiresAt: orderData.expiresAt }),
                  },
                };
              } else if (typeof orderData.checkoutUrl === "string" && /^https:\/\//.test(orderData.checkoutUrl)) {
                cachedOrder = { at: Date.now(), origin, locale, result: { status: "redirect", url: orderData.checkoutUrl } };
              }
            }
          }
        } else {
          const response = await phoneRequest(origin, "verify", phone, code, locale);
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
        if (!checkoutUrl && state.active !== true && (await mustPayFirst())) {
          // The code proved the email, but this account has no Pro: stay signed out and wait on its token, so that
          // paying from the email (or anywhere else) signs in without another code.
          await rememberSignIn(phone);
          await waitFor(origin, token, phone);
          return { ok: false, reason: "notPro" } as const;
        }
        return await writeSession(async () => {
          if (version !== generation || disposed || origin !== billingOrigin(getOrigin())) return phoneFailure();
          clearWaiting();
          await storage.write(sessionRecord({ origin, token, ...(checkoutUrl && { checkoutUrl }), ...(cookie && { cookie }) }));
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
      clearWaiting();
      pendingCheckout = undefined;
      cachedOrder = undefined;
      const saved = await writeSession(async () => {
        const previous = await storage.read();
        await storage.write(signedOutRecord());
        ++generation;
        clearTimeout(timer);
        lastCheck = 0;
        update(false);
        return previous;
      });
      if (!saved) return;
      try {
        const { origin, token } = JSON.parse(saved);
        if (origin !== billingOrigin(getOrigin()) || typeof token !== "string") return;
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
    track(event, count = 1, hostHint) {
      if (disposed || !event || typeof event !== "string" || count <= 0) return;
      if (hostHint) detectedHost = hostHint;
      if (!sentAppOpen && !PASSIVE_TELEMETRY_EVENTS.has(event)) {
        sentAppOpen = true;
        pendingEvents.set("app_open", (pendingEvents.get("app_open") ?? 0) + 1);
      }
      if (event !== "app_open") {
        pendingEvents.set(event, Math.min(1000, (pendingEvents.get(event) ?? 0) + count));
      }
      if (telemetryTimer) return;
      telemetryTimer = setTimeout(() => {
        telemetryTimer = undefined;
        void sendPendingTelemetry();
      }, 800);
      telemetryTimer.unref();
    },
    async flushTelemetry() {
      if (telemetryTimer) {
        clearTimeout(telemetryTimer);
        telemetryTimer = undefined;
      }
      await sendPendingTelemetry();
    },
    dispose() {
      disposed = true;
      clearWaiting();
      clearTimeout(trialTimer);
      clearTimeout(timer);
      clearTimeout(telemetryTimer);
      pendingEvents.clear();
      listeners.clear();
    },
  };
}

const PASSIVE_TELEMETRY_EVENTS = new Set(["plugin_activate", "plugin_install", "onboarding_view"]);

function inferNodeHost(): string {
  if (process.env.INKMAP_HOST) return process.env.INKMAP_HOST;
  if (process.env.ANTIGRAVITY_CONFIG_DIR) return "antigravity";
  if (process.env.VSCODE_PID || process.env.TERM_PROGRAM === "vscode") {
    const app = (process.env.VSCODE_NLS_CONFIG || process.execPath || "").toLowerCase();
    if (app.includes("cursor")) return "cursor";
    if (app.includes("windsurf")) return "windsurf";
    if (app.includes("trae")) return "trae";
    if (app.includes("qoder")) return "qoder";
    return "vscode";
  }
  return "cli";
}

async function atomicCreateIfMissing(path: string, initialContent: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = path + "." + randomUUID();
    try {
      await writeFile(temporary, initialContent, { mode: 0o600, flag: "wx" });
      await link(temporary, path).catch(async (err: NodeJS.ErrnoException) => {
        if (err.code === "EEXIST") return;
        if (err.code === "EPERM" || err.code === "ENOSYS" || err.code === "EXDEV") {
          await rename(temporary, path);
          return;
        }
        throw err;
      });
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    return await readFile(path, "utf8");
  }
}

async function localInstallId(): Promise<string | undefined> {
  const path = join(process.env.INKMAP_HOME || join(homedir(), ".inkmap"), "install-id");
  const generated = "inst_" + randomUUID().replace(/-/g, "").slice(0, 24);
  const value = (await atomicCreateIfMissing(path, generated)).trim();
  return /^[A-Za-z0-9_:-]{8,64}$/.test(value) ? value : undefined;
}

export function fileSessionStorage(path = join(process.env.INKMAP_HOME || join(homedir(), ".inkmap"), "billing-session")): SessionStorage {
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
  const path = join(process.env.INKMAP_HOME || join(homedir(), ".inkmap"), "trial-start");
  const value = await atomicCreateIfMissing(path, String(Date.now()));
  const started = Number(value);
  return Number.isSafeInteger(started) && started > 0 && started <= Date.now()
    ? started + TRIAL_MS
    : undefined;
}
