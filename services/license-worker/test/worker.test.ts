import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { checkLicense, generateLicenseKeys } from "../../../packages/core/src/license.ts";
import { handle, verifyCreemRedirect } from "../src/worker.ts";

const API_KEY = "creem_test_key";

/** Builds a redirect URL signed the way Creem documents it. */
function signed(params: [string, string][], apiKey = API_KEY) {
  const canonical = [...params.filter(([, v]) => v !== "").map(([k, v]) => `${k}=${v}`), `salt=${apiKey}`].join("|");
  const url = new URL("https://license.example/success");
  for (const [k, v] of params) url.searchParams.append(k, v);
  url.searchParams.append("signature", createHash("sha256").update(canonical).digest("hex"));
  return url;
}

const ORDER: [string, string][] = [
  ["checkout_id", "ch_1"],
  ["order_id", "ord_42"],
  ["customer_id", "cust_1"],
  ["subscription_id", ""],
  ["product_id", "prod_pro"],
];

describe("license worker", async () => {
  const keys = await generateLicenseKeys();
  const env = { CREEM_API_KEY: API_KEY, CREEM_PRODUCT_ID: "prod_pro", LICENSE_PRIVATE_KEY: keys.privateKey, SUPPORT_EMAIL: "help@example.com" };
  const codeIn = async (res: Response) => /value="(INK1-[^"]+)"/.exec(await res.text())?.[1];

  it("verifies Creem's redirect signature, skipping empty values", async () => {
    assert.equal(await verifyCreemRedirect(signed(ORDER), API_KEY), true);
    assert.equal(await verifyCreemRedirect(signed(ORDER, "other"), API_KEY), false);
    const tampered = signed(ORDER);
    tampered.searchParams.set("order_id", "ord_43");
    assert.equal(await verifyCreemRedirect(tampered, API_KEY), false);
    assert.equal(await verifyCreemRedirect(new URL("https://license.example/success?order_id=1"), API_KEY), false);
  });

  it("shows the same valid key every time an order's page is opened", async () => {
    const res = await handle(new Request(signed(ORDER)), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const code = await codeIn(res);
    assert.ok(code);
    assert.equal((await checkLicense(code, keys.publicKey)).ok, true);
    assert.equal(await codeIn(await handle(new Request(signed(ORDER)), env)), code);
  });

  it("rejects forged links and other products", async () => {
    const forged = signed(ORDER, "guess");
    const res = await handle(new Request(forged), env);
    assert.equal(res.status, 400);
    assert.equal(await codeIn(res), undefined);

    const other = ORDER.map(([k, v]): [string, string] => [k, k === "product_id" ? "prod_other" : v]);
    assert.equal((await handle(new Request(signed(other)), env)).status, 400);
    assert.equal((await handle(new Request("https://license.example/"), env)).status, 404);
  });
});
