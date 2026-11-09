// Creem redirects buyers here after payment. The worker checks Creem's redirect signature and
// shows a license key derived from the order id, so reloading the page shows the same key.
import { issueLicense, orderLicenseId } from "../../../packages/core/src/license.ts";
import { REVOKED_LICENSES } from "../../../packages/core/src/license-key.ts";

export interface Env {
  CREEM_API_KEY: string;
  CREEM_PRODUCT_ID: string;
  LICENSE_PRIVATE_KEY: string;
  SUPPORT_EMAIL: string;
}

const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");

function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Creem signs the redirect parameters, in URL order and without empty values, as sha256("k=v|…|salt=<api key>"). */
export async function verifyCreemRedirect(url: URL, apiKey: string): Promise<boolean> {
  const signature = url.searchParams.get("signature");
  if (!signature || !apiKey) return false;
  const parts = [...url.searchParams].filter(([k, v]) => k !== "signature" && v !== "").map(([k, v]) => `${k}=${v}`);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode([...parts, `salt=${apiKey}`].join("|")));
  return sameText(hex(digest), signature.toLowerCase());
}

const escape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

function page(status: number, body: string, nonce = "") {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Inkmap Pro</title>
<style>
body{margin:0;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#1f2329}
main{max-width:620px;margin:48px auto;padding:28px 32px;background:#fff;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.08)}
h1{font-size:22px;margin:0 0 4px}.muted{color:#646a73}
.code{display:flex;gap:8px;margin:20px 0}.code input{flex:1;font:13px ui-monospace,Menlo,monospace;padding:10px;border:1px solid #d0d3d6;border-radius:8px}
button{border:0;border-radius:8px;padding:0 16px;background:#3370ff;color:#fff;font:inherit;cursor:pointer}
ol{padding-left:20px}hr{border:0;border-top:1px solid #eceef0;margin:24px 0}
</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
}

function problem(status: number, env: Env, en: string, zh: string, orderId?: string) {
  const mail = escape(env.SUPPORT_EMAIL);
  const order = orderId ? ` (${escape(orderId)})` : "";
  return page(
    status,
    `<h1>Inkmap Pro</h1><p>${escape(en)}</p><p>${escape(zh)}</p>
<p class="muted">Contact / 联系：<a href="mailto:${mail}">${mail}</a>${order}</p>`,
  );
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== "/success") return new Response("Not found", { status: 404 });

  const orderId = url.searchParams.get("order_id") ?? "";
  if (!(await verifyCreemRedirect(url, env.CREEM_API_KEY)) || !orderId || url.searchParams.get("product_id") !== env.CREEM_PRODUCT_ID) {
    console.log(JSON.stringify({ event: "rejected", reason: "signature", order: orderId }));
    return problem(
      400,
      env,
      "We could not verify this payment link. If you have paid, email us your order number and we will send your key.",
      "无法验证这个付款链接。如果你已经付款，请把订单号发邮件给我们，我们会把激活码发给你。",
      orderId,
    );
  }

  const id = await orderLicenseId("creem", orderId);
  if (REVOKED_LICENSES.includes(hex(id))) {
    console.log(JSON.stringify({ event: "rejected", reason: "revoked", order: orderId }));
    return problem(410, env, "This order has been refunded, so its license key is no longer valid.", "这笔订单已经退款，对应的激活码已停用。", orderId);
  }

  const code = await issueLicense(env.LICENSE_PRIVATE_KEY, { id });
  console.log(JSON.stringify({ event: "issued", order: orderId, id: hex(id) }));
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  return page(
    200,
    `<h1>Thank you for buying Inkmap Pro!</h1>
<p class="muted">感谢购买 Inkmap Pro！Order / 订单号：${escape(orderId)}</p>
<div class="code"><input id="code" readonly value="${escape(code)}" aria-label="License key"><button id="copy">Copy / 复制</button></div>
<p><strong>Save this key</strong> — keep it with your receipt. 请保存好激活码，和付款收据放在一起。</p>
<ol>
<li>In Inkmap, click <strong>Get Pro</strong> in the map toolbar, or run <strong>Inkmap: Enter License Key</strong>.</li>
<li>Paste the key and click <strong>Activate</strong>. It works offline on all of your own devices.</li>
</ol>
<hr>
<ol>
<li>在 Inkmap 导图工具栏点「升级 Pro」，或运行命令「Inkmap: 输入激活码」。</li>
<li>粘贴激活码并点「激活」。激活在本机离线完成，你自己的所有设备都可以使用。</li>
</ol>
<p class="muted">Lost your key? Email <a href="mailto:${escape(env.SUPPORT_EMAIL)}">${escape(env.SUPPORT_EMAIL)}</a> with your order number. 激活码丢失可凭订单号邮件找回。</p>
<script nonce="${nonce}">
document.getElementById("copy").onclick = async () => {
  const input = document.getElementById("code");
  input.select();
  try { await navigator.clipboard.writeText(input.value); } catch { document.execCommand("copy"); }
  document.getElementById("copy").textContent = "Copied / 已复制";
};
</script>`,
    nonce,
  );
}

export default { fetch: handle };
