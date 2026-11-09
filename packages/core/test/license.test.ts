import { describe, expect, it } from "vitest";
import { checkLicense, documentSetting, generateLicenseKeys, issueLicense, LICENSE_PREFIX, orderLicenseId, withDocumentSetting } from "../src/index";

describe("license codes", () => {
  it("accepts codes signed by the matching key and nothing else", async () => {
    const keys = await generateLicenseKeys();
    const other = await generateLicenseKeys();
    const code = await issueLicense(keys.privateKey, { issued: new Date("2026-11-09T12:00:00Z") });
    expect(code.startsWith(LICENSE_PREFIX)).toBe(true);
    expect(code.length).toBeLessThan(110);

    const ok = await checkLicense(code, keys.publicKey);
    expect(ok).toMatchObject({ ok: true, edition: "pro", issued: "2026-11-09" });
    expect(await checkLicense(` ${code.slice(0, 40)}\n${code.slice(40)} `, keys.publicKey)).toMatchObject({ ok: true });
    expect(await checkLicense(code, other.publicKey)).toEqual({ ok: false, reason: "signature" });

    const tampered = code.slice(0, 8) + (code[8] === "A" ? "B" : "A") + code.slice(9);
    expect((await checkLicense(tampered, keys.publicKey)).ok).toBe(false);
    expect(await checkLicense("hello", keys.publicKey)).toEqual({ ok: false, reason: "format" });
    expect(await checkLicense(LICENSE_PREFIX + "AAAA", keys.publicKey)).toEqual({ ok: false, reason: "format" });
    expect(await checkLicense(LICENSE_PREFIX + "wrong", keys.publicKey)).toEqual({ ok: false, reason: "format" });
    expect(await checkLicense(LICENSE_PREFIX + "a!b", keys.publicKey)).toEqual({ ok: false, reason: "format" });
  });

  it("revokes by id and reproduces codes from a fixed id", async () => {
    const keys = await generateLicenseKeys();
    const id = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const issued = new Date("2026-12-01");
    const a = await issueLicense(keys.privateKey, { id, issued });
    expect(await issueLicense(keys.privateKey, { id, issued })).toBe(a);
    const check = await checkLicense(a, keys.publicKey);
    expect(check).toMatchObject({ ok: true, id: "010203040506" });
    expect(await checkLicense(a, keys.publicKey, ["010203040506"])).toEqual({ ok: false, reason: "revoked" });
  });

  it("derives the same id for the same store order", async () => {
    const keys = await generateLicenseKeys();
    const id = await orderLicenseId("creem", "ord_123");
    expect(id).toEqual(await orderLicenseId("creem", "ord_123"));
    expect(id).not.toEqual(await orderLicenseId("creem", "ord_124"));
    expect(id).not.toEqual(await orderLicenseId("afdian", "ord_123"));
    const code = await issueLicense(keys.privateKey, { id });
    expect(await checkLicense(code, keys.publicKey)).toMatchObject({ ok: true, id: [...id].map(b => b.toString(16).padStart(2, "0")).join("") });
  });
});

describe("document settings", () => {
  it("reads and writes the inkmap section of the front matter", () => {
    expect(withDocumentSetting("", "layout", "mindMap")).toBe("---\ninkmap:\n  layout: mindMap\n---\n");

    const fm = "---\ntitle: Demo\nmarkmap:\n  layout: two-sided\n---\n";
    const one = withDocumentSetting(fm, "layout", "timeline");
    expect(one).toBe("---\ntitle: Demo\nmarkmap:\n  layout: two-sided\ninkmap:\n  layout: timeline\n---\n");
    const two = withDocumentSetting(one, "theme", "mint");
    expect(two).toBe("---\ntitle: Demo\nmarkmap:\n  layout: two-sided\ninkmap:\n  layout: timeline\n  theme: mint\n---\n");
    expect(withDocumentSetting(two, "layout", "fishbone")).toBe(two.replace("timeline", "fishbone"));

    expect(documentSetting(two, "layout")).toBe("timeline");
    expect(documentSetting(two, "theme")).toBe("mint");
    expect(documentSetting(fm, "layout")).toBeUndefined();
    expect(documentSetting("---\ninkmap:\n  theme: \"dusk\"\ntitle: x\n---\n", "theme")).toBe("dusk");
  });
});
