import { PRODUCT, type LicenseState, type ProFeature } from "@inkmap/core";
import * as vscode from "vscode";
import { licenseService, type LicenseService } from "../../cli/src/license";
import { isChinese, t } from "./i18n";

const KEY = "inkmap.license";

/** License kept in global state and synced across machines with Settings Sync. */
export function extensionLicense(context: vscode.ExtensionContext): LicenseService {
  context.globalState.setKeysForSync([KEY]);
  return licenseService({
    read: async () => context.globalState.get<string>(KEY),
    write: async code => context.globalState.update(KEY, code),
  });
}

export async function promptForCode(license: LicenseService): Promise<LicenseState | undefined> {
  const code = await vscode.window.showInputBox({ prompt: t("codePrompt"), ignoreFocusOut: true, placeHolder: "INK1-…" });
  if (!code) return;
  const result = await license.activate(code);
  if (!result.ok) {
    vscode.window.showErrorMessage(t(`reason.${result.reason}`));
    return;
  }
  vscode.window.showInformationMessage(t("activated"));
  return result.state;
}

/** Explains Pro and offers the store links; resolves true once the user activates. */
export async function offerPro(license: LicenseService, feature?: ProFeature): Promise<boolean> {
  const state = await license.state();
  if (state.pro) {
    if (!feature) vscode.window.showInformationMessage(t("alreadyPro", { id: state.id ?? "", date: state.issued ?? "" }));
    return true;
  }
  const buyCN = t("buyCN", { price: PRODUCT.priceCN });
  const buyIntl = t("buyIntl", { price: PRODUCT.priceIntl });
  const enter = t("enterCode");
  const buttons = isChinese() ? [buyCN, buyIntl, enter] : [buyIntl, buyCN, enter];
  const detail = t("proPitch", { cn: PRODUCT.priceCN, intl: PRODUCT.priceIntl });
  const pick = await vscode.window.showInformationMessage(feature === "browser" ? t("browserLocked") : "Inkmap Pro", { modal: true, detail }, ...buttons);
  if (pick === enter) return !!(await promptForCode(license));
  const url = pick === buyCN ? PRODUCT.buyUrlCN : pick === buyIntl ? PRODUCT.buyUrlIntl : undefined;
  if (pick && !url) vscode.window.showInformationMessage(t("storeSoon"));
  if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
  return false;
}
