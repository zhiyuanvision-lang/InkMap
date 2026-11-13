import type { LicenseState, WechatOrderResult } from "@inkmap/core";
import { applyI18n, locale, t } from "./i18n";

export interface WechatPayData {
  qr: string;
  amountFen: number;
  expiresAt?: string;
}

export function createWechatPay(
  orderPro: () => Promise<WechatOrderResult>,
  getAccount: () => string | undefined,
  onPaid: (state: LicenseState) => void,
  openBrowser: () => Promise<void>,
) {
  const template = document.querySelector<HTMLTemplateElement>("#wechat-pay-template")!;
  const view = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
  const accountEl = view.querySelector<HTMLElement>("#wechat-pay-account")!;
  const amountEl = view.querySelector<HTMLElement>("#wechat-pay-amount")!;
  const qrImg = view.querySelector<HTMLImageElement>("#wechat-pay-qr")!;
  const expiredBox = view.querySelector<HTMLElement>("#wechat-pay-expired")!;
  const refreshBtn = view.querySelector<HTMLButtonElement>("#refresh-wechat-pay")!;
  const expiresEl = view.querySelector<HTMLElement>("#wechat-pay-expires")!;
  const browserBtn = view.querySelector<HTMLButtonElement>("#wechat-pay-browser")!;
  const closeBtn = view.querySelector<HTMLButtonElement>("#close-wechat-pay")!;

  let current: WechatPayData | undefined;
  let trigger: HTMLElement | undefined;
  let pollTimer = 0;
  let expiryTimer = 0;
  let session = 0;
  let refreshing = false;

  function render() {
    if (!current) return;
    amountEl.textContent = "¥" + (current.amountFen / 100).toFixed(2);
    const account = getAccount();
    accountEl.hidden = !account;
    if (account) accountEl.textContent = t("wechatPayAccount", { account });
    if (qrImg.getAttribute("src") !== current.qr) qrImg.src = current.qr;
    const expiryMs = current.expiresAt ? Date.parse(current.expiresAt) : NaN;
    const isExpired = Number.isFinite(expiryMs) && expiryMs <= Date.now();
    expiredBox.hidden = !isExpired;
    refreshBtn.disabled = refreshing;
    if (isExpired) {
      expiresEl.textContent = t("wechatPayExpired");
    } else if (Number.isFinite(expiryMs)) {
      const time = new Intl.DateTimeFormat(locale() === "zh" ? "zh-CN" : "en-US", {
        hour: "2-digit",
        minute: "2-digit",
      }).format(expiryMs);
      expiresEl.textContent = t("wechatPayWaiting", { time });
    } else {
      expiresEl.textContent = t("wechatPayWaitingSimple");
    }
  }

  function scheduleTimers() {
    window.clearTimeout(pollTimer);
    window.clearTimeout(expiryTimer);
    if (!view.isConnected || !current) return;
    const id = session;
    const expiryMs = current.expiresAt ? Date.parse(current.expiresAt) : NaN;
    if (Number.isFinite(expiryMs)) {
      const remain = expiryMs - Date.now();
      if (remain <= 0) {
        render();
        return;
      }
      expiryTimer = window.setTimeout(() => {
        if (id === session) render();
      }, remain + 50);
    }
    pollTimer = window.setTimeout(async () => {
      if (id !== session || !view.isConnected) return;
      try {
        const res = await orderPro();
        if (id !== session || !view.isConnected) return;
        if (res.status === "active") {
          close();
          onPaid(res.state);
          return;
        }
        if (res.status === "qr") {
          current = res;
          render();
        }
      } catch {}
      if (id === session && view.isConnected) scheduleTimers();
    }, 4000);
  }

  function refreshLanguage() {
    applyI18n(view);
    closeBtn.setAttribute("aria-label", t("close"));
    render();
  }

  function close(restoreFocus = false) {
    if (!view.isConnected) return;
    session++;
    window.clearTimeout(pollTimer);
    window.clearTimeout(expiryTimer);
    view.remove();
    current = undefined;
    refreshing = false;
    if (restoreFocus && trigger?.getClientRects().length) trigger.focus();
    trigger = undefined;
  }

  refreshBtn.addEventListener("click", async () => {
    if (refreshing) return;
    const id = ++session;
    refreshing = true;
    render();
    try {
      const res = await orderPro();
      if (id !== session || !view.isConnected) return;
      if (res.status === "active") {
        close();
        onPaid(res.state);
        return;
      }
      if (res.status === "qr") current = res;
    } catch {} finally {
      if (id === session) {
        refreshing = false;
        render();
        scheduleTimers();
      }
    }
  });

  closeBtn.addEventListener("click", () => close(true));
  browserBtn.addEventListener("click", () => {
    close();
    void openBrowser();
  });

  return {
    open(slot: HTMLElement, button: HTMLElement | undefined, data: WechatPayData) {
      close();
      session++;
      trigger = button;
      current = data;
      slot.append(view);
      refreshLanguage();
      scheduleTimers();
      closeBtn.focus();
    },
    close,
    isOpen: () => view.isConnected,
    refreshLanguage,
  };
}
