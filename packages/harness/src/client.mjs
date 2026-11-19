import { createElement as h, useEffect, useRef, useState } from "react";
import { billingFlowUrl, YUNFAN_BILLING_ORIGIN } from "@inkmap/core";
import { actionSlot, bodySlot, fileAddress, kind, packageName, route, selectedFile } from "./shared.mjs";

export const inject = ["slots", "sidebarRight", "sidebarRightTabs"];

const zh = () => {
  const docLang = typeof document !== "undefined" ? document.documentElement?.lang || "" : "";
  const navLang = typeof navigator !== "undefined" ? navigator.language || "" : "";
  if (/^zh(?:[-_.]|$)/i.test(docLang || navLang)) return true;
  try {
    const opts = Intl.DateTimeFormat().resolvedOptions();
    if (/^zh(?:[-_.]|$)/i.test(opts.locale || "")) return true;
    if (/^(Asia\/(Shanghai|Chongqing|Chungking|Harbin|Urumqi|Beijing)|PRC)$/i.test(opts.timeZone || "")) return true;
  } catch {}
  return false;
};
const label = () => zh() ? "用 Inkmap 打开" : "Open in Inkmap";
const desktop = () => location.protocol === "dsh-app:" && location.hostname === "app";
const actionClass = "inkmap-harness-open";
const LEASE_RENEW_MS = 5 * 60_000;
const request = (method, body) => fetch(route, {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  keepalive: method === "DELETE",
});

