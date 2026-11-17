import type { LicenseState, PhoneSignInError } from "@inkmap/core";
import type { Host } from "./host";
import { applyI18n, t } from "./i18n";

export function createPhoneSignIn(
  api: NonNullable<Host["phoneSignIn"]>,
  onSignedIn: (state: LicenseState) => void,
  openBrowser: () => Promise<boolean>,
) {
  const template = document.querySelector<HTMLTemplateElement>("#phone-sign-in-template")!;
  const form = template.content.firstElementChild!.cloneNode(true) as HTMLFormElement;
  const title = form.querySelector<HTMLElement>("#phone-sign-in-title")!;
  const subtitle = form.querySelector<HTMLElement>(".phone-sign-in-sub")!;
  const phone = form.querySelector<HTMLInputElement>("#sign-in-phone")!;
  const code = form.querySelector<HTMLInputElement>("#sign-in-code")!;
  const send = form.querySelector<HTMLButtonElement>("#send-phone-code")!;
  const submit = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const browser = form.querySelector<HTMLButtonElement>("#phone-browser-sign-in")!;
  const cancel = form.querySelector<HTMLButtonElement>("#cancel-phone-sign-in")!;
  const status = form.querySelector<HTMLElement>("#phone-sign-in-status")!;
  let busy = false;
  let verifying = false;
  let forPurchase = false;
  let onVerified: ((state: LicenseState) => void) | undefined;
  let retryAt = 0;
  let timer = 0;
  let trigger: HTMLButtonElement | undefined;
  let request = 0;
  let message: { key: Parameters<typeof t>[0]; error: boolean } | undefined;

  function render() {
    window.clearTimeout(timer);
    const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    title.textContent = t(forPurchase ? "phoneSignInForPay" : "phoneSignIn");
    subtitle.textContent = t(forPurchase ? "phoneSignInForPaySub" : "phoneSignInSub");
    submit.textContent = t(forPurchase ? "phoneVerifyAndPay" : "phoneVerifySubmit");
    send.textContent = seconds ? t("resendPhoneCode", { seconds }) : t("sendPhoneCode");
    send.disabled = busy || seconds > 0;
    submit.disabled = browser.disabled = busy;
    cancel.disabled = verifying;
    phone.readOnly = code.readOnly = busy;
    status.hidden = !message;
    if (message) {
      status.textContent = t(message.key);
      status.dataset.state = message.error ? "error" : "";
    }
    if (form.isConnected && seconds) timer = window.setTimeout(render, 1000);
  }

  function refreshLanguage() {
    applyI18n(form);
    cancel.setAttribute("aria-label", t("close"));
    render();
  }

  function close(restoreFocus = false) {
    if (!form.isConnected) return;
    request++;
    form.remove();
    form.reset();
    window.clearTimeout(timer);
    busy = false;
    verifying = false;
    forPurchase = false;
    onVerified = undefined;
    message = undefined;
    if (restoreFocus) trigger?.focus();
    trigger = undefined;
  }

  function failure(reason: PhoneSignInError, verifying: boolean) {
    if (reason === "rateLimited") retryAt = Date.now() + 60_000;
    message = {
      key: reason === "rateLimited" ? "phoneRateLimited" : reason === "unavailable" ? "phoneSignInUnavailable"
        : verifying ? "phoneCodeInvalid" : "phoneInvalid",
      error: true,
    };
  }

  function normalizedPhone() {
    const raw = phone.value.normalize("NFKC").trim();
    if (raw.includes("@")) {
      const email = raw.toLowerCase();
      if (email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email;
      failure("invalid", false);
      render();
      phone.focus();
      return;
    }
    const number = raw.replace(/[\s\-–‑]/g, "").replace(/^(?:\+86|0086|86(?=1\d{10}$))/, "");
    if (/^1[3-9]\d{9}$/.test(number)) return number;
    failure("invalid", false);
    render();
    phone.focus();
  }

  send.addEventListener("click", async () => {
    const number = normalizedPhone();
    if (!number || busy || Date.now() < retryAt) return;
    const id = ++request;
    busy = true;
    message = undefined;
    render();
    const result = await api.send(number).catch(() => ({ ok: false, reason: "unavailable" } as const));
    if (result.ok || result.reason === "rateLimited") retryAt = Date.now() + 60_000;
    if (id !== request) return;
    busy = false;
    if (result.ok) {
      message = { key: "phoneCodeSent", error: false };
      code.focus();
    } else {
      failure(result.reason, false);
    }
    render();
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy) return;
    const number = normalizedPhone();
    if (!number) return;
    const id = ++request;
    busy = verifying = true;
    message = undefined;
    render();
    const result = await api.verify(number, code.value).catch(() => ({ ok: false, reason: "unavailable" } as const));
    if (id !== request) return;
    busy = verifying = false;
    if (result.ok) {
      const nextCallback = onVerified;
      close();
      onSignedIn(result.value);
      nextCallback?.(result.value);
      return;
    }
    failure(result.reason, true);
    render();
    code.select();
  });

  code.addEventListener("input", () => {
    const digits = code.value.replace(/\D+/g, "").slice(0, 6);
    if (code.value !== digits) code.value = digits;
  });

  cancel.addEventListener("click", () => close(true));
  browser.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    render();
    try {
      const opened = await openBrowser();
      if (opened) close();
    } finally {
      busy = false;
      if (form.isConnected) render();
    }
  });

  return {
    open(slot: HTMLElement, button: HTMLButtonElement, options?: { forPurchase?: boolean; onVerified?: (state: LicenseState) => void }) {
      close();
      trigger = button;
      forPurchase = Boolean(options?.forPurchase);
      onVerified = options?.onVerified;
      slot.append(form);
      refreshLanguage();
      phone.focus();
    },
    close,
    isOpen: () => form.isConnected,
    isVerifying: () => verifying,
    refreshLanguage,
  };
}
