import type { LicenseState, WechatOrderResult } from "@inkmap/core";
import { applyI18n, locale, t } from "./i18n";

type PaymentData =
  | { mode?: "qr"; qr: string; amountFen: number; expiresAt?: string }
  | { mode: "card"; url: string; amountCents?: number };

function formatRmb(fen: number): string {
  return fen % 10 === 0 ? "¥" + (fen / 100).toFixed(1) : "¥" + (fen / 100).toFixed(2);
}

function formatUsd(cents = 1500): string {
  return cents % 100 === 0 ? "$" + String(cents / 100) : "$" + (cents / 100).toFixed(2);
}

export function createWechatPay(
  orderPro: () => Promise<WechatOrderResult>,
  checkLicense: () => Promise<LicenseState>,
  getAccount: () => string | undefined,
  onPaid: (state: LicenseState) => void,
  openCardUrl: (url: string) => void,
) {
  const template = document.querySelector<HTMLTemplateElement>("#wechat-pay-template")!;
  const view = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
  const titleEl = view.querySelector<HTMLElement>("#wechat-pay-title")!;
  const subEl = view.querySelector<HTMLElement>(".wechat-pay-sub")!;
  const accountEl = view.querySelector<HTMLElement>("#wechat-pay-account")!;
  const amountEl = view.querySelector<HTMLElement>("#wechat-pay-amount")!;
  const qrStage = view.querySelector<HTMLElement>("#wechat-pay-stage")!;
  const qrImg = view.querySelector<HTMLImageElement>("#wechat-pay-qr")!;
  const expiredBox = view.querySelector<HTMLElement>("#wechat-pay-expired")!;
  const refreshBtn = view.querySelector<HTMLButtonElement>("#refresh-wechat-pay")!;
  const cardStage = view.querySelector<HTMLElement>("#card-pay-stage")!;
  const cardBtn = view.querySelector<HTMLButtonElement>("#card-pay-btn")!;
  const expiresEl = view.querySelector<HTMLElement>("#wechat-pay-expires")!;
  const closeBtn = view.querySelector<HTMLButtonElement>("#close-wechat-pay")!;

  let current: PaymentData | undefined;
  let trigger: HTMLElement | undefined;
  let pollTimer = 0;
  let expiryTimer = 0;
  let session = 0;
  let refreshing = false;

  function render() {
    if (!current) return;
    const isCard = current.mode === "card";
    view.dataset.mode = isCard ? "card" : "qr";
    titleEl.textContent = t(isCard ? "cardPayTitle" : "wechatPayTitle");
    subEl.textContent = t(isCard ? "cardPaySub" : "wechatPaySub");
    const account = getAccount();
    accountEl.hidden = !account;
    if (account) accountEl.textContent = t("wechatPayAccount", { account });

    if (current.mode === "card") {
      amountEl.textContent = formatUsd(current.amountCents ?? 1500);
      qrStage.hidden = true;
      cardStage.hidden = false;
      cardBtn.textContent = t("cardPayBtn");
      expiresEl.textContent = t("cardPayWaiting");
      return;
    }

    amountEl.textContent = formatRmb(current.amountFen);
    qrStage.hidden = false;
    cardStage.hidden = true;
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
    if (current.mode !== "card") {
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
    }
    pollTimer = window.setTimeout(async () => {
      if (id !== session || !view.isConnected || !current) return;
      try {
        if (current.mode === "card") {
          const next = await checkLicense();
          if (id !== session || !view.isConnected) return;
          if (next.pro) {
            close();
            onPaid(next);
            return;
          }
        } else {
          const res = await orderPro();
          if (id !== session || !view.isConnected) return;
          if (res.status === "active") {
            close();
            onPaid(res.state);
            return;
          }
          if (res.status === "qr" && locale() === "zh") {
            current = { mode: "qr", ...res };
            render();
          }
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
      if (res.status === "qr" && locale() === "zh") current = { mode: "qr", ...res };
    } catch {} finally {
      if (id === session) {
        refreshing = false;
        render();
        scheduleTimers();
      }
    }
  });

  cardBtn.addEventListener("click", () => {
    if (current?.mode === "card") openCardUrl(current.url);
  });

  closeBtn.addEventListener("click", () => close(true));

  return {
    open(slot: HTMLElement, button: HTMLElement | undefined, data: PaymentData) {
      close();
      session++;
      trigger = button;
      current = data;
      slot.append(view);
      refreshLanguage();
      scheduleTimers();
      (data.mode === "card" ? cardBtn : closeBtn).focus();
    },
    close,
    isOpen: () => view.isConnected,
  };
}
