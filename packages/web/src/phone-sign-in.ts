import type { LicenseState, PhoneSignInError } from "@inkmap/core";
import type { Host } from "./host";
import { applyI18n, t } from "./i18n";

export function createPhoneSignIn(
  api: NonNullable<Host["phoneSignIn"]>,
  onSignedIn: (state: LicenseState) => void,
  magicLinkMode = false,
) {
  const template = document.querySelector<HTMLTemplateElement>("#phone-sign-in-template")!;
  const form = template.content.firstElementChild!.cloneNode(true) as HTMLFormElement;
  const title = form.querySelector<HTMLElement>("#phone-sign-in-title")!;
  const subtitle = form.querySelector<HTMLElement>(".phone-sign-in-sub")!;
  const phone = form.querySelector<HTMLInputElement>("#sign-in-phone")!;
  const code = form.querySelector<HTMLInputElement>("#sign-in-code")!;
  const send = form.querySelector<HTMLButtonElement>("#send-phone-code")!;
  const submit = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
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
  let lastAutoSubmitted = "";
  let lastNotProKey = "";
  let message: { key: Parameters<typeof t>[0]; error: boolean } | undefined;

  function render() {
    window.clearTimeout(timer);
    const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    title.textContent = t(forPurchase ? "phoneSignInForPay" : "phoneSignIn");
    subtitle.textContent = t(forPurchase ? "phoneSignInForPaySub" : "phoneSignInSub");
    submit.textContent = t(forPurchase ? "phoneVerifyAndPay" : "phoneVerifySubmit");
    send.textContent = seconds ? t("resendPhoneCode", { seconds }) : t("sendPhoneCode");
    send.disabled = busy || seconds > 0;
    submit.disabled = busy;
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
    lastAutoSubmitted = "";
    lastNotProKey = "";
    message = undefined;
    if (restoreFocus) trigger?.focus();
    trigger = undefined;
  }

  function failure(reason: PhoneSignInError, isVerify: boolean) {
    if (reason === "rateLimited") retryAt = Date.now() + 60_000;
    message = {
      key: reason === "rateLimited" ? "phoneRateLimited" : reason === "unavailable" ? "phoneSignInUnavailable"
        : reason === "notPro" ? "phoneNotPro" : isVerify ? "phoneCodeInvalid" : "phoneInvalid",
      error: true,
    };
  }

  function normalizedPhone(silent = false) {
    const raw = phone.value.normalize("NFKC").trim();
    if (raw.includes("@")) {
      const email = raw.toLowerCase();
      if (email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email;
      if (!silent) {
        failure("invalid", false);
        render();
        phone.focus();
      }
      return;
    }
    const number = raw.replace(/[\s\-–‑]/g, "").replace(/^(?:\+86|0086|86(?=1\d{10}$))/, "");
    if (/^1[3-9]\d{9}$/.test(number)) return number;
    if (!silent) {
      failure("invalid", false);
      render();
      phone.focus();
    }
  }

  async function verifyCode(silentPhoneCheck = false) {
    if (busy) return;
    const number = normalizedPhone(silentPhoneCheck);
    if (!number) return;
    const digits = code.value.replace(/\D+/g, "").slice(0, 6);
    if (digits.length !== 6) {
      if (!silentPhoneCheck) {
        failure("invalid", true);
        render();
        code.focus();
      }
      return;
    }
    const key = `${number}:${digits}`;
    if (!silentPhoneCheck && key === lastNotProKey) {
      failure("notPro", true);
      render();
      return;
    }
    const id = ++request;
    busy = verifying = true;
    message = undefined;
    render();
    const result = await api.verify(number, digits).catch(() => ({ ok: false, reason: "unavailable" } as const));
    if (id !== request) return;
    busy = verifying = false;
    if (result.ok) {
      lastNotProKey = "";
      const nextCallback = onVerified;
      close();
      onSignedIn(result.value);
      nextCallback?.(result.value);
      return;
    }
    lastNotProKey = result.reason === "notPro" ? key : "";
    failure(result.reason, true);
    render();
    code.select();
  }

  send.addEventListener("click", async () => {
    const number = normalizedPhone();
    if (!number || busy || Date.now() < retryAt) return;
    const id = ++request;
    busy = true;
    lastAutoSubmitted = "";
    lastNotProKey = "";
    message = undefined;
    render();
    const result = await api.send(number).catch(() => ({ ok: false, reason: "unavailable" } as const));
    if (result.ok || result.reason === "rateLimited") retryAt = Date.now() + 60_000;
    if (id !== request) return;
    busy = false;
    if (result.ok) {
      const useMagicHint = magicLinkMode && !forPurchase && number.includes("@");
      message = { key: useMagicHint ? "phoneCodeSentMagic" : "phoneCodeSent", error: false };
      code.focus();
    } else {
      failure(result.reason, false);
    }
    render();
  });

  form.addEventListener("submit", event => {
    event.preventDefault();
    void verifyCode(false);
  });

  submit.addEventListener("click", event => {
    event.preventDefault();
    void verifyCode(false);
  });

  phone.addEventListener("input", () => {
    lastAutoSubmitted = "";
  });

  code.addEventListener("input", () => {
    const digits = code.value.replace(/\D+/g, "").slice(0, 6);
    if (code.value !== digits) code.value = digits;
    if (digits.length < 6) {
      lastAutoSubmitted = "";
      return;
    }
    const key = `${phone.value.trim()}:${digits}`;
    if (digits.length === 6 && !busy && key !== lastAutoSubmitted && normalizedPhone(true)) {
      lastAutoSubmitted = key;
      void verifyCode(true);
    }
  });

  cancel.addEventListener("click", () => close(true));

  return {
    /** Shows the form in `slot`; `prefill` is the address last used on this computer, ready to send a code to. */
    open(slot: HTMLElement, button: HTMLButtonElement, options?: {
      forPurchase?: boolean;
      onVerified?: (state: LicenseState) => void;
      prefill?: string;
      /** False where the form is the only way forward (a login-only paywall), so it has no close button. */
      closable?: boolean;
    }) {
      close();
      trigger = button;
      cancel.hidden = options?.closable === false;
      forPurchase = Boolean(options?.forPurchase);
      onVerified = options?.onVerified;
      if (options?.prefill) phone.value = options.prefill;
      slot.append(form);
      refreshLanguage();
      // With the address filled in, sending the code is the one remaining step.
      (options?.prefill && !send.disabled ? send : phone).focus();
    },
    close,
    isOpen: () => form.isConnected,
    isVerifying: () => verifying,
  };
}
