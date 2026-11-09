import { PRODUCT, type ActivateResult, type Ad, type LicenseState, type ProFeature } from "@inkmap/core";
import type { Host } from "./host";
import { locale, t, type I18nKey } from "./i18n";

const FEATURES: (ProFeature | "updates")[] = ["noAds", "browser", "export", "layouts", "themes", "replace", "present", "updates"];
const AD_ROTATE = 45_000;
const AD_SNOOZE = 15 * 60_000;
const AD_DELAY = 1500;
const SNOOZE_KEY = "inkmap.adSnoozedUntil";

const HOUSE_ADS: { key: "export" | "layouts" | "present" }[] = [{ key: "export" }, { key: "layouts" }, { key: "present" }];

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

export interface Pro {
  isPro(): boolean;
  /** True when the feature may be used; otherwise opens the upgrade dialog and returns false. */
  allow(feature: ProFeature): boolean;
  openUpgrade(feature?: ProFeature): void;
  onChange(listener: (state: LicenseState) => void): void;
  /** Pauses ads, e.g. during a presentation. */
  setAdsSuspended(suspended: boolean): void;
}

export async function createPro(host: Host, showToast: (text: string) => void): Promise<Pro> {
  let state = await host.license().catch(() => ({ pro: false }) as LicenseState);
  const listeners: ((s: LicenseState) => void)[] = [];

  // ---- upgrade dialog ----------------------------------------------------

  const dialog = $("#upgrade");
  const list = $(".upgrade-features");
  list.innerHTML = "";
  for (const f of FEATURES) {
    const li = document.createElement("li");
    li.dataset.feature = f;
    li.textContent = t(`feature.${f}` as I18nKey);
    list.append(li);
  }

  const buyLinks = [
    { el: $<HTMLAnchorElement>("#buy-cn"), url: PRODUCT.buyUrlCN, label: t("buyCN", { price: PRODUCT.priceCN }), note: t("buyCNNote") },
    { el: $<HTMLAnchorElement>("#buy-intl"), url: PRODUCT.buyUrlIntl, label: t("buyIntl", { price: PRODUCT.priceIntl }), note: t("buyIntlNote") },
  ];
  if (locale() === "en") buyLinks[1].el.parentElement!.prepend(buyLinks[1].el);
  for (const { el, url, label, note } of buyLinks) {
    el.querySelector("strong")!.textContent = label;
    el.querySelector("span")!.textContent = note;
    if (url) el.href = url;
    else el.classList.add("disabled");
  }
  $(".upgrade-soon").hidden = buyLinks.some(b => b.url);

  const codeInput = $<HTMLInputElement>("#code-input");
  const activateMsg = $("#activate-msg");
  $("#activate-form").addEventListener("submit", async e => {
    e.preventDefault();
    const code = codeInput.value.trim();
    if (!code) return codeInput.focus();
    let result: ActivateResult;
    try {
      result = await host.activate(code);
    } catch (err) {
      activateMsg.dataset.state = "error";
      activateMsg.textContent = t("activateFailed", { error: String(err instanceof Error ? err.message : err) });
      return;
    }
    if (result.ok) {
      activateMsg.dataset.state = "ok";
      activateMsg.textContent = t("activated");
      codeInput.value = "";
      setState(result.state);
      showToast(t("activated"));
    } else {
      activateMsg.dataset.state = "error";
      activateMsg.textContent = t(`reason.${result.reason}` as I18nKey);
    }
  });

  const closeUpgrade = () => (dialog.hidden = true);
  dialog.addEventListener("pointerdown", e => e.target === dialog && closeUpgrade());
  $(".upgrade-close").addEventListener("click", closeUpgrade);
  window.addEventListener("keydown", e => e.key === "Escape" && !dialog.hidden && closeUpgrade());

  function openUpgrade(feature?: ProFeature) {
    const locked = $(".upgrade-locked");
    locked.hidden = !feature || state.pro;
    if (feature) locked.textContent = t("locked", { feature: t(`featureName.${feature}` as I18nKey) });
    list.querySelectorAll<HTMLElement>("li").forEach(li => li.classList.toggle("highlight", li.dataset.feature === feature));
    activateMsg.textContent = "";
    dialog.hidden = false;
    if (!state.pro) codeInput.focus();
  }

  function renderState() {
    document.documentElement.classList.toggle("pro", state.pro);
    const proState = $("#pro-state");
    proState.hidden = !state.pro;
    proState.textContent = state.pro ? t("activeState", { id: state.id ?? "", date: state.issued ?? "" }) : "";
    $("#activate-form").hidden = state.pro;
    $(".upgrade-buy").hidden = state.pro;
    $(".upgrade-soon").hidden = state.pro || buyLinks.some(b => b.url);
    const btn = $("#pro");
    btn.textContent = state.pro ? t("proActive") : t("getPro");
    btn.classList.toggle("active", state.pro);
  }

  function setState(next: LicenseState) {
    state = next;
    renderState();
    updateAds();
    listeners.forEach(fn => fn(state));
  }
  host.onLicenseChange(setState);
  $("#pro").addEventListener("click", e => {
    openUpgrade();
    (e.currentTarget as HTMLElement).blur();
  });

  // ---- ads (free edition) ------------------------------------------------

  const ad = $("#ad");
  const sponsors = (await host.ads().catch(() => [] as Ad[])).filter(a => !a.locale || a.locale === locale());
  const rotation: ({ sponsor: Ad } | { house: (typeof HOUSE_ADS)[number] })[] = [];
  const houses = HOUSE_ADS.map(house => ({ house }));
  for (let i = 0; i < Math.max(sponsors.length, houses.length); i++) {
    if (sponsors[i]) rotation.push({ sponsor: sponsors[i] });
    if (houses[i]) rotation.push(houses[i]);
  }
  let index = Math.floor(Math.random() * rotation.length);
  let suspended = false;
  let ready = false;
  let timer = 0;

  let snoozed = 0;
  const snoozedUntil = () => {
    try {
      return Math.max(snoozed, Number(sessionStorage.getItem(SNOOZE_KEY) ?? 0));
    } catch {
      return snoozed;
    }
  };
  const snooze = () => {
    snoozed = Date.now() + AD_SNOOZE;
    try {
      sessionStorage.setItem(SNOOZE_KEY, String(snoozed));
    } catch {}
  };

  function showAd() {
    const item = rotation[index % rotation.length];
    const cta = ad.querySelector<HTMLAnchorElement>(".ad-cta")!;
    if ("sponsor" in item) {
      ad.querySelector(".ad-title")!.textContent = item.sponsor.title;
      ad.querySelector(".ad-text")!.textContent = item.sponsor.text;
      cta.textContent = item.sponsor.cta ?? "→";
      cta.href = item.sponsor.url;
      cta.onclick = null;
    } else {
      ad.querySelector(".ad-title")!.textContent = t(`house.${item.house.key}.title` as I18nKey);
      ad.querySelector(".ad-text")!.textContent = t(`house.${item.house.key}.text` as I18nKey);
      cta.textContent = t("house.cta");
      cta.removeAttribute("href");
      const feature = item.house.key;
      cta.onclick = e => {
        e.preventDefault();
        openUpgrade(feature);
      };
    }
  }

  function updateAds() {
    clearTimeout(timer);
    const visible = ready && !state.pro && !suspended && Date.now() >= snoozedUntil();
    ad.hidden = !visible;
    if (!visible) {
      if (ready && !state.pro && !suspended) timer = window.setTimeout(updateAds, Math.max(1000, snoozedUntil() - Date.now()));
      return;
    }
    showAd();
    timer = window.setTimeout(() => {
      index++;
      updateAds();
    }, AD_ROTATE);
  }

  ad.querySelector(".ad-hide")!.addEventListener("click", () => {
    snooze();
    updateAds();
  });
  ad.querySelector(".ad-remove")!.addEventListener("click", () => openUpgrade("noAds"));
  setTimeout(() => {
    ready = true;
    updateAds();
  }, AD_DELAY);

  renderState();

  return {
    isPro: () => state.pro,
    allow(feature) {
      if (state.pro) return true;
      openUpgrade(feature);
      return false;
    },
    openUpgrade,
    onChange: fn => listeners.push(fn),
    setAdsSuspended(value) {
      suspended = value;
      updateAds();
    },
  };
}
