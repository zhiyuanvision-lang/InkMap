import * as vscode from "vscode";
import { YUNFAN_BILLING_ORIGIN } from "@inkmap/core";
import { licenseService, type CheckoutMode, type LicenseService } from "../../cli/src/license";
import { t } from "./i18n";

const KEY = "inkmap.billing.session";

export function extensionLicense(context: vscode.ExtensionContext): LicenseService {
  const app = (vscode.env.appName || "").toLowerCase();
  const host = app.includes("cursor")
    ? "cursor"
    : app.includes("windsurf")
      ? "windsurf"
      : app.includes("trae")
        ? "trae"
        : app.includes("qoder")
          ? "qoder"
          : app.includes("antigravity")
            ? "antigravity"
            : "vscode";
  return licenseService({
    read: () => Promise.resolve(context.secrets.get(KEY)),
    write: async token => {
      if (token) await context.secrets.store(KEY, token);
      else await context.secrets.delete(KEY);
    },
  }, () => vscode.workspace.getConfiguration("inkmap").get<string>("billingOrigin")
    || process.env.INKMAP_BILLING_ORIGIN || process.env.INKMAP_DEFAULT_BILLING_ORIGIN || YUNFAN_BILLING_ORIGIN, { host });
}

export async function openCheckout(license: LicenseService, mode: CheckoutMode, localeHint?: string): Promise<void> {
  const url = await license.connect(mode, localeHint);
  if (!await vscode.env.openExternal(vscode.Uri.parse(url))) throw new Error(t("checkoutFailed"));
}
