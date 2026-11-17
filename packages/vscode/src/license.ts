import * as vscode from "vscode";
import { YUNFAN_BILLING_ORIGIN } from "@inkmap/core";
import { licenseService, type CheckoutMode, type LicenseService } from "../../cli/src/license";
import { t } from "./i18n";

const KEY = "inkmap.billing.session";

export function extensionLicense(context: vscode.ExtensionContext): LicenseService {
  const app = (vscode.env.appName || "").toLowerCase();
  const host = app.includes("cursor") ? "cursor" : app.includes("windsurf") ? "windsurf" : app.includes("antigravity") ? "antigravity" : "vscode";
  return licenseService({
    read: () => Promise.resolve(context.secrets.get(KEY)),
    write: async token => {
      if (token) await context.secrets.store(KEY, token);
      else await context.secrets.delete(KEY);
    },
  }, () => vscode.workspace.getConfiguration("inkmap").get<string>("billingOrigin")
    || process.env.INKMAP_BILLING_ORIGIN || process.env.INKMAP_DEFAULT_BILLING_ORIGIN || YUNFAN_BILLING_ORIGIN, { host });
}

export async function openCheckout(license: LicenseService, mode: CheckoutMode): Promise<void> {
  const url = await license.connect(mode);
  if (!await vscode.env.openExternal(vscode.Uri.parse(url))) throw new Error(t("checkoutFailed"));
}

export async function offerPro(license: LicenseService): Promise<boolean> {
  const state = await license.state();
  const accountDetail = state.account ? t("accountLine", { account: state.account }) : state.connected ? t("accountConnected") : "";
  if (state.pro) {
    const signOut = t("remove");
    const detail = [t("proActiveDetail"), accountDetail || t("accountConnected")].join("\n");
    const pick = await vscode.window.showInformationMessage("Inkmap Pro", { modal: true, detail }, signOut);
    if (pick === signOut) {
      await license.deactivate();
      vscode.window.showInformationMessage(t("removed"));
    }
    return true;
  }
  const buy = t("buyPro");
  const signIn = t(state.connected ? "switchAccount" : "signIn");
  const detail = accountDetail ? `${accountDetail}\n${t("checkoutHint")}` : t("checkoutHint");
  const pick = await vscode.window.showInformationMessage("Inkmap Pro", { modal: true, detail }, buy, signIn);
  if (pick) {
    try {
      await openCheckout(license, pick === buy ? "buy" : "restore");
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : t("checkoutFailed"));
    }
  }
  return false;
}
