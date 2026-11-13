import { hasAccess, trialDaysLeft, type LicenseState, type ProFeature } from "@inkmap/core";
import type { Host } from "./host";
import { locale, t, type I18nKey } from "./i18n";
import { createPhoneSignIn } from "./phone-sign-in";
import { createWechatPay } from "./wechat-pay";

const FEATURES: (ProFeature | "updates" | "markdown" | "diagram")[] = ["markdown", "diagram", "browser", "export", "layouts", "themes", "replace", "present", "updates"];
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

export interface Pro {
  isPro(): boolean;
  /** True when the feature may be used; otherwise opens the upgrade dialog and returns false. */
  allow(feature: ProFeature): boolean;
  openUpgrade(feature?: ProFeature): void;
  onChange(listener: (state: LicenseState) => void): void;
  refreshLanguage(): void;
}

export async function createPro(host: Host, showToast?: (text: string) => void): Promise<Pro> {
  let state: LicenseState = { pro: false };
  const listeners: ((s: LicenseState) => void)[] = [];
  let expiryTimer = 0;

  const proBtn = $<HTMLButtonElement>("#pro");
  const account = $("#account");
  const panel = $("#account-panel");
  const badge = $("#account-badge");
  const accountHeading = $("#account-heading");
  const accountText = $("#account-text");
  const planStatus = $("#account-plan-status");
  const planTitle = $("#account-plan-title");
  const planDetail = $("#account-plan-detail");
  const accountPerks = $("#account-perks");
  const accountPerksMore = $<HTMLButtonElement>("#account-perks-more");
  const accountActions = $("#account-actions");
  const accountMsg = $("#account-message");
  const accountBuy = $<HTMLButtonElement>("#account-buy");
  const signIn = $<HTMLButtonElement>("#account-sign-in");
  const switchAccount = $<HTMLButtonElement>("#switch-account");
  const signOutBtn = $<HTMLButtonElement>("#sign-out");

  const dialog = $("#upgrade");
  const toolbar = $("#bar");
  const card = dialog.querySelector<HTMLElement>(".upgrade-card")!;
  const checkoutMsg = $("#checkout-msg");
  const buy = $<HTMLButtonElement>("#buy-pro");
  const upgradeSignIn = $<HTMLButtonElement>("#upgrade-sign-in");
  const upgradeActions = $("#upgrade-account-actions");
  const upgradeAccount = $("#upgrade-account");
  const upgradeSwitch = $<HTMLButtonElement>("#upgrade-switch-account");
  const upgradeSignOut = $<HTMLButtonElement>("#upgrade-sign-out");
  const trialStatus = $("#trial-status");
  const expiredMessage = $("#trial-expired-message");
  const closeButton = $(".upgrade-close");
  const list = $(".upgrade-features");
  const canBuy = host.capabilities.account === "purchase";
  const canSignIn = host.capabilities.account !== "none";
  const actions = [accountBuy, signIn, switchAccount, signOutBtn, buy, upgradeSignIn, upgradeSwitch, upgradeSignOut];
  let busy = false;
  let upgradeTrigger: HTMLElement | null = null;
  const signedIn = () => Boolean(state.connected || state.pro || state.account);
  const focusAction = () => [buy, upgradeSignIn, upgradeSwitch].find(button => button.getClientRects().length && !button.disabled) ?? card;
  const phoneSignIn = host.phoneSignIn && createPhoneSignIn(host.phoneSignIn, next => {
    setState(next);
    if (!panel.hidden) proBtn.focus();
    else if (!dialog.hidden) focusAction().focus();
  }, () => checkout("restore", dialog.hidden || !panel.hidden ? accountMsg : checkoutMsg));
  const wechatPay = host.orderPro && createWechatPay(
    () => host.orderPro!(),
    () => state.account,
    next => {
      setState(next);
      showToast?.(t("proUnlocked"));
    },
    () => checkout("buy", dialog.hidden || !panel.hidden ? accountMsg : checkoutMsg),
  );
  card.tabIndex = -1;
  list.hidden = !canBuy;

  function refreshFeatures() {
    for (const f of FEATURES) {
      let li = list.querySelector<HTMLElement>(`[data-feature="${f}"]`);
      if (!li) { li = document.createElement("li"); li.dataset.feature = f; list.append(li); }
      li.textContent = t(`feature.${f}` as I18nKey);
    }
  }
  function localizeMembership() {
    if (!canBuy) {
      $("#upgrade-title").textContent = t("accountHeading");
      $(".upgrade-sub").textContent = t(canSignIn ? "accountSync" : "accountUnavailable");
    }
  }
  refreshFeatures();
  localizeMembership();

  function setBusy(next: boolean) {
    busy = next;
    for (const button of actions) button.disabled = next;
  }

  function showMessage(target: HTMLElement, text: string, status: "buy" | "signIn" | "error") {
    target.textContent = text;
    target.dataset.state = status;
    target.hidden = false;
  }

  async function checkout(mode: "buy" | "restore", message: HTMLElement) {
    if (busy || phoneSignIn?.isVerifying() || (mode === "buy" ? !canBuy : !canSignIn)) return;
    const trigger = document.activeElement;
    setBusy(true);
    message.hidden = true;
    try {
      await host.checkout(mode);
      if (mode === "buy" ? !state.pro : !signedIn()) {
        showMessage(message, t(mode === "buy" ? "checkoutOpened" : "signInOpened"), mode === "buy" ? "buy" : "signIn");
      }
    } catch (error) {
      const raw = String(error instanceof Error ? error.message : error);
      const key = mode === "restore" ? "signInFailed" : "checkoutFailed";
      const prefix = t(key, { error: "" }).replace(/[：:\s]+$/, "");
      showMessage(message, raw.startsWith(prefix) ? raw : t(key, { error: raw }), "error");
    } finally {
      setBusy(false);
      if (trigger instanceof HTMLElement && trigger.getClientRects().length &&
          (document.activeElement === document.body || document.activeElement === card)) trigger.focus();
    }
  }

  async function signOut(message: HTMLElement) {
    if (busy || phoneSignIn?.isVerifying() || !canSignIn) return;
    phoneSignIn?.close();
    wechatPay?.close();
    setBusy(true);
    message.hidden = true;
    try {
      await host.signOut();
      const next = await host.license().catch(() => ({ pro: false, trialUntil: state.trialUntil }));
      setState(next);
      showToast?.(t("signedOut"));
    } catch (error) {
      showMessage(message, t("signOutFailed", { error: String(error instanceof Error ? error.message : error) }), "error");
    } finally {
      setBusy(false);
      if (!signedIn()) (dialog.hidden ? signIn : upgradeSignIn).focus();
    }
  }

  function openSignIn(button: HTMLButtonElement, slot: string, message: HTMLElement) {
    if (busy || phoneSignIn?.isVerifying()) return;
    wechatPay?.close();
    if (phoneSignIn) {
      message.hidden = true;
      phoneSignIn.open($(slot), button);
    } else void checkout("restore", message);
  }

  async function startBuy(button: HTMLButtonElement, slot: string, message: HTMLElement, afterVerify = false) {
    if (busy || phoneSignIn?.isVerifying() || !canBuy) return;
    if (!host.orderPro) return checkout("buy", message);
    setBusy(true);
    message.hidden = true;
    try {
      const result = await host.orderPro();
      if (result.status === "active") {
        setState(result.state);
        showToast?.(t("proUnlocked"));
        return;
      }
      if (result.status === "qr") {
        phoneSignIn?.close();
        wechatPay?.open($(slot), button, result);
        return;
      }
      if (result.status === "needsPhone" && phoneSignIn) {
        if (afterVerify) {
          phoneSignIn.close();
          showMessage(message, t("checkoutFailed", { error: t("signInPageUnavailable") }), "error");
          return;
        }
        wechatPay?.close();
        phoneSignIn.open($(slot), button, {
          forPurchase: true,
          onVerified: verified => {
            if (!verified.pro) void startBuy(button, slot, message, true);
          },
        });
        return;
      }
      if (result.status === "redirect") {
        showMessage(message, t("checkoutOpened"), "buy");
        return;
      }
    } catch (error) {
      const raw = String(error instanceof Error ? error.message : error);
      const prefix = t("checkoutFailed", { error: "" }).replace(/[：:\s]+$/, "");
      showMessage(message, raw.startsWith(prefix) ? raw : t("checkoutFailed", { error: raw }), "error");
    } finally {
      setBusy(false);
    }
  }

  accountBuy.addEventListener("click", () => void startBuy(accountBuy, "#account-phone-slot", accountMsg));
  accountPerksMore.addEventListener("click", () => openUpgrade());
  signIn.addEventListener("click", () => openSignIn(signIn, "#account-phone-slot", accountMsg));
  switchAccount.addEventListener("click", () => openSignIn(switchAccount, "#account-phone-slot", accountMsg));
  signOutBtn.addEventListener("click", () => void signOut(accountMsg));
  buy.addEventListener("click", () => void startBuy(buy, "#upgrade-phone-slot", checkoutMsg));
  upgradeSignIn.addEventListener("click", () => openSignIn(upgradeSignIn, "#upgrade-phone-slot", checkoutMsg));
  upgradeSwitch.addEventListener("click", () => openSignIn(upgradeSwitch, "#upgrade-phone-slot", checkoutMsg));
  upgradeSignOut.addEventListener("click", () => void signOut(checkoutMsg));

  function setPanel(open: boolean, focus = false) {
    if (panel.hidden === !open) return;
    if (!open && panel.querySelector(".phone-sign-in") && phoneSignIn?.isVerifying()) return;
    panel.hidden = !open;
    if (!open && panel.querySelector(".phone-sign-in")) phoneSignIn?.close();
    if (!open && panel.querySelector(".wechat-pay")) wechatPay?.close();
    proBtn.setAttribute("aria-expanded", String(open));
    if (!open && focus) proBtn.focus();
  }
  proBtn.addEventListener("click", () => setPanel(Boolean(panel.hidden)));
  document.addEventListener("pointerdown", event => {
    if (event.target instanceof Node && !account.contains(event.target)) setPanel(false);
  });
  account.addEventListener("focusout", event => {
    if (event.relatedTarget instanceof Node && !account.contains(event.relatedTarget)) setPanel(false);
  });

  function closeUpgrade() {
    if (!hasAccess(state) || dialog.hidden || card.querySelector(".phone-sign-in") && phoneSignIn?.isVerifying()) return;
    if (card.querySelector(".phone-sign-in")) phoneSignIn?.close();
    if (card.querySelector(".wechat-pay")) wechatPay?.close();
    dialog.hidden = true;
    updateModalAccessibility(true);
    (upgradeTrigger?.getClientRects().length ? upgradeTrigger : proBtn).focus();
    upgradeTrigger = null;
  }
  window.addEventListener("keydown", event => {
    if (event.key === "Escape" && wechatPay?.isOpen()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      wechatPay.close(true);
      return;
    }
    if (event.key === "Escape" && phoneSignIn?.isOpen()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!phoneSignIn.isVerifying()) phoneSignIn.close(true);
      return;
    }
    if (event.key === "Escape" && !panel.hidden) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setPanel(false, true);
      return;
    }
    if (dialog.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeUpgrade();
      return;
    }
    const blocked = !hasAccess(state);
    if (!(event.target instanceof Node && (dialog.contains(event.target) || blocked && account.contains(event.target)))) {
      event.preventDefault();
      focusAction().focus();
    }
    if (event.key === "Tab") {
      const selector = "button:not(:disabled), input:not(:disabled), select";
      const controls = [...(blocked ? account.querySelectorAll<HTMLElement>(selector) : []),
        ...card.querySelectorAll<HTMLElement>(selector)].filter(el => el.getClientRects().length > 0);
      const edge = event.shiftKey ? controls[0] : controls.at(-1);
      if (edge && (document.activeElement === edge || document.activeElement === card)) {
        event.preventDefault();
        (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
      }
    }
    event.stopImmediatePropagation();
  }, true);
  dialog.addEventListener("pointerdown", e => e.target === dialog && closeUpgrade());
  closeButton.addEventListener("click", closeUpgrade);

  function updateModalAccessibility(accessible: boolean) {
    card.setAttribute("aria-modal", String(accessible));
    for (const child of document.body.children) {
      if (child instanceof HTMLElement && child !== dialog && child.tagName !== "SCRIPT") {
        child.inert = !dialog.hidden && (accessible || child !== toolbar);
      }
    }
  }

  function openUpgrade(feature?: ProFeature) {
    const accessible = hasAccess(state);
    const verifying = phoneSignIn?.isVerifying();
    if (state.pro || (accessible && (verifying || !canBuy))) return;
    if (dialog.hidden) upgradeTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPanel(false);
    const locked = $(".upgrade-locked");
    locked.hidden = !feature || accessible;
    if (feature) locked.textContent = t("locked", { feature: t(`featureName.${feature}` as I18nKey) });
    list.querySelectorAll<HTMLElement>("li").forEach(li => li.classList.toggle("highlight", li.dataset.feature === feature));
    checkoutMsg.hidden = true;
    dialog.hidden = false;
    updateModalAccessibility(accessible);
    if (!verifying) focusAction().focus();
  }

  function renderState() {
    clearTimeout(expiryTimer);
    const now = Date.now();
    const accessible = hasAccess(state, now);
    document.documentElement.classList.toggle("trial-expired", !accessible);
    document.documentElement.classList.toggle("pro", accessible);
    document.documentElement.classList.toggle("pro-member", state.pro);

    const days = trialDaysLeft(state, now);
    const trial = !state.pro && accessible;
    const status = t(state.pro ? "proBadge" : trial ? "trialBadge" : "trialEnded", { days });
    const trialDate = trial
      ? new Intl.DateTimeFormat(locale() === "zh" ? "zh-CN" : "en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }).format(state.trialUntil!)
      : "";
    const trialEnd = trial ? t("trialUntil", { date: trialDate }) : "";
    badge.textContent = status;
    proBtn.setAttribute("aria-label", `${t("accountHeading")} · ${status}`);
    proBtn.hidden = false;
    account.dataset.plan = state.pro ? "pro" : !trial || days <= 2 ? "ending" : "trial";
    account.dataset.signedIn = String(signedIn());
    accountText.textContent = state.account || t(signedIn() ? "accountConnected" : "accountSignedOut");
    accountHeading.textContent = t(signedIn() ? "accountHeading" : "accountSignedOutSub");
    planStatus.hidden = trial && canBuy;
    planTitle.textContent = t(state.pro ? "proActive" : trial ? "trialPlan" : "trialEnded");
    planDetail.textContent = state.pro ? t("proActiveDetail") : trial ? trialEnd : t("noProOnAccount");
    accountBuy.hidden = !canBuy || state.pro;
    accountPerks.hidden = accountPerksMore.hidden = !canBuy || state.pro;
    for (const button of [signIn, upgradeSignIn]) button.textContent = t(phoneSignIn ? "phoneSignIn" : "signIn");
    signIn.hidden = !canSignIn || signedIn();
    accountActions.hidden = !canSignIn || !signedIn();
    if (!canSignIn && !state.pro) showMessage(accountMsg, t("accountUnavailable"), "signIn");

    if (trial) {
      const wait = Math.min(Math.max(50, state.trialUntil! - now + 25), 60 * 60 * 1000);
      expiryTimer = window.setTimeout(() => {
        renderState();
        listeners.forEach(fn => fn(state));
      }, wait);
    }
    closeButton.hidden = !accessible;
    trialStatus.hidden = !trial;
    trialStatus.textContent = trialEnd;
    expiredMessage.hidden = accessible;
    expiredMessage.textContent = t(canBuy ? (signedIn() ? "trialExpiredSignedIn" : "trialExpired")
      : !canSignIn ? "trialExpiredNoAccount" : signedIn() ? "trialExpiredNoPro" : "trialExpiredSignIn");
    buy.hidden = !canBuy || state.pro;
    upgradeSignIn.hidden = !canSignIn || signedIn();
    upgradeActions.hidden = accessible || !canSignIn || !signedIn();
    upgradeAccount.hidden = upgradeActions.hidden;
    upgradeAccount.textContent = state.account || t("accountConnected");
    $(".upgrade-buy").hidden = buy.hidden && upgradeSignIn.hidden;
    updateModalAccessibility(accessible);
    if (state.pro) closeUpgrade();
    else if (!accessible && dialog.hidden) openUpgrade();
  }

  function setState(next: LicenseState) {
    const wasSignedIn = signedIn();
    const wasPro = state.pro;
    state = next;
    if (state.pro && wechatPay?.isOpen()) {
      wechatPay.close();
      if (!wasPro) showToast?.(t("proUnlocked"));
    }
    renderState();
    if (!wasSignedIn && signedIn()) {
      for (const message of [accountMsg, checkoutMsg]) {
        if (message.dataset.state === "signIn") message.hidden = true;
      }
      if (!panel.hidden && document.activeElement === document.body) proBtn.focus();
      if (!dialog.hidden && panel.hidden && !card.contains(document.activeElement)) focusAction().focus();
    }
    listeners.forEach(fn => fn(state));
  }

  let receivedUpdate = false;
  host.onLicenseChange(next => {
    receivedUpdate = true;
    setState(next);
  });
  const initial = await host.license().catch(() => state);
  if (!receivedUpdate) setState(initial);

  return {
    isPro: () => hasAccess(state),
    allow(feature) {
      if (hasAccess(state)) return true;
      openUpgrade(feature);
      return false;
    },
    openUpgrade,
    onChange: fn => listeners.push(fn),
    refreshLanguage() {
      refreshFeatures();
      localizeMembership();
      phoneSignIn?.refreshLanguage();
      wechatPay?.refreshLanguage();
      renderState();
    },
  };
}