export function apply(ctx) {
  const sessions = new Map();

  function session(tab) {
    if (sessions.has(tab.signal)) return sessions.get(tab.signal).opened;
    if (tab.signal.aborted) return Promise.reject(new Error("Closed Inkmap tab"));
    const opened = request("POST", { address: tab.contentId }).then(async response => {
      if (!response.ok) throw new Error("Inkmap file is unavailable");
      const data = await response.json();
      if (typeof data.lease !== "string" || typeof data.url !== "string" ||
          !/^http:\/\/127\.0\.0\.1:\d+\/s\/[a-f0-9]{48}\/$/.test(data.url)) {
        throw new Error("Invalid Inkmap editor address");
      }
      return data;
    });
    // Tells the host this tab is still open; a tab that stops renewing (a crashed renderer) is released for it.
    const renewal = setInterval(() => {
      void opened.then(({ lease }) => request("POST", { action: "renew", lease })).catch(() => {});
    }, LEASE_RENEW_MS);
    void opened.catch(() => {
      clearInterval(renewal);
      tab.signal.removeEventListener("abort", release);
      sessions.delete(tab.signal);
    });
    function release() {
      clearInterval(renewal);
      tab.signal.removeEventListener("abort", release);
      sessions.delete(tab.signal);
      void opened.then(({ lease }) => request("DELETE", { lease })).catch(() => {});
    }
    sessions.set(tab.signal, { opened, release });
    tab.signal.addEventListener("abort", release, { once: true });
    return opened;
  }

  function OpenAction({ absolutePath }) {
    if (typeof absolutePath !== "string" || !/\.md$/i.test(absolutePath) ||
        (!desktop() && !["127.0.0.1", "[::1]", "localhost"].includes(location.hostname))) return null;
    return h("button", {
      type: "button",
      className: actionClass,
      title: label(),
      "aria-label": label(),
      onClick(event) {
        const sessionId = ctx.sidebarRight.mounted.getSnapshot();
        if (!sessionId) return;
        const target = ctx.sidebarRight.focusedTarget(event.currentTarget);
        const paneId = target?.host === "dock" ? target.paneId : undefined;
        ctx.sidebarRight.openResource(fileAddress(sessionId, absolutePath), { kind, paneId, preferNewPane: true });
      },
    }, h("svg", {
      width: 15, height: 15, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3,
      strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
    }, h("path", { d: "M2 2.75h12v10.5H2zM7.5 2.75v10.5M10 8h2.5m-1.25-1.25v2.5" })), "Inkmap");
  }

  function EditorBody({ useTabInfo }) {
    const { tab } = useTabInfo();
    const [view, setView] = useState({});
    const frame = useRef(null);
    useEffect(() => {
      let mounted = true;
      void session(tab).then(
        ({ url, lease }) => { if (mounted) setView({ signal: tab.signal, url, lease }); },
        () => { if (mounted) setView({ signal: tab.signal, failed: true }); },
      );
      return () => { mounted = false; };
    }, [tab.signal, tab.contentId]);
    useEffect(() => {
      if (!desktop() || view.signal !== tab.signal || !view.url) return;
      const origin = new URL(view.url).origin;
      let mounted = true;
      async function openAccount(event) {
        const { source, data } = event;
        if (!source || source !== frame.current?.contentWindow || event.origin !== origin ||
            data?.type !== "inkmap:open-account" || typeof data.id !== "string" || tab.signal.aborted) return;
        let ok = false;
        try {
          const mode = data.mode === "buy" ? "buy" : "restore";
          const action = mode === "buy" ? "buy" : "sign-in";
          const response = await request("POST", {
            lease: view.lease,
            action,
            ...(typeof data.locale === "string" && { locale: data.locale }),
          });
          if (!response.ok) throw new Error("Inkmap sign-in is unavailable");
          const url = billingFlowUrl((await response.json()).url, YUNFAN_BILLING_ORIGIN, mode);
          if (!mounted || tab.signal.aborted) return;
          // Harness Desktop forwards HTTPS window requests to the system browser.
          window.open(url, "_blank", "noopener,noreferrer");
          ok = true;
        } catch { /* Report the failure to the editor. */ }
        if (mounted) source.postMessage({ type: "inkmap:open-account", id: data.id, ok }, origin);
      }
      window.addEventListener("message", openAccount);
      return () => {
        mounted = false;
        window.removeEventListener("message", openAccount);
      };
    }, [tab.signal, view]);
    if (view.signal !== tab.signal || !view.url) {
      const failed = view.signal === tab.signal && view.failed;
      const message = failed
        ? (zh() ? "无法打开此文件。请选择本机工作区内的 Markdown 文件。" : "Could not open this file. Select a Markdown file in the local workspace.")
        : (zh() ? "正在打开 Inkmap…" : "Opening Inkmap…");
      return h("p", { role: failed ? "alert" : "status", style: { padding: 16 } }, message);
    }
    return h("iframe", {
      ref: frame,
      src: desktop() ? `${view.url}?account-navigation=host` : view.url,
      title: "Inkmap",
      referrerPolicy: "no-referrer",
      sandbox: "allow-scripts allow-forms allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox",
      style: { display: "block", width: "100%", height: "100%", border: 0 },
    });
  }

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: packageName, kind, canOpen: address => !!selectedFile(address), title: () => "Inkmap", keepMounted: true,
  }), "Inkmap sidebar tab");
  ctx.effect(() => ctx.slots.inject(actionSlot, () => ctx.slots.register({
    name: actionSlot, id: packageName,
  }, OpenAction)), "Inkmap Markdown action");
  ctx.effect(() => ctx.slots.inject(bodySlot, () => ctx.slots.register({
    name: bodySlot, key: packageName,
  }, EditorBody)), "Inkmap sidebar editor");
  ctx.effect(() => {
    const style = document.createElement("style");
    style.textContent = `
      .${actionClass} { display: inline-flex; align-items: center; gap: 5px; height: 26px;
        padding: 0 7px; border: 0; border-radius: 6px; background: transparent; color: inherit;
        font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer; }
      .${actionClass}:hover { background: var(--dsw-alias-interactive-bg-hover, #8882); }
      .${actionClass}:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
    `;
    document.head.append(style);
    return () => style.remove();
  }, "Inkmap Markdown toolbar style");
  ctx.effect(() => {
    const releaseAll = () => {
      for (const { release } of sessions.values()) release();
    };
    const pageHidden = event => { if (!event.persisted) releaseAll(); };
    window.addEventListener("pagehide", pageHidden);
    return () => {
      window.removeEventListener("pagehide", pageHidden);
      releaseAll();
    };
  }, "Inkmap tab sessions");
}
