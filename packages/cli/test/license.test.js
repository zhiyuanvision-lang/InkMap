import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { generateLicenseKeys, issueLicense } from "@inkmap/core";
import { fileLicenseStorage, licenseService } from "../dist/license.js";
import { fileSource, serve } from "../dist/server.js";

const memory = () => {
  let code;
  return { read: async () => code, write: async c => void (code = c) };
};

describe("license service", () => {
  it("activates, remembers and removes a code", async () => {
    const keys = await generateLicenseKeys();
    const storage = memory();
    const service = licenseService(storage, keys.publicKey);
    const seen = [];
    service.onChange(s => seen.push(s.pro));

    assert.deepEqual(await service.state(), { pro: false });
    assert.deepEqual(await service.activate("INK1-nope"), { ok: false, reason: "format" });
    const code = await issueLicense(keys.privateKey);
    const result = await service.activate(`  ${code}\n`);
    assert.equal(result.ok, true);
    assert.equal(await storage.read(), code);
    assert.equal((await licenseService(storage, keys.publicKey).state()).pro, true, "a new session reads the stored code");

    await service.deactivate();
    assert.deepEqual(await service.state(), { pro: false });
    assert.deepEqual(seen, [true, false]);
  });

  it("ignores a stored code signed by another key", async () => {
    const keys = await generateLicenseKeys();
    const other = await generateLicenseKeys();
    const storage = memory();
    await storage.write(await issueLicense(other.privateKey));
    assert.deepEqual(await licenseService(storage, keys.publicKey).state(), { pro: false });
  });

  it("stores the code in a private file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inkmap-license-"));
    try {
      const storage = fileLicenseStorage(join(dir, "sub", "license"));
      assert.equal(await storage.read(), undefined);
      await storage.write("INK1-abc");
      assert.equal(await storage.read(), "INK1-abc");
      assert.equal(await readFile(join(dir, "sub", "license"), "utf8"), "INK1-abc\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serves license state, activation and ads over HTTP", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inkmap-api-"));
    const keys = await generateLicenseKeys();
    const file = join(dir, "a.md");
    await writeFile(file, "# A\n");
    const served = await serve({
      source: await fileSource(file),
      webRoot: dir,
      port: 0,
      license: licenseService(memory(), keys.publicKey),
      ads: async () => [{ id: "x", title: "T", text: "X", url: "https://example.com" }],
    });
    try {
      const api = (path, init) => fetch(new URL(path, served.url), init).then(r => r.json());
      assert.deepEqual(await api("/api/license"), { pro: false });
      const code = await issueLicense(keys.privateKey);
      const post = body => api("/api/license", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.deepEqual(await post({ code: "bad" }), { ok: false, reason: "format" });
      assert.equal((await post({ code })).ok, true);
      assert.equal((await api("/api/license")).pro, true);
      assert.equal((await api("/api/ads")).length, 1);
    } finally {
      await served.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
